// flue-blueprint: tooling/braintrust@2
import { type FlueEvent, observe } from "@flue/runtime";
import { braintrustFlueObserver, initLogger } from "braintrust";

export const braintrustTracingEnabled = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean => environment.BRAINTRUST_TRACING === "1" && Boolean(environment.BRAINTRUST_API_KEY);

const apiKey = braintrustTracingEnabled() ? process.env.BRAINTRUST_API_KEY : undefined;
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

if (apiKey) {
  initLogger({
    projectName: process.env.BRAINTRUST_PROJECT_NAME ?? "Flue",
    projectId: process.env.BRAINTRUST_PROJECT_ID,
    apiKey,
  });

  observe((event, context) => {
    const compatible = compatibleEvent(event);
    if (compatible) braintrustFlueObserver(compatible, context);
  });
}

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
