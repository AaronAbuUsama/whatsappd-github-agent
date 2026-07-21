// flue-blueprint: tooling/braintrust@2
import { type FlueEvent, observe } from "@flue/runtime";
import { braintrustFlueObserver, initLogger } from "braintrust";

export interface BraintrustTracingOptions {
  /** The Braintrust API key from `credentials/braintrust.json`; absent/blank keeps tracing off. */
  readonly apiKey?: string;
  /** The tracing project from `runtime.tracing.project`; the name defaults to `Flue`. */
  readonly project?: { readonly name?: string; readonly id?: string };
}

const MAX_OBSERVED_RUNS = 10_000;
const observedRuns = new Set<string>();

const rememberObservedRun = (runId: string): void => {
  if (observedRuns.has(runId)) return;
  if (observedRuns.size >= MAX_OBSERVED_RUNS) {
    const oldest = observedRuns.values().next().value;
    if (oldest !== undefined) observedRuns.delete(oldest);
  }
  observedRuns.add(runId);
};

/**
 * Register the Braintrust Flue observer for production tracing (#252). Called from
 * {@link createAmbientAgentApp} — the runtime bundle, where `@flue/runtime`'s isolate-scoped
 * observer registry lives (the CLI is a separate bundle, see `runtime-dependencies.ts`) — rather
 * than at module load, so no config-relevant value is read from `process.env`. With no API key
 * (`runtime.tracing.enabled = false`, or the key credential absent) tracing stays off and nothing
 * is registered. Returns whether tracing was configured.
 */
export const configureBraintrustTracing = (options: BraintrustTracingOptions = {}): boolean => {
  const apiKey = options.apiKey?.trim();
  if (!apiKey) return false;
  initLogger({
    projectName: options.project?.name ?? "Flue",
    projectId: options.project?.id,
    apiKey,
  });
  observe((event, context) => {
    const compatible = compatibleEvent(event);
    if (compatible) braintrustFlueObserver(compatible, context);
  });
  return true;
};

function compatibleEvent(event: FlueEvent): unknown {
  if (event.type === "run_start") {
    rememberObservedRun(event.runId);
    return event;
  }
  if (event.type === "run_end") {
    observedRuns.delete(event.runId);
    return event;
  }
  if (event.type === "tool") return { ...event, type: "tool_call" };
  if (event.type === "run_resume") {
    if (observedRuns.has(event.runId)) return event;
    rememberObservedRun(event.runId);
    return { ...event, type: "run_start", input: undefined, payload: undefined };
  }
  if (
    event.type === "operation_start" ||
    event.type === "operation" ||
    event.type === "turn_request" ||
    event.type === "turn" ||
    event.type === "tool_start" ||
    event.type === "task_start" ||
    event.type === "task" ||
    event.type === "compaction_start" ||
    event.type === "compaction"
  ) {
    return event;
  }
  return undefined;
}
