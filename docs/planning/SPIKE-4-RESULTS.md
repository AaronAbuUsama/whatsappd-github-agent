# Spike #4 results — Eve loopback doorway proven (R1/R2)

> Historical design record. Superseded by the Flue Ambience production path completed in milestone #3; this is not current operator or architecture guidance.

Durable record of the runtime evidence for issue #4, so the proof travels with the
repo (not only the GitHub issue comment). Reproduce with the commands at the bottom.

Environment: Node 24.18.0 (the `eve` CLI needs ≥24), `eve@0.22.5`, model
`experimental_chatgpt()` (local Codex login, no API key). Server booted with
`PORT=4319 pnpm start`.

## 1. Server boots (DoD 1)

```
$ curl -s http://127.0.0.1:4319/eve/v1/health
{"ok":true,"status":"ready","workflowId":"workflow//eve//workflowEntry"}
$ curl -s http://127.0.0.1:4319/eve/v1/info      # → model "codex/gpt-…", 200
```

`eve dev` also boots and the agent replies via the same session route (`"Hello,
GitHub team!"`). The TUI's own keystroke loop is not driven in CI (non-TTY:
`Interactive UI disabled because the current terminal is not a TTY`) — the reply
path is identical and is exercised through `eve/client`.

## 2. Loopback caller gets a reply (DoD 2)

`scripts/spike-loopback.ts` (a plain `tsx` entry, outside any request):

```
[spike] server healthy: {"ok":true,"status":"ready",...}
[spike] ← status=waiting sessionId=wrun_… reply: Hello, GitHub team!
[spike] OK: non-empty assistant reply received via loopback client
```

## 3. Durable resume — the finding (DoD 3, corrected)

`scripts/spike-resume.ts` (codeword-memory probe; the script now **gates** — exits
non-zero unless this exact pattern holds):

```
=== RESUME STRATEGY RESULTS (codeword=BANANA-42) ===
1 same-ClientSession    | sess1=4RWFXPE0 sess2=4RWFXPE0 same=true  | remembered=true  | probeReply="BANANA-42"
2 persisted-SessionState| sess1=JYJGRWJX sess2=JYJGRWJX same=true  | remembered=true  | probeReply="BANANA-42"
3 token-only cold       | sess1=PNHKK1B7 sess2=BKQ60VCC same=false | remembered=false | probeReply="Unknown"

[spike-resume] OK: durable resume via long-lived/persisted session; token-only does not resume.
```

**Finding:** durable per-chat memory works, but resume is keyed by the persisted
`SessionState`/a long-lived `ClientSession` — **not by `continuationToken` alone**.
The `eve/client` *create* route mints a fresh session per cold call (verified in
`eve@0.22.5` `client/session.ts`: create-vs-continue is chosen by whether the client
holds a `sessionId`). This corrects DECISION-SPEC G1/D4 by one hop — the gateway
needs a `chatId → SessionState` map (the D6 SQLite store) — and is the direct input
to ticket #6.

## 4. One process hosts server + background caller (DoD 4, R2)

`agent/instrumentation.ts` `setup` (gated `R2_SPIKE=1`) runs inside the `eve start`
server process and drives the loopback client against itself:

```
[R2-BOOT] instrumentation setup fired in server process (agent=whatsappd-github-agent); starting background caller
[R2-BOOT] in-process background caller got reply (status=waiting, session=wrun_…): R2 loopback ok for whatsappd-github-agent
```

Chosen one-process boot mechanism: **`eve start` + an in-process startup hook**
(`instrumentation.setup`). There is no public programmatic server-start API
(`startProductionServer` is internal and spawns the built server as a child), so the
in-process path is a startup hook inside the server process. Candidate to revisit for
the real gateway: land the long-lived work as a custom **channel module** instead, or
confirm a dedicated boot hook with the Eve authors.

## Reproduce

```
nvm use 24
pnpm build
PORT=4319 R2_SPIKE=1 pnpm start            # watch for [R2-BOOT] … got reply
# in another shell:
EVE_URL=http://127.0.0.1:4319 pnpm spike:loopback
EVE_URL=http://127.0.0.1:4319 pnpm spike:resume   # exits 0 iff the finding holds
```
