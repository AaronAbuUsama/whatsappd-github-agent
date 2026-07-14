# Ambient Agent

An ambient participant in group conversation that helps a team turn software-development intent into durable, coordinated work. It begins with issue management and grows by adding capabilities toward broader software delivery.

## Language

**Ambient Agent**:
The product and the architectural pattern it embodies: an agent that participates in ongoing group conversation, processes the shared context, and decides when speaking or acting would help without requiring a direct invocation.
_Avoid_: Bot, chatbot, one-to-one assistant

**Ambience**:
The proper name of this project's Ambient Agent — one continuing instance per Managed Chat. It is an application-defined agent, not a framework primitive.
_Avoid_: "Flue Ambience" (implies Ambience is part of Flue), the voice

**Capability**:
A cohesive kind of work the Ambient Agent can perform for the group. Capabilities are the canonical way the product grows.
_Avoid_: Feature module, plugin

**Issue Management**:
The capability that turns bug reports and feature requests into well-formed, maintained GitHub issues and their discussion. It may assign existing labels, assignees, and milestones; creating or administering those structures belongs to Planning.
_Avoid_: Issue proof, GitHub proof, proof-only issue path

**WhatsApp Participation**:
The capability through which Ambience participates in Managed Chats. Its Skill guides group-chat behavior, while its Chat-bound Tools provide conversation history and Say.
_Avoid_: Channel plumbing, WhatsApp bot

### Conversation surface

**Conversation Archive**:
The append-only journal of Conversation Events observed by or sent through a configured WhatsApp account, across all chats whether or not Ambience currently participates in them. Stable WhatsApp identity keeps those events available for later cross-chat and cross-thread capabilities.
_Avoid_: Managed-chat history, mutable transcript, listener log

**Conversation Event**:
An immutable, normalized fact about a WhatsApp message: its arrival, edit, revocation, reaction, or delivery receipt. Later facts supersede earlier state in projections but never erase the original fact.
_Avoid_: Database row, raw provider event, message snapshot

**Managed Chat**:
A WhatsApp chat the Ambient Agent is explicitly configured to participate in. All other chats are ignored, fail-closed.
_Avoid_: Allowed group, whitelisted chat

**Window**:
A lossless group of consecutive chat messages coalesced into one reading, so a busy chat becomes a sequence of digestible readings instead of per-message interruptions. Every accepted live message belongs to exactly one Window.
_Avoid_: Batch, buffer flush, message dump

**Coalescer**:
The per-chat actor that gathers incoming messages into Windows and decides when a Window is ready.

**Managed Chat Inbox**:
The durable processing state for Conversation Events accepted from Managed Chats and awaiting inclusion in a Window. An accepted event remains pending for Ambience until its Window is admitted and the admission receipt is recorded.
_Avoid_: Best-effort listener, live queue

**Say**:
The single explicit act of sending a message to a Managed Chat. Anything the agent produces without Saying it is private working context.
_Avoid_: Reply, respond, send

### Agent anatomy

**Instructions**:
The agent's identity and standing constraints — who it is. Short and stable.

**Skill**:
A named, versionable packet of process and policy — how the agent approaches a kind of work (when to speak, how to run an intake). Skills guide; they grant no new abilities.
_Avoid_: Prompt, persona file

**Action**:
A reusable, validated, agent-backed operation that a Capability may expose to the Ambient Agent or bind into a Bounded Workflow. An Action runs with its own child harness; direct application functions remain Tools.
_Avoid_: Workflow (when no independent run is needed), Tool (when agent-backed work is required)

**Tool**:
A typed direct application function the agent can act with. Tools do; they carry no judgment or agent-backed process.

**Chat-bound Tool**:
A Tool permanently scoped to one Managed Chat at construction, so it cannot reach another chat regardless of what the model asks.

**Evaluation Scenario**:
A repeatable Managed Chat situation with controlled provider state and observable expected effects, used to measure the Ambient Agent's judgment and Capability use across changes.
_Avoid_: Prompt test, golden response, vibe check

### Work execution

**Bounded Workflow**:
A finite, autonomous unit of work with validated input, its own run record, and a terminal result. It does not pause for human conversation; results, failures, and rare Milestones return to the Ambient Agent.
_Avoid_: Interactive workflow, suspended conversation

**Specialist**:
The narrowly-instructed agent that works inside one Bounded Workflow.
_Avoid_: Worker, sub-bot

**Admission**:
Accepting work for processing — an input into the Ambient Agent, or a Bounded Workflow run for execution. Admission returns a receipt immediately; it never waits for the work.
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
