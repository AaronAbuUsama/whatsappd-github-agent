# Current production status

Milestone 3 replaced the legacy harness with one Flue Ambience production path.

- One continuing Ambience instance is keyed by each managed WhatsApp `chatId`.
- Pi ChatGPT subscription OAuth selects `openai-codex/gpt-5.6-luna` with low reasoning.
- The in-process paired whatsappd session feeds the retained per-chat Coalescer.
- Ordinary assistant prose is private Flue context; only `say` sends WhatsApp.
- Root Ambience exposes history, `say`, and finite-workflow admission tools only.
- Bounded GitHub specialists own mutations under the repository allowlist.
- Workflow admission is non-blocking; terminal results return later to the same Ambience.
- GitHub ingress verification, routing, correlation, and deduplication are application-owned.

The architecture and recovery contract live in
[docs/architecture/ambience-recovery.md](./docs/architecture/ambience-recovery.md).
The complete post-deletion receipt is in
[docs/proof/ambience-hard-cut-live.md](./docs/proof/ambience-hard-cut-live.md).
The pre-deletion replacement proof remains as a historical prerequisite in
[docs/proof/ambience-replacement-live.md](./docs/proof/ambience-replacement-live.md).
