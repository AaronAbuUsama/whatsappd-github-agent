import { randomUUID } from "node:crypto";
import { Effect, Semaphore } from "effect";

import type { ScribeBatch, ScribeInbox } from "@ambient-agent/engine/scribe/inbox.ts";
import type { DispatchScribeBatch } from "./coalescer.ts";
import type { ScribeBatchInput } from "./input.ts";
import { attachCurrentGraphContext } from "../capabilities/graph/digest.ts";
import { tryGetGraphStore } from "../capabilities/graph/runtime.ts";
import type { KnowledgeDeltaDraft } from "@ambient-agent/engine/brain/inbox.ts";

export interface ScribeDrainReceipt {
  readonly batchIds: readonly string[];
  readonly evidenceCount: number;
}

export interface ScribeDrainOptions {
  readonly onProposalDelta?: (draft: KnowledgeDeltaDraft) => void | Promise<void>;
}

const drains = Semaphore.makeUnsafe(1);

const inputFor = (batch: ScribeBatch): ScribeBatchInput => ({
  type: "scribe.batch",
  batchId: batch.id,
  evidenceIds: batch.evidenceIds,
  inputs: batch.inputs.map((input) => attachCurrentGraphContext(input)),
});

export const scribeProposalDelta = (batch: ScribeBatch): KnowledgeDeltaDraft | undefined => {
  const store = tryGetGraphStore();
  if (store === undefined) return undefined;
  const attestationIds = store
    .attestations()
    .filter(({ author, batchId }) => author.kind === "scribe" && batchId === batch.id)
    .map(({ id }) => id);
  if (attestationIds.length === 0) return undefined;
  return {
    scribeBatchId: batch.id,
    attestationIds,
    evidenceIds: batch.evidenceIds,
    projectionVersion: store.projectionVersion(),
  };
};

const attempt = async (
  inbox: ScribeInbox,
  batch: ScribeBatch,
  dispatch: DispatchScribeBatch,
  options: ScribeDrainOptions,
): Promise<void> => {
  let failure: unknown;
  for (let count = 1; count <= 3; count++) {
    const attemptId = `scribe-attempt:${randomUUID()}`;
    inbox.beginAttempt(batch.id, attemptId);
    try {
      await dispatch(attemptId, inputFor(batch));
      const delta = scribeProposalDelta(batch);
      if (delta !== undefined) await options.onProposalDelta?.(delta);
      inbox.completeAttempt(batch.id, attemptId);
      return;
    } catch (cause) {
      failure = cause;
      inbox.failAttempt(batch.id, attemptId, cause instanceof Error ? cause.message : String(cause));
    }
  }
  throw failure;
};

const drain = async (
  inbox: ScribeInbox,
  dispatch: DispatchScribeBatch,
  options: ScribeDrainOptions,
): Promise<ScribeDrainReceipt> => {
  const batchIds: string[] = [];
  let evidenceCount = 0;
  for (;;) {
    const wave = inbox.claimWave(4, 50);
    if (wave.length === 0) return { batchIds, evidenceCount };
    const settled = await Promise.allSettled(wave.map((batch) => attempt(inbox, batch, dispatch, options)));
    batchIds.push(...wave.map(({ id }) => id));
    evidenceCount += wave.reduce((total, batch) => total + batch.evidenceIds.length, 0);
    const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  }
};

/** One process-wide drain gate shared by live offers and Historical Replay. */
export const drainScribeInbox = (
  inbox: ScribeInbox,
  dispatch: DispatchScribeBatch,
  options: ScribeDrainOptions = {},
): Promise<ScribeDrainReceipt> =>
  Effect.runPromise(
    drains.withPermits(1)(
      Effect.tryPromise({
        try: () => drain(inbox, dispatch, options),
        catch: (cause) => cause,
      }),
    ),
  );
