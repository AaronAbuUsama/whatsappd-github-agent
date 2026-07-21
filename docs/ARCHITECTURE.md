# Architecture map

> This is the **code taxonomy** — which package owns what. For the definitive
> description of how the agentic system *works* (the Brain, Speakers, the Graph, the
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
  participant AG as agents (Speaker)
  participant FLUE as Flue runtime
  participant GH as GitHub

  WA->>ENG: ConversationEvent → Conversation Archive (append-only)
  ENG->>ENG: Coalescer: one fiber per chatId,<br/>throttle + settle window → Window
  ENG->>AG: WindowDispatcher port → admitWindow (admission, retry, at-least-once)
  AG->>FLUE: dispatchSpeaker (Flue dispatch + activity correlation)
  FLUE->>AG: runs Speaker with mounted capabilities
  AG->>WA: Say / React (whatsapp-participation port)
  AG->>GH: issue operations with Operation Identity (issue-management port)
  FLUE-->>AG: lifecycle observations (dispatchId only)<br/>→ activity reporter re-attaches chat context
```

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
