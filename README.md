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

Until the package is published, build a local tarball and install that exact
artifact. After publication, replace the first three commands with
`npx ambient-agent`:

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
ambient-agent doctor --live     # opt-in real GitHub and model readiness requests

# If status or doctor prints an Uncertain reference, inspect first, then choose explicitly:
ambient-agent doctor --retry admission:<windowId>
ambient-agent doctor --retry mutation:<operationId>
ambient-agent doctor --accept-observed mutation:<operationId>
ambient-agent doctor --abandon admission:<windowId>
ambient-agent doctor --abandon mutation:<operationId>

# Review or change the synchronized managed chat and authorized repository.
ambient-agent config
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

`status` is read-only. It checks both SQLite files and the app-owned WhatsApp
registration fact, reports Uncertain counts and mutation kinds, and makes one
bounded local `/health` request at the port stored in `config.json`. An explicit
connection refusal reports `stopped`; timeouts, malformed responses, HTTP
failures, and responses from a different installation report `failed`. A
correlated response reports `starting`, `healthy`, `degraded`, `failed`, or
`stopped` from the actual runtime phase. The CLI does not probe PIDs or infer
stale ownership.
On the
supported stopped-runtime boundary it also counts durable `dispatching` and
`attempting` rows as degraded instead of claiming interrupted work is healthy.
It does not print chat content, issue/comment bodies, credentials, or stored
provider errors. `doctor` examines at most 25 Uncertain items per run, rotates
unresolved items fairly across later runs while reserving capacity for
admissions and mutations, and makes one bounded read-only observation at each
owning boundary; canonical Flue
inspection also stops after 100,000 records rather than scanning without
limit. A canonical Flue receipt or provider Operation Identity is
enough to reconcile automatically. A desired state without attributable
Operation Identity is reported as `observed` and requires
`--accept-observed`. Absence is not proof of non-delivery and never triggers an
automatic retry. `--retry` and `--abandon` are explicit operator decisions;
both preserve the prior attempt record, and a GitHub retry uses a fresh
Operation Identity.

These commands assume the supported local runtime: the foreground process is
stopped and one machine owns `application.sqlite` and `flue.sqlite`. They do
not implement PID probing, stale-lock recovery, active-active ownership, or
cross-host reconciliation.

For current source development, build and use the same managed CLI path:

```bash
pnpm install --frozen-lockfile
pnpm run build
node dist/cli/main.js init --chat 120363000000000000@g.us \
  --repository owner/repository \
  --github-token-file /secure/path/github-token.txt
node dist/cli/main.js start
```

The managed composition root enables WhatsApp and supplies its managed paths;
no operator-authored `AMBIENCE_WHATSAPP`, database, GitHub, or credential-path
variables are required. On a new credential store setup prints a QR; link it
from WhatsApp's Linked devices screen. Use `pnpm run whatsapp:dry-run` only for
source-development credential probing.

For a built deployment, `start` stays in the foreground and the process manager
owns restart policy and log capture:

```bash
pnpm run build
pnpm run start
```

A minimal systemd service can therefore use the installed executable directly:

```ini
[Service]
Type=simple
ExecStart=/usr/local/bin/ambient-agent start
Restart=on-failure
KillSignal=SIGTERM
```

Run the service as the same dedicated user that performed setup. Do not copy
credentials into the unit or add model/GitHub secrets as environment
variables. Select a non-default local listener once with
`ambient-agent config --port <port>`; `start` and `status` then use the same
validated managed setting.

## Backup, restore, and recovery

Stop the foreground process cleanly before copying data. Back up the entire
managed directory as one private unit: `config.json`, `credentials/`, both
SQLite files, `whatsapp/`, and `logs/`. Preserve owner-only directory access
and private credential-file modes. To restore, keep the process stopped, place
the complete copy at the target managed-data path, run `ambient-agent status`
and `ambient-agent doctor`, and only then run `ambient-agent start`. Never mix
databases or credentials from different snapshots. Issue #58 adds the
independent temporary-home replacement proof for this documented boundary.

Recovery is deliberately local and explicit:

- Missing or rejected ChatGPT authorization: run `ambient-agent auth`.
- Invalid permissions, JSON, SQLite integrity, or WhatsApp registration:
  leave the process stopped and follow the exact `doctor` remediation.
- Uncertain admission or GitHub mutation: inspect it and choose one explicit
  `doctor --retry`, `--accept-observed`, or `--abandon` action.
- Damaged managed data: restore a complete known-good backup; `init` and
  `config` refuse to overwrite it.

The GitHub token and an installation-local webhook signing secret live inside
the private `credentials/github.json` file. Older valid installations receive
the missing webhook secret through one atomic app-owned migration at `start`;
a pre-migration `status` reports that pending step as degraded with the same
remediation. A failed commit leaves the previous credential file intact. ChatGPT OAuth and
WhatsApp session material are likewise app-owned. Ambient Agent never searches
or adopts machine-global Pi credentials.

The health endpoint reports the model authentication mode, selected model,
sanitized WhatsApp runtime phase, and a non-secret installation correlation ID.
No model API-key environment variable is supported.

## Configuration boundaries

`ambient-agent start` reads and validates the managed installation once. It
passes typed configuration, credential, and path dependencies to the generated
composition root; GitHub and WhatsApp runtime modules do not read product
configuration or secrets from `process.env`. The GitHub allowlist bounds every
Issue Management write, the app-owned webhook secret authenticates ingress,
`application.sqlite` owns application facts, and the explicit managed
`flue.sqlite` path owns canonical Agent state. The validated non-secret
`runtime.port` setting selects the local HTTP listener and lets `status`
discover the matching installation without inspecting process state.

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
can afford to lose. Keep managed data and any source-development `.env` or
`.wa-auth*/` directories private. Scope GitHub tokens to the smallest
repository and issue permissions that satisfy the workflow.

## License

[MIT](./LICENSE) © Aaron AbuUsama
