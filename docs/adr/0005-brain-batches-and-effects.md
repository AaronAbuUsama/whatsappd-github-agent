# Brain batches settle durable inputs; effects leave through a local outbox

One Brain Batch immutably claims a bounded set of ready up-inbox inputs. New arrivals wait for
the next Batch. Crash recovery reuses the open Batch and exact membership; one local
transaction settles that Batch and exactly its claimed inputs.

The Brain chooses separate typed effects. Trusted application code derives stable effect
identity within the Batch, records asynchronous effects in the application database before
delivery, and returns discriminated receipts. That record is a durable outbox and correlation
point; the receiving Speaker, workflow, Graph, clock, or provider module owns execution.
Delivery into Flue remains at-least-once, matching its public API and the existing admission
contract. Stable application identity makes duplicate wakes harmless at the consumer and at
external mutation boundaries.

Batch settlement reads the application's effect records; the model never echoes generic
receipts back as state. A local effect may complete in its insertion transaction. An
asynchronous effect is accepted when the application owns durable delivery. An ambiguous
provider mutation becomes Uncertain under a reconciliation owner, never a blind retry.

## Rejected

- Cross-database exactly-once Flue admission, because public `dispatch()` and `invoke()` generate their own identifiers.
- One generic effect envelope or workflow engine, because existing modules retain action-specific lifecycle truth.
- Treating Brain prose or conversation history as an effect, deduplication key, or settlement authority.
