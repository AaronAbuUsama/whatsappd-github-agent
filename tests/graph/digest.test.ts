import { describe, expect, it, vi } from "vite-plus/test";

import {
  createGraphStore,
  type EntityUpsert,
  type GraphStore,
  type RelationUpsert,
} from "../../packages/engine/src/graph/store.ts";
import { computeGraphDigest, MAX_GRAPH_DIGEST_BYTES } from "../../packages/engine/src/graph/digest.ts";
import { speakerDigestSeeds } from "../../packages/engine/src/inputs.ts";
import {
  createSpeakerGraphTools,
  createSpecialistGraphTools,
  createScribeGraphTools,
  createBrainGraphTools,
  createGraphTools,
} from "../../packages/agents/src/capabilities/graph/tools.ts";
import { attachGraphContext } from "../../packages/agents/src/capabilities/graph/digest.ts";
import { configureGraphStore } from "../../packages/agents/src/capabilities/graph/runtime.ts";

const CHAT = "team@g.us";
const ALICE = "alice@s.whatsapp.net";
const BOB = "bob@s.whatsapp.net";

let fixtureEvidence = 0;
const fixtureContext = () => ({
  author: { kind: "ingester" as const, id: "graph-digest-fixture" },
  evidenceIds: [`test:graph-digest:${fixtureEvidence++}`],
});

const attestEntity = (store: GraphStore, input: EntityUpsert) => {
  const result = store.attest({ context: fixtureContext(), claim: { kind: "entity", input } });
  if (result.kind !== "entity") throw new Error("Expected an Entity Attestation.");
  return result.entity;
};

const attestRelation = (store: GraphStore, input: RelationUpsert) => {
  const result = store.attest({ context: fixtureContext(), claim: { kind: "relation", input } });
  if (result.kind !== "relation") throw new Error("Expected a Relation Attestation.");
  return result.relation;
};

/** A small neighbourhood: two participants, work in view, a topic, an overdue commitment, roll-ups. */
const seed = (store: GraphStore) => {
  const thread = attestEntity(store, {
    type: "thread",
    properties: { chatId: CHAT },
    identity: { platform: "whatsapp", externalId: CHAT },
  });
  const alice = attestEntity(store, {
    type: "person",
    properties: { name: "Alice" },
    identity: { platform: "whatsapp", externalId: ALICE },
  });
  const bob = attestEntity(store, {
    type: "person",
    properties: { name: "Bob" },
    identity: { platform: "whatsapp", externalId: BOB },
  });
  const topic = attestEntity(store, { type: "topic", properties: { label: "the deploy topic" }, confidence: 0.5 });
  const issue = attestEntity(store, {
    type: "issue",
    properties: { repo: "acme/widgets", number: 45, title: "bug", state: "open", cached_at: "t0" },
    identity: { platform: "github", externalId: "acme/widgets#45" },
  });
  const pr = attestEntity(store, {
    type: "pull_request",
    properties: { repo: "acme/widgets", number: 46, title: "fix", state: "open", cached_at: "t0" },
    identity: { platform: "github", externalId: "acme/widgets#46" },
  });
  const milestone = attestEntity(store, {
    type: "milestone",
    properties: { repo: "acme/widgets", number: 7, title: "m7", state: "open", cached_at: "t0" },
    identity: { platform: "github", externalId: "acme/widgets/milestones/7" },
  });
  const openC = attestEntity(store, {
    type: "commitment",
    properties: { description: "ship it", status: "open", due: "2020-01-01T00:00:00Z" },
  });
  const doneC = attestEntity(store, { type: "commitment", properties: { description: "old thing", status: "done" } });

  attestRelation(store, { fromId: alice.entityId, relation: "participates_in", toId: thread.entityId });
  attestRelation(store, { fromId: bob.entityId, relation: "participates_in", toId: thread.entityId });
  attestRelation(store, { fromId: alice.entityId, relation: "works_on", toId: issue.entityId });
  attestRelation(store, { fromId: alice.entityId, relation: "interested_in", toId: topic.entityId });
  attestRelation(store, { fromId: thread.entityId, relation: "discusses", toId: issue.entityId });
  attestRelation(store, { fromId: thread.entityId, relation: "mentions", toId: pr.entityId });
  attestRelation(store, { fromId: pr.entityId, relation: "resolves", toId: issue.entityId });
  attestRelation(store, { fromId: issue.entityId, relation: "part_of", toId: milestone.entityId });
  attestRelation(store, { fromId: openC.entityId, relation: "made_by", toId: alice.entityId });
  attestRelation(store, { fromId: openC.entityId, relation: "about", toId: issue.entityId });

  return { thread, alice, bob, topic, issue, pr, milestone, openC, doneC };
};

describe("computeGraphDigest — seed resolution and the one-hop walk", () => {
  it("is explicitly versioned, provenance-bearing, and bounded", () => {
    const store = createGraphStore(":memory:");
    const graph = seed(store);
    const digest = computeGraphDigest(store, { chatId: CHAT, identities: [] });
    expect(digest.schemaVersion).toBe("graph-digest.v1");
    expect(digest.projectionVersion).toBe(store.projectionVersion());
    expect(digest.entities.find(({ entityId }) => entityId === graph.thread.entityId)?.supportingAttestationIds).toEqual(
      graph.thread.attestationIds,
    );
    expect(
      [...digest.entities, ...digest.commitments, ...digest.relations].every(
        ({ supportingAttestationIds }) => supportingAttestationIds.length <= 8,
      ),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(digest))).toBeLessThanOrEqual(MAX_GRAPH_DIGEST_BYTES);
  });

  it("drops oversized tail items rather than exceeding the 64 KiB input contract", () => {
    const store = createGraphStore(":memory:");
    attestEntity(store, {
      type: "thread",
      properties: { chatId: CHAT, notes: "x".repeat(MAX_GRAPH_DIGEST_BYTES * 2) },
      identity: { platform: "whatsapp", externalId: CHAT },
    });
    const digest = computeGraphDigest(store, { chatId: CHAT, identities: [] });
    expect(Buffer.byteLength(JSON.stringify(digest))).toBeLessThanOrEqual(MAX_GRAPH_DIGEST_BYTES);
  });

  it("resolves the thread and a whatsapp participant into the neighbourhood", () => {
    const store = createGraphStore(":memory:");
    const g = seed(store);
    const digest = computeGraphDigest(
      store,
      { chatId: CHAT, identities: [{ platform: "whatsapp", externalId: ALICE }] },
      { now: () => new Date("2026-01-01T00:00:00Z") },
    );

    expect(digest.seeds).toEqual(expect.arrayContaining([g.thread.entityId, g.alice.entityId]));

    const ids = digest.entities.map((e) => e.entityId);
    // quiet participant, work-in-view, weak mention, topic, and the secondary-hop milestone
    expect(ids).toEqual(
      expect.arrayContaining([g.bob.entityId, g.issue.entityId, g.pr.entityId, g.topic.entityId, g.milestone.entityId]),
    );

    const work = digest.entities.find((e) => e.entityId === g.issue.entityId);
    expect(work?.properties.cached_at).toBe("t0");
  });

  it("carries the strong edges, weak mentions, and secondary roll-up hops", () => {
    const store = createGraphStore(":memory:");
    const g = seed(store);
    const digest = computeGraphDigest(store, {
      chatId: CHAT,
      identities: [{ platform: "whatsapp", externalId: ALICE }],
    });
    const has = (fromId: string, relation: string, toId: string) =>
      digest.relations.some((r) => r.fromId === fromId && r.relation === relation && r.toId === toId);

    expect(has(g.alice.entityId, "works_on", g.issue.entityId)).toBe(true);
    expect(has(g.thread.entityId, "mentions", g.pr.entityId)).toBe(true);
    expect(has(g.thread.entityId, "discusses", g.issue.entityId)).toBe(true);
    expect(has(g.issue.entityId, "part_of", g.milestone.entityId)).toBe(true); // secondary hop
    expect(has(g.openC.entityId, "made_by", g.alice.entityId)).toBe(true);
  });

  it("surfaces only open commitments touching anyone present, flags overdue, and flags low confidence", () => {
    const store = createGraphStore(":memory:");
    const g = seed(store);
    const digest = computeGraphDigest(
      store,
      { chatId: CHAT, identities: [{ platform: "whatsapp", externalId: ALICE }] },
      { now: () => new Date("2026-01-01T00:00:00Z") },
    );

    const commitmentIds = digest.commitments.map((c) => c.entityId);
    expect(commitmentIds).toContain(g.openC.entityId);
    expect(commitmentIds).not.toContain(g.doneC.entityId);
    expect(digest.commitments.find((c) => c.entityId === g.openC.entityId)?.overdue).toBe(true);
    // commitments are pulled out of the flat entity list
    expect(digest.entities.map((e) => e.entityId)).not.toContain(g.openC.entityId);

    const topic = digest.entities.find((e) => e.entityId === g.topic.entityId);
    expect(topic?.lowConfidence).toBe(true); // confidence 0.5 <= threshold
  });

  it("returns an empty digest when no seed resolves", () => {
    const store = createGraphStore(":memory:");
    seed(store);
    const digest = computeGraphDigest(store, {
      identities: [{ platform: "whatsapp", externalId: "nobody@s.whatsapp.net" }],
    });
    expect(digest.seeds).toEqual([]);
    expect(digest.entities).toEqual([]);
    expect(digest.relations).toEqual([]);
    expect(digest.commitments).toEqual([]);
  });
});

describe("speakerDigestSeeds — window keys", () => {
  it("seeds a whatsapp window from non-self senders, mentions, and the chat", () => {
    const seeds = speakerDigestSeeds({
      type: "whatsapp.window",
      windowId: "w1",
      chatId: CHAT,
      reason: "mention",
      messages: [
        {
          id: "m1",
          chatId: CHAT,
          from: ALICE,
          text: "hi",
          timestamp: 1,
          isGroup: true,
          fromMe: false,
          live: true,
          mentions: [BOB],
        },
        {
          id: "m2",
          chatId: CHAT,
          from: "bot@s.whatsapp.net",
          text: "me",
          timestamp: 2,
          isGroup: true,
          fromMe: true,
          live: true,
          mentions: [],
        },
      ],
      updates: [],
    });
    expect(seeds.chatId).toBe(CHAT);
    const externalIds = seeds.identities.map((i) => i.externalId);
    expect(externalIds).toEqual(expect.arrayContaining([ALICE, BOB]));
    expect(externalIds).not.toContain("bot@s.whatsapp.net"); // fromMe excluded
  });

  it("seeds a github issue window from repo, issue, and sender", () => {
    const seeds = speakerDigestSeeds({
      type: "github.issue.opened",
      chatId: CHAT,
      deliveryId: "d1",
      repository: { owner: "acme", repo: "widgets", id: 1, url: "u" },
      issue: { number: 45, url: "u", title: "bug", state: "open" },
      sender: { login: "octocat", id: 2, type: "User" },
    });
    const externalIds = seeds.identities.map((i) => i.externalId);
    expect(seeds.identities.every((i) => i.platform === "github")).toBe(true);
    expect(externalIds).toEqual(expect.arrayContaining(["acme/widgets", "acme/widgets#45", "octocat"]));
  });
});

describe("graph tool subsets", () => {
  const names = (tools: { name: string }[]) => tools.map((t) => t.name).sort();

  it("gives the Speaker a read-only surface", () => {
    expect(names(createSpeakerGraphTools(createGraphStore(":memory:")))).toEqual(["lookup_graph"]);
  });

  it("gives Specialists read-only", () => {
    expect(names(createSpecialistGraphTools(createGraphStore(":memory:")))).toEqual(["lookup_graph"]);
  });

  it("keeps merge authority off the Scribe surface", () => {
    const context = { author: { kind: "scribe" as const, id: "scribe" }, evidenceIds: ["test:scribe"] };
    expect(names(createScribeGraphTools(context, createGraphStore(":memory:")))).toEqual([
      "lookup_graph",
      "record_entity",
      "record_relation",
    ]);
  });

  it("exposes merge rulings only on the Brain-capable surface", () => {
    const context = { author: { kind: "brain" as const, id: "brain" }, evidenceIds: ["test:brain"] };
    expect(names(createGraphTools(createGraphStore(":memory:"), context))).toEqual([
      "lookup_graph",
      "merge_entities",
      "record_entity",
      "record_relation",
      "rule_attestation",
    ]);
  });

  it("resolves the Brain's trusted Batch context at tool execution time", () => {
    const context = { author: { kind: "brain" as const, id: "brain" }, evidenceIds: ["test:brain"] };
    expect(names(createBrainGraphTools(() => context, createGraphStore(":memory:")))).toEqual([
      "lookup_graph",
      "merge_entities",
      "record_entity",
      "record_relation",
      "rule_attestation",
    ]);
  });
});

describe("attachGraphContext — the funnel field", () => {
  const window = () => ({
    type: "whatsapp.window" as const,
    windowId: "w1",
    chatId: CHAT,
    reason: "mention" as const,
    messages: [
      {
        id: "m1",
        chatId: CHAT,
        from: ALICE,
        text: "hi",
        timestamp: 1,
        isGroup: true,
        fromMe: false,
        live: true,
        mentions: [],
      },
    ],
    updates: [],
  });

  it("rides graphContext on the input when the neighbourhood is non-empty", () => {
    const store = createGraphStore(":memory:");
    seed(store);
    configureGraphStore(store);
    const enriched = attachGraphContext(window());
    expect(enriched.graphContext).toBeDefined();
    expect(enriched.graphContext?.entities.length).toBeGreaterThan(0);
    expect(enriched.type).toBe("whatsapp.window"); // flat field, not an envelope
  });

  it("leaves the input untouched when the graph is empty", () => {
    configureGraphStore(createGraphStore(":memory:"));
    const enriched = attachGraphContext(window());
    expect(enriched.graphContext).toBeUndefined();
  });

  it("falls back to the un-enriched input (and logs) when a graph read throws — the dispatch still succeeds", () => {
    const boom = new Error("SQLITE_BUSY");
    configureGraphStore({
      resolveIdentity: () => {
        throw boom;
      },
    } as unknown as GraphStore);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const input = window();
      const enriched = attachGraphContext(input);
      expect(enriched).toBe(input); // raw input passed straight through — never rejects the dispatch
      expect(enriched.graphContext).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("digest enrichment failed"), boom);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
