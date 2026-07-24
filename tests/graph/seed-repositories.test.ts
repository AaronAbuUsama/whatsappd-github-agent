import { describe, expect, it } from "vite-plus/test";

import { createGraphStore } from "../../packages/engine/src/graph/store.ts";
import { seedRepositoryFacts } from "../../packages/agents/src/capabilities/graph/seed-repositories.ts";
import { toEntityUpsert } from "../../packages/agents/src/capabilities/graph/schemas.ts";
import { createIssueManagementPolicy } from "../../packages/agents/src/capabilities/issue-management/runtime.ts";

const CHAT = "team@g.us";

const seed = {
  allowedRepositories: ["acme/api", "acme/web"],
  surfaceRepositories: [{ chat: CHAT, repository: "acme/api" }],
} as const;

describe("S2 — seed repository facts (#19)", () => {
  it("seeds Repository entities + surface→repository relations, each with a non-empty Evidence Set (L2)", () => {
    const store = createGraphStore(":memory:");
    seedRepositoryFacts(store, seed);

    const repositories = store.findEntities({ type: "repository" });
    expect(repositories.map((entity) => entity.properties.repo).sort()).toEqual(["acme/api", "acme/web"]);

    // Every attestation the seed wrote carries provenance — a non-empty Evidence Set.
    for (const attestation of store.attestations()) {
      expect(attestation.evidenceIds.length).toBeGreaterThan(0);
    }

    // The surface (thread) works_on its configured repository — the relation the Brain resolves.
    const thread = store.resolveIdentity("whatsapp", CHAT, "thread")!;
    const repo = store.resolveIdentity("github", "acme/api", "repository")!;
    const edges = store.relationsFrom(thread.entityId, "works_on");
    expect(edges.map((edge) => edge.toId)).toContain(repo.entityId);
    expect(edges[0]!.attestationIds.length).toBeGreaterThan(0);
    store.close();
  });

  it("is idempotent — re-seeding unchanged config appends no new attestations (boot refresh)", () => {
    const store = createGraphStore(":memory:");
    seedRepositoryFacts(store, seed);
    const after = store.attestations().length;
    seedRepositoryFacts(store, seed);
    expect(store.attestations().length).toBe(after);
    store.close();
  });

  it("converges with a conversation-discovered repository node — no second migration for #249", () => {
    const store = createGraphStore(":memory:");
    seedRepositoryFacts(store, seed);
    // A later graph-extraction node for the same repo carries richer GitHub properties.
    store.attest({
      context: { author: { kind: "scribe", id: "scribe" }, evidenceIds: ["arrival:chat:m1"] },
      claim: {
        kind: "entity",
        input: toEntityUpsert({ type: "repository", repo: "acme/api", title: "API", state: "active", cachedAt: "t" }),
      },
    });
    // One entity for acme/api — the config seed and the discovered node share the natural key.
    const apis = store.findEntities({ type: "repository" }).filter((entity) => entity.properties.repo === "acme/api");
    expect(apis.length).toBe(1);
    expect(apis[0]!.properties.title).toBe("API");
    store.close();
  });

  it("negative: a Repository entity in the Graph never grants write access outside allowedRepositories (fail-closed)", () => {
    const store = createGraphStore(":memory:");
    // Seed a repository that is NOT authorized (simulates a lingering/de-authorized or discovered repo).
    seedRepositoryFacts(store, {
      allowedRepositories: ["acme/api"],
      surfaceRepositories: [{ chat: CHAT, repository: "evil/secret" }],
    });
    // The repository entity exists in the Graph...
    expect(store.resolveIdentity("github", "evil/secret", "repository")).toBeDefined();
    // ...but authorization is the config check, not entity presence: the boundary refuses it.
    const policy = createIssueManagementPolicy("acme/api", ["acme/api"]);
    expect(() => policy.authorize("evil/secret")).toThrow(/not in the configured GitHub write allowlist/);
    expect(policy.authorize("acme/api")).toEqual({ owner: "acme", repo: "api" });
    store.close();
  });
});
