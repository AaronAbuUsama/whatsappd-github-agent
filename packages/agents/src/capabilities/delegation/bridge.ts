import { getRun, instrument, type FlueExecutionOperation, type RunRecord } from "@flue/runtime";

import type { BrainInbox, SpecialistLaunch } from "@ambient-agent/engine/brain/inbox.ts";
import { getDelegationRuntime } from "./runtime.ts";

interface ResultDeps {
  readonly inbox: BrainInbox;
  readonly wake: () => Promise<unknown>;
  readonly getRun: (runId: string) => Promise<RunRecord | null>;
}

const admitRunResult = async (
  launch: SpecialistLaunch,
  run: RunRecord | null,
  deps: Pick<ResultDeps, "inbox" | "wake">,
): Promise<void> => {
  if (deps.inbox.specialistResultForWork(launch.id) !== undefined) return;
  deps.inbox.admitSpecialistResult({
    workId: launch.id,
    runId: launch.runId!,
    status: run?.status === "completed" ? "ok" : "interrupted",
    ...(run?.status === "completed" && run.result !== undefined && run.result !== null ? { result: run.result } : {}),
  });
  await deps.wake();
};

/** Admit a terminal Flue run into the durable global Brain frontier exactly once. */
export const deliverTerminalResult = async (runId: string, deps: ResultDeps): Promise<void> => {
  const launch = deps.inbox.specialistLaunchByRunId(runId);
  if (launch === undefined || launch.runId === undefined) return;
  const run = await deps.getRun(runId);
  if (run === null || run.status === "active") return;
  await admitRunResult(launch, run, deps);
};

/**
 * Boot reconciliation. Accepted launches without a durable result cannot still be
 * executing in the prior Node process: terminal records retain their result; active or
 * missing records become an explicit interrupted input. Admission precedes the wake and
 * is retry-idempotent, so a crash at either line loses nothing and duplicates nothing.
 */
export const reconcileSpecialistWorkAtBoot = async (deps: ResultDeps): Promise<void> => {
  for (const launch of deps.inbox.acceptedSpecialistLaunchesWithoutResult()) {
    const run = await deps.getRun(launch.runId!);
    await admitRunResult(launch, run?.status === "active" ? null : run, deps);
  }
};

export const deliverAfterExecution = async <T>(
  operation: FlueExecutionOperation,
  next: () => Promise<T>,
): Promise<T> => {
  try {
    return await next();
  } finally {
    if (operation.type === "workflow") {
      const runtime = getDelegationRuntime();
      void deliverTerminalResult(operation.runId, { ...runtime, getRun }).catch((cause) => {
        console.error("[delegation] Brain result admission failed", operation.runId, cause);
      });
    }
  }
};

let installed: (() => Promise<void>) | undefined;

export const installDelegationBridge = (): (() => Promise<void>) => {
  if (installed !== undefined) return installed;
  installed = instrument({
    observe: () => {},
    interceptor: (operation, _ctx, next) => deliverAfterExecution(operation, next),
    dispose: () => {},
  });
  return installed;
};
