# One-box ambient-agent instance — live receipt

Date: 2026-07-20

Ticket: #253 (T2 in `docs/planning/ONE-BOX-PLAN-2026-07-20.md`)

The ambient-agent instrument is standing on `capxul-vps` (Tailscale
`100.80.138.56`, user `abuusama`, Linux 6.8, node v22.22.2), packed as a tarball
from the branch and installed with `npm install -g`. The `apps/runtime/Dockerfile`
was deliberately not used (its `CMD` is the deleted provisioner's setup entry, and
a Docker build would exhaust the box's remaining disk).

## Identity

| | |
|---|---|
| Commit SHA | `6c6067d09c8f1200215956ac56484e920fabf192` (`claude/single-box-working`) |
| Tarball SHA-256 | `e311b6e41c9ebaf8ed2a763b011b0159e05792ffeb75e1bfd626a2b7513ab402` |
| Package | `ambient-agent-0.4.0.tgz` |
| Model | `openai/gpt-5.4-mini` (API-key provider) |
| Runtime port | 3737 (3000 is held by docker-proxy on this box) |
| Managed chat | `Tst` — `120363410063306573@g.us` |
| Repository | `AaronAbuUsama/ambient-agent` |

The same SHA-256 was verified on the box after `scp`, and the tarball contains
`dist/cli/main.js` and `dist/server.mjs`.

## Code landed to stand this up

All four merged to `claude/single-box-working` (fix-forward on the branch, not
`main`), each through CI:

| PR | What |
|---|---|
| [#258](https://github.com/AaronAbuUsama/ambient-agent/pull/258) | Single-instance lock on the data directory (T2 scope item 5) |
| [#259](https://github.com/AaronAbuUsama/ambient-agent/pull/259) | `--github-apps-file` is read even in interactive setup |
| [#260](https://github.com/AaronAbuUsama/ambient-agent/pull/260) | App private key taken as a path and proven to parse (the guided paste silently truncated multi-line PEMs to their last line) |
| [#261](https://github.com/AaronAbuUsama/ambient-agent/pull/261) | Runtime archive readies on `online`, not on a sync batch — the runtime could not boot after pairing |

Library-side footgun behind #261 filed as
[`AaronAbuUsama/whatsappd#4`](https://github.com/AaronAbuUsama/whatsappd/issues/4).

### Why #261 was the blocker

Every runtime start after the first pairing is a reconnect. whatsappd skips
history sync for an existing session and goes straight to `phase: "online"`,
emitting zero `onConversationSync` batches. The archive-ready gate required both
`online` **and** a sync batch, so it waited 60s for a batch that by design never
comes, then failed `initialArchiveReady` on a healthy session — the runtime never
reached `online`, and the unit sat live with a dead agent. Captured live with
`--debug`:

```text
whatsappd: "Reconnection with existing sync data, skipping history sync wait. Transitioning to Online."
# → 0 conversationSync batches, connection closed at the 60s mark, then:
whatsapp: WhatsApp initial archive did not become ready (TimeoutError)
```

The fix gates readiness on `online` alone, which is whatsappd's settled-and-ready
signal. After deploy, the shipped bundle's gate reads:

```js
const settleInitialArchive = () => {
  if (!onlineObserved || initialArchiveReady) return;
  ...
```

## systemd unit

`/etc/systemd/system/ambient-agent.service`:

```ini
[Unit]
Description=Ambient Agent managed runtime
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=abuusama
ExecStart=/usr/bin/node /home/abuusama/.local/npm-global/lib/node_modules/ambient-agent/dist/cli/main.js start --log-format json
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Enabled (`multi-user.target.wants`) and active. `~/ambient-apps.json` was deleted
from the box after init. `stopRuntimeOnSignal` handles SIGTERM cleanly.

## Init ceremony (attended, once)

The owner attended `ambient-agent init` in `tmux` over SSH and performed the four
human moments: pasted the OpenAI key, scanned the QR, picked the `Tst` chat,
approved the atomic promotion. No pairing was automated or simulated
(`first-run.ts` hard-aborts non-interactive pairing by design). Result:

```text
Created secure managed installation at /home/abuusama/.ambient-agent.
```

Post-promotion health:

```json
{"authentication":"api-key","model":"openai/gpt-5.4-mini","provider":"openai",
 "ok":true,"runtime":{"state":"healthy","whatsapp":{"phase":"online"}}}
```

## Gate — against the live instance

### 1. A real message from the owner's phone produces a real reply — ✅

```text
chat.received  actor=Abdullah  text="Are you online? Reply in one word."
agent.processing → agent.say  text="Yes"  → agent.completed  durationMs=8904
```

### 2. "File an issue for X" → a real issue by ambient-planner[bot] — ✅

```text
chat.received  text="File an issue: the onboarding email link 404s on mobile"
agent.say      text="Filed: https://github.com/AaronAbuUsama/ambient-agent/issues/262"
```

Verified against GitHub (not the agent's claim):

```text
#262 [OPEN] by app/ambient-planner at 2026-07-20T16:08:41Z
TITLE: Onboarding email link 404s on mobile
BODY: ## Bug report … Reported in WhatsApp chat 120363410063306573@g.us by Abdullah.
```

### 3. `systemctl restart`, then reboot: returns without re-pairing and replies — ✅

Pre-reboot session fingerprint and `systemctl restart` (back online in ~10s):

```text
creds.json sha256 (first 32) = 7bd54b1bfe2b8a51597a98d6088b1610
restart → 16:28:02 online ok=True
```

Full box reboot (`sudo systemctl reboot`; box booted 2026-07-20 16:28:41):

```text
systemctl is-enabled = enabled ; is-active = active
16:29:25 healthy online ok=True
post-reboot creds.json sha256 (first 32) = 7bd54b1bfe2b8a51597a98d6088b1610   # identical → no re-pair
journalctl -b | grep -i 'pairing|qr|scan|link device'  → (empty)             # no QR this boot
```

Post-reboot **reply** (asserting the reply, not the process state):

```text
chat.received  text="What's the staging deploy password?"
agent.say      text="I can’t share passwords."  durationMs=4500   # real reply, not rate-limited
```

### 4. Conversational memory across restart — ✅

Fact established before the reboot: `"Remember this: the staging deploy password
is purple-otter-42."` After the reboot, direct inspection of
`~/.ambient-agent/application.sqlite` shows the fact persisted on two levels:

```text
conversation_messages.text : "Remember this: the staging deploy password is purple-otter-42."   # verbatim
graph_entities             : topic_36016b  type=topic  {"label":"staging deploy password"}  conf=0.73
graph_relations            : thread_872f22 --discusses--> topic_36016b
```

The graph captured the topic; the value lives in the raw archive (secrets are not
distilled into the queryable graph — a deliberate boundary). The value was in the
Speaker's context when asked; the `"I can’t share passwords."` reply was a safety
decision, not amnesia. Persistence, recall availability, and the guardrail are
three separate, working things.

## Negatives — each observed, not assumed

- **Absence of silence** — a mandatory-reply input ("Are you online?") produced a
  reply. A configured-but-inert agent would read FAIL here; it did not. ✅
- **Second instance on the same data directory fails loudly** — with the systemd
  unit holding the lock (pid 2660208), a second `ambient-agent start` against the
  same `--data-dir`:

  ```text
  AGENT_EXIT=1
  ambient-agent: Another ambient-agent runtime (pid 2660208) is already using
  /home/abuusama/.ambient-agent. Stop it before starting another; two runtimes on
  one data directory corrupt it.
  ```

  The live instance stayed `online`, `ok:true` — uncorrupted. ✅
- **Post-reboot assert the reply, not the process state** — covered by the 4.5s
  reply in leg 3, not merely a live unit. ✅
- **`rate-limited` ⇒ inconclusive** (#246) — no run reported `rate-limited`; all
  timings are real-model latency. No run was scored on a rate-limited result.

## ❌ Not observed — deferred, not skipped

- **`kill -9` during an in-flight run → settles `interrupted`, message reaches the
  thread, no relaunch without a user turn** (`sweepUnsettledLaunches`,
  `apps/runtime/src/app.ts:187-199`). This needs an in-flight Coder run to
  interrupt, so per the plan it is a T2 gate **re-run after T3 lands** (#251). It
  was not exercised here and is **not** claimed.
  **Update 2026-07-21:** re-run attempted post-T3. The sweep mechanism was observed
  end-to-end, but the window was polluted by gpt-5.4-mini 429s, so per #246 the leg
  is **INCONCLUSIVE**, not flipped to ✅. See the dated follow-up at the end.

## Follow-ups found while standing this up (not gate blockers)

- **Setup lock is orphaned on a killed `init`** — `acquireSetupLock` is a bare
  `mkdir` with no owner recorded, so a killed setup blocks every later `init` until
  the lock dir is removed by hand (same stale-lock class as #258, on the setup
  path). Worth a ticket.
- **`link-preview-js` missing from the bundled baileys** — a message containing a
  URL logs `ERR_MODULE_NOT_FOUND`. It did not block issue filing or replies, but
  link previews are broken.
- **Reply latency / no preamble** — the Speaker does the slow work (model +
  GitHub call) before saying anything, so the thread goes silent for ~15s on
  action turns. An ack-then-act preamble ("On it — filing that now") would fix the
  perceived slowness. Speaker behavior, not runtime.

## Verdict

The instrument is live on `capxul-vps` and the T2 gate passes on every leg that
can be exercised without a Coder run: a real reply, a real `ambient-planner[bot]`
issue, restart + full reboot without re-pairing with a real post-reboot reply, and
conversational memory persisted across the reboot. All three assertable negatives
were observed. The `kill -9` → `interrupted` leg is deferred to a T2 gate re-run
after T3, as the plan directs.

---

## Follow-up — 2026-07-21: `kill -9` gate re-run (INCONCLUSIVE under 429)

Re-run of the deferred `kill -9` leg on `capxul-vps`, post-T3 (#269 already proved
the box is provisioned). **Verdict: INCONCLUSIVE, not a fail.** The
`sweepUnsettledLaunches` mechanism was observed working end-to-end on the run I
killed, but the whole window was under heavy gpt-5.4-mini rate-limiting, so per the
`#246 rate-limited ⇒ inconclusive` rule this leg is **not** scored green. The
deferred ❌ is **not** flipped to ✅. A clean re-run under TPM headroom is needed.

**Build under test:** `ambient-agent@0.4.0`, runtimeId `jQDCA0ofejoze5MWDSSe1x`
(persisted install identity — stable across boots, not per-process).

**Pre-step — WhatsApp receive path was wedged.** The unit had run since Jul 20
20:50 with its last log a `stream:error` code `503` at Jul 20 21:41:41 and then 8h
of silence, while `/health` still reported `whatsapp: online` (stale phase — a real
health-reporting gap: online reported while the socket is dead). A clean
`systemctl restart` recovered it — fresh `agent.online` at 05:53:49. Only after
this did the trigger reach the Speaker.

**Timeline (UTC 2026-07-21):**

| time | event |
|------|-------|
| 05:58:12 | Trigger processed. Speaker split it into **two** issues #270 + #271 and launched **two** coder runs: `run_01KY1M1PS74Y2NE14XQ25X01DF` (A, 05:58:13.553) and `run_01KY1M1RPXV1WX4NMP195C89GQ` (B, 05:58:15.524). |
| 05:58:33–53 | gpt-5.4-mini **429s** — TPM limit 200000 exceeded (5 `Rate limit reached` hits). Run **A errored on a 429** and settled 05:58:53.195 (its result delivery swallowed by 429s — no message for it reached Tst). |
| 05:59:00 | Verified run **B** still unsettled (in-flight, ~45s). |
| ~05:59:2x | `sudo systemctl kill -s SIGKILL ambient-agent` → `/health` = **DOWN**. (systemctl warned `Failed to kill ... auxiliary processes: Invalid argument` — KillMode quirk; the main PID took the signal, health went DOWN.) |
| — | `Restart=always` auto-restarted the unit (new PID 863810). Boot sweep ran. |
| 05:59:27.888 | Ledger row for run B flipped unsettled → **settled by the sweep** (post-kill; the SIGKILLed process could not have delivered in-process). |
| 05:59:31 | Speaker `agent.say` to Tst: **"The duration formatter run was interrupted. Want me to retry it?"** — offers retry, does **not** auto-relaunch. |

**Assertions:**

1. **Run settled `interrupted`** — ✅ (run B; ledger settled by boot sweep at
   05:59:27.888, `settled_at` post-dates the kill).
2. **Interrupted message reached Tst** — ✅ (`agent.say` above; screenshot held by
   operator).
3. **No PR / no relaunch without a user turn** — ✅ (`0` unsettled after; no coder
   launch after B; `gh pr list` open coder PRs are #185/#162 from Jul 18, nothing
   from run B; the "retry?" offer sits unanswered by design).

**Why INCONCLUSIVE despite 3/3:** the mechanism chain for run B is 429-independent
and held, but (a) run A errored on a **429**, not a clean crash; (b) run B, launched
into an exhausted TPM, was likely stalling on 429 retries rather than doing
productive coder work when killed — so "hard crash of a *genuinely working* in-flight
job" was not cleanly exercised; (c) the trigger split into two runs. Per #246 and the
runbook caveat ("if gpt-5.4-mini 429s anywhere, INCONCLUSIVE"), this is not scored.

**Test debris:** issues **#270** and **#271** were filed by the bot from the trigger
and left open; the interrupted run left no branch/PR. Operator to triage/close.

**Box left:** unit `active`, `/health` `ok:true`, whatsapp `online`, `0` unsettled.
No PR merged or touched. The `#270`/`#271` retry offer was **not** answered.

**To close the leg:** re-run when TPM has headroom, with a single-task trigger so it
does not split, and confirm run B does real work before the kill.
