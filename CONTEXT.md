# CONTEXT — the coworker's ubiquitous language

The vocabulary used throughout the product and code. The canonical *conceptual* description
is [`docs/SYSTEM-ARCHITECTURE.md`](docs/SYSTEM-ARCHITECTURE.md); this file is its glossary.
Where that document sharpens a term, its §12 says so — those sharpenings are ratified here.

> Reset note: the ratified glossary is still being finalized (the domain-modeling pass is a
> deferred design step — see [`STATUS.md`](STATUS.md)). This file already reflects the coworker
> frame; deeper terms may still be sharpened.

## The coworker

**The Coworker**:
The whole system as one felt identity — the colleague a team talks to, with one name, one
memory (the Graph), and one point of view across every Surface. It is multi-agent under the
hood and one agent in the felt experience. *No single part is "the coworker"* — in
particular the Brain is the coworker's mind, not the coworker.
_Avoid_: Bot, chatbot, one-to-one assistant, "the agent" (for a single per-chat instance)

**The Brain** (Master Agent):
The single global mind, owner, and decider — exactly one, process-wide. Silent (bound to no
Surface, owns no chat) but not passive: it owns the Graph, runs the control loop off every
hot path, runs on two clocks, owns all work, and chooses the Surface and voice for every
utterance.
_Avoid_: Orchestrator (implies it only routes), the coworker (it is the mind, not the whole)

**Speaker**:
A local, fast, reactive conversational agent bound to exactly one Surface. Its whole job is
to converse well in its own room; it is *dumb about the wider world* — it never creates
issues, launches work, or writes the ontology. When conversation implies work or a
cross-surface consequence it escalates an Intent up to the Brain. (Sharpens the former
per–Managed-Chat "Ambience" instance: now explicitly a mouth, not the whole, and explicitly dumb.)
_Avoid_: Ambience, the voice, sub-bot, one-to-one assistant

**Surface**:
One place the coworker can listen and speak: a group chat, a DM with one person, or any
future channel. Each Surface has exactly one Speaker. Surfaces are a registry the Brain
grows — it can open a Surface (start a DM) and speak through a freshly-bound Speaker.
Generalizes Managed Chat to any place with a Speaker.
_Avoid_: Channel plumbing, allowed group

**Intent escalation**:
A Speaker signalling the Brain that conversation implies work or a cross-surface
consequence, *without acting on it*. The one seam that keeps Speakers dumb: an upward signal
in place of a direct tool call.
_Avoid_: Command, dispatch (the Speaker does neither)

**Digest**:
A read-projection of the Graph, filtered to what a turn needs, delivered over one
`graphContext` channel at two intensities: mechanical *pull* by default (deterministic
one-hop, no model, no cache, recomputed live every Speaker turn) and deliberate *push* when
the Brain attaches a richer cross-surface projection. Same mechanism, two intensities.
_Avoid_: Cache, snapshot, context dump

**Capability**:
A cohesive kind of work the coworker can perform. Capabilities are a canonical way the
product grows.
_Avoid_: Feature module, plugin

**Issue Management**:
The capability that turns bug reports and feature requests into well-formed, maintained GitHub issues and their discussion. It may assign existing labels, assignees, and milestones; creating or administering those structures belongs to Planning.
_Avoid_: Issue proof, GitHub proof, proof-only issue path

### Conversation surface

**Conversation Archive**:
The append-only journal of Conversation Events observed by or sent through a configured WhatsApp account, across all chats whether or not the coworker currently participates in them. Stable WhatsApp identity keeps those events available for later cross-chat and cross-thread capabilities.
_Avoid_: Managed-chat history, mutable transcript, listener log

**Conversation Event**:
An immutable, normalized fact about a WhatsApp message: its arrival, edit, revocation, reaction, or delivery receipt. Later facts supersede earlier state in projections but never erase the original fact.
_Avoid_: Database row, raw provider event, message snapshot

**Managed Chat**:
A WhatsApp chat the coworker is explicitly configured to participate in. Events from other chats remain in the Conversation Archive but are not admitted to the coworker, fail-closed.
_Avoid_: Allowed group, whitelisted chat

**Window**:
A lossless group of consecutive chat messages coalesced into one reading, so a busy chat becomes a sequence of digestible readings instead of per-message interruptions. Every accepted live message belongs to exactly one Window.
_Avoid_: Batch, buffer flush, message dump

**Coalescer**:
The per-chat actor that gathers incoming messages into Windows and decides when a Window is ready.

**Managed Chat Inbox**:
The durable processing state for Conversation Events accepted from Managed Chats and awaiting inclusion in a Window. An accepted event remains pending for the coworker until its Window is admitted and the admission receipt is recorded.
_Avoid_: Best-effort listener, live queue

**Say**:
The single explicit act of sending a message to a Managed Chat. Anything the agent produces without Saying it is private working context.
_Avoid_: Reply, respond, send

### Shared graph

**The Graph**:
The shared, cross-thread, cross-agent memory of the multi-agent suite — a typed knowledge graph in `application.sqlite`, beside the Conversation Archive. A *derived-meaning layer* above two raw sources (the Conversation Archive locally, GitHub remotely), never a store of truth and never a mirror of either. It holds only what agents need cheaply that those layers can't answer: who is who across platforms, what connects to what, and the social facts GitHub never records. The Scribe *proposes* to it (low-Confidence, provenanced writes); the Brain *owns and curates* it (the single authority — confirm, merge, promote, overwrite); the Digest *reads* it live for each Speaker turn.
_Avoid_: Knowledge base, cache, GitHub mirror, second transcript

**Scribe**:
The coworker's single, silent, *global* ingestion clock. It reads the fact-stream from all Surfaces through one shared Coalescer, batches it, and on each settled batch proposes Entities and Relations as low-Confidence facts, each tagged with its Provenance. It never speaks and holds no external identity; it writes *proposals*, not verdicts — the Brain owns curation. It records *honestly* rather than *certainly*: an ambiguity it cannot resolve at write time becomes a low-Confidence fact, not a blocked write. (Sharpened from the former silent *per-thread* agent; scope is now system-wide.)
_Avoid_: Extractor, indexer, logger, second Speaker

**Entity**:
A typed node in the Graph — one of Person, Agent, Thread, Topic, Commitment, Repository, Issue, PullRequest, Project, Milestone, Goal. Carries typed properties, a Confidence, and Provenance.

**Relation**:
A typed, directed edge between two Entities (e.g. `discusses`, `made_by`, `blocks`). An edge is a single fact, stated once; restating it updates its Confidence. Every relation exists to power a named consumer query — facts GitHub already serves fresh are not edges.

**Confidence**:
A 0–1 score on every Entity and Relation recording how sure the Scribe is of a derived fact. The Graph is deliberately tentative: an uncertain memory is not a hazard but a question the Speaker may raise in conversation, and the answer raises the Confidence.
_Avoid_: Certainty, weight, score (unqualified)

**Provenance**:
The pointer from a Graph row back to the raw fact that produced it — a Conversation Archive message (`source_chat_id`, `source_message_id`) or a GitHub webhook delivery (`source_delivery_id`). The Graph derives; provenance keeps the derivation traceable to its source.

**Commitment**:
A *social* fact in the Graph — a person told the group they would do something (status open/done/dropped, made by exactly one Person or Agent, optionally about an Issue, PR, or Topic). Distinct from an Issue: a Commitment is conversational and may never touch GitHub; it may *link* to an Issue but is never the same thing.
_Avoid_: Task, TODO, Issue (when the promise is only spoken)

**Cross-platform identity**:
The rule that one real actor (human or Agent) is a single Entity however many platform handles it has — a WhatsApp sender id and a GitHub login converge on one node via the identities table, keyed so the database itself permits only one owner per external id. That convergence *is* the cross-thread memory.
_Avoid_: Account (as the primary noun), duplicate person

### Agent anatomy

**Instructions**:
The agent's identity and standing constraints — who it is. Short and stable.

**Skill**:
A named, versionable packet of process and policy — how the agent approaches a kind of work (when to speak, how to run an intake). Skills guide; they grant no new abilities.
_Avoid_: Prompt, persona file

**Action**:
A reusable, validated, agent-backed operation that a Capability may expose to the coworker or bind into a Bounded Workflow. An Action runs with its own child harness; direct application functions remain Tools.
_Avoid_: Workflow (when no independent run is needed), Tool (when agent-backed work is required)

**Tool**:
A typed direct application function the agent can act with. Tools do; they carry no judgment or agent-backed process.

**Chat-bound Tool**:
A Tool permanently scoped to one Managed Chat at construction, so it cannot reach another chat regardless of what the model asks.

**Evaluation Scenario**:
A repeatable Managed Chat situation with controlled provider state and observable expected effects, used to measure the coworker's judgment and Capability use across changes.
_Avoid_: Prompt test, golden response, vibe check

### Work execution

**Bounded Workflow**:
A finite, autonomous unit of work with validated input, its own run record, and a terminal result. It does not pause for human conversation; results, failures, and rare Milestones return up to the Brain, which owns the work's lifecycle.
_Avoid_: Interactive workflow, suspended conversation

**Specialist**:
The narrowly-instructed agent that works inside one Bounded Workflow.
_Avoid_: Worker, sub-bot

**Admission**:
Accepting work for processing — an input into the Brain's up-inbox, or a Bounded Workflow run for execution. Admission returns a receipt immediately; it never waits for the work.
_Avoid_: Doorway (Eve-era term for a wake-up problem that no longer exists)

**Operation Identity**:
The stable, application-owned identity of one external mutation, queried at the provider before any retry decision. A lost response is never grounds to repeat a mutation.
_Avoid_: Idempotency key, dedup token

**Durably Terminal**:
A run state the durable store confirms is finished, completed or failed. The precondition for telling a chat about an outcome.

**Uncertain**:
An outcome where a mutation may or may not have taken effect and observation could not resolve it. Surfaced honestly as its own state; never papered over by a retry.

**Reconciliation**:
The bounded read that tries to resolve an Uncertain outcome by observing provider state through the Operation Identity. An integrity read, never a retry of the mutation.

**Milestone**:
A rare, domain-significant progress fact a Bounded Workflow explicitly tells its chat mid-run (a PR opened, tests green, blocked). Distinct from telemetry, which never enters the conversation.
_Avoid_: Progress event, status update
