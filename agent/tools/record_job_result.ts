import { defineTool } from "eve/tools";
import { z } from "zod";
import { actionLedger, recordJobResult, type LedgerAccess } from "../lib/action-ledger.ts";
import { GatewayStore } from "../lib/jobs.ts";

export interface RecordResultDependencies {
  readonly ledger: LedgerAccess;
  readonly openStore: () => Pick<GatewayStore, "close" | "getJob">;
  readonly now: () => Date;
}

const dependencies = (): RecordResultDependencies => ({
  ledger: actionLedger,
  openStore: () => new GatewayStore(),
  now: () => new Date(),
});

export const executeRecordJobResult = (
  jobId: string,
  voiceSessionId: string,
  deps: RecordResultDependencies = dependencies(),
): { readonly recorded: true; readonly jobId: string; readonly status: "completed" | "failed" } => {
  const store = deps.openStore();
  try {
    const job = store.getJob(jobId);
    if (job === undefined) throw new Error(`Unknown delegated job ${jobId}`);
    if (job.voiceSessionId !== voiceSessionId) throw new Error(`Delegated job ${jobId} does not belong to this voice session`);
    if (job.status !== "report_pending" && job.status !== "reporting") {
      throw new Error(`Delegated job ${jobId} is not ready to record (status=${job.status})`);
    }
    if (job.result === undefined && job.error === undefined) throw new Error(`Delegated job ${jobId} has no result or failure evidence`);
    deps.ledger.update((ledger) =>
      recordJobResult(ledger, { id: job.id, at: deps.now().toISOString(), result: job.result, error: job.error }),
    );
    return { recorded: true, jobId, status: job.result === undefined ? "failed" : "completed" };
  } finally {
    store.close();
  }
};

export default defineTool({
  description:
    "Record the trusted typed result or failure of a completed delegated job in this voice session's durable action ledger. " +
    "On every [worker result] or [worker FAILED] turn, call this exactly once before say.",
  inputSchema: z.object({ jobId: z.string().min(1) }),
  execute({ jobId }, ctx) {
    return executeRecordJobResult(jobId, ctx.session.id);
  },
});
