# T8 — Ratify the implementation DAG (feeds /to-spec → /to-tickets)

Type: `wayfinder:grilling` (HITL — final gate of the map)
Blocked-by: T1, T2, T3, T4, T5, T6, T7 (every decision feeds an edge)
Blocks: /to-spec → /to-tickets

## Question

Ratify the blocking-edge DAG that /to-tickets will file (with Aaron's explicit
go-ahead — nothing reaches GitHub before then).

## Draft DAG (evidence-informed refinement of the WAYFINDER-INPUTS skeleton)

**Wave 0 — parallel, no blockers, all ratified/mechanical:**

- `W-console` — B1 chat-visible console + B4 pino-pretty chat lines + ADR 0016
  amendment (the operative clause is one sentence: "Message text is logged at debug
  level only", docs/adr/0016 ¶2). T3's settled-silent line upgrades this later; don't wait.
- `W-symbolfor` — C1: normalize 4 unsafe module `let`s to the Symbol.for pattern
  (issue-management/runtime.ts:68, whatsapp-port.ts:46, github/ingress-runtime.ts:10,
  host/whatsapp-runtime.ts:118; safe exemplar runtime-dependencies.ts:12-32).
- `W-mech` — D6–D13 mechanical batch (~250 lines incl. combineReceipt — note: evidence
  shows its two branches are IDENTICAL, whatsapp-runtime.ts:29-38, pure delete).
- `W-attach-env` — D4 legacy ATTACH delete + D3 env-loader delete **as one ticket**:
  evidence shows they interlock (`legacyDatabasePath` enters only via
  `loadGitHubIngressSettings`, ingress.ts:85; production app.ts never passes it —
  the cutover is already test-only). Fixture switches to building settings inline,
  which C2 then absorbs.
- `W-d2` — D2 tools.ts lifecycle collapse (ratified ungated; pinned by 35 tests).
- `W-c4` — C4 dependency-direction flip (7-line type move).
- `W-braintrust` — A4 `pnpm exec flue add tooling braintrust`.

**Evals thrust (critical path):**

`T1 rubric session` → `W-window-input` (T2's chosen harness variant) →
`W-scorers` (A2/A3 suites; also needs W-braintrust) → **evals-green milestone**.

**Observability:**

`T3 decision` → `W-observer` (B2+B3, one ticket: observer + dispatch-spanning typing)
→ upgrades W-console's silent line.
`W-c3` (program.ts split, unblocked wave 0-adjacent) + `T7 decision` + `W-observer` +
`T1 carve-out` → `W-smoke` (B5).

**Features:**

`T4 decision` → `W-windows-everything` (coalescer union + renderer + account wiring;
`conversation_reactions`/`receipts` table deletes ride this per T4's projection call).
`T5 decision` → `W-react-tool` (port + tool + fake host event; live-tests the kept echo
machinery).

**Split (last):**

`T6 decision` → `W-compose` (C2) — after W-windows-everything if T4 picks O1 (the
coalescer wiring it centralizes changes shape).
`W-cut` (C5 four-package cut) ← evals-green + W-symbolfor + W-compose + W-c3 + W-c4.

## To ratify

(a) the wave-0 bundle boundaries (esp. D3+D4 merged); (b) the evals-green milestone as
C5's hard gate; (c) W-compose ordered after W-windows-everything; (d) anything Aaron
wants pulled forward/dropped.
