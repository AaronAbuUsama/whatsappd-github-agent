# Ambience hard-cut live receipt

Date: 2026-07-13

Ticket: [#34](https://github.com/AaronAbuUsama/whatsappd-github-agent/issues/34)

This is the post-deletion rerun of the replacement proof. The historical
pre-cut prerequisite remains in
[ambience-replacement-live.md](./ambience-replacement-live.md).

## Proof boundary

The production Flue app was built and run from the #34 hard-cut worktree with
the existing paired whatsappd store. The process contained the managed-chat
gate, retained per-chat Coalescer, one chatId-bound Ambience instance, bounded
GitHub workflow, and signed GitHub ingress. The removed Eve adapter, sidecar,
worker, compensation ledger, and alternate doorway were not present.

The launch explicitly set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and
`EVE_MODEL_ID` to empty values before loading the existing local environment.
The live health response was:

```json
{
  "ok": true,
  "authentication": "pi-oauth",
  "model": "openai-codex/gpt-5.6-luna",
  "provider": "openai-codex",
  "whatsapp": {
    "phase": "online",
    "chatTarget": "120363428464069244@g.us"
  }
}
```

The paired account came online without a QR or new pairing. The root Ambience
tool set exposed communication, chat-bound history reads, and bounded-workflow
admission. It exposed no direct GitHub mutation tool. Luna's low-reasoning
setting and Pi-only credential registration are additionally locked by the
automated adapter tests.

## Qualifying WhatsApp and workflow slice

| Evidence | Identifier |
| --- | --- |
| Managed WhatsApp chat | `120363428464069244@g.us` |
| Canonical Ambience stream | `agents/ambience/120363428464069244@g.us` |
| Stream incarnation | `a572eba1-7e2f-42c0-9a57-b448b618a631` |
| Silent inbound message | `3BFFE2E4415F7FC4D1EC` |
| Silent Ambience dispatch | `c7d5362c-86be-43a6-8616-89f07f26249d` |
| Addressed workflow message | `3B8470676562C5D87495` |
| Initiating Ambience dispatch | `0198fa10-be9b-4d9b-9cc2-8d9571807f16` |
| Native workflow run | `run_01KXERTN141T3PBBDJW9XCXRB2` |
| Application operation | `f0c9a259-bba7-44bb-96f8-1932ee412b34` |
| Completion Ambience dispatch | `b7c4ea38-13c7-4238-add4-9b5fca2cf17f` |
| Observed GitHub resource | [TheCallApp/ios-design-system#75](https://github.com/TheCallApp/ios-design-system/issues/75) |
| Explicit `say` delivery | `3EB03C9244626438D24A81` |

All times below are UTC on 2026-07-13.

1. At `22:14:19`, a real unaddressed WhatsApp message was accepted. Its
   Ambience turn settled privately and produced no outbound WhatsApp message.
2. At `22:16:05`, the real addressed message was admitted to the same Ambience
   stream. Its turn accepted workflow `run_01KXERTN141T3PBBDJW9XCXRB2` and
   settled at `22:16:12`.
3. The workflow was active from `22:16:11.045` through `22:16:19.178`. The
   initiating Ambience turn therefore settled about seven seconds before the
   workflow completed: admission was non-blocking.
4. The specialist created issue #75, read it back as open, closed it, and read
   it back as closed. GitHub reported it created at `22:16:16` and closed at
   `22:16:17`; the terminal result reported both mutations `confirmed`.
5. Completion returned later as submission
   `b7c4ea38-13c7-4238-add4-9b5fca2cf17f` to the same stream. Only that turn
   called `say`, exactly once, with
   `ambience34-complete 75 https://github.com/TheCallApp/ios-design-system/issues/75`.
   whatsappd returned provider message ID `3EB03C9244626438D24A81`, then logged
   `whatsapp.typing.cleared`.

## Concurrent input while a finite workflow was active

A second qualifying workflow was started through the production signed GitHub
channel. While that workflow was durably active, one real WhatsApp message was
sent to the authorized group and admitted through whatsappd and the Coalescer.

| Evidence | Identifier |
| --- | --- |
| Workflow-start delivery | `ambience-34-whatsapp-concurrent-start2-20260713` |
| Workflow-start Ambience dispatch | `a0034601-7d56-4a62-9db7-3839e8863117` |
| Native workflow run | `run_01KXESXV1TNEJHANAFEHFJ6HH5` |
| Application operation | `d026cd7f-9a5f-4655-8a08-c9e4078bcfab` |
| Parallel inbound WhatsApp message | `3B0213C96A25389D97CE` |
| Parallel Ambience dispatch | `75af8141-2014-4108-8eab-7712d48ded72` |
| Later completion dispatch | `4b13e17a-2832-40bb-a1aa-8edcce200680` |
| Observed GitHub resource | [TheCallApp/ios-design-system#81](https://github.com/TheCallApp/ios-design-system/issues/81) |

The workflow became durably active at `22:35:24.090`. The WhatsApp provider
message `3B0213C96A25389D97CE` arrived through the existing paired account at
`22:35:26`. After the ordinary ambient debounce, its Coalescer window was
accepted at `22:35:29.611`, and its Ambience turn started at `22:35:29.614`—
while the workflow was still active. The run completed at `22:35:30.115`, about
half a second later. The WhatsApp turn retained the marker privately, called no
tool, and settled at `22:35:31.498`.

The workflow completion was accepted separately at `22:35:30.115`, then began
after the already-admitted WhatsApp turn at `22:35:31.499` and settled at
`22:35:33.142`. The specialist created, observed, closed, and re-observed issue
[#81](https://github.com/TheCallApp/ios-design-system/issues/81). All three
submissions used the same canonical Ambience stream and stream
incarnation. No turn called `say`, and the server emitted no WhatsApp send
receipt for this slice.

This proves that the retained whatsappd -> Coalescer -> Ambience path remained
responsive to a real new chat window during a finite post-deletion workflow,
and that the terminal result returned later to that same Ambience instance.

## Signed ingress correlation and deduplication

An exact locally generated HMAC delivery used the production GitHub channel
while another bounded run was active:

| Evidence | Identifier |
| --- | --- |
| Workflow-start delivery | `ambience-34-concurrent-start-20260713` |
| Workflow-start Ambience dispatch | `35f6c4e3-f88b-4b38-bfaa-113fc702632d` |
| Native workflow run | `run_01KXESE1QVY31PENW6QW795BAC` |
| Parallel signed delivery | `ambience-34-concurrent-parallel-20260713` |
| Parallel Ambience dispatch | `dad60a78-2529-4298-bc6a-7db2dc2f4278` |
| Later completion dispatch | `df197b82-54ef-423c-a6cf-8d6ba40c692e` |
| Observed GitHub resource | [TheCallApp/ios-design-system#79](https://github.com/TheCallApp/ios-design-system/issues/79) |

The run was active from `22:26:46.651` through `22:26:53.022`. The parallel
delivery was dispatched to the same Ambience at `22:26:46.668`; an identical
immediate retry returned `duplicate` with the same stored dispatch ID. The one
parallel turn started at `22:26:49`, settled at `22:26:50`, and called no tool.
The later workflow result settled at `22:26:54` in the same stream.

This separately proves application-owned signature verification, routing,
correlation, durable deduplication, and same-instance delivery after deletion.

## Dependency and source cut

The final package surface has one production command family:

```text
dev   -> flue dev --target node
build -> flue build --target node
start -> node --env-file-if-exists=.env dist/server.mjs
```

`package.json` has no `eve`, `@ai-sdk/openai`, `ai`, or direct `zod`
dependency. `pnpm why eve` returns no dependency path, the lockfile has no
resolved `eve@...` package, and `import("eve")` fails with
`ERR_MODULE_NOT_FOUND`. Production `src/` contains no Eve import and no model
API-key environment lookup or credential fallback. Pi's OAuth adapter does use
its credential store API with fallback explicitly disabled.

The upstream `whatsappd` package still publishes an optional Eve adapter and
optional peer declaration in its own package metadata. This repository disables
automatic peer installation, so that optional peer is recorded only as
metadata, is not resolved, and cannot be imported by the production app.

Historical planning records retain Eve code samples and old environment names
for archaeology. Every retained record is explicitly bannered as historical;
none is linked as current operator guidance.

## Automated verification

The hard-cut test was added test-first and initially failed on the old command
surface, dependencies, files, and imports. After the deletion it passed.

Final branch commands:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
GITHUB_WEBHOOK_SECRET=ci-build-only-secret pnpm build
pnpm why eve
node --input-type=module -e "import('eve')"
git diff --check
```

Results:

- Node 22.22.3: typecheck passed; 10 test files / 71 tests passed; production
  Flue build passed.
- Node 24.18.0: typecheck passed; 10 test files / 71 tests passed; production
  Flue build passed.
- Dependency and source inspections passed; `eve` was not resolvable.
- `git diff --check` passed.

## Proof classifications and limitations

- **Automated proof:** command surface, deleted paths, no production Eve
  imports, no API-key fallback, Pi model policy, Coalescer ordering, say-only
  output, finite-workflow admission/result routing, recovery, mutation
  reconciliation, signed ingress, correlation, and deduplication.
- **Live-runtime proof:** paired whatsappd online, silent input, explicit say,
  non-blocking workflow, concurrent input, observed GitHub create/read/close/read,
  same Ambience stream, signed ingress, and duplicate suppression.
- **Transport limitation:** the signed GitHub events used exact locally generated
  HMAC bytes against the production HTTP route; GitHub's public webhook delivery
  transport was not exercised.
- **Non-qualifying setup attempts:** issues #76, #77, #78, and #80 were created and
  closed during timing/setup attempts. They are not used for the qualifying
  claims above.
- **Human-only checks:** none remain for the code cut. WhatsApp Desktop was used
  to observe the authorized group message sequence, while provider IDs and
  application receipts provide the durable evidence.
