# T1 · Model auth is API key OR subscription — acceptance receipt

Date: 2026-07-20

Ticket: #250 (with #246) · Plan: `docs/planning/ONE-BOX-PLAN-2026-07-20.md` § T1, revision 3

Branch: `claude/issue-250-api-key-provider` (off `claude/single-box-working`)

## Scope of this receipt

**T1 has no gate.** Everything below is **code-level acceptance**, runnable with no install,
no paired phone and no secrets. The end-to-end proof of model auth is **T2's first reply**
(#253) against the live instance — not anything in this document.

Two things are deliberately absent:

- ❌ **No WhatsApp round trip.** Not attempted, not simulated. An earlier stubbed-socket rig
  that injected the inbound message and captured the outbound reply was built and then
  **rejected and removed** — it was real-model-but-fake-world, which is never admissible as a
  gate. Reverted in `e235981`.
- ❌ **No live model call.** The pre-flight below is gated behind an env var and has not been
  run; it needs the owner's key.

## What shipped

**(a) Provider binding.** `model.provider` accepts any of the 35 provider ids pi ships,
validated against pi's live catalog rather than a hand-kept list. They share one
`createProvider` shape and every api id they name (`openai-responses`, `anthropic-messages`,
…) is already registered by `registerBuiltInApiProviders()` at import
(`pi-ai/dist/compat.js:136`), so `connectPiApiKeyProvider` is a single
`registerProvider(id, {apiKey})` and never a `registerApiProvider`.
`credentials/model-api-key.json` holds `{schemaVersion:1, provider, apiKey}` at mode 0600;
config references it by the name `api-key`, never by value.

**(b) The `init` fix.** First-run setup refused to promote unless a ChatGPT credential had
been staged (`installation.ts`), so a box with only an API key could not complete setup at
all — which made (a) unusable in exactly the situation it was built for. Naming an API-key
provider now skips the device flow entirely and pastes a key instead; the promotion gate
checks the credential the config actually references; the doctor's model-auth check is
provider-aware for the same reason. **This is a widening — subscription setup is unchanged,
and that is asserted rather than assumed (mirror positive below).**

**(c) #246.** A `rate-limited` reason split out of `request-failed`, so a live gate from T2
onward can report INCONCLUSIVE instead of hunting a regression that does not exist.

**Untouched:** `connectPiChatGptSubscription` and the Luna rewrite
(`pi-subscription.ts:116-190`, gated on the Codex URL and model id). The subscription path
**stays working per boot** — its apiKey is captured once at boot and never refreshed, which
is #248 and explicitly not fixed here.

## Acceptance

### 1. Typecheck and tests

```bash
npx tsc --noEmit     # clean
npx vitest run tests/
```

```text
 Test Files  70 passed | 1 skipped (71)
      Tests  693 passed | 4 skipped (697)
```

The four `tests/packaging/packed-cli.test.ts` failures that predate this branch are also
fixed: e2b's CJS entry `require`s a package-internal `#ansi-styles` subpath import the
fixture's module hooks could not link, so every packed-CLI run died at import. The fixture
stubs `e2b`, which the CLI imports statically but only constructs when `E2B_API_KEY` is set.

### 2. `config --model-provider` round-trips config and credential

`tests/managed/cli.test.ts` drives the real `runCli`:

- config gets `{provider: "openai", credential: "api-key", profiles: {speaker: gpt-5.4-nano, coder: gpt-5.4}}`
- `credentials/model-api-key.json` is written at mode `0100600` with the pasted key
- the key appears in **neither** `config.json` **nor** stdout
- `--model-provider openai --model claude-sonnet-4-6` is refused with `has no model claude-sonnet-4-6`, and neither file is written

Per-role models are the cost lever: `--model` sets every role, `--model-<role>` overrides one.

### 3. Structural init exercise — **structural-only**

Drives the real `init` code path in the built CLI **up to and not including** the pairing
ceremony. Pairing is a declared prerequisite of T2 and is never faked; the PTY is not
stubbed, the prompt loop is not faked, and the pairing abort is not simulated.

```bash
node --import=tests/fixtures/packed-runtime.mjs dist/cli/main.js \
  --data-dir $G/managed2 init --model-provider openai --model gpt-5.4-mini \
  --chat 120363000@g.us --repository owner/repo --github-apps-file $G/apps.json
```

```text
Data directory: <scratch>/gate/managed2
ambient-agent: Setting up the openai model provider requires the interactive guided key paste.
EXIT 1
```

The data directory does not exist afterward — it refused before creating anything.

**What this proves:** naming an API-key provider takes model auth off the ChatGPT device flow
entirely. The same invocation before this change demanded a ChatGPT credential.
**What it does not prove:** ❌ that the auth works. That is T2's first reply.

The control, in the same test, shows the subscription path still stops at its own
credential (`existing valid managed ChatGPT credential`) — a widening, not a swap.

### 4. Negative — API-key mode, credential absent

`tests/packaging/packed-cli.test.ts`, real binary, real process exit code. Scoped to API-key
mode, and asserting **more than the exit code**: an unconfigured install already exits 1
(`tests/managed/cli.test.ts:312-318`), so a bare exit-code assertion would pass vacuously.

The install is first shown **ready** (`state: "ready"`, `modelAuthentication: {state: "ready"}`),
then exactly one file is removed:

```text
code: 1
stderr: "model.provider is openai but the managed API key at …/credentials/model-api-key.json
         is missing or unreadable. Run ambient-agent config --model-provider openai and paste
         a fresh key."
```

`tests/managed/model-provider-start.test.ts` additionally asserts in-process that
`importServer` is never called — nothing binds — and covers the second failure shape: a key
pasted for a different provider than the config names.

### 5. Mirror positive — subscription with no API key starts

Without this, the negative above would be satisfied by a runtime that hard-exits on every
subscription install. Real binary: an install with `model.provider: "openai-codex"` and **no**
`credentials/model-api-key.json` (asserted `ENOENT`) boots and reports
`{runtime: {state: "healthy"}}`.

### 6. Negative — provider/credential mismatch refused at config-write time

`writeManagedConfiguration` (`configuration.ts:68`) re-parses through `ManagedConfigSchema`,
whose `v.check` pairs provider and credential, before it touches either file.

```text
REFUSED at write time: The model credential reference must match the configured model provider
config unchanged on disk: true
provider still: openai / credential: api-key
```

`tests/managed/configuration.test.ts` asserts the same and additionally that the injected
write function is never called and both files are byte-identical afterward.

### 7. Negative — #246 rate-limit classification

`tests/speaker/pi-subscription.test.ts`:

| Error message | Reason |
|---|---|
| `429 Too Many Requests` | `rate-limited` |
| `Rate limit reached for gpt-5.4-mini` | `rate-limited` |
| `You exceeded your current quota` | `rate-limited` |
| `too many requests, please slow down` | `rate-limited` |
| `fetch failed: ECONNREFUSED` | `request-failed` |
| `getaddrinfo ENOTFOUND api.openai.com` | `request-failed` |
| `500 Internal Server Error` | `request-failed` |
| `socket hang up` | `request-failed` |
| `401 Unauthorized — quota check failed` | `credential-rejected` |

The rate-limited message says **inconclusive** explicitly, and credential rejection is checked
first so a 401 that mentions a quota is not retried forever. A `rate-limited` reason does not
mark the credential unusable in the doctor, where `credential-rejected` does.

## Pre-flight — owner runs this, one command, fractions of a cent

**Not a gate.** One real model call through the production API-key binding, claiming nothing
about any transport. It de-risks the T2 deploy by flushing out provider bugs before we debug
them through an install.

```bash
AMBIENT_AGENT_LIVE_MODEL=1 OPENAI_API_KEY=sk-… \
  pnpm vitest run tests/speaker/pi-subscription.test.ts
```

It calls `connectPiApiKeyProvider` — the same binding `apps/runtime` makes at boot — asserts
`registerProvider` was called with the key alone, then makes one `maxTokens: 16` request and
asserts:

- `request === "complete"`, and
- **`text.length > 0`** — the assertion that matters. `complete` alone only means the stream
  ended without an error, and an empty response satisfies it.
- a `rate-limited` reason is reported as **INCONCLUSIVE**, not a failure.

It prints `model=<provider>/<id> chars=<n> elapsedMs=<n>`.

Verified non-vacuous: run with a deliberately invalid key, it fails with
`expected 'failed' to be 'complete'` after reaching the provider.

Overrides: `AMBIENT_AGENT_LIVE_PROVIDER` (default `openai`),
`AMBIENT_AGENT_LIVE_MODEL_ID` (default `gpt-5.4-mini`).

`AMBIENT_AGENT_LIVE_*` stays an env var by design — the no-env-vars rule governs runtime
config, not test harnesses.

## Verdict

| Claim | Evidence | Verdict |
|---|---|---|
| Provider is an API-key choice set through the CLI | any of pi's 35 ids, catalog-validated | ✅ |
| Key is never a flag or an environment variable | prompted; non-interactive selection refused | ✅ |
| Key is never in `config.json` or stdout | asserted in cli and first-run tests | ✅ |
| Per-role models | `--model-<role>`; cheap Speaker beside capable Coder | ✅ |
| `init` no longer forces the ChatGPT device flow | structural exercise + first-run test | ✅ |
| Subscription setup still works | control invocation + mirror positive | ✅ |
| Existing configs parse unchanged | `provider` is `v.optional(…, "openai-codex")`; no migration, no schemaVersion bump | ✅ |
| API-key mode, credential absent → non-zero **and** specific message | exit 1 + stderr, from a ready install missing one file | ✅ |
| Subscription runtime with no API key starts | real binary, healthy | ✅ |
| Mismatch refused at config-write time | write refused, both files unchanged | ✅ |
| 429 → `rate-limited`; network failure → `request-failed` | classifier table | ✅ |
| Codex subscription path untouched | no diff to the connector or the Luna rewrite | ✅ |
| Model auth actually works end to end | — | ❌ T2's first reply |
| WhatsApp round trip | — | ❌ not attempted; #253 |
| Live model call | — | ❌ pre-flight not yet run |

## Rollback

`ambient-agent config --model-provider openai-codex` returns to the subscription path, which
is untouched.
