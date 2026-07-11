# whatsappd-github-agent — Execution State (session handoff)

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
1. **TASK #1 (biggest unknown): find + wire the Codex provider.** Verify the exact AI-SDK package
   that authenticates via the ChatGPT/Codex subscription (NOT an OpenAI API key). Candidates to check:
   an `ai-sdk`/`@ai-sdk` community Codex provider, or bridging the local `codex` CLI's auth. If none
   is clean, that's the escalation point — surface options, don't silently fall back to an API key.
   Then edit `agent/agent.ts` to replace `@ai-sdk/anthropic`.
2. **User does the auth/setup** (they will do this live): pair a **fresh** WhatsApp number
   (`npm run whatsapp` → scan QR), set `GITHUB_TOKEN` + `GITHUB_REPO=<sandbox>` + subscription auth.
3. Verify pairing: `npx tsx scripts/whatsapp-dry-run.ts ./.wa-auth` → expect `status: online`.
4. Create the sandbox repo (`gh repo create AaronAbuUsama/wa-bot-sandbox --public`).
5. **Test everything E2E**: drive all 13 tools + the gate against the sandbox repo from a real group
   (or via `curl` POST /event during dev). Confirm the access gate drops unaddressed/foreign-group msgs.

**STAGE 2 — build the two-tier (from the SPEC, §6).**
6. Sidecar-side **fast gate + two-speed debounce/buffer** (free @mention/quote short-circuit; else
   buffer + debounce → fast model verdict). Constants: `IDLE 15s / HOT 4s (per-user) / ENGAGED 40s`.
7. **Fast/deep model routing** (Eve app `defineDynamic`) — both tiers on the Codex subscription.
8. **"One voice" polish**: preamble ("give me a sec"), streaming chunker (deltas → WhatsApp bubbles),
   presence heartbeat, turn correlation/cancel.

## 5. How-to / conventions / DoD

- **Run:** `npm run dev` (Eve agent, port 2000, **Node ≥24**) + `npm run whatsapp` (sidecar, port 8788, Node ≥22 ok). Sidecar POSTs inbound to `WHATSAPP_FORWARD_URLS` = app root **+ `/event`** (NOT `/channels/...`).
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

- ⚠️ **Codex provider is UNVERIFIED** — the single biggest risk. Confirm a real subscription-auth
  AI-SDK path exists before promising it; if not, escalate with options. Do not fall back to an API key.
- ⚠️ **Stored WhatsApp creds are DEAD** (`open-harness/whatsapp/.wa-auth-*` both returned
  `logged_out_remote`). A fresh pairing is mandatory before any live run.
- ⚠️ **Node ≥24 for `eve` CLI** (dev/build/start); the sidecar is fine on Node 22. CI splits the
  `eve build` step onto the Node-24 leg only.
- ⚠️ **Do NOT build Stage 2 (two-tier) until Stage 1 (single-model E2E) works** — user's explicit order.
- ⚠️ Never commit secrets: `.gitignore` covers `.env`, `.env.*`, `.wa-auth*/`. Secret-scan before any push.
- The bot uses **npm** (not pnpm); the whatsappd library uses pnpm + has an `allowBuilds` CI gotcha —
  don't conflate the two toolchains.
- whatsappd exposes a first-class Eve adapter at `whatsappd/adapters/eve`; the bot re-implements only
  the inbound route (to gate before starting a session), reusing the adapter's other building blocks.
