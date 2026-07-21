# Code-reviewer agent + identity-prompt extraction

## Context

The product currently has one Flue agent (`ambience`). We're adding a second: **code-reviewer**, a GitHub-event-driven agent that reviews every non-draft `pull_request.opened` on routed repos and posts one review back to GitHub. The implementer agent is explicitly **dropped for now** (ratified 2026-07-17).

Ratified decisions:
- `.agents/skills/` is for coding agents working on this repo — **not** a source for product-agent skills. The reviewer gets a purpose-built **capability** (`pull-request-review`) with its own SKILL.md and tools, following the ratified shared-capabilities pattern (`docs/planning/SHARED-CAPABILITIES-SPEC.md`): capability = SKILL.md + references + tools.ts + port/runtime; capabilities never import agents (enforced by `tests/ambience/hard-cut.test.ts`).
- Reviewer reviews **every** non-draft opened PR (no gate).
- Use Flue's built-in sandbox support to give the reviewer a repo checkout (review with surrounding code, not just the API diff).
- Agent identity prompts move out of loose strings into colocated markdown; evals go in `packages/test-support/src/evals/` per ADR-0003 (drive the production Flue interface).

Key verified runtime facts:
- Flue is natively multi-agent: `apps/server/src/agents/<name>.ts` default-exporting `defineAgent` is discovered by filename; `dispatch({ agent, id, input })` (named overload) targets by name.
- The flue bundler resolves `import x from "./identity.md" with { type: "markdown" }` to a raw string (`@flue/cli` `flue-import-attributes` plugin).
- `@flue/runtime/node` ships `local({ cwd, env }): SandboxFactory`; `AgentRuntimeConfig` accepts `sandbox` + `cwd`.
- Model provider is registered once at boot; reuse `AMBIENCE_MODEL_SPECIFIER` (`packages/engine/src/model/pi-subscription.ts`).

## Slice 1 — identity markdown extraction (tiny, zero behavior change)

- `packages/agents/src/flue-markdown.d.ts` — ambient decl: `declare module "*identity.md" { const text: string; export default text; }` (sibling of `flue-skill.d.ts`; no collision with `*SKILL.md`).
- `packages/agents/src/ambience/identity.md` — the 4 lines currently at `packages/agents/src/ambience/agent.ts:17-20`, verbatim.
- `agent.ts` → `import identity from "./identity.md" with { type: "markdown" };` … `instructions: identity`.
- Proves the markdown import through the real `flue build`.

## Slice 2 — `pull-request-review` capability (no agent yet)

`packages/agents/src/capabilities/pull-request-review/`, cloning the `issue-management` shapes:

- **`pull-request-repository.ts`** (port):
  - `getPullRequest(repo, number)` → meta + changed-file list
  - `getDiff(repo, number)` → unified diff string
  - `createReview(repo, number, { body, event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE", comments?: {path, line, body}[] })` → `{ url }`
- **`runtime.ts`** — global-symbol singleton (`Symbol.for("ambient-agent.pull-request-review-runtime")`) holding `{ repository, policy }`; **reuse** `IssueManagementPolicy` for the repo allowlist (`packages/agents/src/capabilities/issue-management/runtime.ts:14-31`) — no second policy type.
- **`tools.ts`** — three tools via `defineTool` + valibot (same shape as `issue-management/tools.ts`): `github_read_pull_request`, `github_read_pull_request_diff` (byte-capped, truncation noted in output), `github_post_pull_request_review`. No operation-store idempotency in v1 — a duplicate review is annoying, not corrupting (`ponytail:` comment the ceiling; upgrade = operation-identity lifecycle like issue creation).
- **`SKILL.md`** — tiny frontmatter (name/description/version) + ~25 lines of review policy: one review per PR; when COMMENT vs REQUEST_CHANGES; ground findings in code actually read (diff + checkout); agent-neutral wording from day one. Crib the portable prose (two-axis framing, smell baseline) from `.agents/skills/code-review/SKILL.md` but rewrite tool-oriented — do not copy its sub-agent/CLI mechanics.
- **Octokit impl**: `packages/installation/src/github-pull-request-repository.ts` mirroring `github-issue-repository.ts` — `pulls.get` (plain + `mediaType: { format: "diff" }`), `pulls.listFiles`, `pulls.createReview`.
- **Fake**: `packages/test-support/src/fake-pull-request-repository.ts` with an event log, sibling of `fake-issue-repository.ts`.
- Extend the hard-cut test to cover the new capability directory.

## Slice 3 — code-reviewer agent + workspace + ingress routing + eval

### Agent
- `packages/agents/src/code-reviewer/identity.md` — reviewer identity (~5 lines: one PR per session, read meta/diff/checkout via tools+sandbox, post exactly one review via the review tool; final prose is private).
- `packages/agents/src/code-reviewer/agent.ts`:
  ```ts
  export default defineAgent(async ({ id }) => {
    const workspace = await getReviewerWorkspaceRuntime().prepare(id); // checkout at PR head
    return {
      model: AMBIENCE_MODEL_SPECIFIER,
      thinkingLevel: "medium",
      skills: [pullRequestReview],
      tools: createPullRequestReviewTools(),
      instructions: identity,
      sandbox: workspace.sandbox,  // flue built-in local({ cwd })
      cwd: workspace.cwd,
    };
  });
  ```
- `packages/agents/src/code-reviewer/workspace-runtime.ts` — port + configure/get singleton (same pattern as capability runtimes): `prepare(instanceId) → { cwd, sandbox }`.
- Production impl `packages/installation/src/reviewer-workspace.ts`: parse `owner/repo#pr-N` instance id; workdir under `join(paths.data, "workspaces", ...)`; clone/fetch + checkout the PR head ref; token used for clone/fetch only and scrubbed from the remote URL — **no** `GH_TOKEN` in the sandbox env (reviewer never pushes). `ponytail:` note — `local()` runs on the host; remote sandbox adapter is the isolation upgrade path.
- Discovery stub `apps/server/src/agents/code-reviewer.ts`: `export { default, description } from "@ambient-agent/agents/code-reviewer/agent.ts";` (mirrors `agents/ambience.ts`). Instance id: `${owner}/${repo}#pr-${number}` — one Flue session per PR, so redeliveries land in the same session.

### Ingress routing (`packages/engine/src/github/ingress.ts`)
- Widen the dispatch seam: `dispatch: (request: { agent: "ambience" | "code-reviewer"; id: string; input: GitHubIngressInput }) => Promise<DispatchReceipt>`. Routing stays inside ingress where payload knowledge lives.
- `pull_request.opened` (branch at `ingress.ts:240`): always dispatch code-reviewer first (skip drafts); the existing correlation gate (`:259-275`) then decides whether to *also* dispatch ambience (unchanged); the former "uncorrelated" early-return becomes reviewer-only "done". The "deferred" correlation branch defers only the ambience dispatch.
- `issues.opened`: unchanged (ambience only).
- Widen the hardcoded `ambience: "ambience"` literals (`ingress.ts:93, 312, 321, 331, 341, 352`) and `GitHubIngressStore.settle`'s done-variant (`ingress-store.ts:55-73`) to `agents: string` (comma-joined). Keep the sqlite column name to avoid a migration (`ponytail:` note).
- `apps/server/src/app.ts:47` adapter: `agent === "ambience" ? dispatchAmbience({id, input}) : dispatch({ agent, id, input })` (named flue overload).
- `composeAmbience` (`packages/agents/src/ambience/compose.ts`) grows two adapter fields: `pullRequests` (→ `configurePullRequestReviewRuntime`) and `reviewerWorkspace` (→ `configureReviewerWorkspaceRuntime`). Rename to `composeAgents` in this slice (mechanical).

### Eval (deterministic v1, ADR-0003)
- Fixture: add `tests/fixtures/ambience/src/agents/code-reviewer.ts` stub; fixture `app.ts` composes `createFakePullRequestRepository` + a fake workspace runtime (temp-dir checkout over a scripted toy git repo).
- Seam routes in fixture app: `POST /test/github/pulls` (seed PR), `GET/DELETE /test/github/pull-events` (recorded reviews), `POST /test/github/deliver` (feed a synthetic `GitHubWebhookDelivery` through the real ingress handler, return the `GitHubIngressResult`) — webhook in, review out is the production interface.
- Small `createGitHubIngressEvalHarness` wrapper (deliver → poll `/test/submission` → collect pull-events) in `packages/test-support/src/evals/`; leave `createFlueAgentHarness` untouched.
- `packages/test-support/src/evals/code-review.eval.ts`: PR opened → exactly one `github_post_pull_request_review` recorded. `scripts/run-evals.ts` unchanged (same fixture root).

## Deferred (explicitly out of scope)

- Implementer agent entirely (dropped; revisit later — needs sandbox isolation + gating decisions).
- Live rubric eval for the reviewer (`code-review.live.eval.ts` via `rubric-judges.ts`).
- Activity-reporter lifecycle events for GitHub-dispatched agents (`activity-reporter.ts:248` ignores non-window inputs) — chat announcements of reviews are a feature for later.
- Remote/isolated sandbox; Phase-2 agent-neutral wording pass on issue-management prose.

## Verification

- Slice 1: `flue build` (or `pnpm evals deterministic`) proves the markdown import; full test suite green.
- Slice 2: capability unit tests + hard-cut test; typecheck.
- Slice 3: `pnpm evals deterministic` runs `code-review.eval.ts` end-to-end through the fixture (webhook delivery → ingress → dispatch → agent → posted review recorded by fake). Then live: deliver a real `pull_request.opened` webhook to the VPS runtime against a scratch repo and confirm one review posted on the PR.
