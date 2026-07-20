# One box, working end to end

**2026-07-20.** Supersedes the staged rebuild in `REBUILD-PLAN-2026-07-19.md` as the *active* plan.
That document stays for its measured findings; this one is what gets built.

## The goal, in one sentence

**One VPS, one instance, one operator. A message in WhatsApp produces a real reply, files a real
GitHub issue, and opens a real PR — and survives a reboot.**

Everything else is deferred: multi-tenancy (dropped), the web app (later), E2B (later), billing
(later), backup (later).

## Owner decisions this plan encodes

Confirmed directly, 2026-07-19 → 2026-07-20:

1. **Single instance.** No tenants. Two companies live inside it as chats + GitHub orgs.
2. **No environment variables.** Everything configurable through the CLI into managed config.
3. **Deploy on the VPS**, not the laptop. Handoff to an agent working on the box.
4. **One sandbox**, shared by Coder and Reviewer.
5. **Local sandbox is acceptable.** Single operator, nobody else in the group, far from SaaS.
6. **Inference comes from an API key** — no subscription is available. The owner has an OpenAI key
   with **limited funds**, so a cheap model for now and not production-ready. Minimum viable.
7. **Issues must work.** Filing a GitHub issue from chat is part of "working".

## What is actually true today — measured, not assumed

| Claim | Reality |
|---|---|
| "The Reviewer uses a Docker sandbox" | **False.** `bc93fb9` deleted `reviewer-docker-sandbox.ts` and its test. Zero docker sandbox references remain. |
| "Coder and Reviewer need unifying" | **Already unified.** `apps/runtime/src/app.ts:112-113` passes one factory to both; `coder/runtime.ts:14-18` and `reviewer/runtime.ts:5-9` are byte-identical on the sandbox field. |
| "The Coder is blocked on the E2B key" | **False.** `local()` (`@flue/runtime/node`, `dist/node/index.d.mts:45`) is a complete `SandboxFactory`, still installed, currently with **zero imports**. `bc93fb9` deleted the call site that used it. |
| "The CLI depends on the web/SaaS stack" | **False.** Traced transitively from `apps/cli/src/main.ts`: 48 files, reaching only `apps/cli`, `packages/engine`, `packages/installation`, `packages/agents`. F-3/F-4 do not block the CLI. |
| "The CLI needs env vars to run" | **False.** Zero required. Only 6 optional ones matter and all 6 move to config here. |
| "We need a tunnel for the demo" | **False for outbound.** WhatsApp → Speaker → Coder → PR is entirely outbound. A tunnel is only needed for GitHub → agent. |
| "pi can reuse a `pi login` on the box" | **False.** `pi-ai` is a library with no credential storage; `loadAnthropicOAuth` only imports the flow module. The app owns the store — as this repo already does for ChatGPT. |
| "Nothing has been proven" | **False.** WhatsApp pairing + sends, session survival across restart, real signed webhook delivery, a real draft PR from `ambient-coder[bot]`, and a self-cleaning live GitHub issue test all have receipts. |
| "It has been run end to end" | **False, and this is the real gap.** Every receipt is piecemeal, on the `code-factory` rig, via a packed tarball. No completed install exists anywhere. |

## The one rule, unchanged

**Every gate is a real-world proof, and every gate asserts a negative.** The dominant failure mode
here is silent degradation. Two live instances of it, both fixed below:

- **The Reviewer fabricates a review on model silence** — `reviewer/workflow.ts:143-153` posts a real
  GitHub review with `missingModelVerdict = true` and returns non-error success, shaped identically
  to a genuine COMMENT.
- **No 429 handling exists anywhere** — `pi-subscription.ts:247-257` classifies a rate limit as
  `request-failed`, indistinguishable from a network blip.

---

# The order

```
M1 API-key provider ──▶ M2 Sandbox selector ──▶ M4 Run it on the box ──▶ M5 Inbound GitHub
        │                        │                        │
        └──▶ M3 Env → CLI config ┘                        └──▶ M6 Eyes on it
```

**M1 is first because nothing else can be verified without inference.** Every downstream gate drives
the model.

## How each ticket is accepted — no ceremony until M4

The implementing agent works on a remote machine with **no install, no paired phone, and no
secrets**. No completed install exists anywhere yet, so any gate phrased as "message the managed
chat" is unrunnable until M4. Every ticket therefore has a proof the agent can produce alone, plus
**one command the owner runs**.

| Tier | Who | Needs |
|---|---|---|
| **A** | the agent | nothing — typecheck, tests, config round-trip, the negative assertions |
| **B** | the owner, one command | an API key (and for M2, a throwaway repo). **No WhatsApp, no install.** |
| **C** | deferred to M4 | the WhatsApp round trip — needs the one-time pairing ceremony |

Tier B follows the gated live-test pattern already in the tree
(`tests/speaker/pi-subscription.test.ts:320-341`, `tests/speaker/issue-management.live.test.ts`),
which needs only a data directory and a credential. `AMBIENT_AGENT_LIVE_*` stays an environment
variable by design — the no-env-vars rule governs **runtime config**, not test harnesses.

**A green Tier B is the signal to start the next ticket.** The pairing ceremony happens once, in M4,
where it belongs.

## M1 · Make the model provider an API-key choice

No subscription is available and funds are tight. Without this, nothing else can be verified — every
downstream gate drives the model.

Originally scoped as "add Anthropic". It is now the general case, because the owner has switched
provider twice in one sitting (ChatGPT subscription → Anthropic → OpenAI API key). The variation is
real, so the seam is earned — and supporting any provider is **less** code than special-casing one.

**Why it is small:** pi ships **38 providers**, nearly all API-key, through one `createProvider`
shape:

```js
// pi-ai/dist/providers/openai.js
id: "openai", baseUrl: "https://api.openai.com/v1",
auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
api: openAIResponsesApi(),
```

`anthropic`, `groq`, `deepseek`, `cerebras`, `openrouter`, `google`, `together`, `xai` are the same
shape. Their apis (`openai-responses`, `anthropic-messages`, …) are **built-in** Flue api ids
(`pi-ai/dist/compat.js:136` `registerBuiltInApiProviders()` at import), so there is **no
`registerApiProvider`** — only `registerProvider`.

**Leave the Codex subscription path alone.** `connectPiChatGptSubscription` and the Luna rewrite
(`pi-subscription.ts:116-190`, gated on the Codex URL and model id at `:120`,`:168`) stay exactly as
they are, for whenever a subscription returns. This adds a second, simpler path beside it.

`pi-ai` is a library with **no credential storage** — the app owns the store, as it already does for
ChatGPT. There is no `pi login` to reuse.

| File | Change | ~Lines |
|---|---|---|
| `packages/installation/src/schema.ts:49-54` | `provider` accepts a pi provider id; add an `api-key` credential reference; `v.check` pairing provider and credential | 14 |
| `packages/installation/src/paths.ts:16-27,80-90` | `credentials/model-api-key.json` — `{schemaVersion:1, provider, apiKey}` | 5 |
| `packages/engine/src/model/pi-subscription.ts:40,297-321` | `modelSpecifier(provider, id)` (`:40` hardcodes `openai-codex`); `connectPiApiKeyProvider(providerId, apiKey, baseUrl)`, `registerProvider` only | 35 |
| `apps/runtime/src/app.ts:102` | branch: api-key provider vs codex subscription | 6 |
| `apps/cli/src/program.ts` | `config --model-provider <id>`, key via **prompt, not flag** | 20 |

**Gate:** with `provider: "openai"` and a real key, a message to the managed chat gets a real reply.
Record model id, turns, tokens, wall time and cost.
**Negative:** with the credential file absent the runtime must **exit non-zero at start**, not boot
and settle silent. Assert the exit code, not a log line. Second negative: a provider/credential
mismatch is refused at **config-write** time (`configuration.ts:66` re-validates and rolls back), not
discovered at first inference.
**Receipt:** `docs/proof/api-key-inference-live.md`.
**Rollback:** `config --model-provider openai-codex` returns to the untouched subscription path.
Schema changes are `v.optional(…, default)`, so existing configs parse unchanged.

## Running on a budget model

Funds are limited, so gates run on a mid-tier model — `gpt-5.4-mini` or `gpt-5.1-codex-mini` class.
**That is a capable coding model.** It will write a small correct diff, open a PR and review one.
Gates assert real outcomes; nothing is deferred on the assumption the model cannot cope.

Two practical adjustments, and that is all:

1. **Give the first green run a well-specified small task.** Add a file, fix a bug with an obvious
   fix, add a small function with a test. The point of the first run is to prove the loop closes, so
   do not make the task the variable under test.
2. **Instrument the run so a failure names its layer.** If a run fails, we need to know whether the
   sandbox `exec` failed (#172, `/tmp` `noexec`, `EACCES` — a filesystem fact) or the model produced
   a bad diff. Record the sandbox mount flags and whether `exec` succeeded *alongside* the verdict.
   This costs nothing and is the difference between a useful failure and an ambiguous one.

**Per-role profiles are the cost lever.** `AgentModelProfilesSchema` already supports a model per
role (`resolveAgentModelProfile`, `pi-subscription.ts:46-49`). The Speaker can sit on something
cheaper than the Coder — chat replies are less demanding than writing a diff.

## M2 · One sandbox, selectable, config-driven

Unblocks the Coder and Reviewer without E2B. Owner has accepted the local-shell exposure (single
operator, his own repos, attended).

The resolver must return **sandbox and `workspacesRoot` together** — `workspacesRoot` is hardcoded to
`E2B_WORKSPACES_ROOT` (`/home/user/workspaces`, `e2b-sandbox.ts:13`), which does not exist on a host.
With `local` it must be `paths.workspaces` (`paths.ts:94`).

Use `local(options?)` from `@flue/runtime/node` — **verified**, and exactly what `bc93fb9` deleted.
Not `bash(factory)`, which is the lower-level adapter.

| File | Change | Δ |
|---|---|---|
| `packages/installation/src/schema.ts:57-60` | `runtime.sandbox` = `{kind: "local"\|"e2b", template?}`, default `local` | +8 |
| `apps/cli/src/lifecycle.ts:36-42` | takes config not env; returns `{sandbox, workspacesRoot}` | +12/−10 |
| `packages/installation/src/e2b-sandbox.ts:190` | explicit `apiKey` into `Sandbox.create` (SDK supports it) | +4 |
| `packages/installation/src/runtime-dependencies.ts:20` | carry the pair, non-optional | +3/−4 |
| `apps/runtime/src/app.ts:18,48-84` | drop the E2B import and **both** `if (sandbox === undefined)` guards | +6/−14 |

**The `app.ts` diff is negative** — the two silent-disable paths disappear, because a sandbox is
always available. That closes the boot-green-with-specialists-absent hole for free.

**Retain #172's fix:** `TMPDIR` must point inside the workspace, not `/tmp` (which is `noexec` on the
rig). `e2b-sandbox.ts:146,214` already does this for E2B; the local branch needs the same.

**Gate:** from the managed chat, ask for a small well-specified code change. A real non-draft PR
appears with a non-empty diff, authored by `ambient-coder[bot]`, produced in a local sandbox with no
E2B key present, and the verifier returns `PASS`.

**Negative:** assert `verdict === "PASS"` **and** a non-empty diff — draft-ness alone proves nothing,
since a legitimate `SKIP` also yields a non-draft PR. And the process must **not** boot green with
the sandbox misconfigured.

**Record alongside the verdict, so a failure names its layer:** whether the sandbox `exec` succeeded,
and the mount flags from inside the sandbox (`mount | grep /tmp`). A green run on an exec-mounted
`/tmp` proves nothing about #172, and a failed run is only useful if we know whether the shell or the
model was at fault.

**Receipt:** `docs/proof/coder-green-local.md`. **This is the thing that has never worked.**

## M3 · Env vars → CLI config

Hard requirement: no environment variables. Only **6** actually matter.

| Var | Destination |
|---|---|
| `E2B_API_KEY` | `credentials/e2b.json` (secret) |
| `E2B_TEMPLATE` | `runtime.sandbox.template` (M2) |
| `BRAINTRUST_TRACING` | `runtime.tracing.enabled` |
| `BRAINTRUST_API_KEY` | `credentials/braintrust.json` (secret) |
| `BRAINTRUST_PROJECT_NAME` / `_ID` | `runtime.tracing.project` |

Everything else is test-only (`*_FIXTURE_READY`, `*_LIVE_*`, `FLUE_BASE_URL`) and **stays an env
var**, or dies with the provisioner (`TENANT_DB_*`, `AMBIENT_AGENT_RUNTIME_*`, `PORT`,
`packages/env/src/server.ts`).

**Follow the `runtime.port` pattern exactly** — it is the worked example, five steps:
validator+field (`schema.ts:27,58-60`) → creation default (`:126-137`) → **`CONFIG_ISSUE_PATHS`
(`installation.ts:26-57`) — the most-forgotten step** → CLI flag + merge
(`program.ts:341-346,483,494-506`) → runtime read (`lifecycle.ts:70,92`).

**One structural change:** `braintrust.ts:7,9,22` reads env at **module-load time**, which cannot see
a config file read later. It becomes `configureBraintrustTracing({apiKey, project})` called from
`startGeneratedRuntime` beside `configureLogging` (`lifecycle.ts:64-68`).

**Migration: none.** Every addition is `v.optional(…, default)`, so existing configs parse unchanged
— the precedent is `runtime`, `profiles` and `reviewRepositories`. No `schemaVersion` bump.
If `E2B_API_KEY` is in the environment, print a warning naming `config --sandbox e2b`. Nothing more.

**Gate:** `env -i` (empty environment) + `ambient-agent start` runs fully configured — sandbox,
tracing and model all from `config.json` and `credentials/`.
**Negative:** setting `E2B_API_KEY` in the environment must **not** change behaviour. Assert config
wins, so the env path is genuinely dead rather than a silent fallback.

## M4 · Run it on the box, and survive a reboot

**Use the tarball, not Docker.** The tarball is the proven unit — every receipt uses
`npx --package=file:…ambient-agent-*.tgz`. `apps/runtime/Dockerfile`'s `CMD` is `dist/cli/setup.js`,
the deleted provisioner's entry, and has never run standalone. It also costs 5-6 GB to build on a box
with ~19 GB free at ~80%.

1. `pnpm install --frozen-lockfile && pnpm pack --pack-destination ./artifacts` (prepack runs
   `build:dist`). **Record the SHA-256** — every proof doc does.
2. `npm install -g ./artifacts/ambient-agent-*.tgz` on capxul-vps.
3. **`ambient-agent init` inside `tmux` over SSH.** SSH allocates a PTY so `program.ts:173-175` goes
   interactive. The QR renders as terminal ASCII (`qr.ts:12`, `small: true`); the ChatGPT/Anthropic
   step is a URL + code. `tmux` matters — `authenticationSignal()` is a 20-minute timeout and a
   dropped connection aborts setup.
4. `ambient-agent config --port <p>` — default 3000 collides with the compose `api` service.
5. **A systemd unit — ~12 lines that do not exist.** `Type=simple`, `Restart=always`, `User=`,
   `ExecStart=… start --log-format json`. `stopRuntimeOnSignal`
   (`apps/runtime/src/host/runtime-signals.ts`) already handles SIGTERM cleanly, so a supervisor
   works correctly; there just isn't one.

**Prerequisite (ceremony, not a gate):** someone points a phone at the terminal. There is **no
unattended WhatsApp pairing** — `first-run.ts:233-235` hard-aborts when `onPairing` fires
non-interactively. The only alternative is pairing elsewhere and importing with `--whatsapp-store`.

**Gate:** `systemctl restart`, then reboot the box; the agent comes back **without re-pairing** and
replies in the managed chat.
**Negative:** never run two replicas against one volume — Flue's durability forbids it. Assert the
second instance refuses or fails loudly rather than silently corrupting.
**Receipt:** `docs/proof/one-box-live.md`.

## M5 · Inbound GitHub

Only needed for GitHub → agent (issue comments, PR events, the Reviewer). Outbound already works
without it.

The proven shape is Cloudflare proxied A record → Caddy → `127.0.0.1:<port>`, route
`/channels/github/webhook`, `X-Hub-Signature-256` verified over exact bytes before parse, secret from
`credentials/github-planner.json` (auto-created by `ensureManagedGitHubWebhookSecret`,
`lifecycle.ts:71`). **Only the Planner App sends webhooks**; Coder and Reviewer are actors.

**Two unresolved items for the agent on the box — discovery, not assumption:**
- **Caddy vs Traefik.** capxul-vps runs Dokploy, which almost certainly owns 443. Nothing in the repo
  installs or configures Caddy; the Caddyfile exists only as a quoted block inside a proof doc.
  Traefik could reverse-proxy instead, but that combination has never been run.
- **The DNS record `ambient-agent.co-worker.tech` currently points at the code-factory rig.**
  Repointing it kills the one proven webhook path. Prefer a new hostname.

**Gate:** open a real issue in a real repo; the event is delivered, signature-verified, settles in
the ledger, and reaches the chat.
**Negative:** an unsigned probe returns **401** and lands no row.

## M6 · Eyes on it

Cheapest first. **Flue ships no UI** — `docs-api-routing-api.md:98`: *"Flue ships no admin HTTP
surface"*; `flue dev` is watch-mode only. So there is nothing to switch on there, but three things
are nearly free:

1. **Braintrust is already wired** at `apps/runtime/src/app.ts:3`, gated at `braintrust.ts:7`. Turn
   it on via M3's config and you get runs, model turns including the full prompt, tool calls and
   tasks in a hosted UI. Richest thing available, ~zero code.
2. **`export const runs`** on the coder + reviewer workflows and **`export const route`** on the
   Speaker — **3 lines total** — lights up `GET /runs/:runId` (SSE + `?meta`) and
   `GET /agents/speaker/:chatId`. Currently dark: `export const runs` has **zero hits** repo-wide.
3. **Logs already carry a stable `operatorEvent` field**
   (`speaker/activity-reporter.ts:48-71`): `tail -f … | jq 'select(.operatorEvent)'`.

**The graph has no viewer at all** (`graph/store.ts:152-178`; its only reader is
`computeGraphDigest`). Three SQL selects behind a read-only route would fix it. That is the smallest
high-value thing left, and it is **not** on the critical path.

**Gate:** a Coder run is observable end to end from an external surface while it happens.

---

# Deliberately not doing

- The web app (F-3/F-4 are real but the CLI sidesteps both entirely).
- E2B — the selector makes it a one-line config flip when the key arrives.
- Multi-tenancy, two GitHub orgs (#243/#249), billing.
- Backup/restore, a second-replica guard, a graph viewer, the Docker deploy unit.
- Anthropic OAuth — API key first; the flow is in pi when flat-rate matters.

# Known risks

- **macOS is unexercised** — every proof is Linux. Irrelevant if we go straight to the VPS, which is
  the plan.
- **The Coder green path may still not work.** The `TMPDIR` root cause (#172) is documented and the
  fix is restored, but it has never been observed green. M2 is the measurement.
- **`createWhatsAppAccount` is the riskiest surviving module** — cyclomatic 50, cognitive 60, and
  every existing test fakes it through `sessionFactory`.
- **Rate limits and the fabricated-review fallback** make live gates read as PASS when they should
  read as inconclusive. Fix before trusting any Reviewer gate.
- **`local()` puts credentials one `cat` away** — three GitHub App private keys, the model token, and
  the live WhatsApp session share the shell's mount namespace. Accepted by the owner for attended,
  single-operator use. Revisit before anything unattended or multi-party.
