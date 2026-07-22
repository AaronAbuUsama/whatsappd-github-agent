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
to converse well in its own room. It may retrieve specific facts, but it holds no global
authority: it never creates issues, launches work, writes the ontology, or decides a
cross-Surface consequence. When conversation warrants global judgment it escalates an
Intent to the Brain. (Sharpens the former per–Managed-Chat "Ambience" instance: now
explicitly a mouth, not the whole.)
_Avoid_: Ambience, the voice, sub-bot, one-to-one assistant

**Surface**:
One place the coworker can listen and speak: a group chat, a DM with one person, or any
future channel. It has stable application identity, exactly one continuing Speaker, and one
current provider binding. Discovery never authorizes participation: configured groups seed
the registry. When the Brain prompts a known Person directly, trusted application code resolves
or materializes an ordinary DM Surface inside that same prompt admission. This is target
resolution, not a second kind of Surface or a separate open-surface action. Generalizes Managed
Chat to any authorized place with a Speaker.
_Avoid_: Channel plumbing, allowed group, Brain-opened Surface

**Surface Binding**:
The active mapping from a Surface to one authenticated provider account and provider chat
identity. Every intake or Say revalidates it; account replacement never silently rebinds it.
_Avoid_: Surface identity, model-supplied chat id, return address

**Surface Delivery**:
The durable application record of one logical Say across its provider boundary: attempting,
sent with provider and Conversation Archive evidence, failed, or Uncertain. Generated Flue ids
and logs are evidence, never its identity.
_Avoid_: Say result log, dispatch receipt, assumed delivery

**Intent**:
An immutable, evidence-backed request from a Speaker for the Brain to exercise global
judgment. It records the originating Surface and the Speaker's bounded interpretation, but
selects neither an action nor a return Surface and is not itself a work item.
_Avoid_: Command, action, task, work item, mutable request

**Intent escalation**:
Durably admitting an Intent to the Brain's up-inbox without waiting for the Brain to decide.
The Speaker remains free to converse locally, but cannot claim that any global action happened.
_Avoid_: Dispatch, delegation, synchronous hand-off

**Brain Batch**:
The immutable set of ready up-inbox inputs claimed for one Brain decision. Inputs arriving
after the claim wait for another Brain Batch. A crash recovers the same Batch and membership;
settlement consumes exactly those inputs in one local transaction.
_Avoid_: Model turn, recomputed window, queue drain

**Brain Effect**:
One semantic consequence chosen while deciding a Brain Batch. Trusted application code gives
it stable identity, records it before asynchronous delivery, and returns a typed receipt. Its
downstream module owns execution; the Brain's effect record is correlation and a durable
outbox, not a second workflow engine.
_Avoid_: Generic command envelope, Flue dispatch id, orchestration job

**Scheduled Wake**:
An independent, durable future prompt for the Brain to reconsider a stated concern. It is identified by the Brain batch effect that scheduled it; a reschedule explicitly cancels the named predecessor and creates a replacement. A Scheduled Wake is admitted to the Brain's up-inbox at least once when due, remains recoverable until that Brain batch settles, and is consumed in the same local settlement transaction. It is never a process timer.
_Avoid_: In-memory timer, global next wake, generic scheduled job

**Proactive Sweep**:
One coalesced liveness input that tells the Brain to inspect the global Belief Projection for open loops. Boot recovery and the deployment cron may request it, but they never decide or speak; one outstanding sweep is enough until the Brain settles it.
_Avoid_: Cron job history, Graph watcher, a second Brain

**Digest**:
A read-projection of the Graph, filtered to what a turn needs, delivered over one
`graphContext` channel at two intensities: mechanical *pull* by default (deterministic
one-hop, no model, no cache, recomputed live every Speaker turn) and deliberate *push* when
the Brain selects extra cross-Surface entity seeds. Trusted code recomputes and merges both
from one Belief Projection version. Same mechanism and bounded payload, two intensities.
_Avoid_: Cache, snapshot, context dump

**Directive**:
An authoritative Brain instruction for a chosen Speaker to communicate an objective. The Brain owns the substance and target; the Speaker must attempt it and owns the local expression.
_Avoid_: Suggested context, final message, Brain speech

**Directive Outcome**:
The durable result returned to the Brain after a Speaker accepts a Directive: delivered with
provider evidence, failed, Uncertain, or failed because the Speaker settled without Saying.
Acceptance alone is never fulfillment.
_Avoid_: Speaker transcript, dispatch receipt, best-effort log

**Brief**:
A Brain-assembled, Directive-specific packet of selected context that names its origins and links each important item to durable source evidence. It may combine source excerpts, provider facts, workflow results, and Graph beliefs; unlike a Digest, it explains this decision rather than ambient memory.
_Avoid_: Second Digest, context dump, unprovenanced summary

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

**Historical Replay**:
The initial reconstruction of the coworker's understanding from archived observations across
all Surfaces, ordered by when the observations occurred and fed through the same
Scribe-to-Brain loop as live ingestion.
_Avoid_: Per-chat backfill, transcript import

**Managed Chat**:
A WhatsApp chat the coworker is explicitly configured to participate in. Events from other chats remain in the Conversation Archive but are not admitted to the coworker, fail-closed.
_Avoid_: Allowed group, whitelisted chat

**Window**:
A lossless group of consecutive chat messages coalesced into one reading, so a busy chat becomes a sequence of digestible readings instead of per-message interruptions. Every accepted live message belongs to exactly one Window.
_Avoid_: Batch, buffer flush, message dump

**Coalescer**:
The per-chat actor that gathers incoming messages into Windows and decides when a Window is ready.

**Surface Inbox**:
The durable processing state for Conversation Events accepted from active Surfaces and
awaiting inclusion in a Window. An accepted event remains pending for the coworker until its
Window is admitted and the admission receipt is recorded.
_Avoid_: Best-effort listener, live queue

**Say**:
The single explicit act of sending a message through the Speaker's bound Surface. Anything
the agent produces without Saying it is private working context.
_Avoid_: Reply, respond, send

### Shared graph

**The Graph**:
The shared, cross-thread memory of the coworker: an append-only Attestation log plus its
derived Belief Projection. Raw sources remain truth; Scribe proposals, deterministic ingester
claims, and Brain rulings remain permanently attributable and never overwrite one another.
_Avoid_: Knowledge base, mutable fact table, GitHub mirror, second transcript

**Scribe**:
The coworker's single, silent, global ingestion arm. Stateless Scribe attempts may run
concurrently to turn cross-Surface Scribe Batches into low-Confidence Attestations; they hold
no memory or authority, and their durable proposals return to the Brain for integration.
_Avoid_: Per-thread Scribe, second mind, logger, second Speaker

**Scribe Batch**:
A bounded, cross-Surface group of raw observations presented to one stateless Scribe attempt
with a fresh relevant Digest and immutable evidence references. It is one extraction context,
not a conversation or an authority boundary.
_Avoid_: Chat window, Scribe memory, ontology transaction

**Attestation**:
An immutable claim by an identified author, carrying that author's Confidence, a non-empty
Evidence Set, and when it was made. Correction or disagreement creates another Attestation;
it never edits an earlier one.
_Avoid_: Graph row, mutable fact, verdict

**Evidence Set**:
The non-empty set of immutable raw-source references that jointly support one Attestation.
_Avoid_: Optional metadata, model-authored source id

**Belief Projection**:
The coworker's current ontology, deterministically folded from Attestations and rebuilt
whenever needed. It is the Graph's read surface, not another source of truth.
_Avoid_: Truth table, mutable Graph, model memory

**Entity**:
A typed node resolved in the Belief Projection — one of Person, Agent, Thread, Topic,
Commitment, Repository, Issue, PullRequest, Project, Milestone, Goal.

**Relation**:
A typed, directed connection between two Entities (for example `discusses`, `made_by`,
`blocks`) represented by claims in the Attestation log and resolved in the Belief Projection.
Every Relation exists to power a named read; facts a raw source already serves fresh are not
Relations.

**Confidence**:
A 0–1 score expressing one author's certainty in one Attestation; the Belief Projection
derives its current confidence without treating repeated use of the same Evidence Set as
independent support.
_Avoid_: Certainty, weight, score (unqualified)

**Provenance**:
The permanent evidence trail from an Attestation back to the raw observations that support
it, represented by its Evidence Set.

**Commitment**:
A *social* fact in the Graph — a person told the group they would do something (status open/done/dropped, made by exactly one Person or Agent, optionally about an Issue, PR, or Topic). Distinct from an Issue: a Commitment is conversational and may never touch GitHub; it may *link* to an Issue but is never the same thing.
_Avoid_: Task, TODO, Issue (when the promise is only spoken)

**Cross-platform identity**:
The rule that one real actor (human or Agent) is a single Entity however many platform handles it has — a WhatsApp sender id and a GitHub login converge on one node via the identities table, keyed so the database itself permits only one owner per external id. That convergence *is* the cross-thread memory.
_Avoid_: Account (as the primary noun), duplicate person

### Agent anatomy

**Conversation lifetime**:
The boundary for retaining an Agent's private working conversation: continuing across activations, fresh per attempt, or limited to one Bounded Workflow run. It never implies ownership of the Graph, queues, or work state.
_Avoid_: Stateful/stateless (without naming the lifetime), state ownership

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

**Surface-bound Tool**:
A Tool permanently scoped to one Surface at construction, so it cannot reach another Surface
regardless of what the model asks.

**Evaluation Scenario**:
A repeatable Surface situation with controlled provider state and observable expected effects,
used to measure the coworker's judgment and Capability use across changes.
_Avoid_: Prompt test, golden response, vibe check

### Work execution

**Bounded Workflow**:
A finite, autonomous unit of work with validated input, its own run record, and a terminal result. It does not pause for human conversation; results, failures, and rare Milestones return up to the Brain, which owns the work's lifecycle.
Every invocation is a fresh run with a fresh Specialist conversation. Follow-up work starts another run from current durable provider state; it never resumes a finished or interrupted run's private conversation.
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
