# Grill report — rebuild plan revision 2

Date: 2026-07-19. Against `REBUILD-PLAN-2026-07-19.md` (revision 2), ADRs 0020–0024.

Seven questions were pressed, plus two re-derivations. Every finding below is evidence-backed;
where a claim could not be settled by reading, a spike was run and its output recorded. Nothing
here is inferred from a document asserting a thing to be true.

## Verdict on the DAG

**The DAG survives, with three corrections.** No stage is deleted; two are re-ordered, one is
split, and two gates are rewritten because they cannot fail as drafted.

The plan's own nominated "highest-stakes unknown" (F-1, de-globalisation) **resolves in the plan's
favour**. The thing that actually breaks is one the plan never doubted: **ADR 0022's per-tenant
Flue durable adapter does not exist and cannot be built as specified.**

| | Question | Verdict |
|---|---|---|
| 1 | Can `flue build` host the admin API? | ✅ **SOUND** — proven by a working spike |
| 2 | Two tenants, two ChatGPT accounts, one process? | ✅ **DE-GLOBALISABLE** — F-1 overstated |
| 3 | Flue libsql durable adapter per tenant? | ❌ **FALSE PREMISE** — no such adapter exists |
| 4 | Is the demo path E2B-free? | ✅ **YES**, two caveats |
| 5 | Will GitHub refuse the self-approval? | ❌ **GATE IS INCOHERENT** — untestable as written |
| 6 | Rate limits on one subscription | ⚠️ **UNMITIGATED, AND THE FLAKE READS AS PASS** |
| 7 | Is S6 too big? | ❌ **YES — and S6→S6b ordering is backwards** |
| A | Do apps/web's wizard screens survive? | ✅ **YES** — every deletion claim confirmed |
| B | Is the ~1,800-line demolition estimate right? | ❌ **LOW** — actual 2,158 source |

---

## Q1 · `flue build --target node` hosting better-auth + oRPC — SOUND

Retired by construction, not argument. A throwaway Flue root was built mounting `flue()` **plus**
the real `auth.handler` and the real oRPC `RPCHandler` from `@ambient-agent/api`:

```
flue build --target node --root <spike> --output dist  → built dist/server.mjs (2.0s)
node dist/server.mjs                                   → listening on :39117
curl /api/auth/get-session   → null            (real better-auth response)
curl -X POST /rpc/healthCheck → {"json":"OK"}   [200]
curl /runs/abc               → 404             (flue routes still mounted)
```

Two premises behind the worry were wrong:

- **The node target externalizes dependencies, it does not bundle them.**
  `docs-guide-targets-node.md:29`, `docs-ecosystem-deploy-node.md:115`. Declaring a dep in
  `apps/runtime/package.json` is the escape hatch for anything bundler-hostile.
- **The runtime already mounts caller-owned Hono routes.** `apps/runtime/src/app.ts:167-180`
  installs the smoke route and the bridge route; `host/bridge-route.ts:58` is a plain
  `(app: Hono)`. The *proven* GitHub webhook path already runs through exactly this mechanism.

`libsql`'s native `.node` binding is never reached — `packages/db` opens via `@libsql/client`,
already external. Top-level await is a non-issue: `app.ts:209` already ships it.

**S5's shape is correct.** Its real risks are wiring, not toolchain:
1. `apps/api/src/index.ts:129-140` calls `serve()` itself — must be **deleted**, not moved.
2. `apps/api/src/index.ts:101` is an `app.use("/*")` catch-all; mount it before `app.route("/", flue())`
   (`speaker/compose.ts:88`) or `/agents/*` and `/runs/*` stop resolving.
3. `apps/runtime/src/setup-server.ts` is a *second* non-Flue entry with its own `serve()`. **S5 must
   say which entry survives** — the plan does not.

## Q2 · Two ChatGPT accounts in one process — DE-GLOBALISABLE

F-1 says `pi-subscription.ts:297-321` "registers ONE provider process-wide". **The registry is a
keyed `Map`, not a single slot**, verified in `node_modules`:

- `@flue/runtime/dist/providers-CsCcTxMU.mjs:19` `const providersById = new Map();`
  `:44-47` `providersById.set(providerId, registration)`. Docs agree: `docs-api-provider-api.md:31`
  "keyed by the provider ID", `:51` "Each call replaces **the provider ID's** previous registration".
- The key is resolved **per request** — `conversation-stream-store:1520-1522` →
  `providers:76-80`; `internal.mjs:1926-1939` `resolveModel` does not cache.
- The ChatGPT account identity comes **from the JWT, not a global**:
  `pi-ai/dist/api/openai-codex-responses.js:154` `extractAccountId(apiKey)`, `:1149`
  `chatgpt_account_id`, `:1175` sets the `chatgpt-account-id` header.

Two tenants → two provider IDs → two apiKeys → two account ids, with no shared mutable request
state. `openai-codex-${tenantId}/gpt-5.6-luna` is a documented pattern
(`docs-api-agent-api.md:224,239`), and every `resolveAgentModelProfile` call site is **already**
inside an initializer.

**The `globalThis.fetch` patch is not the blocker the plan fears.** `pi-subscription.ts:162-190` is
stateless and content-keyed on `body.model === LUNA_MODEL_ID` (`:120`) — already tenant-safe. It is
a blast-radius problem (it wraps GitHub and WhatsApp fetches too), and it has a supported
replacement: `pi-ai/dist/types.d.ts:69` `onPayload`, applied per call at
`openai-codex-responses.js:155-157`. It must **compose**, not overwrite — Flue already sets
`onPayload` at `conversation-stream-store:714`.

**Twelve process-global slots, six of them behind one factory.**
`packages/engine/src/shared/flue-global.ts:8-21` is a three-line
`slot[Symbol.for('ambient-agent.'+name)] = value`. Adding a tenant key is a one-file change plus
~12 call-site threads.

Three things that would have killed it were checked and none did: catalog-metadata loss (the path
is *already* zero-metadata today — `gpt-5.6-luna` is absent from pi's catalog and
`codexSubscriptionModel:192-202` rebuilds it by hand, so no regression); `registerProvider`
throwing on an unknown id (it throws only on missing api/baseUrl, both supplied at `:308-310`);
hidden globals in the codex api (only `globalThis.WebSocket`/`crypto`, both stateless).

**ADR 0023 survives on the model-credential axis.**

Two costs the plan must absorb:

- `chatgpt-authentication.ts:277-281` `assertProvider` hard-rejects any providerId ≠ `"openai-codex"`.
  Keep the *store's* key as `CHATGPT_PROVIDER_ID` and put per-tenant identity in `options.path` —
  the store is already path-parameterized (`:283-285`) with a path-keyed lock map (`:92`).
- ⚠️ **A latent bug that exists today, independent of multi-tenancy.** The apiKey is a boot-time
  snapshot with no refresh loop. `apps/runtime/src/app.ts:102` is the only call to
  `connectPiChatGptSubscription`; `pi-subscription.ts:300` captures the key once and freezes it at
  `:309`. Full refresh machinery exists at `chatgpt-authentication.ts:511-548` and **nothing on the
  model path ever calls it again** — when the OAuth token expires, the registration is stale until
  process restart. This deserves its own ticket now, not as part of the rebuild.

## Q3 · Flue durable adapter per tenant — THE PREMISE IS FALSE ⚠️

ADR 0022 assumes "the documented libsql durable adapter" can be instantiated per tenant. Both
halves are wrong.

**There is no libsql adapter.** `@flue/runtime/node` exports exactly one persistence factory:
`declare function sqlite(path?: string): PersistenceAdapter` (`dist/node/index.d.mts:18`). This repo
already uses it — `apps/runtime/src/db.ts:7` `export default sqlite(flueDatabasePath())`.
`@libsql/client` appears only in control-plane/credential stores
(`packages/db/src/control-db.ts:1`, `packages/installation/src/tenant-credentials.ts:1`), never in
Flue persistence.

**One adapter per process, by construction.** Flue discovers a source-root `db.ts` and wires **the**
default-exported adapter at **build** time (`docs-guide-database.md:18,26`); it calls `migrate()`
once and awaits `connect()` **once** (`docs-api-data-persistence-api.md:52`, and the contract
comment at `agent-execution-store-BCmrE5Jm.d.mts:738-750`). No API anywhere accepts a per-instance
adapter. Flue's own libsql docs say it "does not promise **multi-process or multi-tenant** writes to
one embedded file", and `docs-concepts-durable-execution.md:54` says "Node requires one live process
to own a given agent instance".

**But this does not sink ADR 0023 — it sinks ADR 0022's file-per-tenant story.**
The Speaker's agent instance id **is the WhatsApp chatId** — stated at `speaker/agent.ts:12` and
supplied per-init via `defineAgent(({ id }) => …)` at `:14`. Each tenant owns its own WhatsApp
account, so chatIds are already naturally tenant-disjoint. One shared `flue.sqlite` with state keyed
by instance id **is literally ADR 0023's "tenants are rows"**, and the five stores
(`PersistenceStores`, `…d.mts:725-737`) are all instance-keyed.

This needs an owner decision and is recorded in "Open decisions" below.

## Q4 · Is the demo path E2B-free — YES, with two caveats

- The Speaker's tool surface is fixed at `speaker/agent.ts:17-24`. `start_coder_job` is mounted
  **unconditionally** via a static `coderSpecialistSpec` import (`coder/workflow.ts:349-355`).
- The Coder chain is **type-only** on the sandbox — `coder/runtime.ts:1`
  `import type { SandboxFactory }`. No SDK pull.
- The `e2b` SDK is nonetheless in the boot graph, via `apps/runtime/src/app.ts:18` importing the
  string constant `E2B_WORKSPACES_ROOT` from `e2b-sandbox.ts`, which imports `e2b` at `:4`. The API
  key is read lazily at `Sandbox.create` (`:180`).
- **`E2B_API_KEY` is absent from `packages/env` entirely** — it can never be a hard boot failure.
- Missing key ⇒ **silent disable**: `apps/cli/src/lifecycle.ts:36-42`, and `app.ts:50-53` / `:73-75`
  `console.warn` + `return`. `app.ts:137` also disables the whole GitHub PR-review ingress branch.

The demo boots and runs without E2B. Caveat: the model can still call `start_coder_job`, which
throws in-chat at `coder/runtime.ts:21-23` — loud, not silent, but a demo "build me X" hits it.

## Q5 · GitHub self-approval — THE GATE IS INCOHERENT ⚠️

ADR 0020's actual claim is that GitHub "refuses to **count** a pull-request approval authored by the
PR's own author". The plan (`REBUILD-PLAN:228-229`) restates this as *"the Reviewer must refuse to
self-approve a PR authored by the Coder App"*.

**A PR authored by the Coder App is not the Reviewer's own PR.** Different App = different actor.
GitHub permits it — that is precisely what the three-App split is *for*. **There is no refusal to
observe, so S2b's negative assertion can never fire.**

Ground truth from docs.github.com:
- "Pull request authors cannot approve their own pull requests" — per-actor, enforced at runtime (422).
- Approvals count only from actors with write/admin permission.
- App installation tokens **do** count toward required approvals — demonstrated by the existence of
  the opt-out toggle *"Preventing GitHub Actions from creating or approving pull requests"*, which is
  scoped to `GITHUB_TOKEN` only; third-party App installation tokens are ungated.

The Reviewer does reach APPROVE: `reviewer/github.ts:45-50` returns APPROVE when findings are empty
and checks passed, passed to `pulls.createReview` at `reviewer/workflow.ts:112-121`. The
model-silence fallback correctly never approves (`github.ts:52-53`).

**Fix:** S2b's negative becomes *"the APPROVE is attributed to `ambient-reviewer[bot]`, an identity
distinct from the PR author `ambient-coder[bot]`"*. Testing ADR 0020's actual claim requires
deliberately pointing the Reviewer at the Coder credential and asserting a 422 — that is a
configuration test, not a green-path test, and it gets its own ticket.

## Q6 · Rate limits — UNMITIGATED, AND THE FLAKE READS AS PASS ⚠️

**No 429 handling exists anywhere.** Zero occurrences of `429`, `Retry-After`, `rate limit` or
`rateLimit` in `packages/engine/src` or `packages/agents/src`. `pi-subscription.ts:247-257`
classifies only 401/403/unauthorized/forbidden/invalid_token/revoked as `credential-rejected`; **a
429 falls through to `request-failed`**, indistinguishable from a network blip, a 500 or DNS
failure. The reason union at `:84` has no rate-limit member. The generic retry helper
(`shared/retry.ts:8-23`) is error-blind, and the only configured policy
(`intake/admission-relay.ts:11-14`, 3 attempts, 1s/2s linear, no jitter) is nowhere near the model
call — against a rate limit it is three more requests into the same wall.

**The dangerous half — the Reviewer fabricates a review on model silence.**
`reviewer/workflow.ts:143-153`: if the model never calls `submit_review` — exactly what a mid-run
rate-limit looks like — the workflow posts a real GitHub review anyway with
`missingModelVerdict = true`, event COMMENT, `status: "commented"`, returned as **non-error
success**. Its shape is indistinguishable from a genuine COMMENT. **An S2b gate asserting "a review
by `ambient-reviewer[bot]` exists" goes green on a run that reviewed nothing.** This is the exact
silent-degradation failure mode the plan's own "one rule" was written to catch, and the drafted gate
does not catch it.

**No account-level concurrency guard.** `reviewer/workflow.ts:27-38` `serializeReviewerSubmission`
is an in-process `Map` keyed `owner/repo#pr@sha:login` — same-PR de-dupe only, useless across
machines. `installation.ts:391`'s setup lock is the wrong lifecycle.

**Mitigation, ordered:**
1. Split a `"rate-limited"` reason out at `pi-subscription.ts:247` and add it to the union at `:84`.
   Live gates assert `reason !== "rate-limited"` → **INCONCLUSIVE, not FAIL and not PASS.** A
   rate-limited gate must stay re-runnable, not read as a regression.
2. Add a discriminator to `ReviewerResult` so a gate can distinguish a real verdict from the
   `missingModelVerdict` fallback. One field; closes the reads-as-PASS hole directly.
3. Lockfile **last** — one human holds the subscription, gates are nightly, and a distinguishable
   429 self-announces. Add it when a second account exists, not before.

## Q7 · S6 is too big, and S6→S6b is backwards ⚠️

S6 bundles five pieces whose real states are wildly different:

| Piece | Real state | Size |
|---|---|---|
| tenant row + `tenants/<slug>/` | `prepareHostedManagedLayout` already written, idempotent, mode-correct, **already tested** (`installation.ts:615-639`; `tests/managed/hosted-layout.test.ts:25-31`); `managedPaths` already takes an absolute dir (`paths.ts:31-40`) | ~60–100 lines |
| per-tenant whatsappd session | account layer already injectable (`whatsapp-account.ts:126-138`); host layer is globals (`whatsapp-runtime.ts:179-183`, `runtime-dependencies.ts:53`) | ~150–200 lines |
| Flue adapter per tenant | **hard blocker — see Q3** | unbounded |
| `CoworkerModelSource` off Turso | the file-backed replacement **already exists and is the default branch** (`chatgpt-authentication.ts:14-32`) | delete ~40, add ~20 |
| installation-id → tenant → dispatch | **already built end-to-end** (`github-control.ts:63-66` → `db/github-control.ts:618-632,679-695` → `github-hosted.ts:46-59` → `bridge-route.ts:83-105`) | ~50 lines (last hop only) |

**Four of S6's five proofs are single-tenant proofs**, runnable today. The one genuinely
multi-tenant proof ("two dispatches in one process") is definitionally S6b's — so **S6's gate cannot
go green before the stage that follows it.** The plan's own S6b headline, *"required before two
tenants"*, contradicts S6's third gate.

Worse, the cheapest item in the plan (credentials off Turso, ~60 lines, and the thing that unblocks
deleting Turso) is buried inside the largest and riskiest stage.

**Split — S6a → S6b′ → S6c → S6d**, where S6c is the only risky stage and its failure costs only
itself and S8:

- **S6a · Tenant directory, one tenant.** Migration + `tenantPaths(slug)` + move the
  `prepareHostedManagedLayout` call from `setup-server.ts:9`. Turso columns go nullable, not dropped.
  *Gate:* create a tenant → `stat` shows 0700 dirs / 0600 files. *Negative:* a pre-existing
  Docker-mode 0755 tree is repaired in place.
- **S6b′ · Credentials off Turso.** Rewrite `coworker-hosted.ts:19-46` onto
  `createManagedChatGptAuthentication`. *Gate:* device-code auth → 0600 credential in the tenant dir
  → restart → `verify()` true. *Negative:* a tenant with no credential file surfaces
  `model_store_unavailable`, **not a silent fallback.** Depends on S6a only.
- **S6c · De-globalise** (the current S6b, pulled forward, plus the Q3 decision).
  *Gate:* two instances, different GitHub App credentials, each Coder job under its own identity.
  *Negative:* configuring B does not alter A's bindings.
- **S6d · In-process delivery routing.** Swap the last hop from `tenantBridge.deliver`
  (`github-hosted.ts:62-67`) to in-process dispatch. *Gate:* two installation ids, one real webhook
  each, one process. *Negative:* A's webhook does not reach B — the existing `tenantId`/`runtimeId`
  assertions (`github-control.ts:264,271`) must survive the move.

**Move out of S6 entirely:** the kill/restart conversational-memory proof and the `kill -9` →
`interrupted` / no-unattended-relaunch proof. Neither is multi-tenant; both belong with S2/S2b,
where `sweepUnsettledLaunches` (`app.ts:187-199`) is the actual subject. Leaving them in S6 means a
de-globalisation failure blocks two unrelated proofs.

---

## Re-derivations

### A · apps/web wizard screens — SURVIVE, every deletion claim confirmed

2,190 lines across 14 files; `onboarding.tsx` (763) and `dashboard.tsx` (691) are 66% of the app.
Stage table at `onboarding.tsx:31-72`.

| Plan's claim | Verdict | Evidence |
|---|---|---|
| subscription stage deleted | CONFIRMED | `onboarding.tsx:33-36`, `:325-350` |
| `preparing` stage deleted | CONFIRMED | `:43-46`, `:386-424` (`ensureSetup` dies with the provisioner) |
| "every reconcile button" | CONFIRMED — **3** | `onboarding.tsx:409-417`, `:748-756`, `dashboard.tsx:646-660` |
| `runtime.restart` deleted | CONFIRMED — **1** | `dashboard.tsx:414` |
| `uncertain` branches deleted | CONFIRMED — **9** | `onboarding.tsx:287`; `dashboard.tsx:49-50,225,270,306,311,318,435,646` |
| tenant switcher is new UI | CONFIRMED, **worse than stated** | the redirect is **bidirectional**: `onboarding.tsx:121-124` → `/dashboard` and `dashboard.tsx:98-102` → `/onboarding`. `nextAction` is one scalar off a single-tenant snapshot; no route, param or state slot for a second tenant |
| ASCII QR renders in browser | CONFIRMED | `qrcode-terminal@0.12.0` at `apps/web/package.json:29`; `<pre>` at `onboarding.tsx:501-510`, `dashboard.tsx:604-613`. Canvas swap = 2 files, ~6 sites |

**S7's real blast radius is 2 files and 21 oRPC call sites** (onboarding 12, dashboard 9);
`utils/orpc.ts` names no verb and is untouched. **The GitHub stage already passes `tenantId`**
(`onboarding.tsx:207,232,250`) because it goes over REST (`apps/api/src/github-routes.ts`), not
oRPC. So the plan is *pessimistic* on rewiring and *optimistic* on new UI.

### B · The demolition estimate — LOW by ~360 lines

| File | Lines |
|---|---|
| `apps/api/src/provisioner.ts` | 822 |
| `apps/api/src/provisioner-providers.ts` | 507 |
| `apps/api/src/provisioner-hosted.ts` | 133 |
| `apps/api/src/tenant-bridge.ts` | 128 |
| `apps/runtime/src/host/bridge-route.ts` | 111 |
| **named subtotal** | **1,701** |
| `packages/db/src/provisioner-control.ts` — sole importer is `provisioner.ts:6-17` | **457** |
| **source total** | **2,158** |

Plus **1,859 test lines** (provisioner 796, provisioner-providers 362, bridge-route 235,
provisioner-control 194, provisioner-hosted 137, tenant-bridge 135) — **4,017 all in**.

The "reconciliation loop" is not a separate file; it is `provisioner-hosted.ts:102-128`, already
counted. `bridge-contract.ts` and `runtime-health.ts` **survive** — 13 non-test importers including
all of `apps/cli`.

**Unmentioned collateral: ~397 lines of rewrite, not deletion.** `coworker-hosted.ts:8` (171),
`github-hosted.ts:9` (86) and `apps/api/src/index.ts:19` (140) all import `tenantBridge` and must be
re-pointed in-process.

---

## Corrections required for revision 3

1. **ADR 0022 must be rewritten.** There is no libsql durable adapter; per-tenant Flue *files* are
   not constructible. Pending the owner decision below.
2. **S6 splits into S6a/S6b′/S6c/S6d**, and de-globalisation moves **before** the two-tenant proof.
3. **S2b's negative assertion is replaced** — the drafted one can never fire.
4. **S2b/S6 gain a fallback discriminator** so a fabricated review cannot pass as a real one.
5. **`rate-limited` becomes a first-class reason**; live gates report INCONCLUSIVE, never PASS/FAIL.
6. **Demolition total corrected to 2,158 source / 4,017 with tests**, plus ~397 lines of collateral
   rewrite named explicitly.
7. **S5 must name which of the two `serve()` entries survives** (`apps/api/src/index.ts:129-140` vs
   `apps/runtime/src/setup-server.ts`).
8. **Two proofs move out of S6** into S2/S2b, where their subject actually lives.
9. **New standalone ticket, unrelated to the rebuild:** the ChatGPT apiKey never refreshes after
   boot (`app.ts:102`, `pi-subscription.ts:300,309`).

## Open decisions — owner only

**D-1 · Where does Flue durable state live once there are two tenants?** See Q3. Three options,
graded in the conversation that accompanies this report. Nothing in S6c can be specified until this
is answered.

## What was NOT re-verified

Stated plainly rather than left to look settled:

- **S1/S2/S2b remain blocked on the E2B key and a throwaway repo.** No live E2B evidence was
  obtained; the six assumptions in `e2b-sandbox.ts` are still guesses.
- The `TMPDIR` restoration was verified **as present in the tree**
  (`e2b-sandbox.ts:146`, `:214`) — not verified as *working*, which requires S1.
- S9 (backup/restore) and S10 (deploy) were not examined.
- Q2's analysis covers **model credentials only**. `whatsapp-port.ts:40` (one live Baileys socket)
  and `runtime-dependencies.ts:52` (one E2B binding, one GitHub credential, one paths tree) are
  structurally larger multi-tenant problems and were out of its scope — they land in S6c and are
  the reason S6c is the risky stage.
