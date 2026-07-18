import { getRun, instrument, type RunRecord } from "@flue/runtime";

import type { SpecialistMilestoneInput, SpecialistResultInput } from "@ambient-agent/engine/inputs.ts";
import type { RunLedger } from "./ledger.ts";
import { getDelegationRuntime, type DispatchSpecialist } from "./runtime.ts";

/**
 * The ADR 0001 delivery bridge: ONE generic `instrument()` interceptor wraps every
 * workflow run and, only AFTER the run is Durably Terminal, delivers its result to the
 * launching chat's Speaker as a `specialist.result` input.
 *
 * Why the interceptor and not self-dispatch from inside `run()`: Flue persists
 * `run_end` (via `endRun`) inside the intercepted body, so by the time `next()`
 * resolves the durable record is terminal — reading `getRun()` here reflects it. A
 * Specialist self-dispatching from inside `run()` would fire BEFORE `run_end`
 * persisted, telling the chat "completed" about a run recovery still shows `active`.
 * The gate is the explicit `status !== "active"` check below.
 */
export interface DeliveryDeps {
  readonly ledger: RunLedger;
  readonly dispatch: DispatchSpecialist;
  readonly getRun: (runId: string) => Promise<RunRecord | null>;
}

const buildResultEnvelope = (runId: string, chatId: string, run: RunRecord): SpecialistResultInput => {
  // The job input (validated at launch) carries the pushed §5 digest; ride it flat on the
  // envelope. The funnel (`dispatchSpeaker`) refreshes it with a live digest on delivery.
  const jobInput = (run.input ?? {}) as { graphContext?: SpecialistResultInput["graphContext"] };
  return {
    type: "specialist.result",
    chatId,
    runId,
    // ponytail: an errored (thrown) run has no `result` and still delivers status "ok" —
    // the Specialist contract (§8) returns business failures as a terminal `result`
    // (e.g. Coder `outcome:"blocked"`), never by throwing, so this is the crash edge only.
    status: "ok",
    ...(run.result === undefined || run.result === null ? {} : { result: run.result }),
    ...(jobInput.graphContext === undefined ? {} : { graphContext: jobInput.graphContext }),
  };
};

/**
 * Deliver one run's terminal result, if it is ours and Durably Terminal. Settles the
 * ledger entry BEFORE dispatch: a completed run must never re-fire as `interrupted` on
 * the next boot, and a chat missing one best-effort notification is the lesser fault.
 */
export const deliverTerminalResult = async (runId: string, deps: DeliveryDeps): Promise<void> => {
  const launch = deps.ledger.get(runId);
  if (launch === undefined || launch.settledAt !== undefined) return; // not a Specialist launch, or already delivered
  const run = await deps.getRun(runId);
  if (run === null || run.status === "active") return; // not Durably Terminal — the boot sweep catches a crash here
  deps.ledger.settle(runId, new Date().toISOString());
  if (launch.chatId === undefined) return; // no return address (§8): settled; its work rests in the run record
  await deps.dispatch({ id: launch.chatId, input: buildResultEnvelope(runId, launch.chatId, run) });
};

/**
 * Boot reconciliation (§8 Failure, the `operation-store.ts` sweep). Node has no
 * automatic workflow recovery, so a run interrupted by a crash stays `active` and the
 * bridge never fires. On startup every unsettled launch becomes a `specialist.result`
 * with `status:"interrupted"` and NO payload, so the Speaker can tell the thread and
 * offer relaunch. Runs before any new launch, so "unsettled" == "recorded before this boot".
 */
export const sweepUnsettledLaunches = async (
  deps: { readonly ledger: RunLedger; readonly dispatch: DispatchSpecialist },
  now: () => string = () => new Date().toISOString(),
): Promise<void> => {
  for (const launch of deps.ledger.unsettled()) {
    deps.ledger.settle(launch.runId, now());
    if (launch.chatId === undefined) continue;
    const input: SpecialistResultInput = {
      type: "specialist.result",
      chatId: launch.chatId,
      runId: launch.runId,
      status: "interrupted",
    };
    await deps.dispatch({ id: launch.chatId, input }).catch((cause) => {
      console.error("[delegation] interrupted-sweep dispatch failed", launch.runId, cause);
    });
  }
};

/**
 * Emit a milestone (§8 Progress) — the rare, domain-significant progress a workflow
 * interrupts the thread with, over the same delivery seam as `specialist.result`.
 */
export const dispatchSpecialistMilestone = async (input: {
  readonly chatId: string;
  readonly runId: string;
  readonly milestone?: unknown;
  readonly graphContext?: SpecialistMilestoneInput["graphContext"];
}): Promise<void> => {
  const { dispatch } = getDelegationRuntime();
  await dispatch({ id: input.chatId, input: { type: "specialist.milestone", ...input } });
};

let installed: (() => Promise<void>) | undefined;

/**
 * Register the bridge on the ambient runtime. Idempotent within a process (one
 * interceptor, never stacked across repeated composition), returning the
 * `instrument()` disposer.
 */
export const installDelegationBridge = (): (() => Promise<void>) => {
  if (installed !== undefined) return installed;
  installed = instrument({
    observe: () => {},
    interceptor: async (operation, _ctx, next) => {
      const result = await next();
      if (operation.type === "workflow") {
        const { ledger, dispatch } = getDelegationRuntime();
        // Detached: run finalization must not wait on the Speaker turn the result triggers.
        void deliverTerminalResult(operation.runId, { ledger, dispatch, getRun }).catch((cause) => {
          console.error("[delegation] result delivery failed", operation.runId, cause);
        });
      }
      return result;
    },
    dispose: () => {},
  });
  return installed;
};
