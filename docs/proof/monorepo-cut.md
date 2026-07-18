# Monorepo cut — live proof

Date: 2026-07-17

Tickets: [#117](https://github.com/AaronAbuUsama/ambient-agent/issues/117) (the cut) +
[#131](https://github.com/AaronAbuUsama/ambient-agent/issues/131) (the ratified taxonomy, folded
into the same PR per Aaron's direction)

This records the proof that the monorepo cut changed structure, not behavior: the packed-tarball npx
install on the rig with every smoke station passing, and the full eval battery at the recorded
[#113 baseline](./eval-baseline.md) floors.

## The taxonomy (ratified live, 2026-07-17)

```text
apps/
├── cli/            the operator application (setup/ folded in)
└── server/         the Flue application (build root: flue build --root apps/runtime)
packages/
├── engine/         agent-agnostic conversation machinery: coalescer (WindowDispatcher port),
│                   intake, GitHub ingress + operation store, the agent input contracts,
│                   model/provider glue, logging, shared. Imports nothing internal.
├── agents/         everything that thinks; one folder per agent. ambience/ owns agent.ts,
│                   layered domain skills (SKILL bundle + tools + port per slice), compose,
│                   dispatch (T8: beside the agent), observer, activity reporter.
├── installation/   installation machinery, flat (name ratified 2026-07-17): paths, config,
│                   schema, installation, diagnostics, migration, uncertain-work, runtime
│                   health + the globalThis handshake, credentials, WhatsApp pairing,
│                   Octokit adapter, qr/files.
└── test-support/   fakes + eval harness/judges/suites.
```

The arrows, enforced by `tests/ambience/hard-cut.test.ts`: engine imports nothing internal;
agents → engine; installation → agents + engine; apps/runtime → all three; **apps/cli → installation +
engine, never agents** (the operator surface and the thinking surface meet only at the running
server). Wildcard `./*` exports are gone and asserted gone — each package exports an explicit
measured surface (engine 23, agents 8, installation 12 subpaths); root tests use relative white-box
paths so the public surfaces stay honest.

Composition: `composeAmbience(adapters)` (T6 O1) is the one composition root, consumed by
`apps/runtime/src/app.ts` and the eval fixture; the coalescer stack deliberately stays outside it
(production: `runWhatsAppSession`; fixture: its Effect fork with test seams). Identity stays in
the agent's `instructions:` — Flue skills are progressively disclosed per the Agent Skills spec,
so standing identity is precisely the frame a skill can't carry (recorded on #131); all behavior
policy lives in the two skill bundles.

**Bundling mechanism** (the load-bearing discovery): `flue build` externalizes exactly the
dependencies declared in its `--root` manifest. `apps/runtime/package.json` therefore declares the
real npm runtime dependencies but deliberately **no** internal `@ambient-agent/*` packages, so
engine/agents/installation bundle into the published `dist/server.mjs` while npm dependencies stay
external — the tarball remains self-contained with an unchanged layout. The CLI bundle pins the
same property with `pack.noExternal: [/^@ambient-agent\//]`.

## Checks

All green locally at the PR tip:

- `pnpm build` — flue server build (agent + channel discovered from `apps/runtime`) + vp pack CLI
- `pnpm exec vp lint .` — one pre-existing warning (`no-useless-catch`), no new findings
- `pnpm exec tsc --noEmit` — clean
- `pnpm test` — 377 passed, 3 skipped (39 files), including `tests/packaging/packed-cli.test.ts`
  (npm pack → pnpm install → init/status/start/doctor journeys against the installed tarball) and
  the boundary test enforcing the arrow diagram + explicit-exports rule
- `pnpm evals` — see below (authenticated run on the rig)

## Rig

- Host: `code-factory` (user `abuusama`)
- Persistent runtime: tmux session `validate-88`, window `run117`
- Tarball: `$HOME/validate-88/ambient-agent-0.3.0-issue117.tgz`
- Packed artifact SHA-256: `94a8002a1ee1420d2314a2375d8fb4865038163b5cc86a3f5381b452c48c098e`
- Data directory: the isolated `$HOME/validate-88/issue126-data` clone (same as the #126 proof; no
  schema change in this PR)
- Runtime health endpoint: `http://127.0.0.1:42069/health`

## npx install transcript

```sh
npx --yes --package=file:$HOME/validate-88/ambient-agent-0.3.0-issue117.tgz \
  ambient-agent --data-dir $HOME/validate-88/issue126-data start
```

Health after start:

```json
{"ok":true,"installationId":"CK-jmk8n-7S-fAop5_w8lm","authentication":"chatgpt-oauth",
 "model":"openai-codex/gpt-5.6-luna","provider":"openai-codex",
 "runtime":{"state":"healthy","whatsapp":{"phase":"online"}}}
```

`status --json` (same npx form): `state: ready`; checks `application-database:ready ·
flue-database:ready · whatsapp-session:online · github-credential:ready`; observed runtime
healthy. `doctor --json`: exit 0, `state: ready`, `chatgpt: ready`.

## Six-station smoke transcript

```sh
npx --yes --package=file:$HOME/validate-88/ambient-agent-0.3.0-issue117.tgz \
  ambient-agent --data-dir $HOME/validate-88/issue126-data smoke --timeout 60000
```

Real output (exit 0):

```text
PASS installation: managed installation ready
PASS chatgpt: authentication ready; live readiness complete
PASS runtime: healthy; WhatsApp online
PASS backlog: 0 pending, 0 failed, no Uncertain work
PASS github: access to AaronAbuUsama/ambient-agent
PASS canary: SMOKE 5c2a3a3739ed settled silent (admission → dispatch → settled-silent)
```

The persistent runtime independently recorded the same nonce and lifecycle
(`$HOME/validate-88/issue131-runtime.log`):

```json
{"operatorEvent":"chat.received","text":"SMOKE 5c2a3a3739ed — ignore","chatId":"120363410063306573@g.us",...}
{"operatorEvent":"agent.settled_silent","windowId":"...","dispatchId":"...",
 "msg":"Ambience settled without saying a WhatsApp message"}
```

## Eval battery vs the #113 baseline

`pnpm evals` ran on the rig from a checkout of the PR tip
(`$HOME/validate-88/issue117-eval-source`, log `issue131-evals-final.log`), authenticated to Braintrust.
Experiment:
[ambient-agent-eval-baseline-2026-07-17T13-41-37-968Z](https://www.braintrust.dev/app/capxul/p/ambient%20agents/experiments/ambient-agent-eval-baseline-2026-07-17T13-41-37-968Z).
Application and judge model unchanged: `openai-codex/gpt-5.6-luna`.

Receipt: deterministic 12 passed (9 live gated); live judged 9 passed (12 deterministic gated) —
identical counts to the baseline receipt.

| Axis                      | Metric                          | Baseline | Floor | This run | Verdict |
| ------------------------- | ------------------------------- | -------: | ----: | -------: | ------- |
| 1 — address forms         | Unsolicited-reply rate          |       0% |   ≤5% |     0.0% | HOLDS   |
| 1 — address forms         | Live address-forms grade        |     100% |   95% |   100.0% | HOLDS   |
| 2 — usefulness            | Addressed-response grade        |     100% |   90% |   100.0% | HOLDS   |
| 2 — usefulness            | Addressed-say rate (mechanics)  |     100% |  100% |   100.0% | HOLDS   |
| 3 — issue capture         | Capture-conversation grade      |     100% |   80% |   100.0% | HOLDS   |
| 3 — issue capture         | Filed-issue receipt rate        |     100% |  100% |   100.0% | HOLDS   |
| 4 — multi-message Windows | Per-concern handling grade      |      80% |   50% |   100.0% | HOLDS   |
| 5 — hard silence          | SMOKE hard-silence rate         |     100% |  100% |   100.0% | HOLDS   |
| 6 — elicitation           | Elicitation-quality grade       |     100% |   80% |   100.0% | HOLDS   |

Axis 4 note: this stochastic judged axis graded 0.90 and 0.50 in two intermediate runs on this
branch (both at/above the 50% floor) and 1.00 at the final tip — consistent with the baseline
document's warning that its judged grade varies while the exact no-chatter and mutation mechanics
stay protected by deterministic assertions (all passed in every run).

## Verdict

Structure changed, behavior didn't: all suites/lint/typecheck green, the packed npx flow runs the
real installation end-to-end with every smoke station passing, and every eval axis meets its
recorded regression floor at the final taxonomy.
