import { defineWorkflow } from "@flue/runtime";
import * as v from "valibot";

import scribe from "@ambient-agent/agents/scribe/agent.ts";
import { dispatchScribeAttempt } from "@ambient-agent/agents/scribe/coalescer.ts";
import { drainScribeInbox } from "@ambient-agent/agents/scribe/durable-clock.ts";
import { scribeObservations, scribeOffers } from "@ambient-agent/agents/scribe/input.ts";
import { createHistoricalReplayStore } from "@ambient-agent/engine/intake/historical-replay.ts";
import { createScribeInbox } from "@ambient-agent/engine/scribe/inbox.ts";
import { createBrainInbox } from "@ambient-agent/engine/brain/inbox.ts";
import { wakeBrain } from "@ambient-agent/agents/brain/dispatch.ts";
import { getManagedRuntimeDependencies } from "@ambient-agent/installation/runtime-dependencies.ts";

const input = v.object({});
const output = v.object({
  outcome: v.picklist(["live", "failed"]),
  surfacesProcessed: v.number(),
  batchesProcessed: v.number(),
  eventsProcessed: v.number(),
  errorCode: v.optional(v.string()),
});

const run = async ({
  log,
}: {
  input: v.InferOutput<typeof input>;
  log: {
    info(message: string, attributes?: object): void;
    warn(message: string, attributes?: object): void;
    error(message: string, attributes?: object): void;
  };
}) => {
  const dependencies = getManagedRuntimeDependencies();
  const store = createHistoricalReplayStore(dependencies.paths.applicationDatabase);
  const scribeInbox = createScribeInbox(dependencies.paths.applicationDatabase);
  const brainInbox = createBrainInbox(dependencies.paths.applicationDatabase, {
    providerChatIdForSurface: () => undefined,
  });
  let batchesProcessed = 0;
  let eventsProcessed = 0;
  try {
    store.captureSnapshots();
    const surfacesProcessed = store.states().filter(({ mode }) => mode === "catching_up").length;
    log.info("historical_replay.started", { surfacesProcessed });
    for (;;) {
      const batch = store.nextBatch();
      if (batch === undefined) {
        if (store.advance() > 0) continue;
        log.info("historical_replay.live", { surfacesProcessed, batchesProcessed, eventsProcessed });
        return { outcome: "live" as const, surfacesProcessed, batchesProcessed, eventsProcessed };
      }
      if (batch.inputs.length === 0) {
        store.checkpoint(batch);
        log.info("historical_replay.batch.skipped", {
          archiveEventCount: batch.archiveEventCount,
          receiptCount: batch.receiptCount,
        });
        continue;
      }
      const observations = scribeObservations(batch.inputs.flatMap(scribeOffers), "historical_replay");
      scribeInbox.admit(observations);
      log.info("historical_replay.wave.started", {
        batch: batchesProcessed + 1,
        archiveEventCount: batch.archiveEventCount,
        scribeEventCount: batch.archiveEventCount - batch.receiptCount,
        surfaceCount: new Set(batch.inputs.map(({ chatId }) => chatId)).size,
      });
      try {
        const deltaIds: string[] = [];
        const receipt = await drainScribeInbox(scribeInbox, dispatchScribeAttempt, {
          onProposalDelta: async (draft) => {
            const delta = brainInbox.admitKnowledgeDelta(draft);
            deltaIds.push(delta.id);
            await wakeBrain(brainInbox);
          },
        });
        if (!scribeInbox.isEvidenceComplete(observations.map(({ evidenceId }) => evidenceId))) {
          throw new Error("Historical Replay evidence did not reach a completed Scribe Batch.");
        }
        while (!brainInbox.knowledgeCaughtUp(deltaIds)) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        store.checkpoint(batch);
        batchesProcessed += receipt.batchIds.length;
        eventsProcessed += batch.archiveEventCount - batch.receiptCount;
        log.info("historical_replay.wave.completed", {
          batchIds: receipt.batchIds,
          batchesProcessed,
          eventsProcessed,
        });
      } catch (cause) {
        store.fail("scribe_prompt_failed");
        log.error("historical_replay.failed", {
          attempts: 3,
          errorCode: "scribe_prompt_failed",
          cause: String(cause),
        });
        return {
          outcome: "failed" as const,
          surfacesProcessed,
          batchesProcessed,
          eventsProcessed,
          errorCode: "scribe_prompt_failed",
        };
      }
    }
  } finally {
    brainInbox.close();
    scribeInbox.close();
    store.close();
  }
};

export default defineWorkflow({ agent: scribe, input, output, run });
