# apps/runtime — the tenant runtime server

The published artifact contains two mutually exclusive entry points: the narrow
tenant setup server and the Flue server that hosts Speaker operation. `vp build --root apps/runtime`
builds the operate server; `vp pack` adds the setup server to that same artifact.
Both bundle the internal `@ambient-agent/*` packages, while the Flue build
externalizes the dependencies declared in this `package.json` — which is why that
dependency list includes packages this app never imports directly (they are the
externals manifest for the bundled internal packages; fallow knows via
`toolingDependencies` in `.fallowrc.json`).

## Structure — mostly Flue conventions

| File | Convention |
|---|---|
| `src/setup-server.ts` | The SaaS setup composition root: validates the provisioner environment before serving `dist/cli/setup.js`. |
| `src/setup-app.ts` | The setup-only HTTP surface: health plus authenticated pairing and chat enumeration. |
| `src/app.ts` | The unchanged operate app: reads CLI-installed managed dependencies and wires `composeSpeaker` + dispatch + stores + the Octokit repository. |
| `src/db.ts` | Flue database convention: `export default sqlite(flueDatabasePath())`. |
| `src/agents/speaker.ts` | Flue agent-discovery convention: a deliberate 3-line re-export of `@ambient-agent/agents/speaker/agent.ts` (the real definition lives beside its dispatch — decision T8). Not a duplicate; do not "fix". |
| `src/channels/github.ts` | Flue channel convention (`channel/github@1`): webhook verification, delegates to engine's `handleGitHubDelivery`. |
| `src/host/whatsapp-setup-runtime.ts` | One setup-only WhatsApp account that still journals observed events, with no Managed Chat inbox, Coalescer, Speaker, GitHub, model, or stdout pairing material. |
| `src/host/whatsapp-runtime.ts` | The WhatsApp runtime host: session lifecycle, backoff, the production `WhatsAppOutboundPort` adapter (`createWhatsAppHost` — typing lead, quote lookup, delivery classification), and the smoke canary. |
| `src/host/smoke-route.ts` | The authorized `/smoke` HTTP route. |

## Dependency arrows

`apps/cli/src/lifecycle.ts` installs typed dependencies before importing the
Flue operate server. The SaaS provisioner selects `node dist/cli/setup.js`
before any operate module is imported, so setup never initializes Flue agents,
workflows, channels, or model composition. Activation and repair restart the
same tenant application with the other entry point; they do not add a supervisor.

## Tested by

`tests/speaker/{db,whatsapp-runtime}.test.ts`, `tests/managed/{runtime-profile,smoke-route}.test.ts`,
and the fixture app `tests/fixtures/speaker/` mirroring this layout.
