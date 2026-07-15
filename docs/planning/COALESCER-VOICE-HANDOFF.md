# Coalescer + Voice — execution state (handoff)

> Historical design record. Superseded by the Flue Ambience production path and
> #50's durable Managed Chat Inbox; this is not current operator or architecture
> guidance. The bounded buffer module and its count/age eviction tests described
> below were deliberately removed. Use `docs/COALESCER-DESIGN.md` and the Ambient
> Agent ADRs for the current contract.

Single source of truth for the two-tier WhatsApp agent work. If you're resuming
after a compaction: **read this whole file first**, then confirm status back.

Sister doc (design detail, keep in sync): [`docs/COALESCER-DESIGN.md`](../COALESCER-DESIGN.md).
Prior stage (the GitHub agent): [`docs/planning/EXECUTION-STATE.md`](./EXECUTION-STATE.md).

---

## 1. Mission

A WhatsApp group-chat agent that feels like one assistant but is two tiers:

- **Coalescer** (no model) — subscribes to inbound WhatsApp messages, holds a
  bounded rolling window per chat, and decides *when* to wake the voice.
- **Conversationalist / "the voice"** (Agent 1, cheap+fast) — reads the window
  and decides **speak / act / stay silent**. It is a *participant*, not a
  reply-bot.
- **Worker** (Agent 2, deep model) — the existing fused GitHub agent (`agent/`).
  The voice delegates real work to it and narrates the result.

GitHub is only the test capability; the **architecture is the deliverable**.

---

## 2. Decisions (with the *why*)

1. **Coalescer built in Effect. DONE + committed.** Per-chat actor loop; debounce
   = `Queue.take` raced against a virtual sleep (`timeoutOption`). Deterministic
   under `TestClock`. See COALESCER-DESIGN §2.

2. **THE BEHAVIOR CORRECTION (Aaron, this session) — load-bearing.** The voice
   must **engage whenever it judges it can help** (someone stuck, a bug, a PR/issue
   mentioned, a question it can answer), **not** only when @-mentioned. An
   @-mention / quote-reply just means *"respond NOW, skip the wait."* Staying
   quiet during pure social chatter is normal. **This judgment lives in the
   voice's PERSONA instructions, not in code.** The old `selfGatingConversationalist`
   stub had this backwards (silent unless addressed) and is a placeholder to be
   replaced, NOT the intended behavior.

3. **"Debounce" was the wrong word — it needs a CAP (throttle + settle window).**
   Pure debounce starves a busy chat (timer keeps resetting → bot never speaks).
   Wanted: **fire when the chat goes quiet OR when a max wait has elapsed,
   whichever first** — so a nonstop chat still fires every ~`maxWait`, processes
   the pile, responds, gathers again. NOT YET IMPLEMENTED (see §4, held item 1).
   Effect's `groupedWithin` is *tumbling* (doesn't reset per message) so it's not
   a drop-in; we keep our loop and add the cap.

4. **The voice is PLAIN EFFECT, NOT an Eve agent.** This is the crux that
   simplified everything. Eve only lets you start/resume a session from a
   "doorway" (an HTTP route / WS handler / scheduled job) — a background timer
   (our Coalescer) cannot call `send`. That doorway rule is *Eve's*, and Effect
   can't reach past it. **But the voice doesn't need Eve:** Eve's gift is durable
   cross-session memory, and we deliberately feed the voice only a *recent window*
   (not full history), so that gift is nearly unused. So: make the voice a plain
   Effect program that calls the model directly. The doorway problem evaporates;
   the whole hot path is one Effect graph.

5. **Model = AI SDK (`ai@7`) directly, wrapped in `Effect.tryPromise`. NOT
   `@effect/ai`.** Verified in the cloned effect repo: `@effect/ai`'s OpenAI
   provider authenticates with an API key against the real OpenAI API, and has
   **no AI-SDK bridge**. Our model `experimental_chatgpt()` speaks to the *Codex
   backend* with signed-JWT subscription auth (no key). Using `@effect/ai` would
   mean rebuilding Eve's Codex transport — rejected. `ai@7`'s streaming loop runs
   the tools for us; that's the seam.

   **DISCOVERED building Rung 1 — the Codex backend is STREAMING-ONLY.**
   `generateText` (non-streaming) is rejected outright: `400 {"detail":"Stream
   must be set to true"}`. So the voice uses **`streamText` + `result.consumeStream()`**,
   not `generateText`. `consumeStream()` swallows+logs stream errors by default, so
   we capture the real cause via the `onError` callback and rethrow it after
   draining — a failed turn becomes a `ConversationError`, never a silent no-op.
   (This is the one substantive change from the verbatim §4 sketch, which used
   `generateText`; `src/coalescer/voice.ts` is the real, working version.)

6. **`experimental_chatgpt()` works standalone.** It returns a plain AI-SDK
   `LanguageModel` (`eve/dist/src/public/models/openai/index.d.ts`), reads the
   local Codex login, needs no Eve app. **Local-dev only — fails in deployment**
   (no Codex creds there); branch on env for prod.

7. **Worker stays an Eve agent** (the existing `agent/`), reached only when the
   voice `delegate()`s — the ONE Eve doorway, and only on real work, not per
   message. Delegation is **blocking (D1a)** — matches Eve's native subagent
   semantics (a subagent is a blocking tool; validated in the Eve docs). D1b
   (non-blocking) is a later swap; the `Effect`-returning `Worker.delegate` port
   keeps it a swap, not a rewrite.

8. **Silence needs no machinery** — the model simply doesn't call the `reply`
   tool. (Validated: Eve/channels drop empty/tool-only turns; and for a
   plain-Effect voice it's even simpler — no reply call = nothing sent.)

---

## 3. Done (committed on `main`)

- `f886a13` — feat(coalescer): the original in-memory Coalescer build, including
  count/age eviction artifacts that #50 later removed. Its resilience work made
  dispatch catch failures and defects while preserving interruption.
- `80ed4c6` — refactor(coalescer): the Tier-1 simplification (dead config removed,
  `Array.takeRight`, shared `delegateAndNarrate`, `startSelfGating` test helper).
- `1f2a921` — docs(handoff): this file.
- **Rung 1 (see §4) — the `maxWait` throttle cap + the real voice + the interactive
  terminal. `config.ts` gains `maxWait` (default 10s); `coalescer.ts` warm state
  waits `min(debounceWindow, maxWait − elapsedSinceBurstStart)` off a per-burst
  `burstStart`; new cap test. `src/coalescer/voice.ts` = the real model-backed voice
  (`streamText`); `src/coalescer/repl.ts` (`pnpm run voice`) = the interactive
  terminal. Verified live end-to-end: silent on chatter, chimes in on a relevant
  un-@-mentioned message, delegates+narrates on an addressed task.**

**State: 72 tests green, `pnpm typecheck` clean, `pnpm run coalescer` demo + `pnpm run
voice` REPL both work.** Working tree clean.

Two adversarial reviews already run and folded in: a correctness review (→ the
resilience hardening in `f886a13`) and a 4-angle simplify review (→ `80ed4c6`;
the one deferred item is the `Stream.groupByKey` fan-out, intentionally NOT done
because idle-chat eviction is easier against our owned registry — see §5).

---

## 4. Rung 1 — DONE ✅ (built; NEXT is Rung 2)

The testing ladder: **Rung 0** = `pnpm run coalescer` (scripted real-time
playground, exists). **Rung 1** = real voice + interactive terminal — **BUILT &
verified live** (`pnpm run voice`). **Rung 2** = real WhatsApp (needs re-pair;
NEXT — see §7).

Rung 1's three steps below are all done; the sketches are kept as the record of
what was built (the voice sketch's `generateText` became `streamText` per §2.5).
Steps as built:

1. **Add the `maxWait` cap to the loop** (`src/coalescer/coalescer.ts`) + a new
   config knob `maxWait` (default ~10s) in `config.ts`. Warm state waits
   `Duration.min(debounceWindow, maxWait − elapsedSinceBurstStart)`. Track
   `burstStart` (a `Clock.currentTimeMillis` at first message of a burst).
   **Add a TestClock test**: a nonstop burst (messages every 1s forever) fires
   roughly every `maxWait`, not never. Sketch:
   ```ts
   // warm state:
   const capLeft = config.maxWait - (now - burstStart);
   const wait = Duration.min(config.debounceWindow, Duration.millis(capLeft));
   Queue.take(queue).pipe(Effect.timeoutOption(wait), /* onNone → fire; onSome → gather (keep burstStart) */)
   ```

2. **Write `src/coalescer/voice.ts`** — the real voice as a plain-Effect
   `Conversationalist` Layer. VERBATIM shape to preserve (plugs into the existing
   `Conversationalist` port unchanged; Coalescer does not change):
   ```ts
   // src/coalescer/voice.ts — real voice. Plain Effect + AI SDK. No Eve.
   import { Effect, Layer } from "effect";
   import { generateText, tool, stepCountIs } from "ai";
   import { experimental_chatgpt } from "eve/models/openai";   // ChatGPT sub, no key
   import { z } from "zod";
   import { Conversationalist, ConversationError, Outbound, Worker } from "./ports.ts";

   const PERSONA = `You're a regular member of this WhatsApp group.
   - Chime in WHENEVER you can genuinely help — someone's stuck, a bug/PR/issue comes up, a question you can answer.
   - Do NOT wait to be @-mentioned. Being addressed just means "definitely answer now."
   - Stay quiet during pure social chatter — silence is normal. To stay silent, just don't call reply.
   - For real GitHub work, call delegate() then reply() to narrate what came back.`;

   export const aiVoice: Layer.Layer<Conversationalist, never, Outbound | Worker> = Layer.effect(
     Conversationalist,
     Effect.gen(function* () {
       const outbound = yield* Outbound;
       const worker = yield* Worker;
       return {
         turn: (window) =>
           Effect.tryPromise({
             try: (signal) =>
               generateText({
                 model: experimental_chatgpt(),
                 system: PERSONA,
                 prompt: renderWindow(window),      // buffered recent messages as text
                 stopWhen: stepCountIs(6),
                 abortSignal: signal,
                 tools: {
                   reply:      tool({ description: "Say something in the group.",
                                      inputSchema: z.object({ text: z.string() }),
                                      execute: ({ text }) => Effect.runPromise(outbound.reply(window.chatId, text)) }),
                   set_typing: tool({ description: "Show typing while you work.",
                                      inputSchema: z.object({ on: z.boolean() }),
                                      execute: ({ on }) => Effect.runPromise(outbound.setTyping(window.chatId, on)) }),
                   delegate:   tool({ description: "Hand real GitHub work to the Worker; returns its result.",
                                      inputSchema: z.object({ instruction: z.string() }),
                                      execute: ({ instruction }) => Effect.runPromise(worker.delegate({ chatId: window.chatId, instruction })) }),
                 },
               }),
             catch: (cause) => new ConversationError({ cause }),
           }).pipe(Effect.asVoid),
       };
     }),
   );
   ```
   Plus a `renderWindow(window)` helper: format `window.messages` as a readable
   transcript (`pushName: text` per line) + note `window.reason`
   (mention/quote-reply/debounce) so the model knows if it was addressed.

3. **Interactive terminal harness** (Rung 1 test) — a script (e.g.
   `src/coalescer/repl.ts`, add `pnpm run voice`) where **you type messages** and
   watch the REAL model decide speak/silent/delegate. Mock ONLY the WhatsApp send
   (console `Outbound`) and the Worker (`cannedWorker`). Real time. This tests the
   two genuine unknowns: the model's persona/judgment, and the Effect↔AI-SDK seam.
   Existing `demo.ts` is the template; swap the stub voice Layer for `aiVoice`,
   read stdin lines → `Queue.offer` into the source.

**DoD for Rung 1:** you can hold a conversation in the terminal; the model stays
quiet on chit-chat, chimes in on relevant/GitHub-ish messages *without* being
@-mentioned, and delegates + narrates on a task. Existing `agent/` untouched.

---

## 5. Gotchas & guardrails (will bite if forgotten)

- **DO NOT touch the existing GitHub agent (`agent/`, `agent/tools/*`,
  `agent/channels/whatsapp.ts`, `agent/instructions.md`).** It is the future
  Worker; leave it entirely alone.
- **`experimental_chatgpt()` is local-dev only** — needs Codex CLI login
  (`~/.codex/auth.json`); fails in deploy. Branch on `NODE_ENV` for prod.
- **Do NOT go down the `@effect/ai` path** for the voice — it can't speak the
  Codex subscription backend (decision §2.5).
- **The Eve "doorway" is real and immovable** — a background timer can't call
  `send`. That is precisely why the voice is plain Effect, not an Eve agent. Don't
  re-litigate wiring the voice through an Eve session.
- **The Effect repo is cloned for reference** at
  `/Users/abuusama/projects/hack-space/effect` (sibling dir). Useful:
  `packages/ai` (= `@effect/ai`, rejected but for reference), `packages/platform`
  (`HttpClient`, if we ever need the Eve-client loopback for delegation).
- **WhatsApp creds actually connect** — the earlier "dead / `logged_out_remote`"
  note was stale; `pnpm run live` reaches `online` on the existing `./.wa-auth`
  (QR re-pair path exists in `whatsapp.ts` if it ever does log out).
- **`groupByKey` fan-out deferred on purpose** — the manual per-chat registry is
  kept because idle-chat eviction (a real future need) is easier against a
  registry we own than `groupByKey`'s opaque group lifecycle.
- **Historical maxWait shape** — this snapshot used `reason: "debounce"` for a
  cap-triggered fire. The durable #50 contract records `maximum-wait` separately.
- **The Codex backend is streaming-only** — `generateText` 400s (`"Stream must be
  set to true"`). The voice uses `streamText` + `consumeStream()`; don't switch it
  back to `generateText`. See §2.5.

---

## 6. Key file pointers

- Design + known edges: `docs/COALESCER-DESIGN.md` (esp. §7 known edges/seam notes).
- Current core: `src/intake/managed-chat-inbox.ts` plus
  `src/coalescer/{coalescer,events,config,ports,mocks}.ts`.
- Current tests: `tests/intake/managed-chat-inbox.test.ts` and
  `tests/coalescer/coalescer.test.ts` (TestClock, `@effect/vitest` `it.scoped`).
- Voice + REPL: `src/coalescer/voice.ts` (real model-backed `Conversationalist`),
  `src/coalescer/repl.ts` (`pnpm run voice` interactive terminal).
- Model helper: `eve/models/openai` → `experimental_chatgpt(model?)`.
- AI SDK: `ai@7` → `streamText`, `tool`, `stepCountIs` (voice uses `streamText`,
  NOT `generateText` — Codex is streaming-only, §2.5).

---

## 7. Rung 2 — 2a ✅ + 2b ✅ DONE; blocked only on a GitHub token (see BLOCKER below)

The seams swap in behind the same ports; the Coalescer, voice, and ports did NOT
change. Built in `src/coalescer/whatsapp.ts` + `src/coalescer/live.ts`
(`pnpm run live`):

- **Real `EventSource` + `Outbound` — DONE.** `whatsapp.ts` uses the in-process
  `createSession(...).onMessage / .send / .setTyping` (NOT the lossy HTTP sidecar,
  so `context.mentions`/`quoted` survive). `session.onMessage` → whatsappd
  `IncomingMessage` maps straight onto our `events.ts` shape; `timestamp` is
  already ms (`toMillis` in whatsappd). `botId` comes from `session.identity().jid`.
- **Session bootstrap — DONE.** `openSession` is a scoped resource (stops on scope
  close), waits for `isOnline`, prints a QR (`qrcode-terminal`) on first-run pair.
- **Chat gate — DONE.** `live.ts` fails closed: set `WHATSAPP_GROUP_ID`/`_IDS`
  (or `WHATSAPP_ALLOW_DM=true`) or the bot stays silent. The voice replies for real
  and engages on relevance, so this gate is mandatory — use a private test group.
- **Creds actually WORK** — the "dead / `logged_out_remote`" note was stale.
  `pnpm run live` connected (`connecting → authenticated → online`) on the existing
  `./.wa-auth`. **No re-pair needed** (QR path is there if it ever logs out).

**Live is PROVEN.** `pnpm run live` connected and the two-tier behavior ran in the
"Tst" group for real: silent on "Yo", chimed in unprompted on "What's happening with
GitHub" — no @-mention needed. Every WhatsApp in/out is logged (📥/📤/⌨️, with raw
mention JIDs; `whatsapp.ts`). All traffic bills the local Codex sub (no API key set).

### Rung 2b — real Worker — DONE ✅ (chose Option B: in-process reuse)
`src/coalescer/worker.ts` runs `agent/`'s GitHub agent **in-process**: imports its 13
tools + `instructions.md` UNCHANGED, drives them with `ai@7` `streamText` (same seam
as the voice), no Eve runtime. Decisions/mechanics:
- Eve `defineTool` → AI-SDK `tool` via a tiny `adapt()`; tools ignore Eve's
  `ToolContext` (0/13 use it), so a `{}` stand-in works.
- `adapt()` STRIPS empty-string args — the model fills optional `owner`/`repo` with
  `""`, and `agent/`'s `resolveRepo` does `input.owner ?? fallback` (keeps `""`); the
  strip lets the configured default repo win. (Do NOT "fix" this in `agent/`.)
- `voice.ts`: persona is now a param — `aiVoice(persona?)` (default unchanged; REPL
  uses `aiVoice()`). `live.ts` passes a **QA bug-intake persona**.
- Verified end-to-end: the worker drove the REAL GitHub API (model → adapted tool →
  octokit). Committed `9dc87a6`. 72 tests green, typecheck clean, `agent/` untouched.

### Near-term GOAL (the actual use case)
A WhatsApp group of **non-technical QA testers** for an **iOS app**. They describe
bugs casually; the voice (QA persona in `live.ts`) asks short clarifying questions
(repro / expected vs actual / device+iOS / frequency), then `delegate`s a structured
bug report; the worker files a GitHub **issue** and the voice replies with the link.

### BLOCKER (hand back to user) — GitHub token can't see the target repo
`.env` `GITHUB_REPO` is now **`TheCallApp/ios-design-system`** (changed from the
non-existent `AaronAbuUsama/wa-bot-sandbox`). But the current **fine-grained** token
is scoped to `AaronAbuUsama` + a few orgs — NOT `TheCallApp` → every call **404s**.
User must create a new token that can reach `TheCallApp/ios-design-system`:
- Fast (classic, pre-fillable): `https://github.com/settings/tokens/new?scopes=repo&description=whatsappd-qa-bot`
  → generate → if org uses SAML, "Configure SSO → Authorize" for TheCallApp →
  `sed -i '' 's|^GITHUB_TOKEN=.*|GITHUB_TOKEN=<paste>|' .env`.
- Tidy (fine-grained): `https://github.com/settings/personal-access-tokens/new`,
  Resource owner = **TheCallApp**, repo = ios-design-system, perms Issues R/W +
  PRs R/W + Contents R + Metadata R.
On resume: re-run the token access check (the `node -e fetch /repos/TheCallApp/…`
probe) before testing live. `.env` is gitignored — token never enters git.

### Also open / next
- **Prod guard** — `experimental_chatgpt()` is local-dev only; branch on `NODE_ENV`
  at the model-hoist in `voice.ts` + `worker.ts` for a deployed model (see §2.6).
- **/simplify pass** — deferred until after 2b (now done). Known target: `demo.ts` /
  `repl.ts` / `live.ts` triplicate a console `Outbound` + worker stub; consolidate
  into `mocks.ts`. Also re-check `voice.ts` indentation around the `aiVoice(persona)`
  wrapper.
- **Eve direction (decided):** we are ~90% off Eve — the voice + worker are plain
  Effect + AI SDK; the Eve *runtime* is never run. KEEP the one import
  `experimental_chatgpt` (Eve's CUSTOM transport to the Codex subscription backend via
  the local `codex login` — there is NO free ecosystem/Effect drop-in; standard
  AI-SDK/@effect/ai providers need paid API keys). Fully scrapping Eve = reimplement
  that Codex transport OR pay for keys — a later call, not now. `agent/` the Eve app is
  now vestigial (we reuse its tools, never run it).
- **Multi-agent vision:** the `Worker` port already makes each agent a swappable
  layer; a future code-runner/sandbox agent is another worker + another `delegate_*`
  tool (or a router). Not built; nothing blocks it.

DoD (near-term): a QA tester messages "Tst" (or the real QA group) → voice gathers
details → worker files an issue in `TheCallApp/ios-design-system` → voice replies with
the link. Blocked only on the token above.

## 8. Session update — it WORKS (alpha); model on an API key now

State as of the latest session: the loop is **working end-to-end** in the *new* group.
It's alpha — the **prompts need iteration** — but voice → gather → delegate → file
issue → reply runs. Blockers from §7 are all cleared. Tip: **`fcd0cf4`** on `main`,
72 tests green, typecheck clean, tree clean.

### What got fixed/built this session (commits)
- **`f62c443`** — the voice was going *silent*: the Codex/model answers in plain text
  but never called the `reply` tool, and `voice.ts` only delivers `reply`-tool text.
  Fix = a **SPEECH_CONTRACT** appended to every persona ("the group only hears you via
  the reply tool; prose is discarded; call no tools to stay silent") — verified in a
  harness (replies on a bug report, stays silent on chatter). Same commit: **decision
  logging** (`🗣️ voice turn` / `💬 replied` / `🤫 chose to stay silent` / `🛠️ delegated`)
  so a silent turn is visible, and **`botIds` as a set** so an @-mention under EITHER the
  phone-number OR the `@lid` scheme matches (LID groups sent the bot's `@lid`, botId was
  the PN jid → never matched). New env **`WHATSAPP_BOT_LID`** (bare number or `NNN@lid`).
- **`a51c15b`** — **per-chat memory** (THE big one): the voice was stateless — each turn
  saw only the buffered delta (usually 1 msg), so it forgot its own question the instant
  it asked ("15" → blank). Now `voice.ts` keeps a bounded per-chat transcript (`MAX_HISTORY`
  = 30, incl. the bot's own replies) fed to `streamText` as `messages`. Also: **typing
  only when it acts** (a `Deferred` latch fires on the first `reply`/`delegate`, so silent
  turns don't flash "typing…"); **90s turn timeout** (a wedged backend can't hang the chat
  loop); **real error surfacing** (`❌ voice turn failed — <cause>` — this is how we caught
  the usage-limit error instead of a silent gap).
- **`b92ddf3`** — **second-account isolation via `CODEX_HOME`**: eve's `experimental_chatgpt`
  reads `${CODEX_HOME}/auth.json` (default `~/.codex`) and refreshes tokens itself.
  `pnpm run login` = `codex login --device-auth` (headless PIN) into project-local
  `.codex-bot/` (gitignored). **NOTE: currently reverted** — `CODEX_HOME` is NOT set in
  `.env` (back to default `~/.codex`), because we're using an API key instead (below). The
  `.codex-bot` login scaffolding stays for later. (Blocked when tried: lost the 2nd
  account's Google password AND device-auth doesn't auto-select the account without an
  existing browser session.)
- **`fcd0cf4`** — **API-key model path** (`src/coalescer/model.ts` → `makeModel()`): if
  `OPENAI_API_KEY` is set → plain OpenAI via **`@ai-sdk/openai@4.0.11`** (spec v4, matches
  `ai@7`); else → `experimental_chatgpt()`. Chosen on key *presence*, not `NODE_ENV` — this
  also **is** the prod/VPS model path. `describeModel()` prints the active source at
  startup. **Currently: `OPENAI_API_KEY` set + `OPENAI_MODEL=gpt-5.4-nano`** — verified
  with a real "pong" call. This is what unblocked live testing (main Codex account had
  hit its usage cap).

### Resolved from §7
- **GitHub token** — now a **classic `ghp_…` token** with full access to
  `TheCallApp/ios-design-system` (admin/push, issues R/W confirmed via probe). The old
  404 was a fine-grained token wrongly scoped to the personal account.
- **Prod model guard** — solved by `makeModel()` (API key works anywhere).
- **Group** — `.env` `WHATSAPP_GROUP_ID=120363428464069244@g.us` (the **NEW** group; old
  "Tst" `…410063306573@g.us` no longer watched). `WHATSAPP_BOT_LID=69158251274313@lid`.

### Issues filed (parked, GitHub `AaronAbuUsama/whatsappd-github-agent`)
- **#1** — relitigate at v1.0: conversation state / whether to bring Eve back (the
  in-process memory here is the lightweight stand-in; deeper state is the real question).
- **#2** — in-process Codex device-auth (drop the global `codex` CLI dep for the VPS).
- **#3** — bootstrap a proper agent CLI/daemon (login, config, run, status).

### NEXT (in order)
1. **`/simplify`** — the immediate next task (user asked for it right after this compact).
   Scope = this session's diff + the long-known target: `demo.ts`/`repl.ts`/`live.ts`
   triplicate a console `Outbound` + worker stub → consolidate into `mocks.ts`. Also sanity
   the new `model.ts`/`voice.ts` memory+typing code.
2. **Prompt iteration** — it's alpha; the QA persona + SPEECH_CONTRACT need tuning (user
   is sending a live log with specifics). Don't relitigate architecture yet.
3. Later: issues #1/#2/#3 when moving toward v1.0 / the VPS.

### How to run it
`pnpm run live` → startup prints `🔑 model: OpenAI API key — gpt-5.4-nano` and the watched
group → message the new group with a bug → watch `🗣️`/`💬`/`🛠️` + typing. `.env` (gitignored)
holds `OPENAI_API_KEY`, `OPENAI_MODEL=gpt-5.4-nano`, `GITHUB_TOKEN` (classic), `GITHUB_REPO`,
`WHATSAPP_GROUP_ID`, `WHATSAPP_BOT_LID`. Model swap = set/unset `OPENAI_API_KEY`.
