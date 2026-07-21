# Context Topology Design — the global/local seam for "coworker"

> **Status: crystallized.** This is the options-spectrum exploration that led to the
> chosen architecture. The single ratified design it converged on now lives in
> [`../SYSTEM-ARCHITECTURE.md`](../SYSTEM-ARCHITECTURE.md) (the "Master Brain + reactive
> Speakers" shape — Option B, sharpened). Keep this doc as the decision record of *why*
> that shape won over A/C/D; read the master doc for *what* the architecture is.

> Parallel exploration. Design-only, no code, no PR. This does **not** change the
> current execution line; it informs future stages. Every claim about today's
> behavior cites real code at `file:line`.

## Executive summary (5 lines)

1. Today "global" exists only as **shared data** (the graph); there is no global
   **actor**, so inbound GitHub events are broadcast to every chat and each Speaker
   self-judges relevance (`ingress.ts:518-525`), and events that correlate to nothing
   are silently dropped (`ingress.ts:474-489`).
2. The felt "identity" is wrongly fused onto the **Planner app** — runtime identity +
   issue-writer + webhook-secret owner all at once (`runtime-dependencies.ts:9`,
   `first-run.ts:180-182`, `program.ts:417`).
3. The fix is not "add global context" (we have it) — it is **give the global a home
   and a router**, and **move the felt identity off the Planner** onto the front role.
4. Four architectures below, simplest→most powerful: **A** deterministic routing, no
   actor · **B** one silent global router actor (Concierge) · **C** promote a Speaker
   to Prime · **D** full orchestrator + subscription bus.
5. **Recommendation: ship A as the floor now (kills both smells, tiny diff), grow into
   B when the one-identity feel is required — B literally contains A's router as its
   deterministic fast-path.** C is the viable no-new-agent-type middle; D is YAGNI for a
   single instance.

---

## 1. The current architecture, grounded

### 1.1 The seams that already work (do not regress these)

**Coalescer — the timing layer with no model.** One actor fiber per `chatId` draining
its own queue; a burst of messages coalesces into one `ConversationWindow`, an
@-mention/quote-reply of the bot fires immediately (`coalescer/coalescer.ts:72-95`,
`events.ts:87-92`). A busy chat is fully *processed* but replied-to once per settled
window, not per message. Dispatch failure is swallowed and the chat continues
(`coalescer.ts:37-42, 58-63`). This is force #3 (non-blocking) already solved for chat.

**Scribe → shared graph — the partial "global."** After each Speaker dispatch, the same
funnel offers the input to the Scribe's *own* coalescer (`speaker/dispatch.ts:33-34`,
`scribe/coalescer.ts`), which batches per chat and runs one silent extraction turn that
writes entities/relations into `application.sqlite` (`graph/store.ts:151-179`). The
Scribe never speaks and has no GitHub identity (`scribe/agent.ts:14-15, 25-30`). It is
best-effort and non-durable: a crash drops ≤ one window and "the graph self-heals"
(`scribe/coalescer.ts:11-14, 54-58`).

**Digest — global pushed down, live, no cache.** At the Speaker funnel,
`attachGraphContext` computes a one-hop neighborhood of the graph seeded from identities
in the window and rides it on the input as a flat `graphContext` field
(`speaker/dispatch.ts:30`, `capabilities/graph/digest.ts:52-65`, `graph/digest.ts:90-171`).
It is **recomputed live every window**, so "a fact another thread's Scribe wrote seconds
ago is visible this turn. That staleness is the cross-thread-memory feature"
(`graph/digest.ts:9-12`). The Speaker also reads deeper on demand with `lookup_graph`
(`capabilities/graph/tools.ts:121-168`, `speaker/agent.ts:30`).

**Delegation — the async, no-drop-on-crash seam.** `start_coder_job` launches a Coder
workflow bound to the launching chat as the return address; the result returns *async*
as a `specialist.result` input via one `instrument()` interceptor that fires only after
the run is durably terminal (`capabilities/delegation/bridge.ts:44-57`, `speaker/agent.ts:21-24, 32-34`).
A launch is recorded in a sqlite ledger (`delegation/ledger.ts`), and a boot sweep turns
any launch left unsettled by a crash into an `interrupted` result so the chat is always
told (`bridge.ts:59-83`). This is force #4 (no-drop) already solved for *outbound* work.

**Config is the source of truth.** `managedChats` is a non-empty validated list
(`installation/src/schema.ts:49`); `apps/server/src/app.ts:126` wires it into ingress. A
new managed thread receives events automatically with no per-repo routing config
(`ingress.ts:119-127`).

### 1.2 The three smells, at `file:line`

**Smell 1 — broadcast.** A supported event builds one input per managed chat and
fan-out-dispatches to all of them; each Speaker judges relevance itself and staying
silent is a valid outcome (`ingress.ts:518-525`, comment `518-519` cites #144). Wasteful
(N Speaker turns per event), and it exists *only because there is no global home for an
event* — the ledger even apologizes for it: "the single-row ledger predates broadcast"
(`ingress.ts:546-548`).

**Smell 2 — silent drop.** A PR that closes no Speaker-captured issue settles
`uncorrelated`, logs a warn, and returns — **no chat is notified**
(`ingress.ts:474-489`). A referenced-issue race settles `deferred` the same way
(`ingress.ts:448-459`). Nothing real should ever vanish; today it does.

**Smell 3 — identity is the Planner.** The Planner app is "the runtime's issue-filing
identity and webhook-secret owner" (`runtime-dependencies.ts:9`), "the runtime's own
identity" that proves repo access (`first-run.ts:180-182`, `program.ts:417`), and it
owns the single webhook secret (`program.ts:395`) — so it is also the single webhook
sink. Three roles (felt identity + issue writer + webhook owner) fused onto one backstage
worker. The felt identity should be the *front/speaking* role, not the Planner.

**Bonus smell — the hard-coded home chat.** A specialist result with no obvious home
resolves to `managedChats[0]` via `github.defaultRepository → managedChats[0]`, and the
repo→chat mapping "survives only here" (`installation/src/specialist-return.ts:8-16`,
also `ingress.ts:347, 378`). This is the *same missing-global-home hole* seen from the
outbound side, and it is exactly what multi-project-per-chat (#243/#249) must replace.

### 1.3 The one-sentence diagnosis

> We have global **data** (the graph) but no global **home** for an event or a decision,
> and no global **face**. Broadcast, silent drop, and Planner-as-identity are three
> symptoms of that one hole.

---

## 2. The design axis

Two orthogonal questions organize the spectrum:

- **Is "global" a context, an actor, or both?** Context = data others read (we have it).
  Actor = something that *routes and decides*. The options differ mainly in *how much
  actor* they add.
- **Where does the single felt identity live?** The four options place it at: a named
  inbox (A), a silent Concierge (B), a promoted Prime Speaker (C), or a first-class
  Orchestrator (D).

A shared invariant across all four: **decouple the three fused Planner roles**
(`runtime-dependencies.ts:9`). The webhook-secret owner is infrastructure and can stay
any app; the issue-writer stays the Planner *as a backstage team member*; the felt
identity moves to the front role the option introduces. The GitHub team stays distinct
apps on purpose in every option — nothing here collapses the backstage identities.

---

## 3. Option A — Deterministic routing, no new actor (the floor)

**The simplest thing that could work.** Global stays pure **context** (the graph,
unchanged). The only change: **replace broadcast with a deterministic graph lookup in
ingress**, and name a **front-desk inbox** so nothing drops.

### Context topology
- Global = shared graph (unchanged). Local = per-chat Speaker context (unchanged).
- Local rolls **up** via Scribe (unchanged). Global pushes **down** via digest (unchanged).
- Connection between them: unchanged. No cross-thread search primitive added.

### Agent set & felt identity
- Speaker, Scribe. **No new agent.**
- Felt identity: a **named** front-desk chat (today's implicit `managedChats[0]`, now an
  explicit, documented "inbox," and it is *notified*, never a silent sink). Still
  per-chat voice — identity is only *named*, not *unified*.

### Inbound routing primitive (replaces broadcast, no drops)
In ingress, resolve the event's GitHub natural keys (`owner/repo`, `owner/repo#N`) to a
Thread via `graph_identities` — the machinery already exists
(`graph/store.ts:112`, `graph/digest.ts:99-108`, `installation/src/specialist-return.ts`).
- Correlates to a Thread → dispatch to **that one chat**.
- Correlates to nothing → dispatch to the **front-desk inbox** with an "unrouted event"
  input (replaces the `uncorrelated`/`deferred` returns at `ingress.ts:474-489, 448-459`).
- The single-target dispatch reuses the existing `dispatch(chatId, input)` path, so the
  coalescer and async delegation are untouched.

### Non-blocking mechanism
Unchanged. One dispatch instead of N; the coalescer and delegation seams are not touched.

### Key data shape
No new tables. Reuse `graph_identities` (`store.ts:172-178`) and existing `works_on` /
`about` / `resolves` edges (`store.ts:31-42`) as the repo/issue↔thread routing index.

### Honest tradeoffs
- **Good:** smallest possible diff; kills *both* smells (broadcast waste + silent drop);
  reuses every existing seam; fully reversible (routing is one function in ingress).
- **Bad / where it breaks:** does **not** satisfy force #2 (one identity across chats) —
  chats remain islands that merely share a graph. The front-desk inbox has no
  intelligence: it is a Speaker like any other, with no authority to fan out or reassign
  an event it received by fallback. Single-target routing loses the "two chats both
  care" case that broadcast's self-judging covered — in practice rare, but real for a
  cross-project PR. Multi-project-per-chat is *unblocked* (the resolver replaces
  `specialist-return.ts`) but not *modeled*.

---

## 4. Option B — Concierge: one silent global router actor (recommended target)

Introduce **one** new singleton agent — the **Concierge** — that is the global **actor**.
It owns no chat. It is the brain behind the single webhook sink and the cross-chat router.
Global becomes **both**: context (graph, unchanged) *and* an actor (Concierge). Crucially,
the **Concierge does not speak** — it routes; Speakers remain the mouths. It is
"Scribe-shaped" (a silent always-on actor with its own coalescer) but for *routing*
instead of *extraction*.

### Context topology
- Global = graph (unchanged) + the Concierge as its reader/router.
- Local rolls up via Scribe (unchanged); global pushes down via digest (unchanged).
- **New:** the Concierge can push a cross-chat notification *down* into any chat, and
  reads the graph to decide *which*. This is the missing "global → specific chat" arrow.

### Agent set & felt identity
- Speaker, Scribe, **+ Concierge** (silent, no GitHub identity, like Scribe).
- **Felt identity = the Concierge**, conceptually: "coworker" is the Concierge; the
  Speakers are its per-chat voices. On GitHub the team stays distinct apps. The Planner
  is demoted to backstage issue-writer; the webhook secret is infra. The Concierge is
  what the product *means* by "one thing you talk to," realized as one routing brain
  behind many mouths.

### Inbound routing primitive (replaces broadcast, no drops)
Inbound events dispatch to the **Concierge**, not broadcast. The Concierge:
- fast-path: deterministic graph lookup (exactly Option A's resolver) → dispatch to the
  right Speaker;
- residual: when correlation is ambiguous or empty, it *decides* — route to the best-fit
  chat, ask a clarifying question there, or open/notify the front desk. Nothing drops
  because the Concierge is the always-there home for an event.

### Non-blocking mechanism
The Concierge gets its **own coalescer** (reuse `debounceActor`, `coalescer/debounce-actor.ts`,
exactly as the Scribe does at `scribe/coalescer.ts:60-68`): a burst of inbound events
coalesces into one routing turn; dispatch to a Speaker is the existing async
`dispatch(chatId, input)`. The Concierge's own model turn never blocks a chat's
responsiveness — same discipline as the Scribe fan-out.

### Key data shape
Reuse the graph. The Concierge needs no new store: thread↔repo/project is already
`graph_identities` + `works_on`/`part_of` edges (`store.ts:31-42, 172-178`). Optionally a
thin `unrouted_events` ledger (mirroring `delegation/ledger.ts`) so an event the Concierge
is still deciding about survives a crash — that is the *no-drop durability* upgrade
Option A lacks.

### Honest tradeoffs
- **Good:** a real global actor with a real home for every event (force #4 becomes
  structural, not best-effort); a genuine single felt identity (force #2); deliberate
  routing (force #1 kept small — the fast-path is just A); the natural plug point for
  multi-project routing, a future dashboard, and new agent types (force #7 — all
  additive on the Concierge).
- **Bad / where it breaks:** a new singleton is a new SPOF and a model turn on the
  inbound path (cost + latency the current broadcast doesn't pay per-event, though
  broadcast pays N Speaker turns, so net cost often *drops*). Risk of the Concierge
  becoming a god object — must stay a *router*, never a second Speaker. The honest
  tension: if the Concierge doesn't speak, the felt voice is *still* the Speaker's, and
  the Concierge is "just a smarter router." That is acceptable — arguably correct — but
  it means "one identity" is delivered by *routing coherence + shared graph*, not by a
  single speaking actor. Blast radius: medium (new actor + ingress change), reversible
  (the Concierge can fall back to A's deterministic routing if disabled).

---

## 5. Option C — Promote one Speaker to Prime (no new agent type)

Instead of a new actor *type*, designate one managed chat's Speaker as **Prime** — the
front desk / lead you talk to. Global context = graph (unchanged). Global actor = the
**Prime Speaker**, reusing the Speaker agent, wired as the webhook sink brain + fallback
inbox + cross-chat coordinator. This makes the product frame literal: "he gets work done
through his team, but there is a lead you talk to" — Prime is the lead; peer chats are
per-project rooms.

### Context topology
- Global = graph (unchanged). Local rolls up (Scribe), global pushes down (digest).
- **New cross-thread primitive:** a `handoff` / `search_threads` tool so any Speaker can
  reach across chats via the graph (an additive tool alongside `lookup_graph`,
  `capabilities/graph/tools.ts:176-179`). Prime is the default target for uncorrelated
  events and the default coordinator for cross-chat handoffs.

### Agent set & felt identity
- Speaker (× N), Scribe. **No new agent type** — Prime is a *role flag* on one Speaker.
- **Felt identity = Prime**, concrete and singular. Planner demoted to backstage.

### Inbound routing primitive (replaces broadcast, no drops)
Ingress routes by graph like Option A; the fallback target is **Prime** (not an anonymous
inbox). Prime, being a full Speaker, can then re-route or handle an event it received by
fallback — using its model turn and the new `handoff` tool. No drop: Prime is the
guaranteed home.

### Non-blocking mechanism
Prime is a Speaker: already coalesced + async (`coalescer.ts`). Handoff between chats is
an async dispatch modeled on `specialist.result` delivery (`bridge.ts:44-57`).

### Key data shape
Graph + a thin thread registry — which largely already exists as Thread entities
(`store.ts:18-29` `thread` type) resolved via `graph_identities`.

### Honest tradeoffs
- **Good:** zero new agent types (reuses the Speaker wholesale) — lowest conceptual cost
  after A; concrete single identity (Prime); naturally models multi-project (each project
  = a peer chat, Prime coordinates); the `handoff` tool is a clean additive seam.
- **Bad / where it breaks:** Prime is special-cased and load-bearing. Its chat's *human
  conversation* and its *routing duties contend for the same coalescer window and the
  same turn* (`coalescer.ts:72-95`) — a human actively chatting in Prime's room slows
  global routing, and a noisy Prime room starves it. Mixing "front desk router" with
  "a real conversation" muddies concerns exactly where B keeps them clean. Cross-chat
  handoff routed through one Speaker's private working context (`speaker/agent.ts:27`)
  risks context bleed between projects. Blast radius: small-medium; reversible (unset the
  role flag).

---

## 6. Option D — Orchestrator + subscription bus, stateless Speakers (most powerful)

Full separation. A global **Orchestrator** owns all cross-chat decisions and a
first-class global context (graph + durable working memory + a routing/subscription
table). Inbound events hit an explicit **event bus**: a thread *subscribes* to a
repo/project/issue, subscriptions are evaluated deterministically, and the Orchestrator
handles only the residual (no match). Local Speakers become **thin** — transient turn
context only; the durable "who/what" lives globally and is pushed down per turn. New
agent types register as capabilities on the Orchestrator.

### Context topology
- Global = graph + Orchestrator working memory + subscription table. Local = ephemeral.
- Global pushes down heavily; local rolls up via Scribe *and* the bus.

### Agent set & felt identity
- Orchestrator (global) + thin Speakers + Scribe + specialists.
- **Felt identity = the Orchestrator**; Speakers are indistinguishable mouths of it —
  the strongest "one thing" of the four.

### Inbound routing primitive
Subscription bus (deterministic fan-out to subscribed chats) + Orchestrator for the
residual. Strongest structural no-drop: the residual *always* has the Orchestrator home,
and subscriptions make multi-subscriber ("two chats care") first-class.

### Non-blocking mechanism
Bus fan-out is async; the Orchestrator coalesces. But the path is now two hops
(event → bus → orchestrator/speaker) with more moving parts and more latency.

### Key data shape
Graph + `subscriptions` table + Orchestrator memory store — the most new machinery.

### Honest tradeoffs
- **Good:** cleanest one-identity; most extensible (dashboard, multi-project,
  new agents all natural); strongest no-drop via explicit subscriptions; "two chats care"
  is native.
- **Bad / where it breaks:** biggest blast radius and the only option that **regresses a
  working seam** — making Speakers stateless throws away the Speaker's durable private
  working context that today's design leans on ("retain useful private working context
  across turns," `speaker/agent.ts:27`). The subscription table largely **duplicates what
  graph edges already encode** (`works_on`/`part_of`/`about`, `store.ts:31-42`) — two
  sources of truth for the same routing fact. Highest latency + SPOF. And it is **YAGNI
  for the actual deployment**: one instance, two companies, web app stays
  (per project memory) — D builds a multi-tenant-shaped bus for a single instance.

---

## 7. Rubric — all options × the 8 forces

Scale: ✅ strong · 🟡 partial · ❌ weak/regresses.

| Force | A · Routing | B · Concierge | C · Prime | D · Orchestrator |
|---|---|---|---|---|
| 1 · Simplicity / floor-first | ✅ smallest diff | 🟡 one silent actor (fast-path = A) | 🟡 role flag, +1 tool | ❌ bus + table + memory |
| 2 · One-identity fidelity | ❌ chats stay islands | ✅ one routing brain, many mouths | ✅ concrete Prime lead | ✅ strongest |
| 3 · Non-blocking | ✅ untouched | ✅ own coalescer, async dispatch | 🟡 Prime chat ↔ routing contend | 🟡 two-hop, more latency |
| 4 · No-drop guarantee | 🟡 front-desk inbox (best-effort) | ✅ Concierge home + optional ledger | ✅ Prime is guaranteed home | ✅ subscriptions + residual home |
| 5 · Context coherence | ✅ one story, unchanged | ✅ graph + one router, clean split | 🟡 router role muddies a chat | ❌ subscription table dup's graph edges |
| 6 · Fit with existing seams | ✅ reuses all | ✅ Scribe-shaped actor, graph, delegation | ✅ reuses Speaker + tools | ❌ regresses stateful Speaker |
| 7 · Extensibility (#243/#249, dashboard, new agents) | 🟡 unblocks, doesn't model | ✅ all additive on Concierge | ✅ peer chats = projects | ✅ native, but heavy |
| 8 · Blast radius / reversibility | ✅ one function in ingress | 🟡 new actor + ingress, reversible to A | ✅ small, unset the flag | ❌ largest, hard to unwind |

---

## 8. Recommendation

**Ship A now; grow into B. Do not build D.**

- **A is the floor and it is inside B.** A's deterministic graph-lookup router replaces
  broadcast (`ingress.ts:518-525`) and the silent drop (`ingress.ts:474-489`) with a tiny,
  fully-reversible change that touches one function and reuses `graph_identities`. It
  pays down two of the three smells immediately and unblocks multi-project by replacing
  the hard-coded `managedChats[0]` home (`specialist-return.ts:8-16`).
- **A alone fails force #2.** Named islands are still islands — the product frame ("one
  thing you talk to, across chats") is a *hard* requirement, and A does not deliver it.
- **B is the destination and it composes with A, not replaces it.** The Concierge's
  fast-path *is* A's resolver; B adds the silent global actor that gives every event a
  real home (force #4 structural), moves the felt identity off the Planner onto a single
  routing brain (force #3 smell fixed), and becomes the one additive plug point for
  multi-project, a dashboard, and new agent types. It is "Scribe-shaped," so it fits the
  existing coalescer + silent-actor seams rather than inventing new ones.
- **C is the honest fallback** if a new agent type is unwanted: it delivers a concrete
  single identity with zero new types, at the cost of Prime's chat contending with its
  routing duties. Choose C over B only if "no new actor type" outranks clean separation.
- **D is out.** It is the only option that regresses a working seam (stateful Speaker,
  `speaker/agent.ts:27`) and duplicates the graph in a subscription table, for a
  single-instance deployment that does not need a multi-tenant bus.

**Sequenced plan:** (1) A's router + front-desk inbox — kills broadcast and silent drop.
(2) Decouple the three Planner roles — webhook owner and issue-writer stay backstage; the
felt identity is reassigned. (3) Introduce the Concierge as a silent actor whose
deterministic fast-path is A's resolver, whose residual path is a model decision, and
whose durability is an optional `unrouted_events` ledger. Each step is independently
shippable and reversible; B is reached without ever throwing A away.

### Where B still breaks (be adversarial)
- The Concierge that does not speak means the felt voice is still the Speaker's; "one
  identity" is delivered by routing coherence + shared graph, not a single speaking
  actor. If the product truly needs a single *voice* across chats, that is a further step
  (a Concierge that can speak *through* a chosen Speaker) — deliberately out of scope here
  to avoid re-centralizing into a bottleneck.
- A silent Concierge adds one inbound model turn. If inbound event volume ever dwarfs
  chat volume, its coalescer knobs must be tuned like the Scribe's laggy defaults
  (`scribe/coalescer.ts:6-9`) or the fast-path must bypass the model entirely for
  unambiguous correlations — design for the model turn to be *skippable*, not mandatory.
