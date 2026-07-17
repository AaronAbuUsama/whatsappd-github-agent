# T6 — `composeAmbience(adapters)`: the core public surface (C2)

Type: `wayfinder:grilling` (HITL — this signature IS `packages/core`'s export; worth one grill)
Blocked-by: — (frontier; but its *implementation* should land after T4 decides what flows through the coalescer wiring)
Blocks: C5 (the monorepo cut consumes this as core's API)

## Question

What is the signature of the single composition function both production and fixture
call — which adapters are parameters, and does it also own the coalescer stack?

## Problem in code

Two hand-wired composition roots have already drifted. Production
([src/app.ts:21-55](../../../src/app.ts)) wires: ChatGPT subscription →
`installGitHubIngressRuntime` (settings built inline) →
`configureIssueManagementRuntime` (real Octokit + SQLite ops + policy) → Hono `/health`
→ `flue()`. The fixture ([tests/fixtures/ambience/src/app.ts:176-223](../../../tests/fixtures/ambience/src/app.ts))
wires the same subsystems with fakes — but ALSO spins the Effect coalescer stack that
production wires elsewhere (`runWhatsAppSession`, `src/host/whatsapp-runtime.ts:84-108`),
plus test seams (`failAfterFlueAcceptance`, `loadGitHubIngressSettings(process.env)`):

```ts
// production, src/app.ts:28-43 (gist)
installGitHubIngressRuntime({ webhookSecret, databasePath, routes }, dispatch);
configureIssueManagementRuntime({ repository: createOctokitIssueRepository(token), operations, policy });

// fixture, tests/fixtures/ambience/src/app.ts:181-196 (gist)
configureIssueManagementRuntime({ repository: fakeIssues, operations, policy });
installGitHubIngressRuntime(loadGitHubIngressSettings(process.env), dispatch);
configureWhatsAppParticipationPort({ say: fakeWhatsApp.say, readThread, search });
// + Effect.runFork(Coalescer.run.pipe(Effect.provide(Layer.mergeAll(...))))  ← production has this in host/
```

The 302-line fixture is the most drift-prone file in the repo; every subsystem added to
production must be re-wired there by hand or silently diverge.

## Blast radius

`src/app.ts`, the fixture app, `runWhatsAppSession`'s port wiring; downstream, this
becomes the one thing `packages/{cli,server}` and the future frontend import from core.
The imperative singleton installers (`installGitHubIngressRuntime`,
`configureIssueManagementRuntime`, `configureWhatsAppParticipationPort`) stay as-is
inside it — C1 makes them bundle-safe; this ticket only centralizes who calls them.

## Options

**O1 — adapters-in, Hono-app-out; coalescer stays outside:**

```ts
export interface AmbienceAdapters {
  issues: IssueRepository;                    // Octokit | fake
  operations: IssueOperationStore;
  policy: IssueManagementPolicy;
  ingress: { settings: GitHubIngressSettings; dispatch: AmbienceDispatch };
  participation?: WhatsAppParticipationPort;  // real host wires its own later | fake wires now
  health?: () => HealthReport;                // subscription/runtime probes differ per caller
}
export const composeAmbience = (adapters: AmbienceAdapters): Hono;
```
Production passes real adapters + defers participation to `runWhatsAppSession`; fixture
passes fakes + keeps its own coalescer fork (with test debounce/seams). Smallest
change; coalescer wiring stays duplicated between fixture and host.

**O2 — O1 + core also owns the coalescer stack (`composeAmbience` takes
`coalescer?: { source, dispatcher-wrap, config }` and runs the Effect stack):** kills
the remaining duplication and hands the frontend one entry point, but pulls
Effect-layer wiring into the core surface and entangles with T4's event-type widening —
bigger, and the fixture's injected-failure seam must become a supported option.

**O3 — status quo + a drift test** (fixture asserts it wires the same subsystem list):
cheap but keeps double maintenance forever; fails the "core a frontend can consume"
mission.

## Grading

| | O1 app-only | O2 + coalescer | O3 drift test |
|---|---|---|---|
| Floor-first | core export ships now | ships later, bigger | ships nothing |
| Reversibility | high (O2 can follow) | medium | high |
| Blast radius | 2 composition roots | + host/fixture coalescer wiring | 1 test |
| Correctness | fixture keeps real seams | seams must be re-exposed | drift still possible |
| Parallelizable | independent of T4 | serialized behind T4 | — |
| Fit | matches C2 finding | overshoots into C5 | anti-mission |

**Recommendation: O1** now, with O2 explicitly deferred to the C5 cut (fog: "C5 cut
mechanics"). It's reversible layering: O2 is additive on top of O1.

## Resolution (Aaron, 2026-07-16)

**O1 ratified** (after an in-chat zoom-out of both composition roots + callers):
`composeAmbience(adapters)` covers subsystems + Hono app only; the coalescer stack
stays in `runWhatsAppSession` (production) and the fixture's fork (tests); O2 layers
on at the C5 cut. CLOSED.
