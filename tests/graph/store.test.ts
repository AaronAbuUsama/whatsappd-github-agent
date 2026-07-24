import type { ToolDefinition } from "@flue/runtime";
import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

import { createGraphStore, type GraphAttestationContext } from "../../packages/engine/src/graph/store.ts";
import { createGraphTools } from "../../packages/agents/src/capabilities/graph/tools.ts";
import { entitySchema, relationSchema } from "../../packages/agents/src/capabilities/graph/schemas.ts";

const harness = () => {
  const store = createGraphStore(":memory:");
  const context: GraphAttestationContext = {
    author: { kind: "brain", id: "brain" },
    evidenceIds: ["test:graph-tools"],
  };
  const tools = createGraphTools(store, context);
  const tool = (name: string): ToolDefinition => tools.find((candidate) => candidate.name === name)!;
  // Normalize sync-or-async handlers to a promise so both results and thrown constraints are awaitable.
  const call = <T>(name: string, input: unknown): Promise<T> => {
    const withEvidence =
      name === "record_entity" || name === "record_relation" || name === "merge_entities" || name === "rule_attestation"
        ? { ...(input as Record<string, unknown>), evidenceIds: ["test:graph-tools"] }
        : input;
    return Promise.resolve().then(() => tool(name).run({ input: withEvidence } as never) as T);
  };
  return { store, call };
};

const person = (externalId: string, extra: Record<string, unknown> = {}) => ({
  entity: { type: "person", identity: { platform: "github", externalId }, ...extra },
});

describe("keyless entity convergence", () => {
  it("reuses exact phrases without amplifying an exact Evidence Set retry", () => {
    const store = createGraphStore(":memory:");
    for (const [type, key] of [
      ["topic", "label"],
      ["commitment", "description"],
      ["goal", "description"],
    ] as const) {
      const draft = {
        context: { author: { kind: "scribe" as const, id: "scribe" }, evidenceIds: [`test:${type}`] },
        claim: { kind: "entity" as const, input: { type, properties: { [key]: "Ship it" }, confidence: 0.5 } },
      };
      const first = store.attest(draft);
      const replay = store.attest(draft);
      if (first.kind !== "entity" || replay.kind !== "entity") throw new Error("Expected Entity Attestations.");
      expect(replay.entity.entityId).toBe(first.entity.entityId);
      expect(replay.entity.confidence).toBe(0.5);
    }
    expect(store.findEntities({}).length).toBe(3);
    store.close();
  });
});

describe("graph tool boundary schemas", () => {
  it("accepts each of the eleven entity types and rejects a malformed one", () => {
    const valid: unknown[] = [
      { type: "person", identity: { platform: "github", externalId: "aaron" } },
      { type: "agent", identity: { platform: "github", externalId: "coder[bot]" }, name: "Coder" },
      { type: "thread", chatId: "team@g.us" },
      { type: "topic", label: "release cadence" },
      { type: "commitment", description: "ship the store", status: "open" },
      { type: "goal", description: "cross-thread memory" },
      { type: "repository", repo: "acme/widgets", title: "widgets", state: "active", cachedAt: "t" },
      { type: "issue", repo: "acme/widgets", number: 45, title: "bug", state: "open", cachedAt: "t" },
      { type: "pull_request", repo: "acme/widgets", number: 46, title: "fix", state: "open", cachedAt: "t" },
      { type: "milestone", repo: "acme/widgets", number: 7, title: "m7", state: "open", cachedAt: "t" },
      { type: "project", repo: "acme/widgets", number: 3, title: "p", state: "open", cachedAt: "t" },
    ];
    for (const entity of valid) expect(v.safeParse(entitySchema, entity).success).toBe(true);
    expect(v.safeParse(entitySchema, { type: "commitment", description: "x", status: "maybe" }).success).toBe(false);
    expect(v.safeParse(entitySchema, { type: "issue", repo: "acme/widgets", title: "no number" }).success).toBe(false);
  });

  it("accepts each of the eleven relation types and rejects an unknown one", () => {
    const relations = [
      "participates_in",
      "interested_in",
      "discusses",
      "mentions",
      "works_on",
      "made_by",
      "about",
      "resolves",
      "part_of",
      "blocks",
      "advances",
    ];
    for (const relation of relations) {
      expect(v.safeParse(relationSchema, { relation, fromId: "a_1", toId: "b_2" }).success).toBe(true);
    }
    expect(v.safeParse(relationSchema, { relation: "owns", fromId: "a_1", toId: "b_2" }).success).toBe(false);
  });
});

describe("record_entity — keyed convergence", () => {
  it("converges a retried identity onto one node without confidence amplification", async () => {
    const { call } = harness();
    const first = await call<{ entityId: string; confidence: number }>(
      "record_entity",
      person("AaronAbuUsama", { confidence: 0.5 }),
    );
    const second = await call<{ entityId: string; confidence: number }>(
      "record_entity",
      person("AaronAbuUsama", { confidence: 0.5 }),
    );
    expect(second.entityId).toBe(first.entityId);
    expect(second.confidence).toBe(0.5);
  });

  it("generates type-prefixed ids", async () => {
    const { call } = harness();
    const entity = await call<{ entityId: string }>("record_entity", person("octocat"));
    expect(entity.entityId).toMatch(/^actor_[0-9a-f]{12}$/u);
  });
});

describe("record_relation — upsert and constraints", () => {
  const seed = async (call: ReturnType<typeof harness>["call"]) => {
    const p = await call<{ entityId: string }>("record_entity", person("aaron"));
    const thread = await call<{ entityId: string }>("record_entity", { entity: { type: "thread", chatId: "t@g.us" } });
    return { person: p.entityId, thread: thread.entityId };
  };

  it("deduplicates an edge retry on the same Evidence Set", async () => {
    const { call } = harness();
    const { person: from, thread: to } = await seed(call);
    const first = await call<{ relationId: string; confidence: number }>("record_relation", {
      edge: { relation: "participates_in", fromId: from, toId: to, confidence: 0.5 },
    });
    const second = await call<{ relationId: string; confidence: number }>("record_relation", {
      edge: { relation: "participates_in", fromId: from, toId: to, confidence: 0.5 },
    });
    expect(second.relationId).toBe(first.relationId);
    expect(second.confidence).toBe(first.confidence);
    expect(second.confidence).toBe(0.5);
  });

  it("rejects a foreign-key-less edge before commit", async () => {
    const { call } = harness();
    const { person: from } = await seed(call);
    await expect(
      call("record_relation", { edge: { relation: "mentions", fromId: from, toId: "ghost_000000" } }),
    ).rejects.toThrow();
  });

  it("rejects a made_by edge that would give a commitment a second owner", async () => {
    const { call } = harness();
    const commitment = await call<{ entityId: string }>("record_entity", {
      entity: { type: "commitment", description: "ship it", status: "open" },
    });
    const alice = await call<{ entityId: string }>("record_entity", person("alice"));
    const bob = await call<{ entityId: string }>("record_entity", person("bob"));
    await call("record_relation", { edge: { relation: "made_by", fromId: commitment.entityId, toId: alice.entityId } });
    // Restating the same owner is fine (idempotent bump).
    await expect(
      call("record_relation", { edge: { relation: "made_by", fromId: commitment.entityId, toId: alice.entityId } }),
    ).resolves.toBeDefined();
    await expect(
      call("record_relation", { edge: { relation: "made_by", fromId: commitment.entityId, toId: bob.entityId } }),
    ).rejects.toThrow(/exactly one|already made_by/u);
  });

  it("returns the immutable receipt before validating an overruled relation retry against newer state", async () => {
    const { store, call } = harness();
    const commitment = await call<{ entityId: string }>("record_entity", {
      entity: { type: "commitment", description: "ship retry proof", status: "open" },
    });
    const alice = await call<{ entityId: string }>("record_entity", person("alice-retry"));
    const bob = await call<{ entityId: string }>("record_entity", person("bob-retry"));
    const originalInput = {
      edge: { relation: "made_by" as const, fromId: commitment.entityId, toId: alice.entityId },
    };
    const original = await call<{ relationId: string }>("record_relation", originalInput);
    const originalAttestation = store
      .attestations()
      .find(
        ({ claim }) =>
          claim.kind === "relation" && claim.fromId === commitment.entityId && claim.toId === alice.entityId,
      );
    if (originalAttestation === undefined) throw new Error("Expected the original Relation Attestation.");
    store.attest({
      context: { author: { kind: "brain", id: "brain" }, evidenceIds: ["test:overrule-original-owner"] },
      claim: { kind: "ruling", action: "overrule", targetAttestationId: originalAttestation.id },
    });
    await call("record_relation", {
      edge: { relation: "made_by", fromId: commitment.entityId, toId: bob.entityId },
    });

    await expect(call<{ relationId: string }>("record_relation", originalInput)).resolves.toEqual(original);
  });

  it("rejects a blocks edge that would close a cycle", async () => {
    const { call } = harness();
    const issue = async (number: number) =>
      (
        await call<{ entityId: string }>("record_entity", {
          entity: { type: "issue", repo: "acme/widgets", number, title: `#${number}`, state: "open", cachedAt: "t" },
        })
      ).entityId;
    const a = await issue(1);
    const b = await issue(2);
    const c = await issue(3);
    await call("record_relation", { edge: { relation: "blocks", fromId: a, toId: b } });
    await call("record_relation", { edge: { relation: "blocks", fromId: b, toId: c } });
    await expect(call("record_relation", { edge: { relation: "blocks", fromId: c, toId: a } })).rejects.toThrow(
      /cycle/u,
    );
    await expect(call("record_relation", { edge: { relation: "blocks", fromId: a, toId: a } })).rejects.toThrow(
      /itself/u,
    );
  });
});

describe("merge_entities", () => {
  it("repoints every edge and identity to the survivor and deletes the loser", async () => {
    const { store, call } = harness();
    const survivor = await call<{ entityId: string }>("record_entity", person("aaron"));
    const loser = await call<{ entityId: string }>("record_entity", person("aaron-alt"));
    const topic = await call<{ entityId: string }>("record_entity", {
      entity: { type: "topic", label: "memory" },
    });
    await call("record_relation", {
      edge: { relation: "interested_in", fromId: loser.entityId, toId: topic.entityId },
    });

    await call("merge_entities", { survivorId: survivor.entityId, loserId: loser.entityId });

    expect(store.getEntity(loser.entityId)).toBeUndefined();
    expect(store.relationsFrom(survivor.entityId, "interested_in").map((edge) => edge.toId)).toContain(topic.entityId);
    // The loser's github identity now resolves to the survivor — cross-thread convergence preserved.
    expect(store.resolveIdentity("github", "aaron-alt")?.entityId).toBe(survivor.entityId);
  });

  it("folds a duplicate edge instead of violating the unique key", async () => {
    const { store, call } = harness();
    const survivor = await call<{ entityId: string }>("record_entity", person("aaron"));
    const loser = await call<{ entityId: string }>("record_entity", person("aaron-alt"));
    const thread = await call<{ entityId: string }>("record_entity", { entity: { type: "thread", chatId: "t@g.us" } });
    // Both point at the same thread via the same relation — after merge that is one fact.
    await call("record_relation", {
      edge: { relation: "participates_in", fromId: survivor.entityId, toId: thread.entityId },
    });
    await call("record_relation", {
      edge: { relation: "participates_in", fromId: loser.entityId, toId: thread.entityId },
    });

    await call("merge_entities", { survivorId: survivor.entityId, loserId: loser.entityId });

    expect(store.relationsFrom(survivor.entityId, "participates_in")).toHaveLength(1);
  });
});

describe("lookup_graph", () => {
  it("resolves an external identity to its one-hop neighborhood", async () => {
    const { call } = harness();
    const p = await call<{ entityId: string }>("record_entity", person("aaron"));
    const thread = await call<{ entityId: string }>("record_entity", { entity: { type: "thread", chatId: "t@g.us" } });
    await call("record_relation", { edge: { relation: "participates_in", fromId: p.entityId, toId: thread.entityId } });

    const result = await call<{ entities: { entityId: string }[]; relations: { toId: string }[] }>("lookup_graph", {
      platform: "github",
      externalId: "aaron",
    });
    expect(result.entities.map((entity) => entity.entityId)).toEqual([p.entityId]);
    expect(result.relations.map((relation) => relation.toId)).toContain(thread.entityId);
  });

  it("lists candidate entities by type and text for resolution", async () => {
    const { call } = harness();
    await call("record_entity", { entity: { type: "topic", label: "release cadence" } });
    await call("record_entity", { entity: { type: "topic", label: "graph store" } });

    const result = await call<{ entities: { properties: { label?: string } }[] }>("lookup_graph", {
      type: "topic",
      query: "cadence",
    });
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.properties.label).toBe("release cadence");
  });
});
