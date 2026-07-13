# whatsappd-github-agent — Execution State (session handoff)

> Historical design record. Superseded by the Flue Ambience production path completed in milestone #3; this is not current operator or architecture guidance.

Single source of truth across a `/compact` boundary. Read this first on resume.

Last updated: 2026-07-11.

---

## 1. Mission / end product

A **WhatsApp group-chat GitHub agent** that feels like **one assistant** but is really a
**two-tier system**, running with **no API keys** (OpenAI Codex / ChatGPT subscription auth).

- **Fast tier (orchestrator):** a cheap fast model watches a *debounced* window of the group,
  responds naturally, knows when it's addressed, and decides when to kick off work. Non-blocking —
  never runs the heavy model on every message, never blocks the chat.
- **Deep tier (responder/worker):** does the actual GitHub work (issues, reviews, etc.); can run
  multiple tasks. Steered *between* turns by the fast tier.
- **UX invariant:** cohesive single voice. It must never feel like "a bunch of agents."

This is **already designed**: it is the `agent-niceties` **SPEC** (tickets 00–09). See §6.

## 2. Decisions (with rationale)

| Decision | Choice | Why |
|---|---|---|
| Model provider | **OpenAI Codex / ChatGPT-subscription** (auth via the user's `codex login` session) | Hard rule: **no API credits / no API keys.** Eve routes through the Vercel AI SDK, so this is a provider swap in `agent/agent.ts`. |
| Test target (Stage 1) | **Throwaway sandbox repo** (e.g. `AaronAbuUsama/wa-bot-sandbox`) | Real writes (create/close/comment/label/review) with **zero blast radius**. |
| Sequencing | **Single-model E2E first, THEN split into two-tier** | Keep a working bot at every step; de-risk. |
| North star design | The `agent-niceties` SPEC | Already synthesized; don't reinvent the attention loop. |
| Reads vs writes security | Write allow-list; reads unrestricted | Writes are the blast radius (already built — §3). |

## 3. What's done

**Library — `whatsappd`** (separate repo `/Users/abuusama/projects/hack-space/whatsapp-agent-channel/whatsapp-channel`)
- Public: https://github.com/AaronAbuUsama/whatsappd · npm `whatsappd@0.2.0` · branch **`master`** @ **`1d96d5f`** · tag `v0.2.0` · CI green. Single squashed commit; GitButler removed; pre-cleanup history in `backup/ungb/*` tags. See memory [[whatsappd-publish-setup]].

**Bot — `whatsappd-github-agent`** (this repo) · branch **`main`** @ **`e4d417d`** · public · CI green · 56 tests · 13 tools.
- `70c6c19` initial build (Eve agent + 10 tools + gate + tutorial; built by a prior sub-agent).
- `975ce44` **harden(security):** write allow-list (`resolveWritableRepo`/`GITHUB_ALLOWED_REPOS`); gate **fails closed** on unconfigured group; `WHATSAPP_GROUP_IDS` multi-group; `WHATSAPP_ALLOWED_SENDERS`; constant-time sidecar-token check + startup warning.
- `b7780a3` **feat(tools):** `github_add_labels`, `github_assign`, `github_get_pull_request_diff` (→13); write-guard tests.
- `de38d78` **feat(scripts):** `scripts/whatsapp-dry-run.ts` (send-nothing connectivity probe).
- `e4d417d` **docs:** tutorial + README + STATUS updated for the hardening pass.

## 4. What's held / next (in order — user's chosen sequencing)

**STAGE 1 — prove the single-model bot end-to-end on Codex.**
1. **TASK #1 — Codex/subscription model: ✅ SOLVED NATIVELY & PROVEN E2E (2026-07-11).**
   `agent/agent.ts` uses **eve's native `experimental_chatgpt()`** (`eve/models/openai`) +
   `modelContextWindowTokens: 200_000`. It reads the local `codex login` (`~/.codex/auth.json`) and
   bills the ChatGPT subscription — **no ANTHROPIC_API_KEY / OPENAI_API_KEY**. The third-party
   `ai-sdk-provider-codex-cli` was removed (native path is cleaner and — being in eve's model catalog —
   carries the context-window metadata eve needs for compaction; a custom AI-SDK provider does not,
   which crashed `eve dev` with "does not have known AI Gateway context window metadata").
   **Residual tool-round-trip risk is RESOLVED:** a synthetic addressed event → the model called
   `github_create_issue` → issue #1 created in `wa-bot-sandbox` with the exact requested title/body.
   Eve-native tool loop routes our tools correctly.
2. ✅ **Paired** a fresh number (Benin 229…); creds in `./.wa-auth`. Group locked to **"Lavin UK"**
   `WHATSAPP_GROUP_ID=120363410063306573@g.us` (found via `scripts/find-group-jid.ts`; note: the
   sidecar drops `fromMe`, so send test messages from a *second* number).
3. ✅ **Sandbox repo** `AaronAbuUsama/wa-bot-sandbox` created (private). The user's fine-grained PAT
   wasn't scoped to it → E2E used the `gh` CLI token via gitignored `.env.local`. For real use, scope
   the PAT (add the repo + Issues/PRs read-write, Contents read) and delete `.env.local`.
4. ✅ **E2E PROVEN — every leg**: gate accepts addressed msg → session → `experimental_chatgpt` (no key)
   → `github_create_issue` → issue #1 in sandbox; and the reply leg `sidecar POST /send → WhatsApp group`
   delivered a message to Lavin UK. Run harness: `POST http://127.0.0.1:2000/event` with a synthetic
   `SidecarEvent` (see §7). Ports: sidecar 8788, agent 2000; use **127.0.0.1** (sidecar is IPv4-only).
5. 🐞 **Found + fixed a whatsappd bug** that blocked the reply leg: `adapter.start()` awaited the
   never-resolving `supervise()` loop, so `runSidecar` never reached `server.listen()` and the sidecar
   HTTP server never bound 8788 (replies → ECONNREFUSED). Filed **whatsappd#1**, opened **PR whatsappd#2**
   (fix + regression test + bump to **0.2.1**). Bot bridges via `pnpm patch whatsappd@0.2.0`
   (`patches/whatsappd@0.2.0.patch`) until 0.2.1 ships.
   **→ NEXT (needs the maintainer): merge PR #2 and `pnpm publish` whatsappd 0.2.1**, then in the bot
   `pnpm add whatsappd@^0.2.1` and drop the patch (`patches/` + `pnpm.patchedDependencies`).
   Then Stage 1 is fully closed and we start Stage 2.

**STAGE 2 — build the two-tier (from the SPEC, §6).**
6. Sidecar-side **fast gate + two-speed debounce/buffer** (free @mention/quote short-circuit; else
   buffer + debounce → fast model verdict). Constants: `IDLE 15s / HOT 4s (per-user) / ENGAGED 40s`.
7. **Fast/deep model routing** (Eve app `defineDynamic`) — both tiers on the Codex subscription.
8. **"One voice" polish**: preamble ("give me a sec"), streaming chunker (deltas → WhatsApp bubbles),
   presence heartbeat, turn correlation/cancel.

## 5. How-to / conventions / DoD

- **Run:** `pnpm run dev` (Eve agent, port 2000, **Node ≥24**) + `pnpm run whatsapp` (sidecar, port 8788, Node ≥22 ok). Sidecar POSTs inbound to `WHATSAPP_FORWARD_URLS` = app root **+ `/event`** (NOT `/channels/...`).
- **Find the group JID:** `npx tsx scripts/find-group-jid.ts` (listener on :8790); point `WHATSAPP_FORWARD_URLS` at it, send a message in the target group, it prints `WHATSAPP_GROUP_ID=…@g.us`. Then revert the forward URL to the agent.
- **Env:** see `.env.example`. Key knobs: `GITHUB_TOKEN`, `GITHUB_REPO`, `GITHUB_ALLOWED_REPOS` (writes), `WHATSAPP_GROUP_ID(S)`, `WHATSAPP_BOT_TRIGGER` (default `@github-bot`), `WHATSAPP_ALLOWED_SENDERS`, `WHATSAPP_SIDECAR_TOKEN`. (`ANTHROPIC_API_KEY` line gets replaced by the Codex auth mechanism.)
- **Match conventions:** tools = one file per `agent/tools/github_*.ts`, `defineTool()` + Zod, WRITE tools resolve via `resolveWritableRepo`, READ via `resolveRepo`; every tool has a mocked-octokit unit test in `tests/tools/`.
- **DoD Stage 1:** `npm run typecheck` + `npm test` green; `eve build` green in CI (Node 24); a real "@github-bot open an issue: …" in a group creates an issue in the sandbox repo; an unaddressed message is dropped (`{"ignored":true}`); all running on Codex/subscription with no API key present.

## 6. Key file pointers

- **The two-tier SPEC (blueprint):** in the whatsappd repo, recover with
  `git show backup/ungb/niceties-docs:.scratch/agent-niceties/SPEC.md` (also `map.md` + `issues/00..09`).
  It has the attention-loop architecture, the gate code shape, the debounce constants, and the
  concern-placement table (sidecar vs Eve adapter).
- **Bot model wiring (to change):** `agent/agent.ts`.
- **Bot gate:** `agent/channels/whatsapp.ts` (`isAddressed`, `createGatedEventRoute`).
- **Bot GitHub layer:** `agent/lib/github.ts` (`resolveWritableRepo`, allow-list), `agent/tools/`.
- **Pairing probe:** `scripts/whatsapp-dry-run.ts`.
- **Docs:** `docs/TUTORIAL.md`, `README.md`, `STATUS.md`.
- **Memory:** [[whatsappd-github-agent-build]], [[whatsappd-publish-setup]], [[wayfinder-agent-niceties]].

## 7. Gotchas & risks (will bite if forgotten)

- ✅ **Model SOLVED** (was the biggest risk): eve-native `experimental_chatgpt()` rides `~/.codex/auth.json`
  — no API key. See §4 Task #1. Keep both `*_API_KEY` env vars UNSET on purpose.
- ⚠️ **Do NOT set `PORT` in `.env`.** Both the sidecar and `eve dev` read `PORT`; setting it makes eve
  bind the sidecar's port (8788) instead of its default 2000, breaking the forward URL. Unset → sidecar
  8788, eve 2000. (Fixed in `.env.example`.)
- ℹ️ **E2E harness (no phone needed):** `POST http://localhost:2000/event` with a synthetic `SidecarEvent`
  (Bearer = `WHATSAPP_SIDECAR_TOKEN`, `chatId` = the group JID, text containing `@github-bot …`) drives the
  gate → session → model → tools. Reply delivery is the only leg that needs a live sidecar on 8788.
- ℹ️ **Testing token:** the user's fine-grained PAT wasn't scoped to `wa-bot-sandbox`; E2E used the `gh`
  CLI token via a gitignored `.env.local` (`GITHUB_TOKEN=<gh auth token>`, overrides `.env`). Write
  allow-list still confines writes to the sandbox. For real use, scope the PAT and delete `.env.local`.
- ⚠️ **Stored WhatsApp creds are DEAD** (`open-harness/whatsapp/.wa-auth-*` both returned
  `logged_out_remote`). A fresh pairing is mandatory before any live run.
- ⚠️ **Node ≥24 for `eve` CLI** (dev/build/start); the sidecar is fine on Node 22. CI splits the
  `eve build` step onto the Node-24 leg only.
- ⚠️ **Do NOT build Stage 2 (two-tier) until Stage 1 (single-model E2E) works** — user's explicit order.
- ⚠️ Never commit secrets: `.gitignore` covers `.env`, `.env.*`, `.wa-auth*/`. Secret-scan before any push.
- The bot now uses **pnpm** (`packageManager: pnpm@9.15.9`). `pnpm.onlyBuiltDependencies` allowlists
  `esbuild`/`baileys`/`protobufjs` so pnpm-10+ CI doesn't hit `ERR_PNPM_IGNORED_BUILDS`. Local pnpm 9
  runs those build scripts by default. Node ≥24 still required for the `eve` CLI.
- whatsappd exposes a first-class Eve adapter at `whatsappd/adapters/eve`; the bot re-implements only
  the inbound route (to gate before starting a session), reusing the adapter's other building blocks.
