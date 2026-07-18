/**
 * Deterministic extraction battery for the Scribe (#155, MEMORY-STATE-SPEC §4/§9).
 *
 * These assert the ratified policy on the Scribe's tool calls — liberal `mentions`
 * vs conservative `discusses`, the commitment θ floor + force line, the ownerless-
 * promise reject, and anchored auto-close.
 *
 * GATED: running these green requires the eval fixture (`tests/fixtures/speaker`) to
 * serve a discoverable `scribe` agent with faux-model scenarios that emit the tool
 * calls below, plus a graph store behind `getGraphStore()`. That fixture wiring is
 * deferred (eval-harness work, out of the typecheck+test gate); until it lands,
 * `SCRIBE_FIXTURE_READY` is unset and the battery skips instead of failing CI.
 */
import { expect } from "vitest";
import { describeEval, toolCalls, type ToolCall } from "vitest-evals";

import { createFlueAgentHarness } from "../../../../../test-support/src/evals/harness.ts";

const harness = createFlueAgentHarness({ agentName: "scribe" });

/** One batched extraction input carrying a single utterance, keyed by scenario. */
const batch = (scenario: string): string => `Scribe extraction batch:\n${scenario}`;

const entityOf = (call: ToolCall): { type?: string; confidence?: number; status?: string } =>
  (call.arguments?.entity ?? {}) as { type?: string; confidence?: number; status?: string };
const relationOf = (call: ToolCall): string | undefined =>
  (call.arguments?.edge as { relation?: string } | undefined)?.relation;

const recordedCommitments = (calls: readonly ToolCall[]): ToolCall[] =>
  calls.filter((call) => call.name === "record_entity" && entityOf(call).type === "commitment");
const hasRelation = (calls: readonly ToolCall[], relation: string): boolean =>
  calls.some((call) => call.name === "record_relation" && relationOf(call) === relation);

describeEval(
  "Scribe extraction deterministic contract",
  {
    harness,
    skipIf: () => process.env.SCRIBE_FIXTURE_READY !== "true" || process.env.SPEAKER_EVAL_LIVE_MODEL === "true",
  },
  (it) => {
    it("records mentions liberally but withholds a conservative discusses", async ({ run }) => {
      const calls = toolCalls(await run({ message: batch("MENTION_WITHOUT_DISCUSSION") }));
      expect(hasRelation(calls, "mentions")).toBe(true);
      expect(hasRelation(calls, "discusses")).toBe(false);
    });

    it("writes a high-confidence commitment on a force-line promise (will / I'll / by X)", async ({ run }) => {
      const commitments = recordedCommitments(toolCalls(await run({ message: batch("PROMISE_FORCE_LINE") })));
      expect(commitments).toHaveLength(1);
      expect(entityOf(commitments[0]!).confidence ?? 0).toBeGreaterThanOrEqual(0.5);
    });

    it("writes a below-floor commitment on a hedged promise (should / could / ought)", async ({ run }) => {
      const commitments = recordedCommitments(toolCalls(await run({ message: batch("PROMISE_HEDGED") })));
      expect(commitments).toHaveLength(1);
      expect(entityOf(commitments[0]!).confidence ?? 1).toBeLessThan(0.5);
    });

    it("never writes an ownerless promise (no resolvable made_by)", async ({ run }) => {
      const commitments = recordedCommitments(toolCalls(await run({ message: batch("PROMISE_OWNERLESS") })));
      expect(commitments).toHaveLength(0);
    });

    it("auto-closes a GitHub-anchored commitment when its issue/PR resolves", async ({ run }) => {
      const calls = toolCalls(await run({ message: batch("ANCHORED_COMMITMENT_RESOLVED") }));
      expect(hasRelation(calls, "resolves")).toBe(true);
      expect(recordedCommitments(calls).some((call) => entityOf(call).status === "done")).toBe(true);
    });
  },
);
