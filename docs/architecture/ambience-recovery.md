# Ambience recovery boundaries

> Historical baseline: this document describes the shipped hard-cut recovery surface before the Ambient Agent stable-base rollout. The target replaces the best-effort pre-dispatch gap with the durable Managed Chat Inbox and Admission Relay in [ambient-agent.md](./ambient-agent.md) and ADR 0006; the proof below remains evidence for the Flue and GitHub behavior already demonstrated.

Ambience uses Flue's canonical conversation stream and submission coordinator;
it does not maintain an application transcript, cursor, queue, or replay loop.
Finite workflows use Flue run records, while GitHub mutation integrity remains
owned by the bounded GitHub operation and its stable operation marker.

## Ownership

| State | Owner | Recovery rule |
| --- | --- | --- |
| Accepted Ambience input and per-chat ordering | Flue agent submission store | A replacement Node process reclaims an expired submission lease. |
| Ambience model and tool context | Flue canonical conversation stream | Rebuild the same `chatId` instance from canonical records; reuse completed output and tool results. |
| Finite workflow input, events, and result | Flue run and event-stream stores | Terminal runs remain terminal and inspectable. An interrupted Node workflow remains inspectable as `active`; arbitrary TypeScript is not resumed. |
| GitHub mutation identity and observed state | Bounded GitHub operation | Query by the unique `operationId` marker or exact issue identity before any retry decision. Never repeat a mutation merely because its response was lost. |
| Workflow result routing to Ambience | Application workflow boundary | Normal completion dispatches one structured event. There is no poller or result-copy ledger that manufactures a missing delivery after a crash. |

The SQLite adapter proves same-host process replacement. It does not prove host
loss, active-active ownership, or horizontal failover. Exactly one live Node
process may own a given Ambience instance.

## Proof table

| Interruption or outcome | Persisted | Recovered or reconciled | Decision |
| --- | --- | --- | --- |
| Process stops after an Ambience input is accepted and applied, before provider output | Submission, input marker, and canonical chat stream | Replacement process rebuilds the same `chatId` context and completes the turn when replay is safe | Supported by Flue; no application replay code |
| Process restarts after a settled Ambience turn | Canonical user, assistant, and tool records | Later input sees the same private working context | Supported by Flue |
| Process stops while a finite Node workflow is active | Run ID, validated input, and events written before interruption | Run remains inspectable as `active`; the workflow function and its in-memory specialist are not resumed | Intentionally unsupported automatic resume; report the interrupted run honestly |
| Process restarts after a terminal workflow result | Terminal run result and event stream | Same result remains inspectable; the workflow is not executed again | Supported inspection; no mutation replay |
| GitHub create response times out after the issue was created | Operation ID and stable issue-body marker | One marker query observes the issue, then exact state is read before close | Reconciled success; the create call is not repeated |
| GitHub create response times out and marker query observes no issue | Operation ID and the failed observation | Structured `uncertain` result; no close and no create retry | Visible uncertainty; a later bounded decision must query again before retry |
| GitHub close response times out | Exact issue number and operation marker | Read the exact issue once; closed means reconciled success, open or unreadable remains uncertain | No blind close retry |
| Process stops after terminal run persistence but before result-event admission | Terminal run remains inspectable | Flue does not replay application interceptor code | Visible delivery gap; do not add a polling/result-copy layer to disguise it |
| Process stops with an unresolved external tool call in an Ambience turn | Canonical interrupted-tool evidence | Flue does not automatically repeat an effect whose outcome is unknown | Reconcile at the owning provider boundary or require human confirmation |

## Retry boundary

An interrupted workflow is never "continued" by starting another invocation.
A new run is a new bounded decision. Before that decision, the application or a
human must inspect the prior run and reconcile every possibly-started external
effect using its stable provider identity. Only an observation proving that the
effect did not occur can make a retry eligible.

These constraints preserve the architecture record in issue #25: Flue remains
the agentic harness, Ambience remains one continuing instance per `chatId`, and
application code does not grow another queue, poller, transcript, result-copy
layer, assistant-output parser, or custom agent harness.
