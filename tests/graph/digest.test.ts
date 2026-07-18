import { describe, expect, it } from "vite-plus/test";

import { createGraphStore, type GraphStore } from "../../packages/engine/src/graph/store.ts";
import { computeGraphDigest } from "../../packages/engine/src/graph/digest.ts";
import { speakerDigestSeeds } from "../../packages/engine/src/inputs.ts";
import {
  createSpeakerGraphTools,
  createSpecialistGraphTools,
  createGraphTools,
} from "../../packages/agents/src/capabilities/graph/tools.ts";
import { attachGraphContext } from "../../packages/agents/src/capabilities/graph/digest.ts";
import { configureGraphStore } from "../../packages/agents/src/capabilities/graph/runtime.ts";

const CHAT = "team@g.us";
const ALICE = "alice@s.whatsapp.net";
const BOB = "bob@s.whatsapp.net";

/** A small neighbourhood: two participants, work in view, a topic, an overdue commitment, roll-ups. */
const seed = (store: GraphStore) => {
  const thread = store.upsertEntity({ type: "thread", properties: { chatId: CHAT }, identity: { platform: "whatsapp", externalId: CHAT } });
  const alice = store.upsertEntity({ type: "person", properties: { name: "Alice" }, identity: { platform: "whatsapp", externalId: ALICE } });
  const bob = store.upsertEntity({ type: "person", properties: { name: "Bob" }, identity: { platform: "whatsapp", externalId: BOB } });
  const topic = store.upsertEntity({ type: "topic", properties: { label: "the deploy topic" }, confidence: 0.5 });
  const issue = store.upsertEntity({
    type: "issue",
    properties: { repo: "acme/widgets", number: 45, title: "bug", state: "open", cached_at: "t0" },
    identity: { platform: "github", externalId: "acme/widgets#45" },
  });
  const pr = store.upsertEntity({
    type: "pull_request",
    properties: { repo: "acme/widgets", number: 46, title: "fix", state: "open", cached_at: "t0" },
    identity: { platform: "github", externalId: "acme/widgets#46" },
  });
  const milestone = store.upsertEntity({
    type: "milestone",
    properties: { repo: "acme/widgets", number: 7, title: "m7", state: "open", cached_at: "t0" },
    identity: { platform: "github", externalId: "acme/widgets/milestones/7" },
  });
  const openC = store.upsertEntity({ type: "commitment", properties: { description: "ship it", status: "open", due: "2020-01-01T00:00:00Z" } });
  const doneC = store.upsertEntity({ type: "commitment", properties: { description: "old thing", status: "done" } });

  store.upsertRelation({ fromId: alice.entityId, relation: "participates_in", toId: thread.entityId });
  store.upsertRelation({ fromId: bob.entityId, relation: "participates_in", toId: thread.entityId });
  store.upsertRelation({ fromId: alice.entityId, relation: "works_on", toId: issue.entityId });
  store.upsertRelation({ fromId: alice.entityId, relation: "interested_in", toId: topic.entityId });
  store.upsertRelation({ fromId: thread.entityId, relation: "discusses", toId: issue.entityId });
  store.upsertRelation({ fromId: thread.entityId, relation: "mentions", toId: pr.entityId });
  store.upsertRelation({ fromId: pr.entityId, relation: "resolves", toId: issue.entityId });
  store.upsertRelation({ fromId: issue.entityId, relation: "part_of", toId: milestone.entityId });
  store.upsertRelation({ fromId: openC.entityId, relation: "made_by", toId: alice.entityId });
  store.upsertRelation({ fromId: openC.entityId, relation: "about", toId: issue.entityId });

  return { thread, alice, bob, topic, issue, pr, milestone, openC, doneC };
};

describe("computeGraphDigest — seed resolution and the one-hop walk", () => {
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
    expect(ids).toEqual(expect.arrayContaining([g.bob.entityId, g.issue.entityId, g.pr.entityId, g.topic.entityId, g.milestone.entityId]));

    const work = digest.entities.find((e) => e.entityId === g.issue.entityId);
    expect(work?.properties.cached_at).toBe("t0");
  });

  it("carries the strong edges, weak mentions, and secondary roll-up hops", () => {
    const store = createGraphStore(":memory:");
    const g = seed(store);
    const digest = computeGraphDigest(store, { chatId: CHAT, identities: [{ platform: "whatsapp", externalId: ALICE }] });
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
    const digest = computeGraphDigest(store, { identities: [{ platform: "whatsapp", externalId: "nobody@s.whatsapp.net" }] });
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
        { id: "m1", chatId: CHAT, from: ALICE, text: "hi", timestamp: 1, isGroup: true, fromMe: false, live: true, mentions: [BOB] },
        { id: "m2", chatId: CHAT, from: "bot@s.whatsapp.net", text: "me", timestamp: 2, isGroup: true, fromMe: true, live: true, mentions: [] },
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

  it("gives the Speaker read + confirmed-resolution, never record_relation", () => {
    expect(names(createSpeakerGraphTools(createGraphStore(":memory:")))).toEqual(["lookup_graph", "merge_entities", "record_entity"]);
  });

  it("gives Specialists read-only", () => {
    expect(names(createSpecialistGraphTools(createGraphStore(":memory:")))).toEqual(["lookup_graph"]);
  });

  it("keeps the Scribe's full four-tool surface", () => {
    expect(names(createGraphTools(createGraphStore(":memory:")))).toEqual(["lookup_graph", "merge_entities", "record_entity", "record_relation"]);
  });
});

describe("attachGraphContext — the funnel field", () => {
  const window = () => ({
    type: "whatsapp.window" as const,
    windowId: "w1",
    chatId: CHAT,
    reason: "mention" as const,
    messages: [{ id: "m1", chatId: CHAT, from: ALICE, text: "hi", timestamp: 1, isGroup: true, fromMe: false, live: true, mentions: [] }],
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
});
