import {
  defineAgent,
  defineWorkflow,
  instrument,
  type FlueExecutionContext,
  type FlueExecutionInterceptor,
  type FlueExecutionOperation,
  type FlueInstrumentation,
} from "@flue/runtime";
import * as v from "valibot";

import { AMBIENCE_MODEL_SPECIFIER } from "../model/pi-subscription.js";
import {
  workflowCompletedInputSchema,
  workflowFailedInputSchema,
  type WorkflowCompletedInput,
  type WorkflowFailedInput,
} from "../ambience/events.js";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

export const TEST_TASK_WORKFLOW_NAME = "test-task";

export const testTaskInputSchema = v.object({
  chatId: nonEmptyString,
  operationId: nonEmptyString,
  value: nonEmptyString,
  shouldFail: v.optional(v.boolean(), false),
});

export const testTaskOutputSchema = v.object({
  operationId: nonEmptyString,
  value: nonEmptyString,
});

export type TestTaskInput = v.InferOutput<typeof testTaskInputSchema>;

export interface TestTaskGate {
  wait(operationId: string): Promise<void>;
}

export type TestTaskResultInput = WorkflowCompletedInput | WorkflowFailedInput;
export type TestTaskResultSink = (chatId: string, input: TestTaskResultInput) => Promise<void>;

export interface TestTaskCorrelation {
  readonly chatId: string;
  readonly operationId: string;
}

interface CorrelationRendezvous {
  readonly promise: Promise<TestTaskCorrelation>;
  readonly resolve: (correlation: TestTaskCorrelation) => void;
  registered: boolean;
}

const immediateGate: TestTaskGate = { wait: async () => undefined };
let configuredGate: TestTaskGate = immediateGate;
let configuredResultSink: TestTaskResultSink = async () => {
  throw new Error("Test workflow result sink is not configured");
};
const correlations = new Map<string, CorrelationRendezvous>();

const getCorrelation = (runId: string): CorrelationRendezvous => {
  const existing = correlations.get(runId);
  if (existing) return existing;

  let resolve!: (correlation: TestTaskCorrelation) => void;
  const promise = new Promise<TestTaskCorrelation>((resolved) => {
    resolve = resolved;
  });
  const created = { promise, resolve, registered: false };
  correlations.set(runId, created);
  return created;
};

export const registerTestTaskCorrelation = (runId: string, correlation: TestTaskCorrelation): void => {
  const rendezvous = getCorrelation(runId);
  if (rendezvous.registered) throw new Error(`Test workflow correlation is already registered: ${runId}`);
  rendezvous.registered = true;
  rendezvous.resolve(correlation);
};

const deliverTerminalResult = async (
  runId: string,
  result: unknown,
  error?: unknown,
): Promise<void> => {
  const rendezvous = getCorrelation(runId);
  const correlation = await rendezvous.promise;

  let input: TestTaskResultInput;
  if (error === undefined) {
    const output = v.parse(testTaskOutputSchema, result);
    if (output.operationId !== correlation.operationId) {
      throw new Error(
        `Test workflow result operationId ${output.operationId} does not match ${correlation.operationId}`,
      );
    }
    input = v.parse(workflowCompletedInputSchema, {
      type: "workflow.completed",
      chatId: correlation.chatId,
      workflow: TEST_TASK_WORKFLOW_NAME,
      runId,
      operationId: correlation.operationId,
      output: { value: output.value },
    });
  } else {
    input = v.parse(workflowFailedInputSchema, {
      type: "workflow.failed",
      chatId: correlation.chatId,
      workflow: TEST_TASK_WORKFLOW_NAME,
      runId,
      operationId: correlation.operationId,
      error: {
        message: error instanceof Error && error.message.length > 0 ? error.message : "Test workflow failed",
      },
    });
  }

  await configuredResultSink(correlation.chatId, input);
  if (correlations.get(runId) === rendezvous) correlations.delete(runId);
};

export const testTaskResultInterceptor: FlueExecutionInterceptor = async function interceptTestTaskResult<T>(
  operation: FlueExecutionOperation,
  _context: FlueExecutionContext,
  next: () => Promise<T>,
): Promise<T> {
  if (
    operation.type !== "workflow" ||
    operation.workflowName !== TEST_TASK_WORKFLOW_NAME ||
    operation.phase !== "start"
  ) {
    return next();
  }

  let result: T;
  try {
    result = await next();
  } catch (workflowError) {
    try {
      await deliverTerminalResult(operation.runId, undefined, workflowError);
    } catch (deliveryError) {
      throw new AggregateError(
        [workflowError, deliveryError],
        "Test workflow failed and its terminal Ambience input could not be admitted",
      );
    }
    throw workflowError;
  }

  await deliverTerminalResult(operation.runId, result);
  return result;
};

const resultDeliveryInstrumentation: FlueInstrumentation = {
  key: Symbol("test-task-result-delivery"),
  observe: () => undefined,
  interceptor: testTaskResultInterceptor,
  dispose: () => undefined,
};

let resultDeliveryInstalled = false;

export const installTestTaskResultDelivery = (): void => {
  if (resultDeliveryInstalled) return;
  instrument(resultDeliveryInstrumentation);
  resultDeliveryInstalled = true;
};

export const configureTestTaskGate = (gate: TestTaskGate): void => {
  configuredGate = gate;
};

export const configureTestTaskResultSink = (sink: TestTaskResultSink): void => {
  configuredResultSink = sink;
};

export interface ControllableTestTaskGate extends TestTaskGate {
  pending(): Promise<readonly string[]>;
  release(operationId: string): void;
}

export const createControllableTestTaskGate = (): ControllableTestTaskGate => {
  const waiters = new Map<string, () => void>();

  return {
    wait: (operationId) =>
      new Promise<void>((resolve, reject) => {
        if (waiters.has(operationId)) {
          reject(new Error(`Test workflow operation is already waiting: ${operationId}`));
          return;
        }
        waiters.set(operationId, resolve);
      }),
    pending: async () => [...waiters.keys()],
    release: (operationId) => {
      const resolve = waiters.get(operationId);
      if (!resolve) throw new Error(`No test workflow operation is waiting: ${operationId}`);
      waiters.delete(operationId);
      resolve();
    },
  };
};

const workflowAgent = defineAgent(() => ({
  model: AMBIENCE_MODEL_SPECIFIER,
  thinkingLevel: "low",
}));

export default defineWorkflow({
  agent: workflowAgent,
  input: testTaskInputSchema,
  output: testTaskOutputSchema,
  run: async ({ input }) => {
    await configuredGate.wait(input.operationId);
    if (input.shouldFail) throw new Error("Deterministic test workflow failure");
    return { operationId: input.operationId, value: input.value };
  },
});
