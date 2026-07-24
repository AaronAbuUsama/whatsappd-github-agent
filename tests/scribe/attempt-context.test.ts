import type { ToolDefinition } from "@flue/runtime";
import { describe, expect, it } from "vite-plus/test";

import { createGraphStore } from "../../packages/engine/src/graph/store.ts";
import { createScribeGraphTools } from "../../packages/agents/src/capabilities/graph/tools.ts";
import { scribeAttemptContext, withScribeAttemptContext } from "../../packages/agents/src/scribe/attempt-context.ts";
import { scribeAttemptRuntimeConfig } from "../../packages/agents/src/scribe/agent.ts";

describe("trusted Scribe attempt context", () => {
  it("keeps concurrent attempt Evidence Sets isolated and removes them at settlement", async () => {
    const observed: string[][] = [];
    await Promise.all([
      withScribeAttemptContext(
        "attempt:a",
        { author: { kind: "scribe", id: "scribe" }, evidenceIds: ["arrival:a"], batchId: "batch:a" },
        async () => {
          await Promise.resolve();
          observed.push([...scribeAttemptContext("attempt:a")!.evidenceIds]);
        },
      ),
      withScribeAttemptContext(
        "attempt:b",
        { author: { kind: "scribe", id: "scribe" }, evidenceIds: ["arrival:b"], batchId: "batch:b" },
        async () => {
          observed.push([...scribeAttemptContext("attempt:b")!.evidenceIds]);
        },
      ),
    ]);

    expect(observed).toEqual(expect.arrayContaining([["arrival:a"], ["arrival:b"]]));
    expect(scribeAttemptContext("attempt:a")).toBeUndefined();
    expect(scribeAttemptContext("attempt:b")).toBeUndefined();
  });

  it("removes context after a failed attempt", async () => {
    await expect(
      withScribeAttemptContext(
        "attempt:failed",
        { author: { kind: "scribe", id: "scribe" }, evidenceIds: ["arrival:failed"] },
        async () => {
          throw new Error("model failed");
        },
      ),
    ).rejects.toThrow("model failed");
    expect(scribeAttemptContext("attempt:failed")).toBeUndefined();
  });

  it("settles an orphaned recovery as a tool-less no-op instead of throwing (#330)", async () => {
    // A durable Scribe submission recovered on a fresh boot re-runs the agent initializer with an
    // empty in-memory context Map. It must not throw (which left the submission re-recovering on
    // every restart); it settles as a no-op with no Graph tools, so it cannot write or duplicate.
    const orphan = scribeAttemptRuntimeConfig("scribe-attempt:recovered-on-boot");
    expect(orphan.tools).toEqual([]);
    expect(orphan.skills ?? []).toEqual([]);

    // A live in-process attempt keeps its trusted context and mounts the real ontology tools.
    await withScribeAttemptContext(
      "scribe-attempt:live",
      { author: { kind: "scribe", id: "scribe" }, evidenceIds: ["arrival:live"], batchId: "scribe-batch:live" },
      async () => {
        const live = scribeAttemptRuntimeConfig("scribe-attempt:live");
        expect((live.tools ?? []).map((tool) => tool.name)).toContain("record_entity");
      },
    );
  });

  it("takes provenance only from the trusted batch context and deduplicates a retry", async () => {
    const store = createGraphStore(":memory:");
    const context = {
      author: { kind: "scribe" as const, id: "scribe" },
      evidenceIds: ["arrival:trusted-chat:trusted-message"],
      batchId: "scribe-batch:trusted",
    };
    const tool = createScribeGraphTools(context, store).find(
      (candidate) => candidate.name === "record_entity",
    ) as ToolDefinition;
    const input = {
      entity: {
        type: "person",
        identity: { platform: "whatsapp", externalId: "alice@s.whatsapp.net" },
        confidence: 0.5,
        provenance: { chatId: "invented", messageId: "invented" },
      },
      evidenceIds: ["arrival:trusted-chat:trusted-message"],
    };

    await tool.run({ input } as never);
    await tool.run({ input } as never);

    expect(store.attestations()).toHaveLength(1);
    expect(store.attestations()[0]).toMatchObject({
      author: { kind: "scribe", id: "scribe" },
      evidenceIds: ["arrival:trusted-chat:trusted-message"],
      batchId: "scribe-batch:trusted",
    });
    expect(() =>
      tool.run({
        input: {
          ...input,
          evidenceIds: ["arrival:invented"],
        },
      } as never),
    ).toThrow(/trusted Scribe Batch/u);
    store.close();
  });
});
