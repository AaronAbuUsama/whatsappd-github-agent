import { randomUUID } from "node:crypto";

import { defineTool, invoke, type WorkflowInvocationReceipt } from "@flue/runtime";
import * as v from "valibot";

import testTaskWorkflow, {
  registerTestTaskCorrelation,
  type TestTaskInput,
} from "../../workflows/test-task.js";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

export const startTestWorkflowOutputSchema = v.object({
  runId: nonEmptyString,
  status: v.literal("started"),
});

export type AdmitTestTask = (input: TestTaskInput) => Promise<WorkflowInvocationReceipt>;

const admitTestTask: AdmitTestTask = (input) => invoke(testTaskWorkflow, { input });

export const createStartTestWorkflowTool = (
  chatId: string,
  admit: AdmitTestTask = admitTestTask,
  createOperationId: () => string = randomUUID,
) =>
  defineTool({
    name: "start_test_workflow",
    description: "Start the bounded test workflow and return its run ID without waiting for completion.",
    input: v.object({
      value: nonEmptyString,
      shouldFail: v.optional(v.boolean(), false),
    }),
    output: startTestWorkflowOutputSchema,
    run: async ({ input }) => {
      const operationId = createOperationId();
      const receipt = await admit({
        chatId,
        operationId,
        value: input.value,
        shouldFail: input.shouldFail,
      });
      registerTestTaskCorrelation(receipt.runId, { chatId, operationId });
      return { runId: receipt.runId, status: "started" as const };
    },
  });
