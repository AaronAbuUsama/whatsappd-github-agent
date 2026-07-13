import { defineDynamic, defineTool } from "eve/tools";
import type { ToolContext } from "eve/tools";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  actionLedger,
  findDuplicateJob,
  findLedgerItem,
  removeJob,
  recordStartedJob,
  referencedNumber,
  referencedKind,
  type LedgerAccess,
} from "../lib/action-ledger.ts";
import { GatewayStore } from "../lib/jobs.ts";

export interface DelegateDependencies {
  readonly ledger: LedgerAccess;
  readonly openStore: () => Pick<GatewayStore, "close" | "enqueue">;
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
    deps.ledger.update((ledger) => recordStartedJob(ledger, { id: jobId, task: input.task, at: deps.now().toISOString() }));
    try {
      store.enqueue({ id: jobId, voiceSessionId: ctx.session.id, kind: input.kind, task });
    } catch (cause) {
      // Never leave a phantom dedup entry when durable queue insertion fails.
      deps.ledger.update((ledger) => removeJob(ledger, jobId));
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
