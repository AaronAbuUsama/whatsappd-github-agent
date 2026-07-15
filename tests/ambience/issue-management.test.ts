import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

import ambience from "../../src/agents/ambience.ts";
import {
  configureIssueManagementRuntime,
  createIssueManagementPolicy,
  loadIssueManagementSettings,
} from "../../src/capabilities/issue-management/runtime.ts";
import {
  isUncertainIssueMutationError,
  MAX_PUBLIC_ISSUE_BODY_LENGTH,
} from "../../src/capabilities/issue-management/issue-repository.ts";
import { createIssueManagementTools } from "../../src/capabilities/issue-management/tools.ts";
import { createIssueOperationStore } from "../../src/capabilities/issue-management/operation-store.ts";
import { createFakeIssueRepository } from "../../src/host/fake-issue-repository.ts";
import {
  GITHUB_ISSUE_BODY_LIMIT,
  githubIssueProviderBody,
  githubIssueRecord,
  githubIssueSearchQuery,
} from "../../src/host/github-issue-repository.ts";

const CHAT = "issue-management@g.us";
const REPOSITORY = { owner: "acme", repo: "widgets" } as const;

const configured = () => {
  const repository = createFakeIssueRepository();
  const operations = createIssueOperationStore(":memory:");
  const policy = createIssueManagementPolicy("acme/widgets", ["acme/widgets"]);
  configureIssueManagementRuntime({ repository, operations, policy });
  return { repository, operations, policy };
};

describe("Issue Management configuration", () => {
  it("loads only the managed GitHub boundary and fails closed when it is incomplete", () => {
    expect(
      loadIssueManagementSettings({
        GITHUB_TOKEN: "  github-token  ",
        GITHUB_REPO: " acme/widgets ",
        GITHUB_ALLOWED_REPOS: "acme/widgets,acme/other",
        GITHUB_ISSUE_OPERATIONS_DB_PATH: "/managed/application.sqlite",
      }),
    ).toEqual({
      token: "github-token",
      defaultRepository: "acme/widgets",
      allowedRepositories: ["acme/widgets", "acme/other"],
      operationDatabasePath: "/managed/application.sqlite",
    });
    expect(() =>
      loadIssueManagementSettings({
        GITHUB_REPO: "acme/widgets",
        GITHUB_ISSUE_OPERATIONS_DB_PATH: "/managed/application.sqlite",
      }),
    ).toThrow("GITHUB_TOKEN");
    expect(() => loadIssueManagementSettings({ GITHUB_TOKEN: "token", GITHUB_REPO: "acme/widgets" })).toThrow(
      "GITHUB_ISSUE_OPERATIONS_DB_PATH",
    );
  });

  it("rejects an out-of-policy repository before provider reads or writes", async () => {
    const { repository, operations, policy } = configured();
    const create = createIssueManagementTools({ repository, operations, policy }).find(
      (tool) => tool.name === "github_create_issue",
    )!;

    await expect(
      create.run({
        input: {
          repository: "other/repo",
          kind: "bug",
          title: "The scheduler loses a queued job",
          body: "Expected the queued job to run. It disappears after restart.",
        },
      }),
    ).rejects.toThrow("not in the configured GitHub write allowlist");
    expect(repository.events()).toEqual([]);
    expect(operations.list()).toEqual([]);
  });
});

describe("production Issue Management tools", () => {
  it("quotes model search text so GitHub qualifiers cannot escape the authorized repository", () => {
    expect(githubIssueSearchQuery(REPOSITORY, 'scheduler repo:other/private "secret"')).toBe(
      '"scheduler repo:other/private \\"secret\\"" in:title,body repo:acme/widgets is:issue',
    );
  });

  it("rejects pull-request records at the private issue adapter boundary", () => {
    expect(() =>
      githubIssueRecord(REPOSITORY, {
        number: 42,
        html_url: "https://github.com/acme/widgets/pull/42",
        title: "A pull request",
        body: "Not an issue",
        state: "open",
        pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/42" },
      }),
    ).toThrow("acme/widgets#42 is a pull request, not an issue");
  });

  it("keeps provider Operation Identity markers out of the public issue body", () => {
    expect(
      githubIssueRecord(REPOSITORY, {
        number: 7,
        html_url: "https://github.com/acme/widgets/issues/7",
        title: "Visible title",
        body: "Visible body\n\n<!-- ambience-operation:create-id -->\n\n<!-- ambience-operation:update-id -->",
        state: "open",
      }),
    ).toMatchObject({ body: "Visible body" });
  });

  it("reserves provider body capacity for the stable create and latest update identities", () => {
    const body = "x".repeat(MAX_PUBLIC_ISSUE_BODY_LENGTH);
    const markers = [
      `<!-- ambience-operation:${"c".repeat(200)} -->`,
      `<!-- ambience-operation:${"u".repeat(200)} -->`,
    ];
    expect(githubIssueProviderBody(body, markers).length).toBeLessThanOrEqual(GITHUB_ISSUE_BODY_LIMIT);
    expect(() => githubIssueProviderBody("x".repeat(GITHUB_ISSUE_BODY_LIMIT), markers)).toThrow(
      `exceeds ${GITHUB_ISSUE_BODY_LIMIT} characters`,
    );
  });

  it("bounds a maximum-length issue title to GitHub's complete search-query limit", () => {
    const query = githubIssueSearchQuery(REPOSITORY, `${"x".repeat(250)}\\"repo:other/private`);
    expect(query.length).toBeLessThanOrEqual(256);
    expect(query).toMatch(/^"x+" in:title,body repo:acme\/widgets is:issue$/);
  });

  it("treats ambiguous HTTP responses as uncertain while preserving definite validation failures", () => {
    expect(isUncertainIssueMutationError(Object.assign(new Error("bad gateway"), { status: 502 }))).toBe(true);
    expect(isUncertainIssueMutationError(Object.assign(new Error("request timeout"), { status: 408 }))).toBe(true);
    expect(isUncertainIssueMutationError(Object.assign(new Error("validation failed"), { status: 422 }))).toBe(false);
  });

  it("searches for duplicates before creating one well-formed issue", async () => {
    const { repository, operations, policy } = configured();
    const create = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-create-1",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    }).find((tool) => tool.name === "github_create_issue")!;

    await expect(
      create.run({
        input: {
          kind: "bug",
          title: "The scheduler loses a queued job",
          body: "Expected the queued job to run. It disappears after restart.",
        },
      }),
    ).resolves.toMatchObject({
      status: "created",
      operationId: "operation-create-1",
      issue: {
        number: 1,
        title: "The scheduler loses a queued job",
        state: "open",
      },
    });
    expect(repository.events()).toEqual([
      {
        kind: "search",
        repository: "acme/widgets",
        query: "The scheduler loses a queued job",
        matches: [],
      },
      {
        kind: "create",
        repository: "acme/widgets",
        operationId: "operation-create-1",
        outcome: "created",
        number: 1,
      },
    ]);
    expect(operations.list()).toEqual([
      expect.objectContaining({
        operationId: "operation-create-1",
        kind: "create-issue",
        repository: "acme/widgets",
        status: "completed",
        issueNumber: 1,
      }),
    ]);
  });

  it("reads the issue, validates existing metadata, and applies one exact correction", async () => {
    const { repository, operations, policy } = configured();
    repository.setOptions({
      labels: ["bug", "priority: high"],
      assignees: ["octocat", "maintainer"],
      milestones: [
        { number: 3, title: "Stable base", state: "open" },
        { number: 2, title: "Earlier", state: "closed" },
      ],
    });
    const issue = repository.seed({
      repository: REPOSITORY,
      title: "Schedular looses jobs",
      body: "Restart is bad.",
      labels: ["bug"],
      assignees: ["octocat"],
      milestone: { number: 2, title: "Earlier", state: "closed" },
    });
    repository.resetEvents();
    const update = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-update-1",
      now: () => new Date("2026-07-15T01:00:00.000Z"),
    }).find((tool) => tool.name === "github_update_issue")!;

    await expect(
      update.run({
        input: {
          number: issue.number,
          title: "Scheduler loses queued jobs after restart",
          body: "Expected queued jobs to run after restart. Observed that they disappear.",
          labels: ["priority: high", "bug"],
          assignees: ["maintainer"],
          milestone: 3,
        },
      }),
    ).resolves.toMatchObject({
      status: "updated",
      operationId: "operation-update-1",
      issue: {
        number: issue.number,
        title: "Scheduler loses queued jobs after restart",
        body: "Expected queued jobs to run after restart. Observed that they disappear.",
        labels: ["priority: high", "bug"],
        assignees: ["maintainer"],
        milestone: { number: 3, title: "Stable base", state: "open" },
      },
    });
    expect(repository.events()).toEqual([
      { kind: "get", repository: "acme/widgets", number: issue.number },
      { kind: "list-options", repository: "acme/widgets" },
      {
        kind: "update",
        repository: "acme/widgets",
        number: issue.number,
        operationId: "operation-update-1",
        outcome: "updated",
      },
    ]);
    expect(operations.get("operation-update-1")).toMatchObject({
      kind: "update-issue",
      repository: "acme/widgets",
      issueNumber: issue.number,
      status: "completed",
      target: {
        title: "Scheduler loses queued jobs after restart",
        body: "Expected queued jobs to run after restart. Observed that they disappear.",
        labels: ["priority: high", "bug"],
        assignees: ["maintainer"],
        milestone: 3,
      },
    });
  });

  it("rejects unknown repository metadata before starting an operation", async () => {
    const { repository, operations, policy } = configured();
    repository.setOptions({ labels: ["bug"], assignees: ["octocat"], milestones: [] });
    const issue = repository.seed({ repository: REPOSITORY, title: "Existing issue", body: "Existing body" });
    repository.resetEvents();
    const update = createIssueManagementTools({ repository, operations, policy }).find(
      (tool) => tool.name === "github_update_issue",
    )!;

    await expect(update.run({ input: { number: issue.number, labels: ["does-not-exist"] } })).rejects.toThrow(
      'GitHub label "does-not-exist" does not exist',
    );
    expect(repository.events()).toEqual([
      { kind: "get", repository: "acme/widgets", number: issue.number },
      { kind: "list-options", repository: "acme/widgets" },
    ]);
    await expect(update.run({ input: { number: issue.number, assignees: ["ghost"] } })).rejects.toThrow(
      'GitHub assignee "ghost" does not exist',
    );
    await expect(update.run({ input: { number: issue.number, milestone: 99 } })).rejects.toThrow(
      "GitHub milestone #99 does not exist",
    );
    expect(repository.events().filter((event) => event.kind === "update")).toEqual([]);
    expect(operations.list()).toEqual([]);
  });

  it("can explicitly remove all labels, assignees, and the milestone", async () => {
    const { repository, operations, policy } = configured();
    repository.setOptions({
      labels: ["bug"],
      assignees: ["octocat"],
      milestones: [{ number: 3, title: "Stable base", state: "open" }],
    });
    const issue = repository.seed({
      repository: REPOSITORY,
      title: "Keep title",
      body: "Keep body",
      labels: ["bug"],
      assignees: ["octocat"],
      milestone: { number: 3, title: "Stable base", state: "open" },
    });
    repository.resetEvents();
    const update = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-clear-metadata",
    }).find((tool) => tool.name === "github_update_issue")!;

    await expect(
      update.run({ input: { number: issue.number, body: "", labels: [], assignees: [], milestone: null } }),
    ).resolves.toMatchObject({
      status: "updated",
      issue: {
        number: issue.number,
        title: "Keep title",
        body: "",
        labels: [],
        assignees: [],
        milestone: null,
      },
    });
    expect(operations.get("operation-clear-metadata")).toMatchObject({
      kind: "update-issue",
      target: { body: "", labels: [], assignees: [], milestone: null },
      status: "completed",
    });
  });

  it("observes an ambiguous update by exact requested state and never repeats it", async () => {
    const { repository, operations, policy } = configured();
    const issue = repository.seed({ repository: REPOSITORY, title: "Typo", body: "Body" });
    repository.resetEvents();
    repository.timeoutNextUpdate({ afterMutation: true });
    const update = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-update-uncertain",
      now: () => new Date("2026-07-15T02:00:00.000Z"),
    }).find((tool) => tool.name === "github_update_issue")!;

    await expect(
      update.run({ input: { number: issue.number, title: "Correct title", milestone: null } }),
    ).resolves.toMatchObject({
      status: "reconciled",
      operationId: "operation-update-uncertain",
      issue: { number: issue.number, title: "Correct title", milestone: null },
    });
    expect(repository.events()).toEqual([
      { kind: "get", repository: "acme/widgets", number: issue.number },
      { kind: "list-options", repository: "acme/widgets" },
      {
        kind: "update",
        repository: "acme/widgets",
        number: issue.number,
        operationId: "operation-update-uncertain",
        outcome: "unknown",
      },
      { kind: "get", repository: "acme/widgets", number: issue.number },
    ]);
    expect(operations.get("operation-update-uncertain")).toMatchObject({
      kind: "update-issue",
      issueNumber: issue.number,
      status: "completed",
    });
  });

  it("leaves a non-observed ambiguous update uncertain without repeating it", async () => {
    const { repository, operations, policy } = configured();
    const issue = repository.seed({ repository: REPOSITORY, title: "Original title", body: "Body" });
    repository.resetEvents();
    repository.timeoutNextUpdate({ afterMutation: false });
    const update = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-update-not-observed",
    }).find((tool) => tool.name === "github_update_issue")!;

    await expect(update.run({ input: { number: issue.number, title: "Requested title" } })).resolves.toMatchObject({
      status: "uncertain",
      operationId: "operation-update-not-observed",
      issue: { number: issue.number, title: "Original title" },
    });
    expect(repository.events().filter((event) => event.kind === "update")).toHaveLength(1);
    expect(operations.get("operation-update-not-observed")).toMatchObject({
      kind: "update-issue",
      issueNumber: issue.number,
      target: { title: "Requested title" },
      status: "uncertain",
    });
  });

  it("persists the attempting Operation Identity before the provider mutation begins", async () => {
    const baseRepository = createFakeIssueRepository();
    const operations = createIssueOperationStore(":memory:");
    const repository = {
      ...baseRepository,
      create: async (input: Parameters<typeof baseRepository.create>[0]) => {
        expect(operations.get(input.operation.id)).toMatchObject({
          status: "attempting",
          repository: "acme/widgets",
        });
        return await baseRepository.create(input);
      },
    };
    const create = createIssueManagementTools({
      repository,
      operations,
      policy: createIssueManagementPolicy("acme/widgets", ["acme/widgets"]),
      createOperationId: () => "operation-before-provider",
    }).find((tool) => tool.name === "github_create_issue")!;

    await expect(
      create.run({
        input: {
          kind: "feature",
          title: "Show queue depth",
          body: "Operators need queue depth in status.",
        },
      }),
    ).resolves.toMatchObject({ status: "created", operationId: "operation-before-provider" });
  });

  it("returns the related issue and performs no create when duplicate search matches", async () => {
    const { repository, operations, policy } = configured();
    repository.seed({
      repository: REPOSITORY,
      title: "The scheduler loses a queued job",
      body: "Already tracked.",
    });
    repository.resetEvents();
    const create = createIssueManagementTools({ repository, operations, policy }).find(
      (tool) => tool.name === "github_create_issue",
    )!;

    await expect(
      create.run({
        input: {
          kind: "bug",
          title: "The scheduler loses a queued job",
          body: "Expected the queued job to run.",
        },
      }),
    ).resolves.toMatchObject({ status: "duplicate", issues: [{ number: 1 }] });
    expect(repository.events().map((event) => event.kind)).toEqual(["search"]);
    expect(operations.list()).toEqual([]);
  });

  it("allows a related but distinctly titled issue to proceed after the mandatory search", async () => {
    const { repository, operations, policy } = configured();
    repository.seed({
      repository: REPOSITORY,
      title: "Scheduler loses jobs during shutdown",
      body: "Related context: The scheduler loses a queued job under a different shutdown condition.",
    });
    repository.resetEvents();
    const create = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-related-distinct",
    }).find((tool) => tool.name === "github_create_issue")!;

    await expect(
      create.run({
        input: {
          kind: "bug",
          title: "The scheduler loses a queued job",
          body: "This distinct case occurs only after restart.",
        },
      }),
    ).resolves.toMatchObject({ status: "created", issue: { number: 2 } });
    expect(repository.events().map((event) => event.kind)).toEqual(["search", "create"]);
  });

  it("reconciles an uncertain create by Operation Identity without a second mutation", async () => {
    const { repository, operations, policy } = configured();
    repository.timeoutNextCreate({ afterMutation: true });
    const create = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-reconcile-1",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    }).find((tool) => tool.name === "github_create_issue")!;

    await expect(
      create.run({
        input: {
          kind: "feature",
          title: "Expose queue depth in status",
          body: "Operators need queue depth to diagnose backpressure.",
        },
      }),
    ).resolves.toMatchObject({
      status: "reconciled",
      operationId: "operation-reconcile-1",
      issue: { number: 1 },
    });
    expect(repository.events().filter((event) => event.kind === "create")).toHaveLength(1);
    expect(repository.events().filter((event) => event.kind === "find-operation")).toHaveLength(1);
    expect(operations.get("operation-reconcile-1")).toMatchObject({ status: "completed", issueNumber: 1 });
  });

  it("returns durable Uncertain state when observation proves nothing and never retries create", async () => {
    const { repository, operations, policy } = configured();
    repository.timeoutNextCreate({ afterMutation: false });
    const create = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-uncertain-1",
      now: () => new Date("2026-07-15T00:00:00.000Z"),
    }).find((tool) => tool.name === "github_create_issue")!;

    await expect(
      create.run({
        input: {
          kind: "bug",
          title: "The queue stalls",
          body: "The queue remains pending after admission.",
        },
      }),
    ).resolves.toMatchObject({ status: "uncertain", operationId: "operation-uncertain-1" });
    expect(repository.events().filter((event) => event.kind === "create")).toHaveLength(1);
    expect(repository.events().filter((event) => event.kind === "find-operation")).toHaveLength(1);
    expect(operations.get("operation-uncertain-1")).toMatchObject({ status: "uncertain" });
  });

  it("never records a successful provider create as failed when completion persistence fails", async () => {
    const repository = createFakeIssueRepository();
    const persisted = createIssueOperationStore(":memory:");
    const operations = {
      ...persisted,
      complete: () => {
        throw new Error("injected SQLite completion failure");
      },
    };
    const create = createIssueManagementTools({
      repository,
      operations,
      policy: createIssueManagementPolicy("acme/widgets", ["acme/widgets"]),
      createOperationId: () => "operation-ledger-failure",
    }).find((tool) => tool.name === "github_create_issue")!;

    await expect(
      create.run({
        input: {
          kind: "feature",
          title: "Show queue health",
          body: "Operators need a queue health signal.",
        },
      }),
    ).resolves.toMatchObject({
      status: "uncertain",
      operationId: "operation-ledger-failure",
      issue: { number: 1 },
    });
    expect(repository.events().filter((event) => event.kind === "create")).toHaveLength(1);
    expect(persisted.get("operation-ledger-failure")).toMatchObject({ status: "uncertain" });
  });

  it("records a definite provider update failure after exactly one mutation attempt", async () => {
    const { repository, operations, policy } = configured();
    const issue = repository.seed({ repository: REPOSITORY, title: "Original", body: "Body" });
    repository.resetEvents();
    repository.failNextUpdate(new Error("GitHub rejected the update"));
    const update = createIssueManagementTools({
      repository,
      operations,
      policy,
      createOperationId: () => "operation-update-failed",
    }).find((tool) => tool.name === "github_update_issue")!;

    await expect(update.run({ input: { number: issue.number, title: "Requested" } })).rejects.toThrow(
      "GitHub rejected the update",
    );
    expect(repository.events().filter((event) => event.kind === "update")).toEqual([
      expect.objectContaining({ operationId: "operation-update-failed", outcome: "failed" }),
    ]);
    expect(operations.get("operation-update-failed")).toMatchObject({
      kind: "update-issue",
      issueNumber: issue.number,
      status: "failed",
    });
  });

  it("never records a successful provider update as failed when completion persistence fails", async () => {
    const repository = createFakeIssueRepository();
    const issue = repository.seed({ repository: REPOSITORY, title: "Original", body: "Body" });
    const persisted = createIssueOperationStore(":memory:");
    const operations = {
      ...persisted,
      complete: () => {
        throw new Error("injected SQLite completion failure");
      },
    };
    const update = createIssueManagementTools({
      repository,
      operations,
      policy: createIssueManagementPolicy("acme/widgets", ["acme/widgets"]),
      createOperationId: () => "operation-update-ledger-failure",
    }).find((tool) => tool.name === "github_update_issue")!;

    await expect(update.run({ input: { number: issue.number, title: "Corrected" } })).resolves.toMatchObject({
      status: "uncertain",
      operationId: "operation-update-ledger-failure",
      issue: { number: issue.number, title: "Corrected" },
    });
    expect(repository.events().filter((event) => event.kind === "update")).toHaveLength(1);
    expect(persisted.get("operation-update-ledger-failure")).toMatchObject({
      kind: "update-issue",
      issueNumber: issue.number,
      status: "uncertain",
    });
  });

  it("registers only bounded direct issue tools without model-controlled Operation Identity or administration", async () => {
    configured();
    const config = await ambience.initialize({ id: CHAT, env: {} });
    expect(config.skills?.map((skill) => skill.name)).toEqual(["whatsapp-participation", "issue-management"]);
    await expect(
      readFile(join(process.cwd(), "src/capabilities/issue-management/SKILL.md"), "utf8"),
    ).resolves.toContain('version: "1.1.0"');
    expect(config.tools?.map((tool) => tool.name)).toEqual([
      "say",
      "whatsapp_read_thread",
      "whatsapp_search",
      "github_search_issues",
      "github_read_issue",
      "github_list_issue_options",
      "github_create_issue",
      "github_update_issue",
    ]);
    const create = config.tools?.find((tool) => tool.name === "github_create_issue");
    expect(create).toBeDefined();
    if (create === undefined) throw new Error("Expected the Issue Management create Tool");
    expect(
      v.parse(create.input as v.GenericSchema, {
        operationId: "model-injected",
        title: "x",
        body: "y",
        kind: "bug",
      }),
    ).not.toHaveProperty("operationId");
    expect(JSON.stringify(create.input)).not.toContain("operationId");
    const update = config.tools?.find((tool) => tool.name === "github_update_issue");
    expect(update).toBeDefined();
    if (update === undefined) throw new Error("Expected the Issue Management update Tool");
    expect(
      v.parse(update.input as v.GenericSchema, {
        number: 1,
        body: "",
        operationId: "model-injected",
      }),
    ).toEqual({ number: 1, body: "" });
    expect(() =>
      v.parse(update.input as v.GenericSchema, {
        number: 1,
        body: "x".repeat(MAX_PUBLIC_ISSUE_BODY_LENGTH + 1),
      }),
    ).toThrow();
  });

  it("deletes the discarded proof workflow and provider path", async () => {
    for (const obsolete of [
      "src/github/proof-contract.ts",
      "src/github/proof-operation.ts",
      "src/github/proof-runtime.ts",
      "src/host/github-proof-host.ts",
      "src/host/fake-github-proof-host.ts",
      "src/tools/workflows/start-github-proof.ts",
      "src/workflows/github-proof.ts",
      "tests/fixtures/ambience/src/workflows/github-proof.ts",
      "tests/ambience/github-proof.test.ts",
    ]) {
      await expect(stat(join(process.cwd(), obsolete))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

describe("Issue Management operation schema", () => {
  it("transactionally migrates create-only records before accepting update identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-issue-operations-"));
    const path = join(root, "application.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE github_issue_operations (
          operation_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind = 'create-issue'),
          repository TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('attempting', 'completed', 'uncertain', 'failed')),
          issue_number INTEGER,
          error TEXT,
          started_at TEXT NOT NULL,
          settled_at TEXT
        ) STRICT;
        INSERT INTO github_issue_operations
          (operation_id, kind, repository, status, issue_number, started_at, settled_at)
        VALUES ('legacy-create', 'create-issue', 'acme/widgets', 'completed', 7,
                '2026-07-15T00:00:00.000Z', '2026-07-15T00:00:01.000Z');
      `);
      legacy.close();

      const operations = createIssueOperationStore(path);
      expect(operations.get("legacy-create")).toMatchObject({
        kind: "create-issue",
        issueNumber: 7,
        status: "completed",
      });
      expect(
        operations.begin({
          operationId: "new-update",
          kind: "update-issue",
          repository: "acme/widgets",
          issueNumber: 7,
          target: { title: "Correct title" },
          startedAt: "2026-07-15T01:00:00.000Z",
        }),
      ).toMatchObject({
        operationId: "new-update",
        kind: "update-issue",
        issueNumber: 7,
        target: { title: "Correct title" },
        status: "attempting",
      });
      operations.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
