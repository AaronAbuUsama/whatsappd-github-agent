import {
  defineTool,
  getRun,
  invoke,
  type ActionInputSchema,
  type ToolDefinition,
  type WorkflowDefinition,
} from "@flue/runtime";
import * as v from "valibot";

import { getDelegationRuntime } from "./runtime.ts";
import { buildJobGraphContext, specialistJobSeeds } from "../graph/digest.ts";

/**
 * One Specialist as the delegation transport sees it. `input` IS the Specialist's own
 * workflow input schema (one source of truth, §8): the launch tool re-exposes it
 * unchanged and bakes the return address in, so the model supplies only the work
 * reference and instructions. `description` is the tool's agent-neutral, eval-gated
 * prose (#137) — supplied by the Specialist's own capability (the Coder is #158).
 */
export interface SpecialistSpec<TInput extends ActionInputSchema = ActionInputSchema> {
  /** Specialist identifier recorded in the ledger and shown by `check_jobs`, e.g. "coder". */
  readonly name: string;
  /** Launch tool name mounted on the Speaker, e.g. "start_coder_job". */
  readonly toolName: string;
  readonly description: string;
  readonly input: TInput;
  readonly workflow: WorkflowDefinition;
}

const launchOutputSchema = v.object({ runId: v.string() });

/**
 * A chat-bound launch tool for one Specialist, mirroring `createIssueManagementTools()`
 * / `createWhatsAppParticipationTools(id)`. The handler admits the run without waiting
 * (`invoke` → `{runId}`), records the launch in the run ledger, and returns immediately
 * — the Speaker can say "kicked it off" from the tool result. The result comes back
 * later as a `specialist.result` input via the ADR 0001 bridge.
 */
export const createSpecialistLaunchTool = <TInput extends ActionInputSchema>(
  chatId: string,
  spec: SpecialistSpec<TInput>,
): ToolDefinition =>
  defineTool({
    name: spec.toolName,
    description: spec.description,
    input: spec.input,
    output: launchOutputSchema,
    run: async ({ input }) => {
      const { ledger } = getDelegationRuntime();
      // The bound chatId is the return address (§8); it wins over any value in `input`.
      const record = input as Record<string, unknown>;
      const jobInput: Record<string, unknown> = { ...record, chatId };
      // §5 D6: push the graph digest, seeded from the job's repo/issue + launching thread.
      // No-op without a graph store (existing delegation tests) or an empty neighbourhood.
      if (typeof record.repository === "string" && typeof record.issue === "number") {
        const graphContext = buildJobGraphContext(specialistJobSeeds(chatId, record.repository, record.issue));
        if (graphContext !== undefined) jobInput.graphContext = graphContext;
      }
      // Generic at the transport boundary: the concrete input/output typing is the
      // Specialist's own (its `input` schema gives the model-facing safety above).
      const { runId } = await invoke(spec.workflow, { input: jobInput } as never);
      ledger.record({ runId, chatId, workflow: spec.name, launchedAt: new Date().toISOString() });
      return { runId };
    },
  });

const jobStatusSchema = v.object({
  runId: v.string(),
  workflow: v.string(),
  launchedAt: v.string(),
  status: v.picklist(["active", "completed", "errored", "unknown"]),
  endedAt: v.optional(v.string()),
});

/**
 * The chat-bound inspection tool (§8 Progress) — the Speaker's memory of what it
 * launched, across restarts. Reads this chat's launches from the ledger and their live
 * status from the durable run record. An on-request pull; the terminal outcome still
 * arrives on its own via the bridge.
 */
export const createCheckJobsTool = (chatId: string): ToolDefinition =>
  defineTool({
    name: "check_jobs",
    description:
      "List the background jobs launched from this chat and each one's current run status (active, completed, " +
      "errored, or unknown). A pull-only status check; finished jobs also report back on their own.",
    input: v.object({ limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))) }),
    output: v.object({ jobs: v.array(jobStatusSchema) }),
    run: async ({ input }) => {
      const { ledger } = getDelegationRuntime();
      const launches = ledger.forChat(chatId, input.limit ?? 20);
      const jobs: v.InferOutput<typeof jobStatusSchema>[] = await Promise.all(
        launches.map(async (launch) => {
          const run = await getRun(launch.runId);
          return {
            runId: launch.runId,
            workflow: launch.workflow,
            launchedAt: launch.launchedAt,
            status: run?.status ?? "unknown",
            ...(run?.endedAt === undefined ? {} : { endedAt: run.endedAt }),
          };
        }),
      );
      return { jobs };
    },
  });

/**
 * The Speaker's delegation surface for a chat: one launch tool per configured Specialist
 * plus `check_jobs`. Specialists are supplied by their own capabilities (the Coder,
 * #158, supplies the first); with none configured this is just `check_jobs`.
 */
export const createDelegationTools = (
  chatId: string,
  specialists: readonly SpecialistSpec[] = [],
): ToolDefinition[] => [
  ...specialists.map((spec) => createSpecialistLaunchTool(chatId, spec)),
  createCheckJobsTool(chatId),
];
