# Coder green in a local sandbox — T3 (#251) receipt

Date: 2026-07-20

Ticket: #251 · Plan: `docs/planning/ONE-BOX-PLAN-2026-07-20.md` § T3 · PR: #266
(into `claude/single-box-working`, **not** main)

Code commit under test: `28ac2ae` on `claude/t3-sandbox-selector-9c0eae`.

> **Status: code + acceptance done; the instrument is NOT yet redeployed, so the
> gate has NOT run.** Every gate/deploy row below is marked ❌ because it has not
> been observed. This file will be completed after the PR merges, the instrument
> is re-packed and redeployed, and the gate runs from the managed chat. Nothing
> here is marked ✅ that was not actually seen.

## What landed

The sandbox selector, exactly per § T3:

- `runtime.sandbox = {kind: "local" | "e2b", template?}`, default `local`
  (`packages/installation/src/schema.ts`), following the `runtime.port` pattern:
  validator + creation default + the `CONFIG_ISSUE_PATHS` dotted paths
  (`runtime.sandbox`, `runtime.sandbox.kind`, `runtime.sandbox.template` —
  `installation.ts`) + a `--sandbox` CLI flag + the runtime read.
- One resolver returns the sandbox **and** its `workspacesRoot` together
  (`packages/installation/src/agent-sandbox.ts`): `local()` from
  `@flue/runtime/node` paired with the host `paths.workspaces`; `e2b` paired with
  the in-VM `E2B_WORKSPACES_ROOT`. The #172 workspace-local `TMPDIR` is restored
  for the local branch (`mkdir` before first use). The e2b branch threads an
  explicit `apiKey` into `Sandbox.create`.
- All **five** silent-disable paths removed (closes #247): both
  `if (sandbox === undefined)` guards in `apps/runtime/src/app.ts`; the CLI
  resolver now throws instead of returning `undefined` when `e2b` is selected
  with no key; and a missing or mispasted Coder/Reviewer App credential fails
  boot loudly via `readProvisionedGitHubAppCredential`. The Reviewer's App-slug
  network lookup stays resilient (transient GitHub failure → unprovisioned +
  warn, not a boot brick).

## Acceptance — observed, runnable with no install, no key, no phone

Run at commit `28ac2ae`:

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | ✅ green (`tsc --noEmit` + api + web check-types) |
| Full suite | `pnpm test` | ✅ 712 passed, 4 skipped, 0 failed |
| `--sandbox` round-trips | `tests/managed/cli.test.ts` "selects the agent sandbox from the CLI and round-trips local\|e2b" | ✅ init → local; `config --sandbox e2b` → e2b; back to local; `--sandbox docker` refused before any write |
| Schema default + validation | `tests/managed/schema.test.ts` "defaults the agent sandbox to local…" | ✅ default local, e2b+template round-trips, unknown kind / unknown field / blank template refused |
| Resolver: local | `tests/managed/agent-sandbox.test.ts` | ✅ workspacesRoot = host workspaces; `.tmp` created before first use |
| Resolver: e2b | same | ✅ workspacesRoot = `E2B_WORKSPACES_ROOT` when a key is present |
| **Negative — sandbox misconfigured** | same | ✅ `resolveAgentSandbox({kind:"e2b"})` with no key **throws** (`/E2B_API_KEY/`) — the non-zero-exit mechanism, not a log line |
| **Negative — App credential misconfigured** | `tests/managed/configuration.test.ts` "fails loudly and nameably…" | ✅ `readProvisionedGitHubAppCredential` **throws** on missing and on mispasted (present-but-malformed), naming the role; reads a well-formed one back |
| e2b apiKey threaded | `tests/reviewer/e2b-sandbox.test.ts` | ✅ explicit `apiKey` + `template` reach `Sandbox.create` |

The two negatives assert the **throw** (a rejected promise), which is what makes
`startGeneratedRuntime` / the server module's top-level `await` reject and the
process exit non-zero. They do not assert a log line.

## Pre-flight — sandbox shell, model-independent — ✅ observed

The Coder is a server-embedded Flue workflow; it cannot be driven standalone
without forking `createAmbientAgentApp`'s runtime composition and a live model
key, so the model-driven half of the pre-flight is folded into the gate (a small
task on this repo from the managed chat — no throwaway repo). The
**model-independent** half — does the resolved local sandbox actually run the
model's shell — is proven here and needs no model, GitHub, or key:

`tests/coder/local-sandbox-shell.test.ts` (runs in the normal suite):

| In the local sandbox | Observed |
|---|---|
| `$TMPDIR` | `<workspaces>/.tmp` — workspace-local, not `/tmp` (the #172 fix) |
| write + `chmod +x` + run a binary from `$TMPDIR` | exit 0, prints `ran-from-tmpdir` — the scenario that failed `EACCES` on `noexec /tmp` |
| `node --version` | exit 0, resolves on the host PATH `local()` keeps |

Demonstrated live (2026-07-20, local dev host) additionally running
`npx fallow --help` inside the sandbox → exit 0. The owner can run
`pnpm vitest run tests/coder/local-sandbox-shell.test.ts` on `capxul-vps` to
confirm the shell layer there before the model-driven gate; capture
`mount | grep /tmp` alongside it (exec-mounted on that box).

## Re-deploy the instrument — ❌ NOT DONE

The live instrument on `capxul-vps` (unit `ambient-agent`, port 3737) still runs
**pre-T3** code (commit `6c6067d`), where `start_coder_job` is
mounted-but-unprovisioned. Nothing below can run until this PR merges and the
instrument is re-packed from a commit containing the T3 code and reinstalled
(via the packed tarball, **not** Docker — its `CMD` is the deleted provisioner).

| Step | Status |
|---|---|
| Pack from a commit containing merged T3 code; record commit + tarball SHA-256 | ❌ not done |
| `scp` + `npm install -g` the tarball on `capxul-vps` | ❌ not done |
| `config --sandbox local`; `systemctl restart`; `curl :3737/health → ok:true`, whatsapp online | ❌ not done |

## The gate (live instance, from the managed chat) — ❌ NOT RUN

From the `Tst` chat, a small well-specified task. Assert **all** of:

| Assertion | Status |
|---|---|
| Real **non-draft** PR by `ambient-coder[bot]` on `AaronAbuUsama/ambient-agent` | ❌ not observed |
| **Non-empty diff** | ❌ not observed |
| `verdict === "PASS"` (asserted **together** with non-empty diff — a legitimate SKIP also yields a non-draft PR) | ❌ not observed |
| Produced in a **local** sandbox with **no E2B key** present | ❌ not observed |
| PR **references the real GitHub issue** filed by the same chat request | ❌ not observed |

**Layer-naming instrumentation to record alongside the verdict** (so a failure
names its layer): whether sandbox `exec` succeeded, and `mount | grep /tmp` from
inside the sandbox. On `capxul-vps` `/tmp` is exec-mounted, so a green run here
does **not** validate #172, and a Coder failure here is **not** #172 — it is the
model, the workspace wiring, or the App-credential path.

If any run reports reason `rate-limited` (#246), that run is **INCONCLUSIVE** —
never PASS, never FAIL — and is re-run, not chased as a regression.

## Deferred T2 leg — ❌ NOT RUN (unblocked once T3 is green)

`kill -9` an in-flight Coder job on the box → the run settles `interrupted`, the
message reaches the thread, and no relaunch happens without a user turn
(`sweepUnsettledLaunches`, `apps/runtime/src/app.ts`). Requires a live Coder run
to interrupt, so it re-runs as a T2 gate leg after the gate above.

## Honest verdict

Code and acceptance: ✅. Everything requiring the live, redeployed instrument
(deploy, gate, deferred T2 leg): ❌ not yet observed. T2 + T3 green together are
the milestone; this receipt records only the half that has been proven so far.
