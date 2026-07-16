# Windows carry everything — live proof

Date: 2026-07-16

Ticket: [#114](https://github.com/AaronAbuUsama/ambient-agent/issues/114)

## Rig

- Host: `code-factory`
- Runtime: tmux `validate-88:1.1`
- Final reviewed artifact: `$HOME/validate-88/ambient-agent-0.2.2-issue114-final.tgz`
- Final artifact SHA-256: `07d49f7f8367757086e81f1af64deca400cf39f6a86389fc2ce30ecd5d57bdcf`
- Reaction proof artifact SHA-256: `84e3f272380c4326bd610dda9f2751616de7ad451f264965c1a3ecfa73b00508`
- Managed chat: paired Tst group

## Schema upgrade

Before startup, the existing application database was schema version 1 and contained both obsolete projections:

```json
{"userVersion":1,"tables":["conversation_reactions","conversation_receipts"]}
```

The reaction proof artifact started successfully, migrated the database once, and left both operator commands green. The final reviewed artifact narrows the pre-diagnostic startup step to migration-only behavior; it was then packed from the final tree, restarted against the upgraded database, and independently returned the same green `status` and `doctor` results:

```json
{"userVersion":2,"tables":[]}
{"command":"status","state":"ready","application":"database.ready","runtime":"healthy","whatsapp":"online","pending":0,"failed":0}
{"command":"doctor","state":"ready","application":"database.ready"}
```

## Reaction Window

A participant removed a 👍 reaction from provider message `3EB073AF6B7203E9804FD2`. The corrected runtime journaled one normalized update and no duplicate unsupported arrival:

```json
{
  "kind": "reaction",
  "providerMessageId": "3EB073AF6B7203E9804FD2",
  "payload": { "by": "204663831932940@lid", "removed": true }
}
```

That update opened Window `afccf303-7e81-408c-892f-4c7923a517d2` by itself. The durable Window contained zero messages and exactly that reaction update, fired by debounce, and completed dispatch `8fc385d7-ba5f-4045-a24a-5b0585b0fa1d` as `done`.

Rig transcript:

```text
9:20:52 PM  ▶ [AGENT] Processing: 0 messages
9:20:54 PM  ✓ [AGENT] Completed: 2.3s
9:20:54 PM  — settled silent
```

The first live attempt also exposed whatsappd emitting a reaction as both `onUpdate(reaction)` and an `onMessage` unsupported `reactionMessage` envelope. The corrected reaction artifact filters that provider envelope at the shared account intake seam; the transcript above is from that corrected artifact and the Window contains only the normalized update. The final reviewed artifact retains the same event path and adds only the narrower startup migration invocation described above.

## Automated verification

```sh
pnpm build
pnpm lint
pnpm typecheck
pnpm exec tsc --noEmit
pnpm test
pnpm evals
git diff --check
```

The deterministic integration test covers an added reaction, edit, and revocation reaching `whatsapp.window` while receipts remain journal-only. Effect `TestClock` tests fix extend-only debounce and message-only capacity semantics. The packed CLI regression starts from the version-1 schema, upgrades it, and verifies both `status` and `doctor` remain ready.

After rebasing onto the Braintrust eval battery, the complete isolated validation-host run passed 12 deterministic cases and 9 authenticated live-judged cases. Braintrust export remained disabled because no export credential was supplied; all enforced local rubric floors passed, including the multi-message Window grade at 80% against its 50% floor.

## Proof boundary

- **Live-runtime proof:** real provider reaction update, reaction-only durable Window, debounce dispatch, deliberation, silent settlement, version-1-to-version-2 migration, and operator diagnostics.
- **Automated proof:** added reaction plus edit/revocation rendering, receipt exclusion, deterministic timing/capacity invariants, restart durability, projection removal, and packed startup migration.
- **Not claimed:** the live action was a reaction removal; the added-reaction shape is covered at the production integration seam and the first provider attempt, but the final corrected rig transcript records `removed: true`.
