# Wayfinder inputs — tightening pass (2026-07-16)

Consolidated input for the `/wayfinder` pass. Sources: the architecture survey and the
aggressive ponytail audit (both run 2026-07-16 over `docs/tightening-pass-handoff` @
`f7f0553` = main `a96f4fe`), cross-referenced, plus Aaron's same-day ratifications.
Companion doc: `docs/planning/TIGHTENING-PASS-HANDOFF.md` (mission, guardrails, rig how-to).

Repo verdict: core is healthy — zero cyclic imports in `src/`; coalescer/intake/evals
clusters are cleanly seamed; the monorepo cut lines fall naturally. Four findings were
flagged independently by BOTH passes (high confidence): `combineReceipt`'s identical
branches, the QR-renderer duplication, `renderInspection`'s 10 positional params,
`program.ts` decomposition.

## Ratified by Aaron (2026-07-16, in-session)

1. **Console is chat-visible by default** — inbound AND outbound message text render as
   chat-style lines on the default console (no `--debug`). **Amends ADR 0016** (bodies
   were debug-only). Privacy accepted: runs on a controlled machine. whatsappd protocol
   noise stays dimmed/debug.
2. **React tool is wanted** (NEW FEATURE): the agent should be able to send reactions to
   messages. Consequence: the outbound mutation-echo machinery
   (`src/whatsapp/account.ts:131-176` pendingMutationEchoes, outbound react branches in
   `src/intake/conversation-event.ts`) is **KEPT** — it is that tool's support layer.
   Only the provably-unreachable outbound MEDIA branches (~70 lines: image/video/audio/
   document/sticker/location/contacts in `conversation-event.ts:152-222`) still delete.
3. **Windows must carry everything, not just messages** (NEW FEATURE): "the window of
   events should include everything that happens in that window — not just the messages,
   the reactions, everything; it needs them for its own deliberations." Today reactions
   bypass the coalescer entirely (`onUpdate → archive.append`, then nothing). Design
   needed: (a) update events feed the coalescer (likely extend-window, not fire),
   (b) `whatsappWindowInput` (src/ambience/events.ts) renders them.
   The `conversation_reactions` projection's fate follows this design (journal-only may
   suffice per ADR 0008); **`conversation_receipts` deletes** — read receipts not needed.
4. **Legacy ATTACH cutover deletes** — no pre-managed standalone-DB installation exists
   anywhere (`src/github/ingress-store.ts:150-219` + `legacyDatabasePath` threading).
   The in-place status-vocabulary migration (:106-143) STAYS.
5. Ungated findings proceed: D2 (tools.ts lifecycle collapse), D3 (env-config loaders),
   D6–D13 mechanical batch (below).

Standing ratifications (from handoff): evals FIRST, before the monorepo split; both eval
tracks equally (issue capture + participation quality); code-factory is a test rig with
full authority.

## Findings by workstream

### A. Evals (ratified first thrust)

- **A1. Harness stimulates the wrong path for participation evals.**
  `src/evals/harness.ts:169` only uses `client.agents.prompt()`; production input is
  coalesced windows (debounce + admission relay + `whatsappWindowInput` shaping). The
  fixture already exposes the real path (`/test/coalescer`,
  `tests/fixtures/ambience/src/app.ts:239`) — used by integration tests, not evals.
  Fix: additive `window?: { texts: string[]; addressed?: boolean }` input variant on the
  harness that POSTs to `/test/coalescer` and polls `/test/admission`.
- **A2. Participation rubric does not exist** — the top live complaint. Encode as
  vitest-evals scorers (silence already assertable: `whatsappEvents.length === 0`).
  **Rubric ratification with Aaron is the critical path, not code.**
- **A3. Declare the faux-vs-live boundary**: deterministic suites keep the faux keyword
  responder (fixture app.ts:40-159) and assert mechanics; quality suites run live-model
  (`AMBIENCE_FIXTURE_LIVE_MODEL=true`) + LLM-judge scorers.
- **A4. Braintrust**: absent from package.json; official blueprint exists —
  `pnpm exec flue add tooling braintrust`. Installation task.

### B. Observability (live complaints, verified in code)

- **B1. Reply text never logged anywhere** (`src/host/whatsapp-runtime.ts:54` logs id
  only); inbound is debug-only (`src/coalescer/whatsapp.ts:43`). Per ratification #1 the
  fix is now info-level chat lines on the console sink, both directions.
- **B2. Deliberations/silence invisible** — `src/ambience/dispatch.ts:18` fire-and-forgets
  into Flue. Proposed `AmbienceObserver` seam (windowDispatched / spoke / settledSilent)
  — the ONE genuinely new abstraction both passes endorse; also the frontend's event
  feed. **Gate: investigate Flue dispatch-completion hooks first** (does `dispatch()`'s
  return / runtime expose settlement?).
- **B3. Typing flickers** — spans only the send (`whatsapp-runtime.ts:41-72`). Fix:
  decorate dispatch in `runWhatsAppSession` (setTyping true → dispatch → finally false).
  Same site as B2; ship together.
- **B4. Chat-style pino-pretty renderer** — contained in `consoleSink`
  (`src/logging/logging.ts:80`), ~30 lines, function `messageFormat`. Depends on B1.
- **B5. Live smoke battery** — compose existing probes (`doctor --live`, `status`,
  repair preflight) into one `smoke` command with per-station pass/fail. Nearly free
  after C3. Open decision: the canary message (which chat, what text).

### C. Monorepo-split pre-work (small; must land BEFORE the split)

- **C1. Module-level `let` singletons break across bundles** (highest-priority
  pre-split). CLI imports server bundle by URL (`src/cli/program.ts:153-160`) — two
  bundles, one process. Safe pattern exists (`Symbol.for` on globalThis:
  runtime-dependencies.ts, logging.ts). Unsafe `let`s: issue-management/runtime.ts:68,
  whatsapp-port.ts:46, github/ingress-runtime.ts:10, host/whatsapp-runtime.ts:118
  (status). Fix: mechanical Symbol.for normalization, 4 files, ~20 lines.
- **C2. No core public surface; composition root duplicated** — `src/app.ts:28-43` vs
  `tests/fixtures/ambience/src/app.ts:181-223` hand-wire the same five subsystems; the
  302-line fixture is the most drift-prone file in the repo. Fix: one
  `composeAmbience(adapters)` — production passes Octokit + real session; fixture passes
  fakes; frontend passes real adapters + its own AmbienceObserver. This IS
  `packages/core`'s export.
- **C3. Split program.ts (1075 lines) into 5 files** along its four interleaved
  responsibilities: runtime bootstrap / `reportInspection` (176-line fn) /
  `renderInspection` (10 positionals → name the existing anonymous return object
  `InspectionReport`, program.ts:504-514) / prompts. Mechanical; unlocks B5 and hands
  the frontend its status API.
- **C4. Dependency-direction flip** — `src/managed/runtime-health.ts:3` imports the
  status type from `host/whatsapp-runtime.ts` (CLI side ← runtime side). Move the 7-line
  contract into runtime-health.ts; host implements it.
- **C5. The split itself** (after evals, ratified): `packages/{core,cli,server,test-support}`,
  pnpm workspace; rule: core imports nothing internal; cli ⊥ server (they already only
  meet via globalThis). Constraint: `ambience/dispatch.ts` + `agents/` stay together in
  core (dispatch hard-imports the agent; do not invert).

### D. Deletions (post-ratification state)

- **D1 (revised): keep echo machinery; delete only unreachable outbound MEDIA branches**
  (~70 lines, conversation-event.ts:152-222). React tool becomes a feature ticket.
- **D2. tools.ts lifecycle collapse** (~110 lines): settleCreated (:204), settleUpdated
  (:349), and lifecycleMutation's settle (:437) are the same ~25-line block; route
  createIssue/updateIssue through lifecycleMutation. Integrity core — pinned by 35 tests
  in tests/ambience/issue-management.test.ts (1154 lines).
- **D3. Env-config loaders delete** (~100 src + 80 test): loadGitHubIngressSettings
  (ingress.ts:51-93), loadIssueManagementSettings (issue-management/runtime.ts:19-37),
  ChatGateEnv+parseSet (chat-gate.ts:9-49). Production builds settings from managed
  config directly (app.ts:28-43); only fixture/tests consume the loaders.
- **D4. Legacy ATTACH cutover deletes** (~90 src + 60 test) — ratified above.
- **D5 (revised): `conversation_receipts` deletes; `conversation_reactions` fate decided
  by the windows-carry-everything design** (ratification #3). `messageState()` and
  `archive.events()` are test-only today.
- **D6–D13 mechanical batch** (~250 lines, near-zero risk, one ticket):
  - combineReceipt identical branches (whatsapp-runtime.ts:29-38, ~10)
  - WhatsAppSayResult 6-arm union → flat shape; kills 3 hand-rolled combiners (~55)
  - retry loop ×2 (admission-relay.ts:37 ≡ ingress.ts:249), sleep ×2 (use
    node:timers/promises), errorMessage ×3, errorCode ×3, exists ×2 (~60)
  - fake-issue-repository create/update modes → its own generic lifecycleModes (~55)
  - dead/test-only exports: PiAuthSchema (zero consumers), installManagedData,
    inbox.admission singular, createSayTool port param (~50)
  - unused prod dep `@earendil-works/pi-coding-agent` (package.json:55, zero imports)
  - QR renderer duplicated with two shims (program.ts:471 vs whatsapp-runtime.ts:158, ~12)
  - four owner/repo validators, three regexes → one module (~15)
  - fakes out of prod tree: src/host/fake-*.ts → test-support (move)

### NOT flagged (looked over-built, is earned — do not "fix")

Coalescer Effect ports/mocks (ratified design, TestClock tests depend on seams);
uncertain-work healthy/degraded (ADR 0004); installation-inspection paranoia (trust
boundary); globalThis defer handshake (#87); eval harness (Flue blueprint
tooling/vitest-evals@1).

## New feature tickets that emerged (for the DAG, not yet filed)

1. **React tool** — agent sends reactions; gives the kept echo machinery its live caller
   + live test.
2. **Windows carry everything** — reactions/updates enter the coalescer + window input;
   design decides fire-vs-extend semantics and the reactions projection's fate.
3. **Participation rubric ratification** — the evals critical path; a working session
   with Aaron, output = scorer definitions.
4. **Smoke canary decision** — which chat, what text (part of B5).

## Suggested ordering skeleton (for wayfinder to refine into a real DAG)

1. Parallel, trivial, now: B1+B4 (console, one ADR amendment) · C1 (Symbol.for) ·
   D6–D13 batch · D4 · D3.
2. Evals thrust: A4 (Braintrust install) → A1 (window input) → A2/A3 (rubric + scorers;
   rubric session with Aaron gates this).
3. Observability: Flue dispatch-hook investigation → B2+B3 (same site) → B5 (after C3).
4. Features: react tool · windows-carry-everything (design first; D5-reactions rides it).
5. Split: C2, C3, C4 → C5 four-package cut (last, after evals prove no regression).

Process reminders: decision tickets not deliverables (the #91 pattern); explicit
blocking edges; nothing filed on GitHub without Aaron's go-ahead; wayfinder → to-spec →
to-tickets wants one unbroken context window.
