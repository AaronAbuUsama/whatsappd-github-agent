import { getRun, listRuns, type RunRecord, type WorkflowDefinition } from "@flue/runtime";

import type { BrainInbox, SpecialistLaunch } from "@ambient-agent/engine/brain/inbox.ts";
import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";

export interface DelegationRuntime {
  readonly inbox: BrainInbox;
  readonly wake: () => Promise<unknown>;
  readonly providerChatIdForSurface: (surfaceId: string) => string | undefined;
  readonly findAdmittedRun?: (launch: SpecialistLaunch) => Promise<RunRecord | undefined>;
  readonly admitWorkflow?: (
    workflow: WorkflowDefinition,
    input: Readonly<Record<string, unknown>>,
  ) => Promise<{ readonly runId: string }>;
}

const runtimeSlot = createFlueGlobal<DelegationRuntime>("delegation-runtime", "Delegation runtime is not configured");

export const configureDelegationRuntime = (runtime: DelegationRuntime): void => runtimeSlot.set(runtime);
export const getDelegationRuntime = (): DelegationRuntime => runtimeSlot.get();
/** Non-throwing read for the digest funnel and the Speaker pull tool — undefined when delegation is unwired. */
export const tryGetDelegationRuntime = (): DelegationRuntime | undefined => runtimeSlot.peek();

/**
 * Reconcile the only ambiguous boundary: Flue may have durably admitted a run before
 * the application persisted its generated runId. The stable Brain work id rides in the
 * snapshotted workflow input, so a retry finds that run before it considers invoking.
 */
export const findAdmittedSpecialistRun = async (launch: SpecialistLaunch): Promise<RunRecord | undefined> => {
  let cursor: string | undefined;
  do {
    const page = await listRuns({ workflowName: launch.specialist, limit: 1000, ...(cursor === undefined ? {} : { cursor }) });
    for (const pointer of page.runs) {
      if (Date.parse(pointer.startedAt) < Date.parse(launch.requestedAt)) return undefined;
      const run = await getRun(pointer.runId);
      if (
        run !== null
        && typeof run.input === "object"
        && run.input !== null
        && (run.input as { brainWorkId?: unknown }).brainWorkId === launch.id
      ) return run;
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return undefined;
};
