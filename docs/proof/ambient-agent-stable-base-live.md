# Ambient Agent stable-base live receipt

Date: 2026-07-15

Issue: [#59](https://github.com/AaronAbuUsama/whatsappd-github-agent/issues/59)

Integration baseline: `9976b356229c4745cc71bbe77be33c4c13aaeb47`

## Result

One private managed installation completed the supported first-run, managed
ChatGPT OAuth, packed-runtime, real WhatsApp, real GitHub, and local process-
replacement journey. A real report created exactly one issue in the authorized
repository. After a clean process replacement, a later real instruction added
one comment and closed that same issue. The application retained both Windows,
both Flue submissions, the canonical Ambience stream, the Conversation Archive,
and all three GitHub Operation Identities with no Uncertain work.

The qualifying GitHub resource is
[TheCallApp/ios-design-system#86](https://github.com/TheCallApp/ios-design-system/issues/86).
Its final observed state was `closed` with reason `completed`.

## Proof boundary

This receipt covers one local macOS user, Node `24.18.0`, the supported stopped-
source WhatsApp-store import, one managed data directory, the managed
`openai-codex` device OAuth flow, a locally packed and installed `ambient-agent`
artifact, one foreground process at a time, a second real WhatsApp account as
the message source, and one fine-grained-token-authorized GitHub repository.

It does not claim hot store adoption, concurrent ownership of one WhatsApp
store, PID liveness, stale-lock recovery, active-active processes, cross-host
recovery, or provider credential portability. Those mechanisms are not part of
the supported local-runtime design.

## Packaged installation and authentication

The first-run installation was created through the installed CLI from this
issue branch's packed artifact:

| Fact                               | Receipt                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| Package                            | `ambient-agent@0.1.0`                                                             |
| Setup tarball SHA-256              | `4cbef22211da8023b5f0b062d94030303da24e0a8c3e3a166748675c44edec59`                |
| Qualifying runtime tarball SHA-256 | `a0330d1d532fd9a9d2c00b974f33452e555882d2a100d4c1e555cdf8dae80c02`                |
| Reviewed PR-head tarball SHA-256   | `ae780668b88aadaddfffad51a9641032844a019644bb93f52f0ff5514283ad13`                |
| Installed binary                   | `/tmp/ambient-agent-issue59-9976b356/install-run/node_modules/.bin/ambient-agent` |
| Managed directory                  | `~/Library/Application Support/ambient-agent-issue59-stable-base`                 |
| Managed Chat                       | `120363428464069244@g.us`                                                         |
| Authorized repository              | `TheCallApp/ios-design-system`                                                    |

The setup artifact imported a stopped same-owner `whatsappd` file store into a
private staging directory, left the source unchanged, normalized the copied
tree to directory mode `0700` and file mode `0600`, and rejected links and
special files. It authenticated the adopted account and provisionally accepted
the explicit supported chat JID when the already-linked account emitted no
fresh conversation index. The first real inbound event below is the stronger
membership proof.

The setup flow printed the ChatGPT device verification URI and code. The
operator approved it in a browser signed in to the intended subscription
account. The credential was then owned by
`credentials/chatgpt-oauth.json`; no model API key or machine-global Pi state
was used. A subsequent installed `doctor --live --json` reported:

- `modelAuthentication.state: ready`;
- model `openai-codex/gpt-5.6-luna` with `request: complete`;
- GitHub access `ready` for `TheCallApp/ios-design-system`;
- both SQLite databases and persisted WhatsApp registration-or-identity evidence `ready`;
- zero Uncertain admissions or external mutations.

The public npm registry also returned `ambient-agent@0.1.0`. That release is an
earlier integration snapshot; the newer source proven here remains a local
tarball until a subsequent registry release.

The real provider mutations and process replacement below used qualifying
runtime artifact `a0330d1d...`. Review then added three deterministic hardening
changes: reject source/staging overlap during store import, refuse the
provisional imported-chat fallback after any fresh pairing event, and describe
the offline WhatsApp diagnostic as registration-or-linked-account identity
evidence. Those changes are not attributed retroactively to the live artifact.
They were packed as reviewed PR-head artifact `ae780668...`, installed into a
fresh prefix, and run against the same stopped managed installation. Its
`doctor --live` completed the real model and GitHub checks with zero Uncertain
work; its foreground runtime reached WhatsApp `online`; and its correlated
`status` was `healthy` before a clean stop. No WhatsApp instruction or GitHub
mutation was sent during this post-proof compatibility check.

## Qualifying real journey

All times are UTC on 2026-07-15.

### Report, duplicate search, and creation

At `10:19:52`, the managed runtime archived real inbound provider message
`3EB0358A3CF0F43304C8F6`. It contained a complete disabled-button bug report
with marker `ambient59-live-20260715-1018Z` and explicitly required duplicate
search before creating exactly one issue.

| Boundary                   | Identifier                                               |
| -------------------------- | -------------------------------------------------------- |
| Conversation Archive event | `arrival:120363428464069244@g.us:3EB0358A3CF0F43304C8F6` |
| Stable Window              | `eb8d75a3-b4c0-474c-a428-82bd19e4130e`                   |
| Admission attempt          | `59511282-f419-4014-a0dc-57b6db4c828b`                   |
| Flue dispatch/submission   | `27ea6235-320c-40f4-9739-64b74d23c2cf`                   |
| Create Operation Identity  | `b33ffe00-bce7-4a0a-9cfe-0d6f923a9853`                   |
| Created issue              | `TheCallApp/ios-design-system#86`                        |
| WhatsApp Say               | `3EB0729648A09A2CD33D3B`                                 |

The Window was admitted at `10:19:55.388`; the Flue submission settled once
with `attempt_count = 1`. The create operation ran from `10:20:10.276` through
`10:20:10.821` and settled `completed`. GitHub reported exactly one issue whose
title contains the marker, created at `10:20:10`. Its body preserved the
report, reproduction, expected result, actual result, acceptance condition,
proof marker, and application Operation Identity footer. Ambience sent exactly
one result message; the archive retained its outbound arrival plus delivered
and read receipts.

### Process replacement

Before replacement, the canonical stream was:

```text
path: agents/ambience/120363428464069244@g.us
incarnation: 1f1b7990-2990-4beb-ac43-61e2973d385f
producer_epoch: 1
next_offset: 35
```

The foreground process received a clean interrupt and exited. The installed
`status --json` then reported `runtimeState: stopped`, both databases ready,
persisted WhatsApp registration-or-identity evidence ready, managed model authentication ready, and
zero Uncertain work. The exact Window, settled Flue submission, and completed
create operation remained queryable from the two managed SQLite files.

A new process using the same installed packed binary and managed directory came
online. `status --json` reported `runtimeState: healthy` and WhatsApp phase
`online`. The original Window, dispatch, operation, and stream incarnation were
unchanged.

### Later discussion and closure

At `10:25:23`, after replacement, the runtime archived real inbound provider
message `3EB01BA76297B4903B6625`. Its unique marker was
`ambient59-followup-20260715-1025Z`; it instructed Ambience to inspect issue
#86, avoid a duplicate comment, add one exact comment, close the issue, and Say
once after confirmation.

| Boundary                   | Identifier                                               |
| -------------------------- | -------------------------------------------------------- |
| Conversation Archive event | `arrival:120363428464069244@g.us:3EB01BA76297B4903B6625` |
| Stable Window              | `2dc097cd-aa64-44aa-a7b3-81d99ebed151`                   |
| Admission attempt          | `a17b5b03-d3e5-4abf-825e-84b6d8fb1448`                   |
| Flue dispatch/submission   | `be7e9178-42e6-4dec-9b06-a8d46743a3a0`                   |
| Comment Operation Identity | `167387a0-616a-42f6-885a-0221da8cedb5`                   |
| Close Operation Identity   | `1ac8ec37-6090-4a96-8f5f-95362d4fb0b7`                   |
| WhatsApp Say               | `3EB0BA77B2993EB059258D`                                 |

The second Window was admitted at `10:25:26.779`; its submission also settled
once with `attempt_count = 1`. GitHub created exactly one marked comment at
`10:25:39`, then closed #86 with reason `completed` at `10:25:43`. Both
Operation Identities settled `completed`. The single Say was archived and
received delivered and read receipts.

After the second turn, the same canonical stream incarnation remained present,
`producer_epoch` had advanced from `1` to `2`, and `next_offset` had advanced
from `35` to `69`. That is the expected local process-replacement boundary: a
new producer owns the same canonical conversation rather than creating a new
Ambience context.

The replacement process was then stopped cleanly. Final installed status again
reported `runtimeState: stopped`, ready databases, ready structural WhatsApp
registration-or-identity evidence, ready managed OAuth, and zero Uncertain work.

## Evidence classification

### Deterministic checks

- `pnpm test`: 28 files passed, 1 live-provider file skipped; 268 tests passed,
  3 separately gated provider tests skipped (271 total).
- `pnpm run typecheck`: passed.
- `GITHUB_WEBHOOK_SECRET=ambient59-build-only-secret pnpm run build`: Flue
  server and executable bundle passed on Node 24.18.0.
- Deterministic packaged HTTP eval: 8 passed, covering issue creation, feature
  classification, correction, clarification, duplicate suppression, private
  silence, exactly one Say, and current-chat-only search.

The first full-suite attempt while the qualifying process still occupied the
default runtime port produced four status/packaging failures. After the process
was intentionally stopped, the unchanged suite passed. Those failures are
retained as non-qualifying environmental evidence rather than represented as a
code defect.

A later verification launched the full suite concurrently with other checks;
four packaging cases saw a temporary install whose manifest existed but whose
CLI bundle was absent. The independently packed reviewed-head tarball contained
and executed that bundle. The packaging file then passed 5/5 in isolation and
the serial unchanged full suite passed 268/271. The transient attempt is not
counted as green and did not motivate a product change.

### Behavior evaluation

The separately gated built HTTP fixture used the same managed ChatGPT OAuth
adapter and the real `openai-codex/gpt-5.6-luna` model with fake provider
transports. All 8 live-model cases passed: complete bug, complete feature,
correction and organization, one focused clarification, duplicate suppression,
casual silence, exactly one Say, and chat-isolated history search.

This proves model behavior and Tool selection through the public Flue boundary.
It does not prove provider delivery; the qualifying WhatsApp and GitHub
receipts above provide that separate evidence.

### Real provider state

- WhatsApp: two distinct real inbound provider messages, two admitted Windows,
  two settled Flue submissions, two outbound Say messages, and archived
  delivered/read receipts.
- GitHub: one exact marked issue, one exact marked comment, final state closed,
  and three completed application-owned Operation Identities.
- OAuth: managed device authorization was accepted and both a readiness request
  and the qualifying Ambience turns completed through the subscription model.

### Documentation check

The operator README, production architecture, Issue Management Skill v1.2.0,
and WhatsApp Participation Skill v1.0.0 were checked against the installed
runtime and live receipts. The README now documents stopped-store adoption,
the provisional-chat proof boundary, exact ChatGPT device-login steps, and the
complete issue/comment lifecycle. The Capability Skills already matched the
observed behavior: read current discussion before comment/state mutation,
preserve Operation Identity, never retry an Uncertain mutation blindly, and
publish only through one explicit `say` call.

## Non-qualifying and unproven boundaries

- An earlier source-account send returned provider ID
  `3EB0A352E23DA0F720AAAE`, but no managed arrival was observed before that
  sender stopped. It is not counted as delivery and was not blindly retried;
  the later qualifying message had a different provider ID and unique receipt.
- The first-run source store was already linked and stopped. Fresh QR pairing
  was not repeated. Authentication plus the first real inbound event prove the
  adopted-session boundary; they do not prove a new-phone pairing UX.
- No independent WhatsApp Desktop screenshot was captured. Provider IDs,
  application archive rows, and delivery/read receipts are the mechanical
  evidence. A human may optionally inspect the visible group history, but that
  is not required to make the provider receipts true.
- GitHub's public webhook delivery transport was not invoked in this
  WhatsApp-initiated journey. Signed ingress, routing, deduplication, and restart
  behavior remain covered by deterministic production-path tests.
- A URL in each Say triggered Baileys' optional link-preview import warning
  because `link-preview-js` is not installed. Plain-text sending succeeded and
  received delivery/read receipts; rich previews are not a stable-base
  requirement.
- Live ambiguity was not induced against GitHub. Deterministic failure-
  injection and reconciliation tests prove that boundary without risking a
  duplicate real mutation.
- Hot backup, cross-host restore, Windows ACLs, external process-manager policy,
  PID probing, stale locks, concurrent process ownership, and active-active
  recovery remain explicitly outside this local stable base.

## Reproduction commands

Credential values are intentionally omitted.

```bash
shasum -a 256 artifacts/ambient-agent-0.1.0.tgz
npm install --prefix "$INSTALL_ROOT" "$TARBALL"

"$INSTALL_ROOT/node_modules/.bin/ambient-agent" \
  --data-dir "$DATA_DIR" init \
  --authorize \
  --whatsapp-store "$STOPPED_WHATSAPP_STORE" \
  --chat 120363428464069244@g.us \
  --repository TheCallApp/ios-design-system \
  --github-token-file "$TOKEN_FILE"

"$INSTALL_ROOT/node_modules/.bin/ambient-agent" --data-dir "$DATA_DIR" doctor --live --json
"$INSTALL_ROOT/node_modules/.bin/ambient-agent" --data-dir "$DATA_DIR" start
"$INSTALL_ROOT/node_modules/.bin/ambient-agent" --data-dir "$DATA_DIR" status --json

pnpm test
pnpm run typecheck
GITHUB_WEBHOOK_SECRET=ci-build-only-secret pnpm run build
FLUE_BASE_URL=http://127.0.0.1:3583 pnpm run evals
AMBIENCE_EVAL_LIVE_MODEL=true FLUE_BASE_URL=http://127.0.0.1:3583 pnpm run evals
git diff --check
```
