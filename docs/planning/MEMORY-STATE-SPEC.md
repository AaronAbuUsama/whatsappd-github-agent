# Spec: Memory & state — the shared graph and the agents around it

**Status:** Ratified design, assembled 2026-07-17. Spec only — the graph store and
everything on it is still unbuilt. Building happens as ordinary issue work in the
**Memory & state** milestone (milestone 7); this document is the narrative those
issues are cut from.

**Assembles:** the closed decision tickets of map [#132](https://github.com/AaronAbuUsama/ambient-agent/issues/132):
roster [#133](https://github.com/AaronAbuUsama/ambient-agent/issues/133),
identity mechanics [#134](https://github.com/AaronAbuUsama/ambient-agent/issues/134),
identity model [#135](https://github.com/AaronAbuUsama/ambient-agent/issues/135),
Coder shape [#136](https://github.com/AaronAbuUsama/ambient-agent/issues/136),
skill standard [#137](https://github.com/AaronAbuUsama/ambient-agent/issues/137),
ontology schema [#140](https://github.com/AaronAbuUsama/ambient-agent/issues/140),
Scribe design [#141](https://github.com/AaronAbuUsama/ambient-agent/issues/141),
state injection [#142](https://github.com/AaronAbuUsama/ambient-agent/issues/142),
Worker contract [#143](https://github.com/AaronAbuUsama/ambient-agent/issues/143),
broadcast fan-out [#144](https://github.com/AaronAbuUsama/ambient-agent/issues/144),
commitment lifecycle [#146](https://github.com/AaronAbuUsama/ambient-agent/issues/146),
Scribe cadence [#149](https://github.com/AaronAbuUsama/ambient-agent/issues/149).
Delivery of Worker results defers to [ADR 0001](../adr/0001-workflow-result-delivery.md).
The ubiquitous-language entries for this arm (The Graph, Scribe, Entity, Relation,
Confidence, Provenance, Commitment, Cross-platform identity) land in `CONTEXT.md` via
[PR #148](https://github.com/AaronAbuUsama/ambient-agent/pull/148) — this spec uses
that vocabulary and does not restate it.

**Scope note — the memory & state arm only.** The Reviewer workflow shape
([#147](https://github.com/AaronAbuUsama/ambient-agent/issues/147)) is a **suite**
decision, not a memory & state one — it was ratified in parallel (the standalone
Reviewer: a PR opens, it runs, posts a verdict under `reviewer[bot]`, owns no loop).
It consumes the same Worker contract and identity model the Coder does, so nothing
here waits on it; where the Reviewer would slot in, this spec points at the Coder
template ([#136](https://github.com/AaronAbuUsama/ambient-agent/issues/136)) it
inherits and moves on. Its implementation issue (a sibling of #158) is suite build
work, out of scope for this spec.

---

## 1. The shape, in one picture

Two agents run **per WhatsApp thread** — the **Speaker** (talks) and the **Scribe**
(never talks, only writes the graph). Three **Workers** — Coder, Reviewer, Planner —
are workflow-wrapped agents launched on demand, each its own GitHub App identity,
each returning its result as an input. One **shared graph** in `application.sqlite`
is the only cross-thread, cross-agent memory. GitHub events **broadcast** to every
thread; each Speaker judges relevance itself.

```mermaid
flowchart TB
  subgraph ingress["GitHub webhooks"]
    GH["issues / pull_request events"]
  end

  subgraph threadA["Thread A"]
    SPKA["Speaker A<br/>(talks · reads graph)"]
    SCRA["Scribe A<br/>(silent · writes graph)"]
  end
  subgraph threadB["Thread B"]
    SPKB["Speaker B"]
    SCRB["Scribe B"]
  end

  WA["WhatsApp windows"] --> FUNNEL{{"dispatchSpeaker funnel<br/>(digest attached here)"}}
  GH -.->|broadcast to every thread| FUNNEL
  FUNNEL --> SPKA
  FUNNEL -->|detached, debounced| SCRA
  FUNNEL --> SPKB
  FUNNEL -->|detached, debounced| SCRB

  GRAPH[("the graph<br/>graph_entities · graph_relations · graph_identities<br/>application.sqlite")]
  SCRA -->|record_entity / record_relation / merge_entities| GRAPH
  SCRB --> GRAPH
  GRAPH -->|buildGraphDigest · lookup_graph| SPKA
  GRAPH --> SPKB
  SPKA -->|record_entity / merge_entities<br/>confirmed resolutions only| GRAPH

  subgraph workers["Workers (workflow-wrapped, own GitHub App each)"]
    CODER["Coder"]
    REV["Reviewer (#147)"]
    PLAN["Planner"]
  end
  SPKA -->|start_coder_job(invoke) → runId| CODER
  CODER -->|acts on GitHub under its App| GH
  CODER -.->|worker.result via ADR 0001<br/>instrument() durable-gated bridge| FUNNEL
  GRAPH -->|pushed digest + lookup_graph, read-only| CODER
```

Key properties the picture encodes:

- **The funnel is the one seam.** WhatsApp windows, broadcast GitHub events, and
  `worker.result` all arrive at `dispatchSpeaker` (today `dispatchAmbience`,
  `packages/agents/src/ambience/dispatch.ts:19`). Both the digest computation and
  the Scribe fan-out live there, so both agents see the whole input stream by
  construction.
- **The Scribe never blocks the Speaker.** Its fan-out is detached
  (`void dispatchScribe(...).catch`) and runs *after* the Speaker's receipt.
- **The graph is unwelded from routing.** Broadcast does zero graph queries; the
  graph is purely the knowledge base.

---

## 2. The roster (#133)

Five named agents in two run modes, connected only by the shared graph.

| Agent | Run mode | Talks? | GitHub identity | Responsibility |
|---|---|---|---|---|
| **Speaker** | Continuing per-thread instance (`dispatch`, durable transcript) | Yes | Shares the **Planner** App for inline issue-filing (§7) | Manages one thread and responds. Talk/stay-silent per window. Quick inline actions; launches Workers for real work, never blocks. Replaces "Ambience". |
| **Scribe** | Continuing per-thread instance, same input stream, debounced | Never | None | Extracts ontology into the graph. Its only tools write/read the graph. |
| **Coder** | Workflow-wrapped (`defineWorkflow({ agent })`, fresh context per run) | Via GitHub | Own App (`github-coder.json`) | Long-running implementation → PR. |
| **Reviewer** | Workflow-wrapped | Via GitHub | Own App (`github-reviewer.json`) | Reviews PRs; its approval counts (§7). Standalone-Reviewer shape ratified in #147. |
| **Planner** | Workflow-wrapped | Via GitHub | Own App (`github-planner.json`) | Label/milestone administration & planning Issue Management defers. |

**Two run modes, grounded in Flue.** *Continuing* agents (Speaker, Scribe) own a
canonical conversation stream, namespaced by `(agent, id=chatId)`, rebuilt as
context every dispatch. *Workflow-wrapped* agents (the Workers) get a fresh `runId`
and fresh state per `invoke()`, return a validated result, and end; their long-term
memory is the graph plus GitHub itself, never an accumulated transcript.

> **Record reconciliation — the Speaker *does* hold an identity.** #133's table said
> "Scribe/Speaker need no GitHub identity." #135 refined this: the Speaker's inline
> issue-filing authenticates as **`planner[bot]`** (filing/labels/milestones *is* the
> planning domain), so the Speaker shares the Planner App. The Scribe still needs
> none — it writes only the graph. **Three Apps total.** #135 supersedes #133's
> "no identity" phrasing for the Speaker.

---

## 3. The graph — ontology & SQLite shape (#140)

### Principle

The graph is a **derived-meaning layer above raw sources, not a store of truth.** Two
raw layers sit beneath it — the Conversation Archive locally
(`conversation_messages`) and GitHub remotely — and the graph holds only what agents
need cheaply that those layers can't answer: *who is who across platforms, what
connects to what, and the social facts GitHub never records.* It is **not** a GitHub
mirror and **not** a second conversation store.

Everything the graph asserts is **tentative**: every entity and relation carries a
`confidence` score. Because the Speaker can speak whenever useful, an uncertain
memory is not a hazard — it is a question the agent can raise, and the answer raises
the confidence. The medium self-corrects.

### Entities (11)

**Person, Agent, Thread, Topic, Commitment, Repository, Issue, PullRequest, Project,
Milestone, Goal.** Every row carries `confidence` + provenance
(`source_chat_id`/`source_message_id` into the archive, or `source_delivery_id` into
`github_ingress_deliveries`).

- **No `Message` entity** (Q1) — the Conversation Archive
  (`packages/engine/src/intake/conversation-archive.ts`, `conversation_messages`) is
  the raw message layer; the graph never duplicates it.
- **GitHub nodes cache identity + a small advisory summary only** (Q3): `title`,
  `state`, `cached_at` — enough to render context and to match on, never a body or
  label mirror. Full/fresh detail is always a live tool call. **Freshness is
  agent-driven** — the Scribe sees `issues.closed` as an input and updates the cached
  fields itself; there is no sync program.
- **Goal is ours** — it exists nowhere in GitHub.

### Relations (11), earned edges only

Every relation exists because a *named consumer query* needs it; anything GitHub
serves fresh (assignees, authors, `Issue→Repository` containment) stays out.

| relation | from → to | constraint | powers |
|---|---|---|---|
| `participates_in` | Person/Agent → Thread | many↔many | who's here |
| `interested_in` | Person/Agent → Topic/Repository/Issue/PR/Goal | many↔many | proactive context |
| `discusses` | Thread → Topic/Issue/PR/Repository/Milestone/Project/Goal | many↔many | proactive-context signal (see reconciliation) |
| `mentions` | Thread → any | many↔many | weak reference |
| `works_on` | Person/Agent → Issue/PR/Project/Goal | many↔many | who-does-what, cross-source |
| `made_by` | Commitment → Person/Agent | **exactly one** | a promise has an owner |
| `about` | Commitment → Issue/PR/Topic | 0..n | promise ↔ work |
| `resolves` | PR → Issue | many↔many | "the fix for what you reported is in review" |
| `part_of` | Issue/PR → Milestone/Project; Milestone → Project | many→one / many↔many | roll-ups |
| `blocks` | Issue/PR → Issue/PR | **acyclic** | dependency questions |
| `advances` | Issue/PR/Milestone/Project → Goal | many↔many | Goal is ours |

> **Record reconciliation — `discusses` is context signal, not a router.** #140/#141
> called `discusses` "the fan-out edge." #144 (§6) **unwelds routing from the graph**:
> fan-out is broadcast and does *zero* graph queries. So `discusses`/`interested_in`
> are proactive-context signal only (they feed the Speaker's digest, §5) — never a
> routing trigger. The vocabulary is unchanged; only its consumer is.

### SQLite shape (Q6) — generic pair, typed at the tool boundary

Every hot query is a **one-hop edge-walk** (fan-out is gone; injection is the only
walker), so no graph-native engine is earned, and the graph must live in
`application.sqlite` beside the archive for provenance FKs + single-transaction
writes. Three STRICT tables. **Typing lives at the tool layer** (one valibot schema
per type, validated before commit — the `issue-management/tools.ts` pattern); the DB
enforces enums, PK, FK, UNIQUE. Type-prefixed ids (`person_1f3a9c`) because these ids
appear in prompts.

```sql
CREATE TABLE graph_entities (
  entity_id   TEXT PRIMARY KEY,          -- type-prefixed: "person_1f3a9c", "issue_c04b11"
  type        TEXT NOT NULL CHECK (type IN ('person','agent','thread','topic','commitment',
                                            'repository','issue','pull_request','project','milestone','goal')),
  properties_json TEXT NOT NULL DEFAULT '{}',
  confidence  REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_chat_id TEXT, source_message_id TEXT, source_delivery_id TEXT,
  created_at  TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE graph_relations (
  relation_id TEXT PRIMARY KEY,
  from_id     TEXT NOT NULL REFERENCES graph_entities(entity_id),
  relation    TEXT NOT NULL CHECK (relation IN ('participates_in','interested_in','discusses','mentions',
                                                'works_on','made_by','about','resolves','part_of','blocks','advances')),
  to_id       TEXT NOT NULL REFERENCES graph_entities(entity_id),
  confidence  REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  source_chat_id TEXT, source_message_id TEXT, source_delivery_id TEXT,
  created_at  TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (from_id, relation, to_id)       -- an edge is one fact; restating updates confidence
) STRICT;
CREATE INDEX graph_relations_to_idx   ON graph_relations(to_id, relation);
CREATE INDEX graph_relations_from_idx ON graph_relations(from_id, relation);

CREATE TABLE graph_identities (
  platform    TEXT NOT NULL CHECK (platform IN ('whatsapp','github')),
  external_id TEXT NOT NULL,   -- "4915…@s.whatsapp.net" | "AaronAbuUsama" | "owner/repo" | "owner/repo#45"
  entity_id   TEXT NOT NULL REFERENCES graph_entities(entity_id),
  display_name TEXT,
  PRIMARY KEY (platform, external_id)
) STRICT;
```

Property shapes (validated at the tool boundary, not the DB):
`Commitment {description, status: open|done|dropped, due?}`; GitHub nodes
`{repo, number?, title, state, cached_at}`; `Topic {label}`; `Thread {chat_id}`;
`Goal {description, target?}`.

**Cross-platform identity (Q4)** is the `graph_identities` PK: `(platform,
external_id) → entity_id`, the pair PRIMARY KEY. The DB itself guarantees one owner
per external id — *that convergence is the cross-thread memory.* Widened to hold all
external natural keys, so `owner/repo#45` from a webhook resolves in one lookup and
the same guard that stops Person-splintering stops Issue-node duplication.

**Entity resolution (Q7)** is the Scribe's job at write time (§4), not the schema's;
the schema only makes resolution *possible* (confidence, a candidate lookup, cheap
merge: repoint `from_id`/`to_id`/`graph_identities.entity_id` to the survivor, delete
the loser).

---

## 4. The Scribe — the silent writer (#141), and its cadence (#149)

### Principle

**The Scribe records honestly, not certainly.** It is not a clever write-time
matcher; it observes, writes what a consumer will actually read, and marks how sure
it is. `Confidence` is load-bearing: an ambiguity becomes a low-confidence fact, not
a blocked write, and the medium self-corrects.

### Wiring & failure isolation (D1/D2)

The Scribe fans out at the **`dispatchSpeaker` funnel**, after the Speaker's receipt
is obtained, detached:

```ts
export const dispatchSpeaker = async ({ id, input }) => {
  const receipt = await dispatch(speaker, { id, input });   // Speaker — awaited, gates the caller
  speakerActivity.accepted(receipt, input);
  scribeCoalescer.offer({ id, input });                     // Scribe — debounced, detached (see cadence)
  return receipt;
};
```

Fanning out at the funnel (not the WhatsApp window dispatcher) means the Scribe sees
**windows + GitHub events + `worker.result`** by construction. Failure isolation is
structural: the fan-out sits after the Speaker's receipt, is never awaited into the
receipt path, and its errors are caught — a Scribe failure can never re-run or
re-deliver the Speaker's turn. **No separate Scribe durability ledger**; once Flue
admits the input the turn is durable, and the graph is tentative and self-healing.
Honestly flagged: this self-healing is weak for one-shot GitHub events, acceptable
because the cached summary is advisory (Q3) and confidence covers it.

### Cadence — debounced, its own coalescer at the funnel (#149 amends #141 D1)

Flue **serializes** the Scribe's admissions but **never collapses** N queued
admissions into one turn — per-input dispatch is one LLM call per message, the
"overkill" #144 flagged. So the Scribe **debounces**: accumulate sibling inputs,
dispatch **one** combined extraction input per quiet-period-or-cap.

- **Mechanism:** extract `makeChatLoop`'s debounce state machine into a generic
  `debounceActor<T>` and instantiate it **twice** — the existing raw-WhatsApp
  coalescer unchanged (one layer upstream, element type = raw messages), and a
  **second** instance at the funnel over already-composed inputs (a different layer &
  element type). One state machine, two element types.
- **Parameters, much laggier than the Speaker** (whose coalescer is 3s / 10s / 10):
  starting defaults **debounce ~30s / maxWait ~2–5 min / cap ~50**, DI `Config`
  knobs, eval/feel-tuned later. **No immediate-fire predicate** — nothing the Scribe
  extracts is urgent.
- **Durability:** best-effort in-memory buffer, no ledger; a crash drops ≤ one
  `maxWait`, and the graph self-heals. `worker.result` is batched too, backstopped by
  the redundant `pull-request.opened` webhook path (Seam #1) — no bypass.
- **Freshness contract:** uniform cadence across extraction kinds; the advisory cache
  (Q3) absorbs the lag; #146 owns any tighter commitment freshness.

> **Record reconciliation — #140 Q3's "coalesced window."** GitHub ingress bypasses
> the WhatsApp coalescer; under the funnel fan-out the Scribe receives GitHub events
> as **sibling inputs** in the same continuing conversation, *not* folded into a
> WhatsApp window. Read #140 Q3's "coalesced window" as **"same conversation, sibling
> inputs"** (#141 Seam #2). The Scribe's own coalescer (above) then batches those
> siblings for cost, which is a different thing from the WhatsApp window.

### Write-tool surface (D3) — four upsert tools, typed via discriminated union

- `record_entity({ entity: variant("type", [...11 schemas]) })` — **upsert** (folds
  create/update; re-seeing a keyed entity converges, restating bumps confidence).
- `record_relation({ edge: variant("relation", [...11 schemas]) })` — **upsert** on
  `UNIQUE(from,relation,to)`.
- `merge_entities({ survivor_id, loser_id })` — explicit dedup.
- `lookup_graph({...})` — read, for resolution candidates + freshness (shared with §5).

The two constraints valibot can't express (`blocks` acyclic, `made_by` exactly-one)
get a handler check before commit.

### Resolution & extraction policy (D4/D5)

- **Keyed types** (Person, Agent, GitHub objects, Thread-by-`chat_id`) converge free
  via the `graph_identities` PK. **Keyless** (Topic, Commitment): same exact phrasing
  → same node; otherwise a **new node with a confidence that says "I might be
  duplicating."** No write-time matcher (normalized-key / model round-trip /
  embeddings all rejected). Resolution happens **socially** (the Speaker asks, §5) and
  via a **later consolidation pass** (fog).
- **Earned extraction:** the Scribe writes only what a consumer will read.
  `mentions` **liberal** (free signal); `discusses`/`interested_in` **conservative**
  (they feed proactive speaking, where false positives are spam).
- **Seam #1 — a finished job becomes a graph fact:** from the `worker.result` window
  the Scribe writes the graph-only earned edges **`works_on`** and **`resolves`** —
  *not* the PR's labels/body (GitHub serves those). Upsert + unique edges make it
  idempotent, so the redundant `pull-request.opened` webhook triggering the same
  writes just bumps confidence.

### Harness (D6)

The Scribe is its own agent def with its own **extraction SKILL.md** (eval-gated) and
**the four ontology tools only** — no Say, no participation, no issue-management. It
carries its **own** `model` + `thinkingLevel` (starts cheap + minimal-thinking;
latency-free so it can go heavier if extraction quality demands), a per-agent choice
on the one credential — which requires the provider to **stop hard-coding a single
model id** (`pi-subscription.ts:175`).

---

## 5. State injection — the read side (#142)

### Principle

**Reading optimizes for a natural single-turn reply, not token thrift.** A pull tool
call is an extra model turn; extra turns feel robotic. So the Speaker is fed context
proactively and richly up front; the pull tool is the fallback for depth.

### Both, pull-first (D1)

- **Pull (the floor):** `lookup_graph` — the same read primitive the Scribe has, one
  shared tool; makes the confirm loop (D5) and Worker depth-read possible.
- **Push (layered on top):** a proactive digest on the input.

### The digest (D2/D3) — plain code at the funnel, a flat input field

`buildGraphDigest(seeds)` is **plain deterministic code** — a one-hop edge-walk over
the `graph_relations_from_idx`, seeded from keys already in the window
(`messages[].from`, `.mentions`, `chatId`) resolved through `graph_identities`. No
model round-trip.

- It runs at the **funnel** (`dispatchSpeaker`), the one site where all three input
  kinds converge — **not** at `whatsappWindowInput` (WhatsApp-only) and **not** in
  the coalescer (the timing layer, no content). It reads `getGraphStore()` via the
  existing accessor idiom.
- **Shape:** Flue gives a dispatched agent exactly one durable per-turn channel —
  `input`. So the digest rides *on* the input as a **flat optional `graphContext?`
  field** on each input-union member (not an envelope wrapper). Structured-vs-prose
  rendering is deferred to the eval battery.
- **Content:** the **full one-hop neighborhood, every window, read live** — active +
  quiet participants and their strong edges, GitHub work-in-view (from the Q3 cached
  summary) with secondary hops, weak `mentions`, the thread's `discusses` history,
  and open `Commitment`s touching anyone present. Low-confidence facts are flagged
  with their `entity_id` (feeds D5). **No cache layer** — if another thread's Scribe
  wrote a fact seconds ago, this turn sees it; *that staleness is the feature.* The
  recite risk (a cheap model over-referencing peripheral facts) is prompt/eval-tuned,
  not a design cut.

### Statefulness (D4)

`input` is durable, so each window's digest is a permanent transcript turn — a
time-series of digests where later supersede earlier. This is **not** treated as a
problem: it is how agent context works, the transcript's own memory makes
re-injection partly redundant, and Flue's compaction folds old digests. **No
delta/dedup/diff logic.**

### The Speaker's confirm/resolution surface (D5)

#141 D3 ("Scribe is the only writer") and #141 D4 ("the Speaker records the answer")
are in tension; the Speaker's outbound question is `fromMe`-filtered out of the
Scribe's window, so only the Speaker holds the question context and must record the
resolution. It uses a **subset of the four ontology tools** — no new toolset:

- `lookup_graph` — read (this *is* the pull tool);
- `record_entity` — re-asserting a low-confidence entity is an upsert that **bumps
  confidence** ("confirm");
- `merge_entities` — "that's the same as the deploy topic".

`record_relation` (bulk observational extraction) stays **Scribe-only**. Asking uses
the existing `say` tool. Invariant in spirit: **Scribe writes observed facts; Speaker
writes only user-confirmed resolutions** — non-overlapping intents, both safe on
single-file SQLite.

### Workers share the read surface, read-only (D6)

`buildGraphDigest` and `lookup_graph` have **three consumers**, one implementation
each. Workers get the **pushed digest** (seeded from the job's issue/PR/repo +
launching thread, called from both the launch tool and the webhook launch path) and
mount `lookup_graph`. **Workers are read-only** — their discoveries route home as
graph facts through `worker.result → Scribe` (Seam #1); a Worker write tool would
just duplicate that path.

**Three-way split of graph access:** Scribe writes observed (incl. `worker.result`),
reads for resolution · Speaker reads (digest + `lookup_graph`), writes confirmed
resolutions only · Workers read-only.

> **Record reconciliation — the digest is not a routing primitive.** #142 D6's seam
> note said `buildGraphDigest` is #144's routing primitive. The
> [#142 reconciliation comment](https://github.com/AaronAbuUsama/ambient-agent/issues/142#issuecomment)
> superseded that after #144 landed on broadcast: the digest is purely the Speaker's
> per-thread read context, not a routing input, and there is no coordinating router.
> Everything else in #142 stands.

---

## 6. Broadcast fan-out (#144)

**Don't route — broadcast, and let each Speaker's own relevance judgment filter.**

The premise that "routing becomes a graph query over `discusses`" *welded* the router
to the graph — recasting the knowledge base as a routing table. Broadcasting unwelds
them.

- **Inbound events (Decision 1):** delete the static map (`apps/server/src/app.ts:43`
  `new Map([[defaultRepository, managedChats[0]]])`) and its lookup
  (`ingress.ts:201`). Every supported GitHub event dispatches to **every** managed
  thread's Speaker; each judges relevance; silence is valid. This collapses all four
  original sub-questions (granularity, cold-start, caps/dedup, no-match) — everyone
  receives everything once, day one, with zero graph data.
- **Worker return address (Decision 2):** a job result needs *one* home, so it can't
  broadcast. With the map deleted, worker-return resolves the repo's home chat
  straight from managed config (`configuration.github.defaultRepository →
  managedChats[0]`). The repo→chat mapping survives **only** for this consumer.
- **Upgrade path (Decision 3), deferred until it hurts:** the Scribe still writes
  `discusses`/`interested_in` (they feed the digest regardless). If thread count ever
  makes broadcast noisy, the graph query becomes a *filter* over that already-
  populated edge set for both consumers — no schema change, no migration.
  `subscribed_to` (declared interest) stays a parked one-line enum addition.

**Grading (floor-first):** broadcast ships real behavior today with no graph
dependency. Its worst case is a cheap, visible stray message bounded by thread count;
a router's worst case is a **silent miss**. At a handful of threads and few
events/day, waking every Speaker is negligible and leans on exactly the intelligence
we want to lean on.

---

## 7. Identity model (#135), grounded in the mechanics (#134)

**App per agent.** Three GitHub Apps — Coder, Reviewer, Planner — each its own App.
It is the only model where the **Reviewer's approval satisfies branch protection** (a
PR-author identity can never self-approve; `github-actions[bot]`/Copilot approvals
don't count — #134), it is free and unlimited (vs. machine accounts' per-seat +
one-free-per-person ToS cap), and each Worker gets an isolated rate-limit bucket.

- **Credential store:** one file per App, `credentials/github-{coder,reviewer,planner}.json`,
  each `{ schemaVersion, kind: "github-app", appId, installationId, privateKey, webhookSecret? }`,
  `0600`, independently inspectable & rotatable. The Planner file is also the
  Speaker's identity.
- **`personal-token` is retired** — `kind` becomes `v.literal("github-app")`,
  replacing the PAT literal outright (not a union). A lingering PAT file fails schema
  and surfaces as the existing `reauthentication-required` state. The token→App
  cutover is a one-time migration.
- **Setup:** manual guided paste — a per-App checklist collecting the three
  `{appId, installationId, privateKey}` triples, extending the `prepare` seam. Fully
  headless. Rotation = operator re-paste.
- **Octokit:** a shared `githubAppClient(credential)` adapter using
  `@octokit/auth-app`'s `createAppAuth` (auto-refreshing the installation token);
  `createOctokitIssueRepository` is refactored to *receive* an Octokit (ADR 0012's
  "adapter without changing the Issue Management interface" honored). Bot login is
  **derived at runtime** (`apps.getAuthenticated()` → `<slug>[bot]`), replacing
  `users.getAuthenticated()`, because comment-ownership checks compare against it.
- **Names** are a recommended setup convention (`Ambient Coder/Reviewer/Planner` +
  distinct avatars), never hardcoded (App names are globally unique).
- **Hosted mode** (vendor owns keys, tenants only install → per-tenant
  `installationId`) stays parked below.

This retires ADR 0012's personal-token deferral. The credential-migration issue
([#153](https://github.com/AaronAbuUsama/ambient-agent/issues/153)) marks ADR 0012
superseded when the token→App cutover lands.

---

## 8. The Worker contract (#143) → Coder (#136); delivery via ADR 0001

### Launch — per-Worker typed tools from a chat-bound factory

The Speaker mounts **one typed tool per Worker** (`start_coder_job`, `start_review`,
`start_planning`) from a chat-bound factory in a **new "delegation" capability**
(joining `issue-management`, `whatsapp-participation`). Each tool's input schema **is**
its Worker's workflow input schema (one source of truth); each tool's prose is
independently eval-gated. The handler calls `invoke(workflow, { input })` → `{runId}`
without waiting, records the launch in the **run ledger**, and returns immediately.
Rejected: one generic `start_worker(kind, input)` (untyped at the boundary).

**Job input** carries: the return address (`chatId`, optional), the work reference,
instructions, and `graphContext` (the pushed digest, §5).

### Return — result comes back as an input, via the durable-gated bridge

A completed run returns as a **`worker.result` member of the input union** (alongside
`whatsapp.window`, `github.issue.opened`, …) to the launcher-resolved `chatId`:
Speaker-launched → its own chatId; webhook-launched → the config default (§6
Decision 2); no route → the job still runs, result rests in the run record.

**Mechanism = ADR 0001's single generic `instrument()` interceptor.** It wraps every
run and, *after* the run is **Durably Terminal**, reads the durable record via
`getRun()` and dispatches `worker.result` to `input.chatId` — dispatched to
`dispatchSpeaker`, so both Speaker and Scribe see it.

> **Why not self-dispatch.** The lifecycle persists `run_end` *after* `run()`
> returns, so a Worker self-dispatching its result from inside `run()` fires *before*
> durable-terminal — a crash in that window tells the chat "completed" about a run
> that recovery still shows `active`. ADR 0001 considered and rejected self-dispatch
> for exactly this; `observe()` is telemetry-only, not transport.

### Progress — two layers

- **Waypoints:** `ctx.log.info(...)` native durable run-stream events (a research
  round done, a PR opened) — nothing dispatched to any chat; the inspection surface.
- **Inspection tool (`check_jobs`):** a chat-bound read tool reading the ledger's
  `runId`s for this chat and their live status/events via `getRun()` — an on-request
  pull, and the Speaker's memory of what it launched across restarts.
- **Milestone:** the rare domain-significant subset worth interrupting the thread,
  re-dispatched as a `worker.milestone` input (ADR 0001's `workflow.progress`). Quiet
  by default.

### Failure — boot reconciliation

Node has no automatic workflow recovery; an interrupted run stays `active` and the
bridge never fires. So the run ledger is **swept on process startup** (the
`operation-store.ts:158` move): any launch recorded before this boot and still
unsettled → dispatch `worker.result` with `status: "interrupted"` so the Speaker can
tell the thread and offer relaunch. In-run errors the Worker handles and recovers
from stay private telemetry.

### Idempotency — natural keys first (principle C)

Keys are **application-owned**, live with the capability that owns the write; prefer
**deterministic job-derived GitHub identifiers** (branch ref, PR head→base, review
SHA) with **check-then-act**. The **opaque-key store** (`operation-store.ts` pattern)
is the fallback for no-natural-key writes only, instantiated **parallel** to the
issue store, never extending it. The **run ledger is launch memory, not an
idempotency key** — a relaunched dead job is a *new* `runId`, so idempotency keys on
GitHub state.

### The Coder (#136) — first consumer, sets the Worker-capability template

- **Full sandbox, config-bound.** A Coder needs a real toolchain (install/typecheck/
  test/iterate). The capability is written against Flue's `SandboxFactory`
  **interface**, never `local()`; the concrete sandbox is a **deployment binding set
  up beforehand, never per-job** (`local()` on the single-owner VPS today, remote
  container in SaaS). Isolation gap accepted now because the swap is config, not a
  rewrite.
- **Octokit tarball in, Git Data API out.** `repos.downloadTarballArchive` into the
  workspace (the only sandbox-portable seed; git-worktree-off-a-bare-clone rejected as
  local-welded); commit/branch/PR via the Git Data API. No `git` CLI anywhere.
- **Mounts:** the full sandbox fs+shell tools + `lookup_graph` (read-only). All GitHub
  I/O is deterministic app code in `run()`; a lean eval-gated SKILL carries policy.
- **Idempotency:** per-issue natural keys — branch `agent/coder/issue-<N>`
  (check-then-act), one open PR per `head→base` (push more commits if one is open). No
  opaque store (both writes have natural keys).
- **Job input:** `{ repository, issue, instructions?, chatId?, graphContext? }` —
  issue-only for v1.
- **Definition of done:** green-gate — non-draft PR only when the suite is green; if
  still red after N attempts, a **draft** PR with `status:"blocked"` and the failure
  in `summary`. Red work is never presented as done.
- **Relaunch after boot-sweep:** **Speaker-asks-the-chat** — the idempotent key makes
  auto-relaunch *safe*, but a Coder job is expensive and outward-facing, so it follows
  confirm-before-repeating-an-outward-action.
- **New managed path** `~/.ambient-agent/workspaces/`.

**The reusable template #147 inherits:** full sandbox config-bound · Octokit tarball
in / Git Data API out · deterministic natural keys, no opaque store where a natural
key exists · app code owns GitHub I/O, model gets workspace + `lookup_graph`, lean
eval-gated SKILL · idempotent keys make relaunch safe but outward Workers ask.

---

## 9. Commitment lifecycle (#146)

**Passive detection is the spine; `confidence` carries the whole lifecycle.** No new
tool, no new rubric axis, no scheduler — every decision rides existing machinery.

- **Detection is passive** — a Commitment is an earned keyless entity the Scribe
  extracts via `record_entity({commitment})` during normal window processing.
  **"Hold me to that" is not a separate path** — it is the same call at
  `confidence = 1.0`; if that exchange is `fromMe`-filtered from the Scribe, the
  **Speaker** records it through the confirmed-write subset (§5 D5).
- **What counts (two gates, no write floor):** (1) **structural** — `made_by` exactly
  one, enforced before commit; an utterance with **no resolvable owner is never
  written** ("someone should look at this" fails here). (2) **surface floor `θ≈0.5`**
  (eval-tuned SKILL prose) — borderline promises are *written* low-confidence but
  *surfaced/raised* only above `θ`. Implicit owner ("we'll get to it") → written low,
  `made_by` = best-guess flagged uncertain.
- **Close:** **Speaker on user confirmation** (the floor). **Scribe auto-closes
  GitHub-anchored commitments only** — when `about → Issue/PR` merges/closes, from the
  same window that writes `resolves` (Seam #1). **Overdue stays `open`** (never
  auto-`dropped`); `dropped` is manual.
- **`due` = passive digest context.** There is no clock in the architecture; every
  path is input-triggered. Proactive-overdue nudges with no inbound trigger are the
  **"monologue agent" fog** (§11), not built here.
- **Convergence** inherits #141 D4 keyless policy verbatim, with `about → Issue/PR` as
  a free anchor for GitHub-linked promises.

---

## 10. Skill-authoring standard (#137)

Governs product capability prose under `packages/agents/src/capabilities/` (SKILL.md
body, frontmatter `description`, `references/`, tool `description`s). Lands as a repo
doc `docs/agents/skill-authoring.md`.

- **The bar:** *no prose claim without a green assertion; no prose change without a
  red-then-green.* Behavioral prose rides a red-then-green eval (live judged family
  reads the shipped text); mechanical/reference prose needs only deterministic green.
- **Authoring:** eval-first for behavioral prose; the PR must *show* the red.
  Rubric-derived SKILLs are a projection of a ratified rubric, so **a new behavioral
  claim amends the rubric first**.
- **Template:** identity H1 + provenance line + axis-tagged imperative sections +
  progressive-disclosure pointer, ≤~40 lines. **Tool descriptions are
  agent-neutral — hard rule** (no hardcoded agent name). Axis-tags mandatory only for
  rubric-derived capabilities.
- **Enforcement:** deterministic family gates CI (blocking); live judged family is a
  reviewed Braintrust receipt meeting `eval-baseline.md` floors.
- **Drop `metadata.version`** (Flue never injects it, nothing reads it).
- This is the *product* standard, **not** the workshop `writing-great-skills`.

This standard governs the Scribe extraction SKILL (§4), delegation prose (§8), and
each Worker's SKILL (§8, #147).

---

## 11. What this arm does not settle

- **#147 (Reviewer workflow shape)** — ratified in parallel (standalone Reviewer, no
  loop). Consumes this contract + identity model; inherits the Coder template (§8). Its
  implementation issue — a sibling of #158, reusing #157 transport + #153 identity — is
  suite build work, not part of this memory & state arm.
- **The "monologue agent" fog** (#132): keyless-entity consolidation (the later pass
  the Scribe leans on) and overdue-commitment nudges (the first named instance, §9).
  Deliberately unbuilt until honest-recording proves insufficient.
- **Hosted/multi-tenant credential flow** (§7) — parked under the map's supervisor
  question.
- `subscribed_to` declared-interest relation (§6) — a one-line addition if a thread
  ever needs "keep me posted".

---

## 12. The Memory & state milestone

Implementation issues cut from this spec (milestone 7). Blocking edges are GitHub
native dependencies; `A → B` means A blocks B.

| # | Issue | Blocked by | From |
|---|---|---|---|
| [#152](https://github.com/AaronAbuUsama/ambient-agent/issues/152) | Graph store: schema migration + the four ontology tools | — | §3, §4 D3 |
| [#153](https://github.com/AaronAbuUsama/ambient-agent/issues/153) | Credential migration: PAT → three GitHub Apps | — | §7 |
| [#155](https://github.com/AaronAbuUsama/ambient-agent/issues/155) | Scribe agent: funnel fan-out + debounced coalescer | #152 | §4, §9 |
| [#156](https://github.com/AaronAbuUsama/ambient-agent/issues/156) | State injection: digest + `graphContext` + Speaker read/resolution surface | #152 | §5 |
| [#154](https://github.com/AaronAbuUsama/ambient-agent/issues/154) | Broadcast ingress: delete the static map | — | §6 |
| [#157](https://github.com/AaronAbuUsama/ambient-agent/issues/157) | Delegation transport: run ledger, boot sweep, ADR 0001 bridge, `worker.result`/`worker.milestone` | #154 | §8 |
| [#158](https://github.com/AaronAbuUsama/ambient-agent/issues/158) | Coder workflow: first Worker, sets the template | #157, #153, #156 | §8 |
| [#150](https://github.com/AaronAbuUsama/ambient-agent/issues/150) | Rename Ambience → Speaker across code | — (land first) | §2 |

Build order: the **graph store** and **credential migration** are the two roots.
Scribe and state-injection unblock off the store and can proceed in parallel (both
touch the funnel — sequence the merges). Broadcast is independent. Delegation
transport needs broadcast's config-default return resolver; the Coder needs the
transport, its App credential, and the digest builder. The **rename** has no design
dependency but should land first so new agent-dir code is authored in Speaker
vocabulary (#149 note).
