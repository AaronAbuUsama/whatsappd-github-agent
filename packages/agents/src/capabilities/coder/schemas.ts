import * as v from "valibot";

import { graphDigestSchema } from "@ambient-agent/engine/graph/digest.ts";

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));

/**
 * The Coder job input (MEMORY-STATE-SPEC §8) — issue-only for v1. This IS the
 * `start_coder_job` launch tool's input (one source of truth, #157): the launch tool
 * re-exposes it unchanged and bakes `chatId` in as the return address, so the Speaker
 * supplies only the work reference and its extra framing. The issue body itself is
 * fetched deterministically in `run()`, never passed by the model.
 */
export const coderJobInputSchema = v.object({
  repository: nonEmpty, // "owner/repo" → parseGitHubRepository in run()
  issue: v.pipe(v.number(), v.integer(), v.minValue(1)),
  instructions: v.optional(nonEmpty),
  chatId: v.optional(nonEmpty),
  graphContext: v.optional(graphDigestSchema),
});

export type CoderJobInput = v.InferOutput<typeof coderJobInputSchema>;

/**
 * The Coder-specific payload nested inside the `specialist.result` envelope (§8). The
 * transport `status:"ok"|"interrupted"` is the delegation bridge's, NOT here: a business
 * failure returns as a terminal `result`, never by throwing. `coderOutcome` (the light
 * after-check) only ever produces `opened-pr` (fresh PR), `updated-pr` (relaunch reused
 * the open PR), or `blocked` (no PR opened — no committable change or the model gave up);
 * `no-op`/`failed` are kept in the picklist as headroom for #173's verifier but are
 * currently unreachable. `summary` is one sentence the Speaker relays.
 */
export const coderResultSchema = v.object({
  outcome: v.picklist(["opened-pr", "updated-pr", "no-op", "blocked", "failed"]),
  prUrl: v.optional(v.string()),
  prNumber: v.optional(v.number()),
  branch: v.optional(v.string()),
  summary: v.string(),
  testsPassed: v.optional(v.boolean()),
});

export type CoderResult = v.InferOutput<typeof coderResultSchema>;
