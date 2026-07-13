# Ambience live replacement receipt

> Historical prerequisite proof captured before the #34 hard cut. It proves the replacement path that authorized deletion; the #34 issue and PR contain the post-deletion rerun.

Date: 2026-07-13

Ticket: #33

Code under proof: `fc277cf8d7ef9fe0be837b4b028d0d533112ccf5`

## Proof boundary

This receipt covers the production Flue app with the existing paired whatsappd
store, the existing chat gate and Coalescer, one chatId-bound Ambience instance,
the bounded GitHub proof workflow, and the signed GitHub channel. Eve remained
installed for the later hard-cut ticket. The recorded application process was
Flue's `dist/server.mjs`; it did not invoke an Eve route or runtime.

The runtime was launched with `OPENAI_API_KEY` explicitly empty. Its health
response reported:

```json
{
  "authentication": "pi-oauth",
  "provider": "openai-codex",
  "model": "openai-codex/gpt-5.6-luna",
  "whatsapp": {
    "phase": "online",
    "chatTarget": "120363428464069244@g.us"
  }
}
```

The paired account came online without a QR or a new pairing. The root Ambience
tool set contained communication, chat-bound history reads, and workflow
admission; it did not contain a GitHub mutation tool.

## Qualifying end-to-end slice

| Evidence | Identifier |
| --- | --- |
| Managed WhatsApp chat | `120363428464069244@g.us` |
| Canonical Ambience conversation | `conv_01KXEQ0XBG2RBGC19TF7FKFNPN` |
| Addressed inbound WhatsApp message | `3B5BB50A7210EA406719` |
| Initiating Ambience dispatch | `56974a26-fcda-44de-a043-a6b553c79e03` |
| Native workflow run | `run_01KXEQ934Y9Q55WC0EQ7XTSTYE` |
| Application operation | `85e53b61-7b7c-4fa4-865c-9af14c5e0acf` |
| Parallel inbound WhatsApp message | `3B836E0F7906A6A01200` |
| Parallel Ambience dispatch | `f71e66f4-c30d-4d25-8a1e-75ff16849cc6` |
| Completion Ambience dispatch | `67bbd33d-919a-443c-a7fa-edf1fd47bf1e` |
| Observed GitHub resource | [TheCallApp/ios-design-system#74](https://github.com/TheCallApp/ios-design-system/issues/74) |
| Explicit `say` delivery | `3EB05098F403993EFE458A` |
| Signed GitHub delivery | `ambience-33-issues-74-20260713` |
| GitHub ingress Ambience dispatch | `586bd4f9-8f52-4d97-b466-6b5e27c070b9` |

### Timeline

All times are UTC on 2026-07-13.

1. At `21:49:04.867`, the real WhatsApp mention was admitted to Ambience.
2. Ambience called only `start_github_proof`. Its native receipt returned
   `run_01KXEQ934Y9Q55WC0EQ7XTSTYE` with status `started` at `21:49:07.103`.
3. The workflow was durably active from `21:49:07.102` through
   `21:49:13.625` (6,523 ms). The initiating Ambience turn settled privately at
   `21:49:08.614`, more than five seconds before workflow completion.
4. A second real WhatsApp input arrived at `21:49:07` and its Ambience turn
   began at `21:49:10.506`, while the workflow was still active. It retained the
   marker privately and called no tool. It settled at `21:49:14.312`.
5. The specialist created issue #74, read it back as open, closed it, and read
   it back as closed. GitHub independently reported the issue closed at
   `21:49:11`. The workflow's observed-state result was `completed`, with both
   `creation` and `closure` equal to `confirmed`.
6. The durable completion input returned to the same canonical Ambience
   conversation. Only that turn called `say`, exactly once, with
   `ambience33c-complete 74 https://github.com/TheCallApp/ios-design-system/issues/74`.
   whatsappd returned provider message ID `3EB05098F403993EFE458A`, followed by
   an observed `whatsapp.typing.cleared` receipt.

The application history database contained exactly the two qualifying inbound
messages and the one expected outbound message for this time range. WhatsApp
Desktop independently showed the same sequence and no additional reply.

## Signed GitHub delivery

An exact JSON byte sequence representing the observed `issues.opened` resource
was HMAC-SHA256 signed with the runtime's local proof secret and posted to the
production `/channels/github/webhook` route.

The first request returned:

```json
{
  "status": "dispatched",
  "deliveryId": "ambience-33-issues-74-20260713",
  "repository": "thecallapp/ios-design-system",
  "chatId": "120363428464069244@g.us",
  "ambience": "ambience",
  "dispatchId": "586bd4f9-8f52-4d97-b466-6b5e27c070b9"
}
```

The deliberate second delivery of the same signed bytes returned `duplicate`
and the same stored dispatch ID; no second Ambience admission occurred. The
durable ingress row was `dispatched`, correlated to the managed chat, and the
single resulting Ambience turn settled at `21:51:01.363` in
`conv_01KXEQ0XBG2RBGC19TF7FKFNPN`. It called no tool, so the decision was
private silence and no WhatsApp message was sent.

This proves the production signature, normalization, routing, correlation,
durable deduplication, and Ambience dispatch path. The delivery was generated
locally with a correct signature rather than transported from GitHub's public
webhook service; the application path after HTTP receipt is the production
path.

## Verification commands

The credential values are intentionally omitted.

```sh
OPENAI_API_KEY= AMBIENCE_WHATSAPP=1 \
  FLUE_DB_PATH=/tmp/ambience-33-live-flue-1.db \
  GITHUB_INGRESS_DB_PATH=/tmp/ambience-33-live-ingress-1.db \
  PORT=43233 node --env-file-if-exists=.env dist/server.mjs

curl -fsS http://127.0.0.1:43233/health

sqlite3 -json /tmp/ambience-33-live-flue-1.db \
  "select run_id,status,started_at,ended_at,duration_ms,result from flue_runs order by started_at desc limit 1;"

sqlite3 -json /tmp/ambience-33-live-flue-1.db \
  "select sequence,submission_id,status,accepted_at,started_at,settled_at,payload from flue_agent_submissions order by sequence;"

sqlite3 -json /tmp/ambience-33-live-ingress-1.db \
  "select * from github_ingress_deliveries where delivery_id='ambience-33-issues-74-20260713';"

sqlite3 -json .wa-auth/gateway.sqlite \
  "select message_id,direction,text,timestamp_ms from messages where chat_id='120363428464069244@g.us' and timestamp_ms between 1783979344000 and 1783979470000 order by timestamp_ms;"

gh issue view 74 -R TheCallApp/ios-design-system \
  --json number,title,url,state,author,closedAt,body
```

## Automated proof

The focused and full verification suites cover the retained Coalescer behavior,
say-only speech, non-blocking workflow admission, same-instance terminal result,
restart recovery, interrupted workflow inspection, uncertain mutation marker
reconciliation without replay, signed ingress validation, routing, and durable
deduplication.

The final branch verification commands are:

```sh
pnpm typecheck
pnpm test
GITHUB_WEBHOOK_SECRET=<non-secret-placeholder> pnpm ambience:build
pnpm build # Node 24
git diff --check
```

Results:

- Node 22.22.3: typecheck passed; 21 test files / 201 tests passed; Flue
  production build passed.
- Node 24.18.0: typecheck passed; 21 test files / 201 tests passed; Flue
  production build passed; the still-present Eve build also passed.
- `git diff --check` passed.

## Non-qualifying setup attempts

Two earlier live attempts created and closed issues #72 and #73. They proved the
functional workflow and later result but are not used for the concurrency claim:

- #72 completed before the parallel input was admitted.
- #73's attempted second UI write failed against a stale accessibility index, so
  no parallel input was sent.

Both failures were detected from persisted timestamps/action receipts and were
repeated rather than represented as successful proof.

## Remaining limitations

- The public GitHub webhook transport was not exercised; exact-byte signature
  verification and every application-owned step after local HTTP receipt were.
- Restart and uncertain-mutation behavior were re-run in automated production-
  persistence tests, not by interrupting this live paired-account slice.
- Eve is intentionally still present in the repository for #34. The recorded
  launch command and application receipts used only Flue's `dist/server.mjs`;
  this receipt does not claim a contemporaneous system-wide process inventory.
