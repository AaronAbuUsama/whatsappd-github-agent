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
 * Digest seeds for a Specialist job (§5 D6): the job's repo + issue as GitHub natural
 * keys (mirroring `speakerDigestSeeds`' `owner/repo` and `owner/repo#N` conventions),
 * plus the launching thread. `graph_identities` resolves each to its entity.
 */
export const specialistJobSeeds = (chatId: string | undefined, repository: string, issue: number): DigestSeeds => ({
  ...(chatId === undefined ? {} : { chatId }),
  identities: [
    { platform: "github", externalId: repository },
    { platform: "github", externalId: `${repository}#${issue}` },
  ],
});

/**
 * The Specialist launch hook (§5 D6): build the pushed digest from a job's seeds, or
 * `undefined` when no graph is wired or the neighbourhood is empty — so the launch tool
 * is a no-op without a store (existing delegation tests stay green) and never ships an
 * empty digest.
 */
export const buildJobGraphContext = (seeds: DigestSeeds, options?: DigestOptions): GraphDigest | undefined => {
  if (tryGetGraphStore() === undefined) return undefined;
  const digest = buildGraphDigest(seeds, options);
  return isEmptyDigest(digest) ? undefined : digest;
};

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
