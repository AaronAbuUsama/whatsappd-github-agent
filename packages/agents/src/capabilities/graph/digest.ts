import {
  composeWorkItems,
  computeGraphDigest,
  isEmptyDigest,
  type DigestOptions,
  type DigestSeeds,
  type DigestWorkItem,
  type GraphDigest,
} from "@ambient-agent/engine/graph/digest.ts";
import { speakerDigestSeeds, type SpeakerInput } from "@ambient-agent/engine/inputs.ts";
import { getGraphStore, tryGetGraphStore } from "./runtime.ts";
import { tryGetDelegationRuntime } from "../delegation/runtime.ts";

/**
 * Down-flow work state (S3): the active Bounded Workflows plus their latest streamed
 * Milestone, read from the Brain inbox. Empty when delegation is unwired or a read throws —
 * work-state can never fail a Speaker dispatch. Scoped to the dispatching Surface's chat, so
 * one chat's Speaker never sees another chat's work (a cross-surface leak, cf. #249).
 */
const activeDigestWorkItems = (input: SpeakerInput): DigestWorkItem[] => {
  const runtime = tryGetDelegationRuntime();
  if (runtime === undefined) return [];
  const currentChatId =
    input.type === "brain.directive"
      ? runtime.providerChatIdForSurface(input.directive.surfaceId)
      : input.chatId;
  if (currentChatId === undefined) return [];
  try {
    return runtime.inbox
      .activeWorkItems()
      .filter((item) => runtime.providerChatIdForSurface(item.sourceSurfaceId) === currentChatId)
      .map((item) => ({
        workId: item.workId,
        specialist: item.specialist,
        sourceSurfaceId: item.sourceSurfaceId,
        startedAt: item.startedAt,
        ...(item.latestMilestone === undefined
          ? {}
          : { latestMilestone: { note: item.latestMilestone.note, at: item.latestMilestone.at } }),
      }));
  } catch (cause) {
    console.error("[graph] active work-state read failed; digest omits work items", cause);
    return [];
  }
};

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
  // Best-effort push context (§5/§8): a graph read failure (SQLITE_BUSY, a corrupt row throwing
  // in decode) must never fail a Speaker dispatch. Fall back to the raw input.
  try {
    const base = computeGraphDigest(store, speakerDigestSeeds(input), options);
    // Compose active work state onto the graph projection — never replacing it (§5.4).
    const graphContext = composeWorkItems(base, activeDigestWorkItems(input));
    return isEmptyDigest(graphContext) ? input : { ...input, graphContext };
  } catch (cause) {
    console.error("[graph] digest enrichment failed; dispatching with un-enriched input", cause);
    return input;
  }
};

/** Scribe attempts always receive the current Projection explicitly, including an empty versioned Digest. */
export const attachCurrentGraphContext = (input: SpeakerInput, options?: DigestOptions): SpeakerInput => {
  const store = tryGetGraphStore();
  if (store === undefined) return input;
  return { ...input, graphContext: computeGraphDigest(store, speakerDigestSeeds(input), options) };
};
