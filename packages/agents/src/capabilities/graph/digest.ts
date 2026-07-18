import {
  computeGraphDigest,
  isEmptyDigest,
  type DigestOptions,
  type DigestSeeds,
  type GraphDigest,
} from "@ambient-agent/engine/graph/digest.ts";
import { speakerDigestSeeds, type SpeakerInput } from "@ambient-agent/engine/inputs.ts";
import { getGraphStore, tryGetGraphStore } from "./runtime.ts";

export type { DigestSeeds, GraphDigest } from "@ambient-agent/engine/graph/digest.ts";

/**
 * The one digest builder (§5 D6) — three consumers, one implementation: the Speaker
 * funnel (`attachGraphContext`), and the Coder/Reviewer/Planner Specialists, which
 * seed from their job's issue/PR/repo and pass the result as `graphContext`. Reads
 * the live `getGraphStore()`; no cache.
 */
export const buildGraphDigest = (seeds: DigestSeeds, options?: DigestOptions): GraphDigest =>
  computeGraphDigest(getGraphStore(), seeds, options);

/**
 * The funnel hook: compute the digest for an input and ride it on the input as a flat
 * `graphContext` field. A no-op when no graph is configured or the neighbourhood is
 * empty, so it never spends a transcript turn on nothing.
 */
export const attachGraphContext = (input: SpeakerInput, options?: DigestOptions): SpeakerInput => {
  const store = tryGetGraphStore();
  if (store === undefined) return input;
  const graphContext = computeGraphDigest(store, speakerDigestSeeds(input), options);
  return isEmptyDigest(graphContext) ? input : { ...input, graphContext };
};
