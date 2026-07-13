import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";

import { createStartTestWorkflowTool } from "../../src/tools/workflows/start-test-workflow.ts";
import testTaskWorkflow, {
  TEST_TASK_WORKFLOW_NAME,
  configureTestTaskGate,
  configureTestTaskResultSink,
  createControllableTestTaskGate,
  registerTestTaskCorrelation,
  testTaskResultInterceptor,
  type TestTaskResultInput,
} from "../../src/workflows/test-task.ts";

const CHAT = "workflow-proof@g.us";

describe("test task workflow", () => {
  it("stays active behind its deterministic gate and returns validated output after release", async () => {
    const gate = createControllableTestTaskGate();
    configureTestTaskGate(gate);
    const execution = Promise.resolve(
      testTaskWorkflow.action.run({
        input: { chatId: CHAT, operationId: "operation-success", value: "answer", shouldFail: false },
      } as never),
    );

    await expect(gate.pending()).resolves.toEqual(["operation-success"]);
    let settled = false;
    void execution.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    gate.release("operation-success");
    await expect(execution).resolves.toEqual({ operationId: "operation-success", value: "answer" });
  });

  it("turns a released deterministic failure into a rejected workflow execution", async () => {
    const gate = createControllableTestTaskGate();
    configureTestTaskGate(gate);
    const execution = Promise.resolve(
      testTaskWorkflow.action.run({
        input: { chatId: CHAT, operationId: "operation-failure", value: "ignored", shouldFail: true },
      } as never),
    );

    await expect(gate.pending()).resolves.toEqual(["operation-failure"]);
    gate.release("operation-failure");
    await expect(execution).rejects.toThrow("Deterministic test workflow failure");
  });
});

describe("terminal workflow result delivery", () => {
  it("awaits one normalized completion admission after the native workflow boundary returns", async () => {
    const results: TestTaskResultInput[] = [];
    let nativeSettled = false;
    configureTestTaskResultSink(async (_chatId, input) => {
      expect(nativeSettled).toBe(true);
      results.push(input);
    });
    registerTestTaskCorrelation("run-success", { chatId: CHAT, operationId: "operation-success" });

    await expect(
      testTaskResultInterceptor(
        {
          type: "workflow",
          runId: "run-success",
          workflowName: TEST_TASK_WORKFLOW_NAME,
          phase: "start",
          startedAt: "2026-07-13T00:00:00.000Z",
        },
        {},
        async () => {
          nativeSettled = true;
          return { operationId: "operation-success", value: "answer" };
        },
      ),
    ).resolves.toEqual({ operationId: "operation-success", value: "answer" });
    expect(results).toEqual([{
      type: "workflow.completed",
      chatId: CHAT,
      workflow: TEST_TASK_WORKFLOW_NAME,
      runId: "run-success",
      operationId: "operation-success",
      output: { value: "answer" },
    }]);
  });

  it("awaits one safe failure admission after the native workflow boundary rejects", async () => {
    const results: TestTaskResultInput[] = [];
    configureTestTaskResultSink(async (_chatId, input) => {
      results.push(input);
    });
    registerTestTaskCorrelation("run-failure", { chatId: CHAT, operationId: "operation-failure" });
    const failure = new Error("Deterministic test workflow failure");

    await expect(
      testTaskResultInterceptor(
        {
          type: "workflow",
          runId: "run-failure",
          workflowName: TEST_TASK_WORKFLOW_NAME,
          phase: "start",
          startedAt: "2026-07-13T00:00:00.000Z",
        },
        {},
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(results).toEqual([{
      type: "workflow.failed",
      chatId: CHAT,
      workflow: TEST_TASK_WORKFLOW_NAME,
      runId: "run-failure",
      operationId: "operation-failure",
      error: { message: "Deterministic test workflow failure" },
    }]);
  });

  it("surfaces terminal Ambience admission failure after the native workflow has settled", async () => {
    configureTestTaskResultSink(async () => {
      throw new Error("Ambience admission unavailable");
    });
    registerTestTaskCorrelation("run-undelivered", { chatId: CHAT, operationId: "operation-undelivered" });

    await expect(
      testTaskResultInterceptor(
        {
          type: "workflow",
          runId: "run-undelivered",
          workflowName: TEST_TASK_WORKFLOW_NAME,
          phase: "start",
          startedAt: "2026-07-13T00:00:00.000Z",
        },
        {},
        async () => ({ operationId: "operation-undelivered", value: "answer" }),
      ),
    ).rejects.toThrow("Ambience admission unavailable");
  });

  it("rejects a structurally valid result correlated to another operation", async () => {
    const results: TestTaskResultInput[] = [];
    configureTestTaskResultSink(async (_chatId, input) => {
      results.push(input);
    });
    registerTestTaskCorrelation("run-mismatch", { chatId: CHAT, operationId: "operation-expected" });

    await expect(
      testTaskResultInterceptor(
        {
          type: "workflow",
          runId: "run-mismatch",
          workflowName: TEST_TASK_WORKFLOW_NAME,
          phase: "start",
          startedAt: "2026-07-13T00:00:00.000Z",
        },
        {},
        async () => ({ operationId: "operation-other", value: "answer" }),
      ),
    ).rejects.toThrow("operationId operation-other does not match operation-expected");
    expect(results).toEqual([]);
  });
});

describe("start_test_workflow", () => {
  it("returns the native runId from admission without synchronously waiting for execution", async () => {
    const admit = vi.fn(async () => ({ runId: "run-28" }));
    const tool = createStartTestWorkflowTool(CHAT, admit, () => "operation-28");

    await expect(tool.run({ input: { value: "proof", shouldFail: false } })).resolves.toEqual({
      runId: "run-28",
      status: "started",
    });
    expect(admit).toHaveBeenCalledOnce();
    expect(admit).toHaveBeenCalledWith({
      chatId: CHAT,
      operationId: "operation-28",
      value: "proof",
      shouldFail: false,
    });
    expect(v.safeParse(tool.output, { runId: "", status: "started" }).success).toBe(false);
  });
});
