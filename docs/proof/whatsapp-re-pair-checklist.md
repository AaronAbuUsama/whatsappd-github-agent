# WhatsApp guided re-pair — human/live checklist

Deterministic behavior (state classification, gates, staging, promotion, refusals) is
covered by the automated suite (`tests/managed/cli.test.ts`, `tests/managed/diagnostics.test.ts`,
`tests/managed/installation.test.ts`, `tests/ambience/whatsapp-runtime.test.ts`). This
checklist covers only what a machine cannot verify: a real phone scanning a real QR code
against a live WhatsApp session. Run it on a host with an otherwise-valid managed
installation whose WhatsApp session is logged out or whose store was cleared.

## Preconditions

- [ ] `ambient-agent status` reports `Ambient Agent: ready` and
      `whatsapp-session: re-pair-required`. The installation is never reported
      `incomplete` or `corrupt` because of the missing store.
- [ ] `ambient-agent start` refuses with a message pointing at
      `ambient-agent repair whatsapp` and starts nothing.
- [ ] No `ambient-agent start` process is running (`ambient-agent status` shows the
      observed runtime as `stopped`).

## Guided re-pair

- [ ] Run `ambient-agent repair whatsapp` in an interactive terminal (or run bare
      `ambient-agent` — it routes into the repair when the store needs re-pairing).
- [ ] A QR code renders inside the CLI flow. Scan it with the phone that owns the
      managed WhatsApp account (Linked devices → Link a device).
- [ ] The CLI reports the newly paired identity (`Paired WhatsApp as <jid>`) and that
      the configured managed chat is visible.
- [ ] The CLI reports `Replaced the managed WhatsApp store at <path>; configuration,
      credentials, and history are unchanged.`

## Wrong-phone refusal (optional but recommended once)

- [ ] Repeat the repair scanning with a phone whose account is NOT a member of the
      configured managed chat. The CLI must refuse (`does not see the configured
      managed chat`), exit non-zero, and leave the managed store unreplaced.

## Post-repair verification

- [ ] `ambient-agent status` reports `whatsapp-session: paired` with a message that
      liveness is unverified, and exit code 0.
- [ ] Configuration, ChatGPT OAuth, GitHub credential, `application.sqlite`,
      `flue.sqlite`, and any unresolved-work records are byte-for-byte untouched
      (compare mtimes/hashes taken before the repair).
- [ ] `ambient-agent start` starts, `/health` reaches `runtime.state: healthy` with
      `whatsapp.phase: online`, and `ambient-agent status --json` shows the
      whatsapp-session check upgraded to `online`.
- [ ] Send a message in the managed chat and confirm the agent observes it.

## Live logged_out exit (only when reproducible)

- [ ] With the runtime online, log out the linked device from the phone. The
      foreground process must exit non-zero with a message pointing at
      `ambient-agent repair whatsapp`, and the next `ambient-agent status` must
      report `ready` + `whatsapp-session: re-pair-required` — never a damaged or
      corrupt installation.
