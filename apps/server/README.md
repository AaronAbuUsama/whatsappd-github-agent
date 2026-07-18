# apps/server — the Speaker server

The Flue build root: the deployable that hosts Speaker. `vp build --root apps/server`
bundles the internal `@ambient-agent/*` packages into the published artifact and
externalizes the dependencies declared in this `package.json` — which is why that
dependency list includes packages this app never imports directly (they are the
externals manifest for the bundled internal packages; fallow knows via
`toolingDependencies` in `.fallowrc.json`).

## Structure — mostly Flue conventions

| File | Convention |
|---|---|
| `src/app.ts` | The app: `createAmbientAgentApp` wires `composeSpeaker` + dispatch + stores + the Octokit repository, reading its dependencies from the `globalThis` slot the CLI installed (`export default await createAmbientAgentApp(getManagedRuntimeDependencies())`). |
| `src/db.ts` | Flue database convention: `export default sqlite(flueDatabasePath())`. |
| `src/agents/speaker.ts` | Flue agent-discovery convention: a deliberate 3-line re-export of `@ambient-agent/agents/speaker/agent.ts` (the real definition lives beside its dispatch — decision T8). Not a duplicate; do not "fix". |
| `src/channels/github.ts` | Flue channel convention (`channel/github@1`): webhook verification, delegates to engine's `handleGitHubDelivery`. |
| `src/host/whatsapp-runtime.ts` | The WhatsApp runtime host: session lifecycle, backoff, the production `WhatsAppOutboundPort` adapter (`createWhatsAppHost` — typing lead, quote lookup, delivery classification), and the smoke canary. |
| `src/host/smoke-route.ts` | The authorized `/smoke` HTTP route. |

## Dependency arrows

Imports all three packages (engine, agents, installation) — the composition root.
Nothing imports it; `apps/cli/src/lifecycle.ts` boots its packed artifact.

## Tested by

`tests/speaker/{db,whatsapp-runtime}.test.ts`, `tests/managed/smoke-route.test.ts`, and
the fixture app `tests/fixtures/speaker/` mirroring this layout.
