# Agent conversation lifetime follows each role's job

The Brain has one continuing global Flue conversation. Each Surface has one continuing
Speaker conversation. Scribe extraction uses fresh stateless attempts with all required
context pushed in. Each Bounded Workflow invocation gives its Specialist a fresh finite
conversation; follow-up work starts another run from current durable provider state.

Conversation history is working continuity, not domain truth. The Graph, Conversation
Archive, inboxes, schedules, work records, and provider state remain application- or
provider-owned.

## Rejected

- One continuing Scribe conversation, because it would serialize extraction and hide context in private memory.
- Resuming completed Specialist conversations, because completed workflows are immutable run history.
- Treating the Brain conversation as its queue, clock, or source of truth.
