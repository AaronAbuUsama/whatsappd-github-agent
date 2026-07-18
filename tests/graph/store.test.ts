import type { ToolDefinition } from "@flue/runtime";
import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

import { createGraphStore } from "../../packages/engine/src/graph/store.ts";
import { createGraphTools } from "../../packages/agents/src/capabilities/graph/tools.ts";
import { entitySchema, relationSchema } from "../../packages/agents/src/capabilities/graph/schemas.ts";

const harness = () => {
  const store = createGraphStore(":memory:");
  const tools = createGraphTools(store);
  const tool = (name: string): ToolDefinition => tools.find((candidate) => candidate.name === name)!;
  // Normalize sync-or-async handlers to a promise so both results and thrown constraints are awaitable.
  const call = <T>(name: string, input: unknown): Promise<T> =>
    Promise.resolve().then(() => tool(name).run({ input } as never) as T);
  return { store, call };
};

const person = (externalId: string, extra: Record<string, unknown> = {}) => ({
  entity: { type: "person", identity: { platform: "github", externalId }, ...extra },
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
  it("converges a re-seen identity onto one node across provenance and raises confidence", async () => {
    const { call } = harness();
    const first = await call<{ entityId: string; confidence: number }>(
      "record_entity",
      person("AaronAbuUsama", { confidence: 0.5, provenance: { chatId: "thread-A" } }),
    );
    const second = await call<{ entityId: string; confidence: number }>(
      "record_entity",
      person("AaronAbuUsama", { confidence: 0.5, provenance: { chatId: "thread-B" } }),
    );
    expect(second.entityId).toBe(first.entityId);
    expect(second.confidence).toBeCloseTo(0.75);
  });

  it("generates type-prefixed ids", async () => {
    const { call } = harness();
    const entity = await call<{ entityId: string }>("record_entity", person("octocat"));
    expect(entity.entityId).toMatch(/^person_[0-9a-f]{6}$/u);
  });
});

describe("record_relation — upsert and constraints", () => {
  const seed = async (call: ReturnType<typeof harness>["call"]) => {
    const p = await call<{ entityId: string }>("record_entity", person("aaron"));
    const thread = await call<{ entityId: string }>("record_entity", { entity: { type: "thread", chatId: "t@g.us" } });
    return { person: p.entityId, thread: thread.entityId };
  };

  it("upserts an edge on the unique key and raises its confidence", async () => {
    const { call } = harness();
    const { person: from, thread: to } = await seed(call);
    const first = await call<{ relationId: string; confidence: number }>("record_relation", {
      edge: { relation: "participates_in", fromId: from, toId: to, confidence: 0.5 },
    });
    const second = await call<{ relationId: string; confidence: number }>("record_relation", {
      edge: { relation: "participates_in", fromId: from, toId: to, confidence: 0.5 },
    });
    expect(second.relationId).toBe(first.relationId);
    expect(second.confidence).toBeGreaterThan(first.confidence);
    expect(second.confidence).toBeCloseTo(0.75);
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
    await expect(
      call("record_relation", { edge: { relation: "blocks", fromId: c, toId: a } }),
    ).rejects.toThrow(/cycle/u);
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
    await call("record_relation", { edge: { relation: "participates_in", fromId: survivor.entityId, toId: thread.entityId } });
    await call("record_relation", { edge: { relation: "participates_in", fromId: loser.entityId, toId: thread.entityId } });

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
