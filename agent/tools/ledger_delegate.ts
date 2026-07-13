import { defineDynamic, defineTool } from "eve/tools";
import type { ToolContext } from "eve/tools";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  actionLedger,
  findDuplicateJob,
  findLedgerItem,
  recordStartedJob,
  referencedNumber,
  referencedKind,
  type LedgerAccess,
} from "../lib/action-ledger.ts";
import { GatewayStore } from "../lib/jobs.ts";

export interface DelegateDependencies {
  readonly ledger: LedgerAccess;
  readonly openStore: () => Pick<GatewayStore, "cancelPending" | "close" | "enqueue">;
  readonly newJobId: (ctx: ToolContext) => string;
  readonly now: () => Date;
}

const dependencies = (): DelegateDependencies => ({
  ledger: actionLedger,
  openStore: () => new GatewayStore(),
  // Eve preserves callId across durable tool replay. A stable queue id makes
  // the SQLite side effect idempotent if a process dies after enqueue but
  // before the workflow checkpoint commits the defineState update.
  newJobId: (ctx) => createHash("sha256").update(`${ctx.session.id}:${ctx.callId}`).digest("hex"),
  now: () => new Date(),
});

const constrainExistingTarget = (task: string, ledger: LedgerAccess): string => {
  const number = referencedNumber(task);
  if (number === undefined) return task;
  const item = findLedgerItem(ledger.get(), number, referencedKind(task));
  if (item === undefined) return task;
  return (
    `Ledger-verified existing ${item.kind} #${number}. Act on that exact item; do not create a replacement. ` +
    `Prefer the smallest available update operation (get/comment/label/close as requested).\n\n${task}`
  );
};

export const executeLedgerDelegate = (
  input: { readonly kind: "github"; readonly task: string },
  ctx: ToolContext,
  deps: DelegateDependencies = dependencies(),
) => {
  const duplicate = findDuplicateJob(deps.ledger.get(), input.task);
  if (duplicate !== undefined) {
    return {
      status: "already_handled" as const,
      jobId: duplicate.id,
      ...(duplicate.number === undefined ? {} : { number: duplicate.number }),
      ...(duplicate.url === undefined ? {} : { url: duplicate.url }),
      summary: duplicate.summary,
    };
  }

  const store = deps.openStore();
  const jobId = deps.newJobId(ctx);
  try {
    const task = constrainExistingTarget(input.task, deps.ledger);
    // Queue first. If the process dies immediately afterward, durable tool
    // replay uses the same call-derived id, enqueue is an idempotent no-op, and
    // the missing defineState entry is filled below. The reverse ordering can
    // strand a phantom "started" entry that suppresses the replay forever.
    store.enqueue({ id: jobId, voiceSessionId: ctx.session.id, kind: input.kind, task });
    try {
      deps.ledger.update((ledger) => recordStartedJob(ledger, { id: jobId, task: input.task, at: deps.now().toISOString() }));
    } catch (cause) {
      // A synchronous state failure occurs in the same tool tick, before the
      // runner can claim this row. Delete only pending work; never delete a job
      // that another actor has already started.
      store.cancelPending(jobId);
      throw cause;
    }
    return { jobId, status: "started" as const };
  } finally {
    store.close();
  }
};

/**
 * Additional dynamic capability: Eve explicitly allows a dynamic tool to
 * override a same-named authored tool. The frozen #8 delegate remains intact.
 */
export default defineDynamic({
  events: {
    "turn.started": () => ({
      delegate: defineTool({
        description:
          "Start a non-blocking GitHub task unless this voice session's durable ledger shows matching work already started or completed. " +
          "A known #number is constrained to that exact item. After started, say 'on it'; after already_handled, reference the recorded result.",
        inputSchema: z.object({
          kind: z.literal("github"),
          task: z.string().min(1).describe("Everything the GitHub worker needs; it cannot see this chat."),
        }),
        execute({ kind, task }, ctx) {
          return executeLedgerDelegate({ kind, task }, ctx);
        },
      }),
    }),
  },
});
