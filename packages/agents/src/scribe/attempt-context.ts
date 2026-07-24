import type { GraphAttestationContext } from "@ambient-agent/engine/graph/store.ts";

const contexts = new Map<string, GraphAttestationContext>();

/**
 * The trusted Attestation context for a live in-process attempt, or `undefined` when there is
 * none. A miss means this attempt is an orphaned durable-submission recovery on a fresh process:
 * the in-memory context is gone, and the application-owned ScribeInbox already re-drives the same
 * Batch under a fresh attempt. The caller settles such a recovery as a no-op rather than throwing,
 * which previously left the submission unsettled and re-recovering on every boot (#330).
 */
export const scribeAttemptContext = (attemptId: string): GraphAttestationContext | undefined =>
  contexts.get(attemptId);

export const withScribeAttemptContext = async <T>(
  attemptId: string,
  context: GraphAttestationContext,
  run: () => Promise<T>,
): Promise<T> => {
  if (contexts.has(attemptId)) throw new Error(`Scribe attempt ${attemptId} is already active.`);
  contexts.set(attemptId, context);
  try {
    return await run();
  } finally {
    contexts.delete(attemptId);
  }
};
