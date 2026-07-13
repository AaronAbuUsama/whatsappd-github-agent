# Live verification punch-list

Automated tests and builds are the merge gate. These checks need the paired
WhatsApp/model/GitHub host and are intentionally deferred to that environment.

- [ ] **#8 non-blocking delegation:** in the real test group, send a bug report and confirm the voice says “on it” promptly; send unrelated traffic while the worker runs and confirm the voice responds; confirm the GitHub worker creates/updates the real issue and the voice later narrates its real `#number` and URL.
- [ ] **#8 restart recovery:** kill the gateway after a job is claimed, restart it against the same `.wa-auth/gateway.sqlite`, and confirm the job is reclaimed and its result is narrated once the worker finishes.
- [ ] **#9 live context search:** after real group traffic in both directions, ask “what did X say earlier about Y?” and confirm the voice calls `whatsapp_search`, finds only the current chat’s stored message, and answers from that context.
