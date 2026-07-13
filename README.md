# whatsappd-github-agent

A continuing ambient agent for managed WhatsApp chats. Each accepted coalesced
window is admitted to one canonical Flue Ambience instance keyed by WhatsApp
`chatId`. Ambience uses Luna 5.6 at low reasoning through Pi's ChatGPT
subscription OAuth adapter.

## Production architecture

```text
paired whatsappd session
  -> managed-chat gate
  -> per-chat Coalescer actor
  -> Flue dispatch(id = chatId)
  -> continuing Ambience context
       |-> read/search bound WhatsApp history
       |-> say -> whatsappd session.send
       `-> start bounded GitHub workflow -> later result event -> same Ambience

verified GitHub webhook -> application routing/deduplication -> same Ambience
```

The model processes every accepted Coalescer window. Its ordinary assistant
prose remains private canonical Flue context: the application neither parses nor
copies that prose. Only the explicit `say` tool can call the WhatsApp send
boundary.

GitHub mutations are available only inside bounded specialist workflows. Root
Ambience receives no direct GitHub mutation tool. Admission returns a `runId`
without blocking the chat; completion or failure is dispatched later as new
input to the same Ambience instance. Mutation recovery verifies observed GitHub
state by operation identity and never blindly retries an uncertain write.

## Run it

Requirements: Node 22 or 24, pnpm 9, a paired WhatsApp account, a scoped GitHub
token, and a Pi ChatGPT OAuth login.

```bash
pnpm install --frozen-lockfile
pi /login                    # select ChatGPT and complete OAuth
cp .env.example .env         # configure GitHub and managed chat values
pnpm run dev
```

With `AMBIENCE_WHATSAPP=1`, the one Flue process owns the whatsappd session.
On a new credential store it prints a QR; link it from WhatsApp's Linked devices
screen. Use `pnpm run whatsapp:dry-run` for a send-nothing credential probe.

For a built deployment:

```bash
pnpm run build
pnpm run start
```

The health endpoint reports the model authentication mode, selected model, and
WhatsApp runtime phase. No model API-key environment variable is supported.

## Configuration boundaries

- `GITHUB_ALLOWED_REPOS` limits every bounded workflow write.
- `GITHUB_WEBHOOK_SECRET` authenticates ingress before payload parsing.
- `GITHUB_CHAT_ROUTES` keeps repository-to-chat ownership application-owned.
- `WHATSAPP_GROUP_ID(S)` and `WHATSAPP_ALLOW_DM` keep admission fail-closed.
- `WHATSAPP_HISTORY_DB` retains full-fidelity history for the chat-bound tools.
- Pi's `openai-codex` OAuth credential is the only accepted model credential.

See [Ambience recovery](./docs/architecture/ambience-recovery.md) for durable
ownership and failure semantics. The post-deletion production proof is in
[docs/proof/ambience-hard-cut-live.md](./docs/proof/ambience-hard-cut-live.md).
The earlier replacement proof is retained as a historical prerequisite in
[docs/proof/ambience-replacement-live.md](./docs/proof/ambience-replacement-live.md).

## Development

```bash
pnpm run typecheck
pnpm test
GITHUB_WEBHOOK_SECRET=ci-build-only-secret pnpm run build
```

CI runs typecheck, tests, and the Flue build on Node 22 and Node 24. Historical
planning records under `docs/planning/` are explicitly marked as superseded;
they are not current operator guidance.

## Safety

whatsappd uses an unofficial WhatsApp Web implementation. Use an account you
can afford to lose. Keep `.env` and `.wa-auth*/` private. Scope GitHub tokens
to the smallest repository and issue permissions that satisfy the workflow.

## License

[MIT](./LICENSE) © Aaron AbuUsama
