# Phase 1 audit — ponytail sweep + docs/legacy drift + GitHub hygiene

Repo: AaronAbuUsama/ambient-agent, branch integration/coworker-replacement @ 7b2ec13
Report only — nothing closed, deleted, or created yet.

## Top line

- 60 raw debt findings, 59 confirmed after independent skeptical re-check (one dropped as unconfirmed).
- Nothing catastrophic — no crash bugs, no security holes. This is accumulated small debt: dead code, duplicated small helpers, doc drift, and — the one finding that actually matters structurally — **STATUS.md overclaims what the reset deleted.**
- 31 open issues triaged: 8 keep-active, 8 need linking to a new milestone, 7 stale (already done), 8 superseded (premise no longer applies).

## The one finding that matters most

**`STATUS.md` says "Layer 2 — done: removed the orphaned hosted/tenant runtime boot (`TenantRuntime*` setup-boot + operate-bridge)." That's not true.** `TenantRuntimeEnvironment` and `runtimeDeploymentIdentityFromEnvironment` (`packages/installation/src/runtime-dependencies.ts:36-82`) are still live, still wired through `bridge-contract.ts` into `apps/runtime/src/app.ts`, still read by `apps/cli/src/lifecycle.ts:160`. Nothing in the repo ever sets the env vars they gate on, so it's dead — but it wasn't deleted, and the project's own status doc says it was. Same pattern in `pnpm-workspace.yaml`, which still pins the entire deleted SaaS/web dependency catalog (`better-auth`, `@orpc/*`, `next-themes`, `react`, `tailwindcss`, etc.) — none of it referenced anywhere except the catalog declaration itself.

This directly means #299's own checklist box **"Legacy/dead replacement paths deleted" is not actually done**, despite reading as closed in spirit.

## Debt findings by category (59 confirmed)

| Category | Count | Flavor |
|---|---|---|
| dead-code | 17 | Unused exports, test-only interface surface, dead handlers (`/deliveries` route, `github_delete_issue_comment` never-return path) |
| duplicated-logic | 15 | Same transaction-wrapper hand-rolled 4x, same JID-normalization regex in 2 places, same SQLite-open ritual copy-pasted across 8 stores |
| over-engineered | 11 | Empty interface aliases, config knobs that never vary (`maxReviewCycles` for a review loop that doesn't exist yet — #211), optionality guarding a composition that never varies |
| stale-config | 8 | The TenantRuntime/pnpm-workspace items above, plus a stale CONFIG_ISSUE_PATHS mirror missing real fields |
| doc-drift | 6 | Comments describing a quarter of what a 700-line factory now does, a citation to a deleted `docs/planning/` file, a grammatically broken module doc |
| other | 2 | An unguarded `conversation_events` prepare that throws on a fresh DB shape, un-hoisted prepared statements recompiled on every projection rebuild |

Highest-value quick fixes (small diff, real payoff):
- `packages/engine/src/graph/store.ts:36` — delete the entirely-unused `GraphConstraintError` class + guard
- `packages/engine/src/brain/inbox.ts:298` — `canonicalEvidence` is a byte-for-byte duplicate of `canonicalIds` three lines below it
- `packages/engine/src/coalescer/chat-gate.ts:11` — `ChatGate.allowed(chatId, isGroup)` ignores `isGroup` entirely; two call sites compute it for nothing
- `packages/agents/src/capabilities/issue-management/tools.ts:481` — the entire 10-tool GitHub issue-management surface (search/read/update/comment/close) has zero production callers; this is your "update/update issues" ask from earlier — the code exists, it's just never wired to anything

Full 59-item list with exact file:line and suggested action is below.

## Docs-vs-code drift (docs/ARCHITECTURE.md)

- Claims "three packages, two apps" — there are five package directories (`agents, config, engine, installation, test-support`); `packages/config` isn't mentioned anywhere and is itself orphaned (no tsconfig extends it, nothing depends on it).
- Says GitHub webhook ingress "remains at the next frontier" — it's fully built and wired (`apps/runtime/src/channels/github.ts`, `ingress-runtime.ts`, `ingress.ts`, `ingress-store.ts`). What actually remains is routing it through the Brain's up-inbox (#254), not building it from scratch.
- Names zero of the 9 real capabilities under `packages/agents/src/capabilities/` except by loose concept — `delegation`, `graph-extraction`, `issue-management`, `reviewer` never appear.
- Refers to `apps/server`, which doesn't exist (deleted per STATUS.md).

## GitHub issue triage (31 open issues reviewed)

**Propose closing 15:**
- Stale/already-done (7): #318, #317, #252, #251, #246, #242, #1 — all verified against actual merged code, not just assumed
- Superseded/premise gone (8): #249, #238, #236, #212, #173, #139, #90, #19

**Keep active, no milestone needed (8):** #319, #311, #299, #254, #211, #184, #177, #161 — either #299 itself or already-tracked work

**Propose a new milestone** ("Coworker replacement — hardening & routing", or your preferred name) for 8 issues doing real, currently-untracked work: #316 (intent-escalation wiring missing), #312 (WhatsApp online-phase never degrades on stream error), #264 (setup-lock has no staleness reclaim), #255 (tracing partially done), #248 (ChatGPT token never refreshes after boot — the #248 bug from the rig doc's own gotchas list), #245 (model-silence fallback still posts REQUEST_CHANGES instead of staying silent), #179 (managed-chat allowlist frozen at boot, can't add live), #178 (the "ambience" schema fossil, same one this audit found independently).

## Not covered by this sweep

- No performance/load testing — this was a static-read audit only.
- Test files themselves weren't audited for debt (only production code paths).
- The two new issues you asked me to file (ambient UX/typing+preambles, DM/Person-surface completion) aren't reflected in this triage yet — they didn't exist when the sweep ran.

---

## Full findings list (59)

### dead-code (17)

- **packages/engine/src/graph/store.ts:36** — GraphConstraintError typed-error machinery (class with `constraint` discriminant at :36-43, `isGraphConstraintError` guard at :45-46) has zero consumers: nothing anywhere in packages/, apps/, or tests/ catches it by type, reads `.constraint`, or calls the guard; the only reference is a dead re-export at packages/agents/src/capabilities/graph/schemas.ts:4 (schemas.ts itself is imported only by a test, for other symbols).
  - *fix:* Throw plain `Error` at store.ts:1341/1349/1352, delete the class + guard, and drop the re-export at capabilities/graph/schemas.ts:4.
- **packages/engine/src/graph/store.ts:196** — `blocksReachable` is exposed on the public GraphStore interface (:196) and returned object (:1449) but has zero external callers, including tests; its only use is internal, inside attest's blocks-acyclic check (store.ts:1351).
  - *fix:* Remove `blocksReachable` from the GraphStore interface and returned object; keep it as the internal helper it already is.
- **packages/engine/src/brain/inbox.ts:199** — Six BrainInbox methods have no production callers — test-only surface: `intent()` (:199, impl :780, 1 test call), `pendingIntents()` (:200), `pendingKnowledgeDeltas()` (:201), `specialistLaunch()` (:210), `pendingSpecialistResults()` (:216), `effects()` (:236). All production consumers (brain/effects-runtime, delegation/bridge, delegation/tools, whatsapp-runtime, historical-replay) use the other 18 methods.
  - *fix:* Delete `intent()` (its one test assertion can use `pendingIntents()`); keep or consciously bless the other five as test-observability seams — but decide once rather than letting the interface keep growing test-only members.
- **packages/engine/src/scribe/inbox.ts:29** — ScribeBatch.attempts (field at :29, ScribeAttempt type at :17-23, selectAttempts query at :138-141, hydration at :144-152) is loaded on every claimWave but never read by any consumer — the only production callers (apps/runtime/src/host/whatsapp-runtime.ts:275, apps/runtime/src/workflows/historical-replay.ts:35,77) use inputs/evidenceIds only.
  - *fix:* Drop attempts from ScribeBatch and delete the hydration query; attempt history stays queryable in the scribe_attempts table for forensics.
- **packages/engine/src/model/chatgpt-authentication.ts:171** — ensurePrivateDirectory has `} catch (cause) { throw cause; }` (lines 171-173) — a catch clause that only rethrows, pure noise between try and finally.
  - *fix:* Drop the catch clause; keep try/finally.
- **packages/engine/src/model/pi-subscription.ts:331** — rateLimitRetryingFetch wraps `await delay(wait, signal)` in try { } catch (cause) { throw cause; } (lines 331-336) — the catch only rethrows; the comment is its sole content.
  - *fix:* Replace with a bare `await delay(wait, signal);` and keep the comment above it.
- **packages/engine/src/logging/logging.ts:163** — effectLoggerBridge is exported but has zero importers anywhere in the worktree (including tests); its only caller is effectLoggerLayer in the same file.
  - *fix:* Remove the export keyword (keep the function module-private).
- **packages/agents/src/capabilities/delegation/bridge.ts:49** — deliverAfterExecution is exported but its only caller is installDelegationBridge in the same file; no runtime, test, or eval imports it.
  - *fix:* Drop the export keyword and make it module-private (or inline it into the interceptor lambda).
- **packages/agents/src/capabilities/delegation/tools.ts:86** — createSpecialistLaunchTool is exported but only called by createDelegationTools three lines below; additionally the `specialists = []` default at tools.ts:105 is never used — the sole caller (brain/agent.ts:38) always passes [coder, reviewer].
  - *fix:* Un-export createSpecialistLaunchTool and delete the `= []` default parameter.
- **packages/agents/src/brain/dispatch.ts:17** — dispatchBrain (line 17) and BrainDispatchRequest (line 7) are exported but referenced nowhere outside dispatch.ts — dispatchBrain only serves as wakeBrain's default parameter, and all tests inject their own deliver function.
  - *fix:* Remove `export` from dispatchBrain and BrainDispatchRequest (keep DispatchBrain if you want the injectable-deliver signature nameable).
- **packages/agents/src/capabilities/issue-management/tools.ts:481** — createIssueManagementTools — the entire 10-tool GitHub surface (search/read/options/create/update issue, discussion, create/update/delete comment, set state) — has zero production callers. The only production consumer of this 829-line module is brain/issue-filing.ts, which imports just `createIssue` (tools.ts:174). The Speaker deliberately mounts none of these (speaker/agent.ts:15-20; tests/speaker/issue-management.test.ts:1029 asserts 'no issue-management or delegation tools'), and the Brain files issues only via createFileIssueTool → createIssue. That strands updateIssue (tools.ts:300), validatedUpdate/canonicalValues/matchesUpdate (250-298), requiredComment (473), and every comment/state lifecycle tool (579-828) as test-only code, plus the matching unused IssueRepository interface methods (issue-repository.ts:88-131: update, discussion, createComment, updateComment, deleteComment, setState, findCommentByOperation) and their production Octokit implementations.
  - *fix:* Delete createIssueManagementTools and every tool/helper not on the createIssue path; shrink IssueRepository to search/get/create/findCreated (+ operations); restore the rest from git only when an agent actually mounts an issue-editing surface.
- **packages/agents/src/capabilities/issue-management/SKILL.md:1** — issue-management/SKILL.md (v2.0.0, a full Speaker-era conversational capture policy: 'ask for missing information in the chat', 'reply to the report's source message with the filed issue link') is not mounted on any agent — speaker/agent.ts mounts only whatsapp-participation, and brain/agent.ts mounts no skills at all. Its only readers are the eval judge (packages/agents/evals/rubric-judges.ts:9) and nothing at runtime; the escalation flow it describes now lives in whatsapp-participation/SKILL.md + the Brain's file_issue instructions.
  - *fix:* Delete or archive the skill (and its references/) alongside the tool-surface deletion, and repoint rubric-judges.ts at whichever text the judge should actually grade.
- **packages/agents/src/capabilities/issue-management/tools.ts:732** — The reconcile callbacks of github_delete_issue_comment (tools.ts:732-741) and github_set_issue_state (tools.ts:802-811) perform a full `provider.discussion(...)` network read, then unconditionally return undefined; lifecycleMutation discards both the value and any thrown error (tools.ts:451-453), so the fetch has zero effect on the outcome — pure wasted I/O on the uncertain path. (Moot if the tool surface is deleted per the first finding.)
  - *fix:* Replace both reconcile bodies with `async () => undefined` (keeping the explanatory comment), or delete with the surface.
- **packages/agents/src/capabilities/reviewer/github.ts:115** — reviewHeadEligible is a one-line wrapper (`reviewIneligibilityReason(...) === undefined`) with no production caller — workflow.ts uses reviewIneligibilityReason directly; its only callers are tests/reviewer/dispatch.test.ts:46-52, which could assert on the reason function they already import.
  - *fix:* Delete the export and rewrite the four test assertions against reviewIneligibilityReason (=== undefined / !== undefined).
- **apps/runtime/src/host/bridge-route.ts:85** — POST /deliveries (and its helpers githubDelivery at line 36, deliveryIsDurable at line 55, and the never-passed BridgeRouteOptions.configVersion at line 20 and deliver at line 24) has no production caller: it existed for the hosted operate-bridge that pushed GitHub webhooks into tenant runtimes, removed in the Layer 2 reset. Production GitHub ingress now arrives through the Flue GitHub channel (apps/runtime/src/channels/github.ts). Only tests/managed/bridge-route.test.ts exercises it. GET /pairing and /chats on the same route also have no in-repo consumer (the setup-server web UI that polled them is deleted); CLI pairing runs in-process.
  - *fix:* Delete the /deliveries handler, githubDelivery, deliveryIsDurable, and the configVersion/deliver options; confirm no external ops tooling curls /pairing//chats on the rig, then delete the whole bridge route and its runtime-health 'delivery-push'/'pairing-read'/'chats-read' purposes.
- **packages/installation/src/bridge-contract.ts:32** — BridgeGitHubDeliveryAck (line 32) and BridgeChats (line 23) are exported types with zero references anywhere in the repo — leftovers of the removed host↔tenant bridge protocol.
  - *fix:* Delete both type exports (BridgeGitHubDelivery and bridgePairing go with the bridge-route finding; bridgeHealth stays — app.ts /health uses it).
- **apps/cli/src/model-configuration.ts:16** — MODEL_ROLE_OPTIONS is exported and referenced nowhere — not even tests; program.ts hand-writes each --model-<role> option string instead.
  - *fix:* Delete the export.

### duplicated-logic (15)

- **packages/engine/src/brain/inbox.ts:298** — `canonicalEvidence` (:298-302) is byte-for-byte `canonicalIds` (:304-308) with a hard-coded name and a slightly different empty-set error message — two copies of the same trim/dedupe/sort/non-empty logic in one file.
  - *fix:* Define `const canonicalEvidence = (ids) => canonicalIds(ids, "Intent evidence id")` (or inline the call at the 2 call sites) and delete the copy.
- **packages/engine/src/brain/inbox.ts:749** — inbox.ts hand-rolls the BEGIN IMMEDIATE / COMMIT / catch-ROLLBACK-rethrow block four times (:749-758 admitIntent, :880-917 claimBatch, :1017-1039 settleBatch, :451-536 migration) while sibling graph/store.ts:581-591 already has the exact 10-line `transaction<T>(work)` helper for this.
  - *fix:* Copy store.ts's `transaction` helper into inbox.ts and collapse the three method bodies onto it (the migration block can stay bespoke — it needs close-on-failure).
- **packages/engine/src/graph/digest.ts:21** — `DigestIdentitySeed.platform: "whatsapp" | "github"` (:21) re-declares the `GraphPlatform` union already exported by store.ts:32, which digest.ts imports types from on line 3 — a new platform would have to be added in both places.
  - *fix:* Import and use `GraphPlatform` for the field type.
- **packages/engine/src/coalescer/whatsapp.ts:95** — The WhatsApp device-suffix strip regex /:\d+(?=@)/ is duplicated: botIdOf (whatsapp.ts:95) and canonicalActor (intake/conversation-event.ts:81) implement the same JID normalization independently, while shared/whatsapp-jid.ts already exists as the JID seam.
  - *fix:* Add stripDeviceSuffix(jid) to packages/engine/src/shared/whatsapp-jid.ts and use it in both places.
- **packages/engine/src/coalescer/events.ts:52** — The arrival event-id format `arrival:${chatId}:${id}` is hand-built in four places — coalescerEventId (events.ts:52), conversationArrival (conversation-event.ts:229), conversationSent (conversation-event.ts:301), and historical-replay.ts:375/389 — and the replay-overlap dedup in whatsapp.ts:161-162 silently breaks if any copy drifts.
  - *fix:* Export one arrivalEventId(chatId, messageId) helper (natural home: conversation-event.ts) and use it at all four sites.
- **packages/engine/src/scribe/inbox.ts:123** — The hand-rolled BEGIN IMMEDIATE/COMMIT/ROLLBACK transaction wrapper is copy-pasted three times: scribe/inbox.ts:123-133, intake/historical-replay.ts:176-186, and intake/conversation-archive.ts:239-249 (plus a fourth inline at inbox.ts:109-121); the unknown-time-last ORDER BY clause `CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END, occurred_at_ms, ...` is likewise duplicated as raw SQL in ~6 queries across the same three files.
  - *fix:* Extract one withImmediateTransaction(database, work) helper into a shared sqlite util and reuse it; optionally hoist the ordering clause as a shared SQL fragment constant.
- **packages/engine/src/model/pi-subscription.ts:23** — SUBSCRIPTION_PROVIDER_ID = "openai-codex" duplicates CHATGPT_PROVIDER_ID = "openai-codex" (chatgpt-authentication.ts:13) — two exported names for the same constant in the same directory, each with its own downstream importers.
  - *fix:* Keep CHATGPT_PROVIDER_ID and make pi-subscription.ts re-export it as SUBSCRIPTION_PROVIDER_ID (or drop one name entirely) so the literal exists once.
- **packages/engine/src/model/chatgpt-authentication.ts:97** — throwIfAborted (lines 97-99) reimplements the native AbortSignal.prototype.throwIfAborted(), which throws signal.reason with the same DOMException default.
  - *fix:* Replace the helper and its call sites with `signal?.throwIfAborted()`; keep abortError only for the abortable() race listener.
- **packages/engine/src/model/pi-subscription.ts:288** — abortableDelay (lines 288-300) hand-rolls an abortable sleep that node:timers/promises setTimeout already provides via its { signal } option (already used in shared/retry.ts:1).
  - *fix:* Default options.delay to `(ms, signal) => setTimeout(ms, undefined, { signal: signal ?? undefined })` from node:timers/promises and delete abortableDelay; the injectable delay test seam is unchanged.
- **packages/engine/src/logging/operator-reporter.ts:51** — stripTerminalControls (lines 51-78) hand-parses CSI/OSC escape sequences that node:util's stripVTControlCharacters already handles; only the bidi/C0/C1-to-space replacement is bespoke.
  - *fix:* Use util.stripVTControlCharacters(value) followed by one replace(/[ --‎‏‪-‮⁦-⁩]/g, " "); delete the 28-line loop.
- **packages/engine/src/surfaces/delivery.ts:161** — The SQLite open ritual — `if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), {recursive:true}); new DatabaseSync(path); PRAGMA busy_timeout = 5000` — is copy-pasted across 8 engine stores (surfaces/delivery.ts:161-164, surfaces/registry.ts:41-44, github/ingress-store.ts:86-88, github/operation-store.ts:96-98, plus graph/store.ts, intake/conversation-archive.ts, brain/inbox.ts, scribe/inbox.ts).
  - *fix:* Add a 5-line openManagedDatabase(databasePath) helper in shared/ and reuse it in all 8 stores.
- **packages/agents/src/capabilities/reviewer/github.ts:174** — Tarball-to-workspace seeding is implemented twice: reviewer/github.ts:174-178 `archiveBytes` is byte-for-byte the same coercion (same error string) as coder/github.ts:113-122 `downloadTarball`, and the workspace seeding sequence (rm → mkdir → writeFile tarball → `tar xzf … --strip-components=1` → rm, then a try/finally rm) is duplicated between coder/workflow.ts:256-260/330 and reviewer/workflow.ts:82-86/159.
  - *fix:* Extract one shared seedWorkspaceFromTarball(harness, github, repo, ref, dir) helper (engine/github or a shared capability util) and have both workflows call it.
- **packages/installation/src/schema.ts:212** — ChatGptOAuthCredentialSchema duplicates the credential validation that production actually uses (validateChatGptOAuthCredential in packages/engine/src/model/chatgpt-authentication.ts:399); its only consumer is tests/managed/schema.test.ts — no production code imports it.
  - *fix:* Delete the schema export and its test block; the engine validator is the single seam.
- **apps/cli/src/program.ts:227** — The default runtimeHealthFor closure (read config → read planner credential → probeAmbientRuntimeHealth with the same 750ms timeout) is duplicated verbatim in inspection.ts:95-106; a change to the probe contract must be made twice.
  - *fix:* Export one defaultRuntimeHealthFor (e.g. from inspection.ts) and reuse it in program.ts.
- **packages/installation/src/diagnostics.ts:60** — LEGACY_APPLICATION_CORE_SCHEMA / LEGACY_APPLICATION_OPTIONAL_SCHEMA hand-mirror ~40 engine-owned tables and every column name (~240 lines); applicationTableShapeCompatible (line 312) rejects any table not in the map, so adding one table in the engine without updating this file makes doctor report 'schema-incompatible' and ambient-agent start refuse to boot — a coupling that has already forced the map to grow with every Brain/Scribe/Surface table.
  - *fix:* Stop rejecting unknown tables (check only the core tables' columns), or generate the map from the engine's schema constants instead of hand-mirroring it.

### over-engineered (11)

- **packages/engine/src/intake/admission-relay.ts:9** — `export interface DispatchRetryPolicy extends RetryPolicy {}` is an empty interface extension — a second name for an existing type, imported by packages/agents/src/speaker/dispatch.ts:7 purely as an alias.
  - *fix:* Delete the alias and use RetryPolicy from shared/retry.ts directly at both sites.
- **packages/engine/src/coalescer/chat-gate.ts:11** — ChatGate.allowed declares an isGroup parameter that its only implementation (makeManagedChatGate, :22) ignores, yet callers pay to supply it: managed-chat-inbox.ts:164 computes isGroupJid(event.chatId) and whatsapp.ts:136/150 threads msg.isGroup, all to feed a discarded argument.
  - *fix:* Change the signature to allowed(chatId: string) and drop the isGroup computation at the two call sites.
- **packages/engine/src/github/ingress.ts:174** — export interface GitHubIngressRetryPolicy extends RetryPolicy {} is an empty interface alias with zero importers outside this file (grepped whole worktree); it adds a name, not a type.
  - *fix:* Delete it; use RetryPolicy from ../shared/retry.ts directly at lines 176 and 201.
- **packages/agents/src/brain/effects-runtime.ts:39** — deliverPromptEffect (line 39) and deliverIssueFilingEffect (lines 55-56) are pure one-line aliases of the private deliver/deliverFiling functions defined directly above them — identical signature, zero added behavior.
  - *fix:* Rename the private impls to the public names and export them directly; delete both alias wrappers.
- **packages/agents/src/brain/issue-filing.ts:213** — createIssueFiler's `options: { now?: () => Date } = {}` knob is config for a value that never changes — neither the production caller (apps/runtime/src/host/whatsapp-runtime.ts:360) nor the only test caller (tests/brain/effects.test.ts:168) ever passes it.
  - *fix:* Delete the options parameter and pass `now: () => new Date()` inline to createIssue.
- **packages/agents/src/brain/effects-runtime.ts:131** — fileIssue?/repositoryForSurface? optionality plus its two guards (brain/tools.ts:90-92 "Issue filing is not configured", effects-runtime.ts:49 "no GitHub issue-filing binding") defend a composition that doesn't exist — the only production configurer (whatsapp-runtime.ts:355-368) unconditionally sets both, unconfigured routing already surfaces via the throw inside repositoryForSurface (whatsapp-runtime.ts:362-364), and no test exercises either guard; the doc comment "Absent when this runtime carries no GitHub write binding" describes no real runtime.
  - *fix:* Make fileIssue and repositoryForSurface required on BrainEffectsRuntime and delete both unreachable guards (tests that omit fileIssue can pass a throwing stub), or fix the doc comment if genuinely keeping the optional seam.
- **packages/agents/src/capabilities/delegation/bridge.ts:65** — installDelegationBridge memoizes and returns the instrument() dispose function, but its single caller (apps/runtime/src/app.ts:131) runs once per process and discards the return value; the (() => Promise<void>) return type is unused API.
  - *fix:* Return void; replace the memoized dispose-fn with a plain boolean re-entry guard.
- **packages/agents/src/capabilities/coder/schemas.ts:24** — Config knobs for values that never change: `maxReviewCycles` (validated 0–5, default 2, schemas.ts:8/11/24) is accepted, defaulted, echoed into every waypoint (workflow.ts:238) — but no review loop exists; `reviewCycle` is hard-coded `const reviewCycle = 0` (workflow.ts:224) and `mode` is a single-literal picklist ('review_continuation' explicitly reserved for #211, schemas.ts:19). This is #211 scaffolding shipped ahead of #211.
  - *fix:* Drop maxReviewCycles/mode from the request schema and reviewCycle from waypoints/results until #211 actually lands the review-continuation loop; reintroduce them with the code that reads them.
- **packages/agents/src/scribe/coalescer.ts:122** — createScribeCoalescer carries a whole second dispatch pipeline that production never runs: the non-inbox flush path (coalescer.ts:122-135), its per-instance `attempts` semaphore plus the `maxConcurrentAttempts` option (37, 94 — used by exactly one test), and the swallow logger (103-107) all execute only when `options.inbox === undefined`, but production always wires the inbox via configureScribeInbox (apps/runtime/src/host/whatsapp-runtime.ts:276) and the code itself labels the fallback 'legacy in-memory test seam' (164, 226). Concurrency is then gated twice: dispatchScribeAttempt already holds the module-level productionAttempts semaphore (56, 74).
  - *fix:* Make `inbox` required, delete the non-inbox flush branch, maxConcurrentAttempts, and the per-instance semaphore, and port the affected tests to a fake inbox.
- **packages/agents/src/capabilities/whatsapp-participation/whatsapp-port.ts:17** — WhatsAppSayPort and WhatsAppReactPort (whatsapp-port.ts:17-26) exist solely to be intersected into WhatsAppOutboundPort one line later (27); nothing anywhere consumes either interface independently (grep: only this file). Two named abstractions for zero extra consumers.
  - *fix:* Collapse say/react directly into WhatsAppOutboundPort and delete the two single-use interfaces.
- **packages/installation/src/uncertain-work.ts:28** — UncertainWorkStatus carries both externalMutations and total, but the two are always assigned the same value (lines 93-98 and 194-199) — a leftover from when Window delivery was also Uncertain work (the line-21 comment notes only GitHub mutations remain). Consumers (rendering.ts:102-103, smoke.ts:115-120, program.ts:814) mix the two interchangeably.
  - *fix:* Collapse to one field (keep externalMutations or total, not both) and update the three consumers.

### stale-config (8)

- **packages/installation/src/runtime-dependencies.ts:36** — Outside the four audited dirs but explicitly requested: the AMBIENT_AGENT_RUNTIME_PROFILE gate survives the Layer-2 reset — TenantRuntimeEnvironment (:36-39, no external importers) and runtimeDeploymentIdentityFromEnvironment (:68-83) still validate 'setup'/'operate' modes whose consumers were deleted; the sole remaining caller (apps/cli/src/lifecycle.ts:160) always gets undefined on the single-box path per STATUS.md ("all removed code was gated behind unset AMBIENT_AGENT_RUNTIME_PROFILE").
  - *fix:* Delete TenantRuntimeEnvironment + runtimeDeploymentIdentityFromEnvironment, drop the lifecycle.ts call, and prune the now always-undefined deployment field from bridge-contract.ts:15,42.
- **packages/installation/src/tenant-credentials.ts:18** — TENANT_DB_URL/TENANT_DB_TOKEN fork (:18, :34-38) is reset-era multi-tenant residue; STATUS.md already lists collapsing the file-vs-libsql fork to files-only as a deferred decision, so this is confirmation, not news.
  - *fix:* When the deferred decision is taken, delete the TENANT_DB_URL branch and keep files-only; until then no action.
- **packages/installation/src/runtime-dependencies.ts:37** — AMBIENT_AGENT_RUNTIME_PROFILE is still read (TenantRuntimeEnvironment at :36-40, runtimeDeploymentIdentityFromEnvironment at :68-82, sole caller apps/cli/src/lifecycle.ts:160 feeding bridge-contract.ts:15) even though STATUS.md:44-48 says the Layer-2 reset removed all code this profile gated and it is unset on the single-box path — the reader survives with nothing left to select.
  - *fix:* Delete runtimeDeploymentIdentityFromEnvironment, TenantRuntimeEnvironment, and the optional deployment identity in bridge-contract.ts/lifecycle.ts:160 (adjacent to the audited area; flagged because the task asked for reset-era gates).
- **packages/installation/src/tenant-credentials.ts:18** — The TENANT_DB_URL/TENANT_DB_TOKEN libsql credential fork (tenant-credentials.ts:18-38, createLibsqlChatGptCredentialStore at :302, forked in packages/installation/src/chatgpt-authentication.ts:19-31) is dead on the single-box path; STATUS.md:53 already lists collapsing it to files-only as a deferred decision, so this is acknowledged debt, not news.
  - *fix:* When the deferred decision lands, delete the env gate, createLibsqlChatGptCredentialStore, tests/managed/tenant-credentials.test.ts, and the fork in createManagedChatGptAuthentication — until then no action.
- **packages/agents/src/capabilities/coder/evals/coder.eval.ts:31** — Three eval batteries are permanently skipped: they gate on CODER_FIXTURE_READY (coder/evals/coder.eval.ts:31), REVIEWER_FIXTURE_READY (reviewer/evals/reviewer.eval.ts:7), and SCRIBE_FIXTURE_READY (graph-extraction/evals/graph-extraction.eval.ts:38), and nothing in the repo ever sets those flags — scripts/run-evals.ts:125-126 sets only PLANNER_FIXTURE_READY and VERIFIER_FIXTURE_READY. The coder eval's own header admits the fixture 'does not exist yet'. These are green-looking assertions that can never run.
  - *fix:* Either wire the missing fixture flags into scripts/run-evals.ts (making the batteries real) or delete the placeholder eval files and file one issue to bring them back with the fixture.
- **packages/installation/src/tenant-credentials.ts:31** — The entire 528-line TENANT_DB_URL/TENANT_DB_TOKEN libsql fork (libsqlStore, createLibsqlChatGptCredentialStore with its 15s lease + heartbeat machinery, snapshot/rollback helpers) is reachable only when TENANT_DB_URL is set — the SaaS provisioner that set it was deleted in the Layer 1/2 reset, and STATUS.md itself lists 'collapse the file-vs-libsql fork to files-only' as the deferred decision. In production nothing sets these vars, so this is dead weight plus four live forks it forces on callers: whatsapp-account.ts:128, chatgpt-authentication.ts:19, diagnostics.ts:435, and program.ts:323/364/651/686 (init/auth/repair each branch on tenantDatabase), plus installation.ts:137/717 (modelCredentialStorage: 'tenant-database') and first-run.ts:89.
  - *fix:* Execute the deferred collapse: delete tenant-credentials.ts, the four call-site forks (keep fileStore/createManagedChatGptCredentialStore paths), the modelCredentialStorage option, and drop the now-unused @libsql/client dependency from packages/installation/package.json.
- **packages/installation/src/runtime-dependencies.ts:68** — runtimeDeploymentIdentityFromEnvironment reads AMBIENT_AGENT_RUNTIME_PROFILE / AMBIENT_AGENT_CONFIG_VERSION — the exact gates STATUS.md says the removed hosted/tenant boot sat behind (Layer 2 done). Nothing in the repo or deploy sets them, so lifecycle.ts:160 always gets undefined and the whole chain is inert: TenantRuntimeEnvironment (line 36), RuntimeDeploymentIdentity (line 41), the deployment field on ManagedRuntimeDependencies (line 12), bridge-contract.ts:15/42's deployment parameter, and app.ts:189's threading into bridgeHealth. Only tests and STATUS.md mention the vars.
  - *fix:* Delete runtimeDeploymentIdentityFromEnvironment, TenantRuntimeEnvironment, RuntimeDeploymentIdentity, the deployment field/parameter in runtime-dependencies.ts, bridge-contract.ts, lifecycle.ts:160, and app.ts:189, plus their tests.
- **packages/installation/src/installation.ts:31** — CONFIG_ISSUE_PATHS is a hand-kept mirror of ManagedConfigSchema's field paths that has drifted: it lacks github.reviewRepositories, github.surfaceRepositories (and their [] entries), smoke, and smoke.canaryChat (all present in schema.ts:119-131), so a validation issue on any of those fields is reported to the operator as '<unknown field>' instead of its path.
  - *fix:* Add the missing paths (or derive the set from ManagedConfigSchema) so doctor names the actual broken field.

### doc-drift (6)

- **packages/engine/src/brain/inbox.ts:341** — The factory doc comment (:341-347) describes `createBrainInbox` as only "the application-owned Speaker Intent admission boundary (ADR 0002)", but the module has since grown to own Brain Batches, Effects (prompt/silence/file_issue), Knowledge Deltas, and Specialist launch/result reconciliation (ADR 0005) — the comment covers roughly a quarter of what the 700-line factory does.
  - *fix:* Rewrite the comment to name the full Brain inbox/ledger scope and cite both ADR 0002 and ADR 0005.
- **packages/engine/src/coalescer/events.ts:12** — The module doc (lines 12-15) is grammatically broken mid-sentence ("flattens that message into this application record into one record and keep the two addressing fields") and cites `update-Bi5ZPUjP.d.mts:14-22` — a content-hashed generated bundle filename that is already stale and will change on every whatsappd rebuild.
  - *fix:* Rewrite the paragraph in plain terms and remove the hashed-bundle line reference.
- **packages/engine/src/shared/flue-global.ts:5** — The doc comment claims "Every configure/get pair in the codebase goes through here so the mechanism ... lives in exactly one place", but logging.ts:106-107 (LOGGING_ROOT) and packages/installation/src/runtime-dependencies.ts:46-47 (RUNTIME_DEPENDENCIES, WHATSAPP_RUNTIME_START) roll their own Symbol.for globalThis slots.
  - *fix:* Either migrate those slots onto createFlueGlobal (logging can use peek() for its fallback) or soften the comment to stop overclaiming.
- **packages/agents/src/capabilities/coder/SKILL.md:10** — Skill and code comments still cite planning docs deleted in the 2026-07-21 reset: coder/SKILL.md:10 links blob/main/docs/planning/MEMORY-STATE-SPEC.md (docs/planning/ no longer exists — docs/ now holds only SYSTEM-ARCHITECTURE.md, ARCHITECTURE.md, adr/, reference/, research/); whatsapp-participation/SKILL.md:13 and references/rubric-traceability.md:3 and issue-management/SKILL.md:10 link PARTICIPATION-RUBRIC.md on the stale docs/wayfinder-map branch; coder/runtime.ts:10 and graph/schemas.ts:10 cite MEMORY-STATE-SPEC sections as authority. Every 'source of truth' pointer in these skills is a dead or off-canon link.
  - *fix:* Repoint the citations at the surviving canon (docs/SYSTEM-ARCHITECTURE.md / docs/ARCHITECTURE.md sections) or vendor the ratified rubric text into references/, then delete the branch links.
- **packages/agents/src/capabilities/graph/digest.ts:14** — buildGraphDigest's doc claims 'three consumers, one implementation: the Speaker funnel (attachGraphContext), and the Coder/Reviewer/Planner Specialists' — but attachGraphContext calls computeGraphDigest directly (digest.ts:58), not buildGraphDigest, and only issue-shaped launches get a graphContext (delegation/tools.ts:40-49 requires `specialistInput.issue`); reviewerJobInputSchema has no graphContext field at all, and Planner is an internal role of the coder workflow, not a launched Specialist. buildGraphDigest's only real caller is buildJobGraphContext in the same file.
  - *fix:* Fix the comment (one caller: buildJobGraphContext, Coder launches only) or inline buildGraphDigest into buildJobGraphContext and delete the export.
- **packages/installation/src/e2b-sandbox.ts:198** — The e2bSandbox jsdoc says 'Authentication is the SDK's own E2B_API_KEY environment variable — operator configuration', but #252 moved the key to credentials/e2b.json: agent-sandbox.ts:57 explicitly warns that a set E2B_API_KEY is ignored, and E2BSandboxOptions.apiKey (line 174) documents the opposite of this paragraph.
  - *fix:* Delete or rewrite the stale authentication paragraph in the e2bSandbox doc comment.

### other (2)

- **packages/engine/src/brain/inbox.ts:539** — The `evidence` statement is prepared unconditionally against `conversation_events` at construction time — a table this module never creates — so `createBrainInbox` on a database without the conversation archive throws at prepare; sibling graph/store.ts:622-624 guards the very same table with a sqlite_master existence check before touching it.
  - *fix:* Either guard like store.ts's `hasConversationArchive`, or add one comment stating the archive-first co-location invariant so the implicit init-order coupling is at least written down.
- **packages/engine/src/graph/store.ts:935** — `projectEntity` and `projectRelation` call `database.prepare(...)` inside every invocation (INSERT upsert at :935, DELETE at :960, identity INSERT at :963, relation upsert at :977) while read statements are hoisted once at :593-603 — `rebuildProjection` re-compiles these statements once per entity/relation on every full rebuild (which every merge/ruling triggers, :1022-1024).
  - *fix:* Hoist the four write statements next to the existing prepared selects.

