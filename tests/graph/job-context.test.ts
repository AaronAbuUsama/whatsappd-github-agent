import { describe, expect, it } from "vite-plus/test";

import { createGraphStore } from "../../packages/engine/src/graph/store.ts";
import { buildJobGraphContext, specialistJobSeeds } from "../../packages/agents/src/capabilities/graph/digest.ts";
import { configureGraphStore } from "../../packages/agents/src/capabilities/graph/runtime.ts";

// The launch-tool seed end (§5 D6, #158 finding 4a): a Specialist launch pushes a digest
// seeded from the job's repo/issue + source-Surface chat. A fresh module = the graph store
// slot is unset, so the no-store no-op is exercised BEFORE any configure below.

describe("specialistJobSeeds — repo + issue + source chat as github natural keys", () => {
  it("mirrors speakerDigestSeeds' owner/repo and owner/repo#N conventions", () => {
    expect(specialistJobSeeds("home@g.us", "acme/widgets", 158)).toEqual({
      chatId: "home@g.us",
      identities: [
        { platform: "github", externalId: "acme/widgets" },
        { platform: "github", externalId: "acme/widgets#158" },
      ],
    });
  });

  it("omits chatId when no source-Surface binding is available", () => {
    expect(specialistJobSeeds(undefined, "acme/widgets", 1).chatId).toBeUndefined();
  });
});

describe("buildJobGraphContext — the pushed digest, or a no-op", () => {
  it("is undefined when no graph store is wired (existing delegation tests stay green)", () => {
    expect(buildJobGraphContext(specialistJobSeeds("home@g.us", "acme/widgets", 158))).toBeUndefined();
  });

  it("builds a non-empty digest from the job's issue once a store is wired", () => {
    const store = createGraphStore(":memory:");
    store.attest({
      context: { author: { kind: "ingester", id: "test-fixture" }, evidenceIds: ["test:issue:158"] },
      claim: {
        kind: "entity",
        input: {
          type: "issue",
          properties: { repo: "acme/widgets", number: 158, title: "Coder workflow", state: "open" },
          identity: { platform: "github", externalId: "acme/widgets#158" },
        },
      },
    });
    configureGraphStore(store);

    const digest = buildJobGraphContext(specialistJobSeeds("home@g.us", "acme/widgets", 158));
    expect(digest?.entities.some((e) => e.type === "issue" && e.properties.number === 158)).toBe(true);
  });

  it("is undefined for an empty neighbourhood (never ships an empty digest)", () => {
    configureGraphStore(createGraphStore(":memory:")); // store wired, but nothing resolves the seeds
    expect(buildJobGraphContext(specialistJobSeeds("home@g.us", "acme/widgets", 999))).toBeUndefined();
  });
});
