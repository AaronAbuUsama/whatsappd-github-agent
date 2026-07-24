# Architecture map

> This is the **code taxonomy** — which package owns what. For the definitive
> description of how the agentic system _works_ (the Brain, Speakers, the Graph, the
> Digest, the control loop), see [`SYSTEM-ARCHITECTURE.md`](./SYSTEM-ARCHITECTURE.md).

The ratified taxonomy (#117 → #131): three packages, two apps, one arrow diagram —
enforced, not aspirational (`tests/speaker/hard-cut.test.ts`).

```mermaid
graph TD
  subgraph apps
    CLI["apps/cli<br/>operate the installation"]
    SRV["apps/runtime<br/>Flue build root — hosts Speaker"]
  end
  subgraph packages
    AG["agents<br/>everything that thinks:<br/>agents own identity,<br/>capabilities are shared"]
    INST["installation<br/>on-disk state + lifecycle<br/>of one running install"]
    ENG["engine<br/>agent-agnostic conversation<br/>machinery — imports nothing internal"]
  end
  TS["test-support<br/>fakes + eval battery<br/>(may import anything)"]
  CLI --> INST
  CLI --> ENG
  SRV --> AG
  SRV --> INST
  SRV --> ENG
  AG --> ENG
  INST --> AG
  INST --> ENG
```

**Rules** (verbatim from the hard-cut test): engine → nothing internal; agents → engine;
installation → agents+engine; apps/runtime → all packages; apps/cli → installation+engine
(**never** agents); test-support → anything. Additionally: capabilities may never import
from an agent folder, and no package may publish a `./*` wildcard export.

## How a message becomes work

```mermaid
sequenceDiagram
  participant WA as WhatsApp (whatsappd)
  participant ENG as engine (Coalescer + intake)
  participant SP as agents (Speaker)
  participant SC as agents (global Scribe clock)
  participant BR as agents (global Brain)
  participant FLUE as Flue runtime
  participant DB as engine (Brain + Surface stores)

  WA->>ENG: ConversationEvent → Conversation Archive (append-only)
  ENG->>ENG: Coalescer: one fiber per chatId,<br/>throttle + settle window → Window
  ENG->>DB: admit live or Historical Replay observations<br/>to one durable evidence-keyed Scribe inbox
  DB-->>SC: claim one bounded chronological<br/>cross-Surface Scribe Batch wave
  SC->>FLUE: bounded stateless attempt<br/>stable batchId + fresh attempt id + current Projection
  SC->>DB: append immutable Evidence Set Attestations<br/>refresh derived Belief Projection
  SC->>DB: admit the durable proposal delta<br/>to the Brain up-inbox
  ENG->>SP: WindowDispatcher port → admitWindow (admission, retry, at-least-once)
  SP->>DB: escalate_intent (immutable evidence-backed admission)
  DB->>FLUE: wake one Brain Batch on instance global
  FLUE->>BR: runs the continuing Brain
  BR->>DB: prompt one Surface or record deliberate silence
  BR->>DB: reserve stable Brain work identity
  DB->>FLUE: admit existing bounded Workflow
  FLUE-->>DB: terminal result → durable Brain input
  DB->>FLUE: wake result Batch for Brain reconciliation
  DB->>FLUE: dispatch Directive to the Surface's active Speaker binding
  FLUE->>SP: runs the continuing local Speaker
  SP->>DB: say_directive claims Surface Delivery before transport
  SP->>WA: provider send through whatsapp-participation port
  WA->>ENG: outbound Conversation Archive event
  SP->>DB: durable delivered / failed / Uncertain Outcome
  FLUE-->>SP: lifecycle observations (dispatchId only)<br/>→ Window or Directive correlation
```

The Speaker now mounts conversation, Intent escalation, Directive Saying, a work-status pull tool
(`lookup_work`), and read-only Graph tools only. The Brain owns Coder launch, stable work identity,
Flue admission reconciliation, terminal-result admission, the independent choice of reporting
Surface, GitHub events (admitted to the same up-inbox and routed by Brain decision, never
broadcast), and the proactive clock (Scheduled Wake + coalesced Proactive Sweep). The diagram above
is the replacement path that exists now.

## Where things live — quick answers

- **"Any agent needs this"** → `packages/engine`. Precedent: operation-store and input
  contracts moved down in #131.
- **"A kind of work an agent can do"** → `packages/agents/src/capabilities/<name>/`
  (SKILL.md + tools + port). Shared across agents.
- **"Who an agent is"** → `packages/agents/src/<agent>/` (instructions, composition,
  dispatch).
- **"On-disk state of an install"** → `packages/installation`.
- **Deployables** → `apps/` (cli = operate, server = host). Both are bundled; internal
  packages are compiled in, the server's `package.json` dependency list is the flue-build
  externals manifest.

## Domain vocabulary

`CONTEXT.md` at the repo root is the ratified glossary (Capability, Skill, Window,
Managed Chat, Operation Identity, Uncertain, …). Name things from it; propose additions
there first. For the conceptual system (Brain, Speakers, Graph, Digest, control loop) see
[`SYSTEM-ARCHITECTURE.md`](./SYSTEM-ARCHITECTURE.md).

## Per-package docs

Each workspace has a README: [engine](../packages/engine/README.md) ·
[agents](../packages/agents/README.md) ·
[installation](../packages/installation/README.md) ·
[test-support](../packages/test-support/README.md) ·
[cli](../apps/cli/README.md) · [server](../apps/runtime/README.md)
