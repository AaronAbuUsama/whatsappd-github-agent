import { defineTool, invoke, type ActionInputSchema, type ToolDefinition, type WorkflowDefinition } from "@flue/runtime";
import * as v from "valibot";

import { buildJobGraphContext, specialistJobSeeds } from "../graph/digest.ts";
import { findAdmittedSpecialistRun, getDelegationRuntime } from "./runtime.ts";
import type { SpecialistLaunch } from "@ambient-agent/engine/brain/inbox.ts";

export interface SpecialistSpec<TInput extends ActionInputSchema = ActionInputSchema> {
  readonly name: string;
  readonly toolName: string;
  readonly description: string;
  readonly input: TInput;
  readonly workflow: WorkflowDefinition;
  // Throws before any launch is reserved when this Specialist is mounted but unprovisioned, so the
  // Brain hears 'unprovisioned' as a tool error instead of admitting a Flue run doomed to error at
  // getRuntime(). Absent for Specialists that fail boot loudly (Coder) and are always provisioned.
  readonly ensureAvailable?: () => void;
}

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const launchOutputSchema = v.object({ workId: nonEmptyString, runId: nonEmptyString });

const acceptSpecialistLaunch = async <TInput extends ActionInputSchema>(
  launch: SpecialistLaunch,
  spec: SpecialistSpec<TInput>,
): Promise<{ workId: string; runId: string }> => {
  const runtime = getDelegationRuntime();
  const specialistInput = launch.input;
  if (launch.runId !== undefined) return { workId: launch.id, runId: launch.runId };

  const recovered = await (runtime.findAdmittedRun ?? findAdmittedSpecialistRun)(launch);
  let runId = recovered?.runId;
  if (runId === undefined) {
    const jobInput: Record<string, unknown> = {
      ...specialistInput,
      brainWorkId: launch.id,
      sourceSurfaceId: launch.sourceSurfaceId,
    };
    const sourceChatId = runtime.providerChatIdForSurface(launch.sourceSurfaceId);
    if (
      sourceChatId !== undefined
      && typeof specialistInput.repository === "string"
      && typeof specialistInput.issue === "number"
    ) {
      const graphContext = buildJobGraphContext(
        specialistJobSeeds(sourceChatId, specialistInput.repository, specialistInput.issue),
      );
      if (graphContext !== undefined) jobInput.graphContext = graphContext;
    }
    runId = runtime.admitWorkflow === undefined
      ? (await invoke(spec.workflow, { input: jobInput } as never)).runId
      : (await runtime.admitWorkflow(spec.workflow, jobInput)).runId;
  }
  const accepted = runtime.inbox.markSpecialistLaunchAccepted(launch.id, runId);
  return { workId: accepted.id, runId: accepted.runId! };
};

export const launchSpecialistWork = async <TInput extends ActionInputSchema>(
  input: Record<string, unknown> & { batchId: string; sourceSurfaceId: string; evidenceIds?: readonly string[] },
  spec: SpecialistSpec<TInput>,
): Promise<{ workId: string; runId: string }> => {
  spec.ensureAvailable?.();
  const runtime = getDelegationRuntime();
  // `evidenceIds` is launch provenance, not workflow input — a GitHub-event-triggered launch (#211)
  // cites the triggering event's own id (no source Intent). Held out of `specialistInput` so it never
  // reaches the Specialist's workflow. Absent → the inbox derives provenance from the Batch's Intents.
  const { batchId, sourceSurfaceId, evidenceIds, ...specialistInput } = input;
  const launch = runtime.inbox.reserveSpecialistLaunch({
    batchId,
    sourceSurfaceId,
    specialist: spec.name,
    input: specialistInput,
    ...(evidenceIds === undefined ? {} : { evidenceIds }),
  });
  return acceptSpecialistLaunch(launch, spec);
};

export const recoverPendingSpecialistLaunches = async (
  specialists: readonly SpecialistSpec[],
): Promise<void> => {
  const runtime = getDelegationRuntime();
  const byName = new Map(specialists.map((spec) => [spec.name, spec]));
  for (const launch of runtime.inbox.pendingSpecialistLaunches()) {
    const specialist = byName.get(launch.specialist);
    if (specialist === undefined) throw new Error(`Specialist ${launch.specialist} is not configured.`);
    await acceptSpecialistLaunch(launch, specialist);
  }
};

export const createSpecialistLaunchTool = <TInput extends ActionInputSchema>(
  spec: SpecialistSpec<TInput>,
): ToolDefinition => {
  const specialistEntries = (spec.input as unknown as { readonly entries: v.ObjectEntries }).entries;
  if (specialistEntries === undefined) throw new Error(`Specialist ${spec.name} input must be an object schema.`);
  const inputSchema = v.object({
    ...specialistEntries,
    batchId: nonEmptyString,
    sourceSurfaceId: nonEmptyString,
  });
  return defineTool({
    name: spec.toolName,
    description: `${spec.description} The Brain must provide its current Batch id and the originating Surface id as provenance.`,
    input: inputSchema,
    output: launchOutputSchema,
    run: async ({ input }) => launchSpecialistWork(input as never, spec),
  });
};

export const createDelegationTools = (specialists: readonly SpecialistSpec[] = []): ToolDefinition[] =>
  specialists.map((spec) => createSpecialistLaunchTool(spec));
