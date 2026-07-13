# Live verification punch-list

> Historical design record. Superseded by the Flue Ambience production path completed in milestone #3; this is not current operator or architecture guidance.

Automated tests and builds are the merge gate. These checks need the paired
WhatsApp/model/GitHub host and are intentionally deferred to that environment.

- [ ] **#8 non-blocking delegation:** in the real test group, send a bug report and confirm the voice says “on it” promptly; send unrelated traffic while the worker runs and confirm the voice responds; confirm the GitHub worker creates/updates the real issue and the voice later narrates its real `#number` and URL.
- [ ] **#8 restart recovery:** kill the gateway after a job is claimed, restart it against the same `.wa-auth/gateway.sqlite`, and confirm the job is reclaimed and its result is narrated once the worker finishes.
- [ ] **#9 live context search:** after real group traffic in both directions, ask “what did X say earlier about Y?” and confirm the voice calls `whatsapp_search`, finds only the current chat’s stored message, and answers from that context.
- [ ] **#10 live F1 ledger replay:** report one bug and wait for the real issue `#N`; re-mention the same bug in different words and confirm the voice references `#N` without delegating or creating another issue.
- [ ] **#10 live F7 update replay:** ask “make `#N` a feature request” and confirm the worker targets that exact existing issue (comment/label as available) rather than creating a replacement.
- [ ] **#10 live today count + scoping:** ask “how many issues today?” in the source chat and confirm the distinct count matches its ledger; ask from another chat/session and confirm it does not see the source chat’s ledger.
