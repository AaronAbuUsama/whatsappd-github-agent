import { describe, expect, it, vi } from "vitest";
import * as v from "valibot";

import ambience from "../../src/agents/ambience.ts";
import {
  createGitHubProofOperation,
  executeGitHubProof,
} from "../../src/github/proof-operation.ts";
import {
  configureGitHubProofRuntime,
  createGitHubProofPolicy,
  loadGitHubProofSettings,
} from "../../src/github/proof-runtime.ts";
import { createFakeGitHubProofHost } from "../../src/host/fake-github-proof-host.ts";
import { isUncertainGitHubMutationError } from "../../src/host/github-proof-host.ts";
import { createFakeWhatsAppHost } from "../../src/host/fake-whatsapp-host.ts";
import { configureWhatsAppHost } from "../../src/host/whatsapp-host.ts";
import { createStartGitHubProofTool } from "../../src/tools/workflows/start-github-proof.ts";
import {
  GITHUB_PROOF_WORKFLOW_NAME,
  GitHubProofWorkflowError,
  configureGitHubProofResultSink,
  gitHubProofResultInterceptor,
  type GitHubProofResultInput,
} from "../../src/workflows/github-proof.ts";

const CHAT = "github-proof@g.us";
const REPOSITORY = { owner: "acme", repo: "widgets" } as const;
const OPERATION = "operation-30";
const input = { chatId: CHAT, operationId: OPERATION, repository: REPOSITORY };

describe("GitHub proof policy", () => {
  it("loads the existing GitHub environment boundary without a model credential", () => {
    expect(loadGitHubProofSettings({
      GITHUB_TOKEN: "  github-token  ",
      GITHUB_REPO: " acme/widgets ",
      GITHUB_ALLOWED_REPOS: "acme/widgets, acme/other",
      OPENAI_API_KEY: "must-not-be-consumed",
    })).toEqual({
      token: "github-token",
      defaultRepository: "acme/widgets",
      allowedRepositories: ["acme/widgets", "acme/other"],
    });
  });

  it("fails closed when the GitHub credential or default repository is absent", () => {
    expect(() => loadGitHubProofSettings({ GITHUB_REPO: "acme/widgets" })).toThrow("GITHUB_TOKEN");
    expect(() => loadGitHubProofSettings({ GITHUB_TOKEN: "github-token" })).toThrow("GITHUB_REPO");
    expect(() => loadGitHubProofSettings({
      GITHUB_TOKEN: "github-token",
      GITHUB_REPO: "not-a-repository",
    })).toThrow("owner/repo");
  });

  it("rejects an out-of-scope repository before workflow admission", async () => {
    const policy = createGitHubProofPolicy("acme/widgets", ["acme/widgets"]);
    const admit = vi.fn(async () => ({ runId: "run-30" }));
    const tool = createStartGitHubProofTool(CHAT, admit, () => OPERATION, policy);

    await expect(tool.run({ input: { repository: "other/repo" } })).rejects.toThrow(
      "not in the configured GitHub write allowlist",
    );
    expect(admit).not.toHaveBeenCalled();
  });

  it("returns the native runId after admission without awaiting workflow execution", async () => {
    const policy = createGitHubProofPolicy("acme/widgets", ["acme/widgets"]);
    const admit = vi.fn(async () => ({ runId: "run-30" }));
    const tool = createStartGitHubProofTool(CHAT, admit, () => OPERATION, policy);

    await expect(tool.run({ input: { repository: "acme/widgets" } })).resolves.toEqual({
      runId: "run-30",
      status: "started",
    });
    expect(admit).toHaveBeenCalledWith(input);
  });
});

describe("bounded GitHub proof operation", () => {
  it("classifies an Octokit-style wrapped transport timeout as uncertain", () => {
    const timeout = Object.assign(new Error("request timed out"), {
      name: "TimeoutError",
      code: "ETIMEDOUT",
    });
    const wrapped = new Error("HttpError: fetch failed", { cause: timeout });
    wrapped.name = "HttpError";

    expect(isUncertainGitHubMutationError(wrapped)).toBe(true);
  });

  it("classifies an Octokit-wrapped Undici socket drop after a mutation request as uncertain", () => {
    const socket = Object.assign(new Error("other side closed"), {
      name: "SocketError",
      code: "UND_ERR_SOCKET",
    });
    const fetchFailure = new TypeError("fetch failed", { cause: socket });
    const wrapped = new Error("HttpError: fetch failed", { cause: fetchFailure });
    wrapped.name = "HttpError";

    expect(isUncertainGitHubMutationError(wrapped)).toBe(true);
  });

  it("creates once, reads back, closes, and observes the closed issue", async () => {
    const host = createFakeGitHubProofHost();

    await expect(executeGitHubProof(input, host)).resolves.toMatchObject({
      status: "completed",
      chatId: CHAT,
      operationId: OPERATION,
      repository: REPOSITORY,
      creation: "confirmed",
      closure: "confirmed",
      issue: { number: 1, state: "closed", url: "https://github.com/acme/widgets/issues/1" },
    });
    expect(host.events()).toEqual([
      { kind: "create", repository: "acme/widgets", operationId: OPERATION, outcome: "created", number: 1 },
      { kind: "get", repository: "acme/widgets", number: 1, state: "open" },
      { kind: "close", repository: "acme/widgets", number: 1, outcome: "closed" },
      { kind: "get", repository: "acme/widgets", number: 1, state: "closed" },
    ]);
  });

  it("reconciles a create timeout by stable marker without retrying the mutation", async () => {
    const host = createFakeGitHubProofHost();
    host.timeoutNextCreate({ afterMutation: true });

    await expect(executeGitHubProof(input, host)).resolves.toMatchObject({
      status: "completed",
      creation: "reconciled",
      closure: "confirmed",
      issue: { number: 1, state: "closed" },
    });
    expect(host.events().filter((event) => event.kind === "create")).toHaveLength(1);
    expect(host.events()).toContainEqual({
      kind: "find",
      repository: "acme/widgets",
      operationId: OPERATION,
      matches: [1],
    });
  });

  it("returns an uncertain create result when reconciliation observes no issue and never retries", async () => {
    const host = createFakeGitHubProofHost();
    host.timeoutNextCreate({ afterMutation: false });

    await expect(executeGitHubProof(input, host)).resolves.toEqual({
      status: "uncertain",
      chatId: CHAT,
      operationId: OPERATION,
      repository: REPOSITORY,
      phase: "create",
      reason: "GitHub create outcome remained uncertain after marker reconciliation",
    });
    expect(host.events().filter((event) => event.kind === "create")).toHaveLength(1);
    expect(host.events().filter((event) => event.kind === "close")).toHaveLength(0);
  });

  it("keeps a create outcome uncertain when marker reconciliation itself times out", async () => {
    const fake = createFakeGitHubProofHost();
    fake.timeoutNextCreate({ afterMutation: false });
    const findIssuesByMarker = vi.fn(async (
      _repository: typeof REPOSITORY,
      _operationId: string,
      _marker: string,
      signal?: AbortSignal,
    ) => {
      expect(signal?.aborted).toBe(false);
      throw Object.assign(new Error("reconciliation timed out"), { name: "TimeoutError" });
    });

    await expect(executeGitHubProof(input, { ...fake, findIssuesByMarker })).resolves.toMatchObject({
      status: "uncertain",
      phase: "create",
      reason: "GitHub create outcome remained uncertain because marker reconciliation could not complete",
    });
    expect(fake.events().filter((event) => event.kind === "create")).toHaveLength(1);
    expect(findIssuesByMarker).toHaveBeenCalledOnce();
  });

  it("reconciles a close timeout by observed state without retrying close", async () => {
    const host = createFakeGitHubProofHost();
    host.timeoutNextClose({ afterMutation: true });

    await expect(executeGitHubProof(input, host)).resolves.toMatchObject({
      status: "completed",
      creation: "confirmed",
      closure: "reconciled",
      issue: { number: 1, state: "closed" },
    });
    expect(host.events().filter((event) => event.kind === "close")).toHaveLength(1);
  });

  it("keeps a close outcome uncertain when observed-state reconciliation cannot complete", async () => {
    const fake = createFakeGitHubProofHost();
    fake.timeoutNextClose({ afterMutation: false });
    let reads = 0;
    const getIssue = vi.fn(async (...args: Parameters<typeof fake.getIssue>) => {
      reads += 1;
      if (reads === 1) return fake.getIssue(...args);
      expect(args[2]?.aborted).toBe(false);
      throw Object.assign(new Error("reconciliation timed out"), { name: "TimeoutError" });
    });

    await expect(executeGitHubProof(input, { ...fake, getIssue })).resolves.toMatchObject({
      status: "uncertain",
      phase: "close",
      reason: "GitHub close outcome remained uncertain because observed-state reconciliation could not complete",
      issue: { number: 1, state: "open" },
    });
    expect(fake.events().filter((event) => event.kind === "close")).toHaveLength(1);
    expect(getIssue).toHaveBeenCalledTimes(2);
  });

  it("surfaces a deterministic provider failure explicitly", async () => {
    const host = createFakeGitHubProofHost();
    host.failNextCreate(new Error("GitHub rejected the mutation"));

    await expect(executeGitHubProof(input, host)).rejects.toThrow("GitHub rejected the mutation");
    expect(host.events().filter((event) => event.kind === "create")).toHaveLength(1);
  });

  it("preserves a scoped tool failure instead of replacing it with a missing-receipt error", async () => {
    const host = createFakeGitHubProofHost();
    host.failNextCreate(new Error("GitHub rejected the mutation"));
    const operation = createGitHubProofOperation(input, host);

    await expect(operation.tool.run({ input: {} })).rejects.toThrow("GitHub rejected the mutation");
    expect(() => operation.result()).toThrow("GitHub rejected the mutation");
  });

  it("gives the specialist one scoped proof tool and prevents a second mutation call", async () => {
    const host = createFakeGitHubProofHost();
    const operation = createGitHubProofOperation(input, host);

    await expect(operation.tool.run({ input: {} })).resolves.toMatchObject({ status: "completed" });
    await expect(operation.tool.run({ input: {} })).rejects.toThrow("already attempted");
    expect(v.parse(operation.tool.input!, { repository: "other/repo", title: "injected" })).toEqual({});
    expect(operation.result()).toMatchObject({ status: "completed" });
    expect(host.events().filter((event) => event.kind === "create")).toHaveLength(1);
  });
});

describe("root Ambience capability boundary", () => {
  it("has only communication, bound history reads, and workflow admission, never a GitHub mutation tool", async () => {
    configureWhatsAppHost(createFakeWhatsAppHost());
    configureGitHubProofRuntime({
      host: createFakeGitHubProofHost(),
      policy: createGitHubProofPolicy("acme/widgets", ["acme/widgets"]),
    });
    const config = await ambience.initialize({ id: CHAT } as never);

    expect(config.tools?.map((tool) => tool.name)).toEqual([
      "say",
      "whatsapp_read_thread",
      "whatsapp_search",
      "start_github_proof",
    ]);
    expect(config.tools?.some((tool) => tool.name.includes("create_issue") || tool.name.includes("close_issue"))).toBe(false);
  });
});

describe("GitHub proof terminal delivery", () => {
  const completed = {
    status: "completed" as const,
    ...input,
    creation: "confirmed" as const,
    closure: "confirmed" as const,
    issue: {
      number: 1,
      url: "https://github.com/acme/widgets/issues/1",
      title: `[Ambience proof] ${OPERATION}`,
      state: "closed" as const,
    },
  };

  it("admits one validated completion after the native terminal boundary", async () => {
    const delivered: GitHubProofResultInput[] = [];
    let nativeSettled = false;
    configureGitHubProofResultSink(async (_chatId, event) => {
      expect(nativeSettled).toBe(true);
      delivered.push(event);
    });

    await expect(
      gitHubProofResultInterceptor(
        {
          type: "workflow",
          runId: "run-completed",
          workflowName: GITHUB_PROOF_WORKFLOW_NAME,
          phase: "start",
          startedAt: "2026-07-13T00:00:00.000Z",
        },
        {},
        async () => {
          nativeSettled = true;
          return completed;
        },
      ),
    ).resolves.toEqual(completed);
    expect(delivered).toEqual([{
      type: "workflow.completed",
      chatId: CHAT,
      workflow: GITHUB_PROOF_WORKFLOW_NAME,
      runId: "run-completed",
      operationId: OPERATION,
      output: completed,
    }]);
  });

  it("admits an uncertain outcome as data without manufacturing workflow failure", async () => {
    const delivered: GitHubProofResultInput[] = [];
    configureGitHubProofResultSink(async (_chatId, event) => {
      delivered.push(event);
    });
    const uncertain = {
      status: "uncertain" as const,
      ...input,
      phase: "create" as const,
      reason: "GitHub create outcome remained uncertain after marker reconciliation",
    };

    await expect(
      gitHubProofResultInterceptor(
        {
          type: "workflow",
          runId: "run-uncertain",
          workflowName: GITHUB_PROOF_WORKFLOW_NAME,
          phase: "start",
          startedAt: "2026-07-13T00:00:00.000Z",
        },
        {},
        async () => uncertain,
      ),
    ).resolves.toEqual(uncertain);
    expect(delivered).toEqual([{
      type: "workflow.uncertain",
      chatId: CHAT,
      workflow: GITHUB_PROOF_WORKFLOW_NAME,
      runId: "run-uncertain",
      operationId: OPERATION,
      output: uncertain,
    }]);
  });

  it("admits one normalized workflow failure with repository correlation", async () => {
    const delivered: GitHubProofResultInput[] = [];
    configureGitHubProofResultSink(async (_chatId, event) => {
      delivered.push(event);
    });
    const failure = new GitHubProofWorkflowError("GitHub rejected the mutation", input);

    await expect(
      gitHubProofResultInterceptor(
        {
          type: "workflow",
          runId: "run-failed",
          workflowName: GITHUB_PROOF_WORKFLOW_NAME,
          phase: "start",
          startedAt: "2026-07-13T00:00:00.000Z",
        },
        {},
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(delivered).toEqual([{
      type: "workflow.failed",
      chatId: CHAT,
      workflow: GITHUB_PROOF_WORKFLOW_NAME,
      runId: "run-failed",
      operationId: OPERATION,
      repository: REPOSITORY,
      error: { message: "GitHub rejected the mutation" },
    }]);
  });
});
