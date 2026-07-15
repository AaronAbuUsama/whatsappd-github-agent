# Ambient Agent

> The secure `ambient-agent` installer, managed filesystem, foreground runtime,
> `status`, and `doctor` commands are shipped. The production Issue Management
> rollout is still tracked by the remaining stable-base work in
> [the architecture plan](./docs/architecture/ambient-agent.md).

A continuing ambient agent for managed WhatsApp chats. Each accepted coalesced
window is admitted to one canonical instance of Ambience — this application's
Flue agent — keyed by WhatsApp `chatId`. Ambience uses Luna 5.6 at low
reasoning through Ambient Agent's managed ChatGPT subscription authentication;
Pi remains a private model-runtime adapter.

## Production architecture

```text
paired whatsappd session
  -> managed-chat gate
  -> per-chat Coalescer actor
  -> Flue dispatch(id = chatId)
  -> continuing Ambience context
       |-> read/search bound WhatsApp history
       |-> say -> whatsappd session.send
       `-> search/read/create an authorized GitHub issue directly

verified GitHub webhook -> application routing/deduplication -> same Ambience
```

The model processes every accepted Coalescer window. Its ordinary assistant
prose remains private canonical Flue context: the application neither parses nor
copies that prose. Only the explicit `say` tool can call the WhatsApp send
boundary.

Ambience receives the versioned Issue Management Skill and provider-neutral
search, read, and create Tools bound to the one authorized repository. The
application assigns an Operation Identity before creation. If a provider
response is lost, it performs bounded read-only observation and never blindly
repeats the mutation.

## Run it

The installed CLI requires macOS or Linux and Node 22.19 or newer. Building this
repository from source additionally requires a Vite+-supported Node release:
`^22.19.0` or `>=24.11.0`. Development uses pnpm 9. Runtime setup also needs a
paired WhatsApp account, a scoped GitHub token, and a ChatGPT Plus/Pro account.
Windows setup currently fails closed until equivalent private ACL enforcement
is implemented.

Until the package is published, build a local tarball, install that tarball, and
create its managed data skeleton:

```bash
pnpm install --frozen-lockfile
pnpm pack --pack-destination ./artifacts
npm install --global ./artifacts/ambient-agent-0.1.0.tgz

ambient-agent init \
  --chat 120363000000000000@g.us \
  --repository owner/repository \
  --github-token-file /secure/path/github-token.txt

# Open the verification URI printed by Ambient Agent and enter its device code.

ambient-agent status
ambient-agent auth              # replace missing, malformed, or rejected ChatGPT authentication
ambient-agent doctor
ambient-agent doctor --refresh  # safely rotate an expired credential
ambient-agent doctor --live     # opt-in real model readiness request
```

After the package is published, `npx ambient-agent` will be the equivalent
one-command entry point.

With no arguments, the executable enters guided setup on a first run and
reports status thereafter. It stores non-secret configuration and credential
references in the OS data directory while keeping credentials in private
`0600` files beneath a `0700` root. Running setup again verifies the existing
installation and does not replace credentials. Use `ambient-agent auth` for an
explicit ChatGPT reauthentication without changing the rest of the installation.
Managed JSON diagnostics read at most 1 MiB per file and fail closed if a file
exceeds that limit or changes during inspection.

For current source development, build and use the same managed CLI path:

```bash
pnpm install --frozen-lockfile
pnpm run build
node dist/cli/main.js init --chat 120363000000000000@g.us \
  --repository owner/repository \
  --github-token-file /secure/path/github-token.txt
node dist/cli/main.js start
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
- `APPLICATION_DB_PATH` is the single SQLite boundary for archive, intake, GitHub ingress, and operation receipts.
- `WHATSAPP_GROUP_ID(S)` and `WHATSAPP_ALLOW_DM` keep admission fail-closed.
- `WHATSAPP_HISTORY_DB` retains full-fidelity history for the chat-bound tools.
- The application-owned `credentials/chatgpt-oauth.json` record is the only
  accepted model credential. Pi global state and model API-key environment
  variables are not authentication sources.

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
