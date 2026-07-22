# Global Scribe clock separates extraction from Brain integration

The Scribe is one application-owned global ingestion clock, not one persistent model
conversation. Live arrival and Historical Replay both produce bounded cross-Surface Scribe
Batches. Bounded concurrent stateless attempts receive a fresh relevant Digest plus lookup,
then append low-Confidence Attestations with trusted Evidence Sets.

Stable logical batch identity and fresh attempt identity make extraction retries idempotent.
The Scribe only proposes: its durable deltas enter the Brain's coalesced up-inbox, where the
one stateful Brain integrates them and may append authoritative rulings. Historical Replay is
complete only after both extraction and the resulting Brain backlog have caught up.

## Rejected

- Per-chat replay, because unprocessed chats cannot contribute to current understanding.
- One serial Scribe model call, because integration belongs to the Brain and should not cap extraction throughput.
- Unbounded extraction followed by one final Brain pass, because it creates an unbounded reconciliation dump.
