import { dispatch, type DispatchReceipt } from "@flue/runtime";
import { Effect, Semaphore } from "effect";

import type { BrainBatch, BrainInbox } from "@ambient-agent/engine/brain/inbox.ts";
import brain from "./agent.ts";

export interface BrainDispatchRequest {
  readonly id: "global";
  readonly input: {
    readonly type: "brain.batch";
    readonly batch: Omit<BrainBatch, "dispatch">;
  };
}

export type DispatchBrain = (request: BrainDispatchRequest) => Promise<DispatchReceipt>;

export const dispatchBrain: DispatchBrain = (request) => dispatch(brain, request);

const wakes = Semaphore.makeUnsafe(1);

export const wakeBrain = async (
  inbox: BrainInbox,
  deliver: DispatchBrain = dispatchBrain,
): Promise<BrainBatch | undefined> =>
  Effect.runPromise(
    wakes.withPermits(1)(
      Effect.tryPromise({
        try: async () => {
          const batch = inbox.claimBatch();
          if (batch === undefined || batch.dispatch !== undefined) return batch;
          const receipt = await deliver({
            id: "global",
            input: {
              type: "brain.batch",
              batch: {
                id: batch.id,
                createdAt: batch.createdAt,
                intents: batch.intents,
                knowledgeDeltas: batch.knowledgeDeltas,
                specialistResults: batch.specialistResults,
                githubEvents: batch.githubEvents,
              },
            },
          });
          return inbox.markBatchDispatched(batch.id, receipt);
        },
        catch: (cause) => cause,
      }),
    ),
  );
