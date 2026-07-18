# Handoff: final consistency sweep of the Memory & state arm

**For:** a fresh agent, clean context. **Mode:** read-only review → **report findings only, do
not edit or push anything** without an explicit go-ahead from Aaron (house rule:
"review means report, not fix"). File nothing; comment on nothing. Produce one findings
report.

**Why you exist:** the memory & state arm of map #132 was designed across many HITL
grilling sessions and then *assembled* (spec + a populated milestone) in one long session.
Assembly touched a lot of surfaces quickly. Before the arm is considered done, one
independent pass should confirm the assembled artifacts are mutually consistent and
faithful to the ratified record. You are that pass. Be skeptical; assume drift exists.

---

## The artifacts (what to sweep)

**Spec (under review, open PR):**
- `docs/planning/MEMORY-STATE-SPEC.md` — the assembled narrative. On branch
  `docs/145-memory-state-spec`, open as **PR #159** → `main`.

**The ratified record (source of truth — the closed decision tickets):**
- #133 roster · #134 identity mechanics · #135 identity model · #136 Coder ·
  #137 skill standard · #140 ontology (incl. the SQL) · #141 Scribe (6 decisions) ·
  #142 state injection (6 decisions **+ the #144-reconciliation comment** superseding its
  D6 routing note) · #143 Worker contract (defers delivery to **ADR 0001**) ·
  #144 broadcast fan-out · #146 commitment lifecycle · #149 cadence (amends #141 D1).
- Read each ticket's **resolution comment** with `gh issue view <n> --repo AaronAbuUsama/ambient-agent --json body,comments`.

**The filed milestone-7 issues (under review — the "populate the milestone" deliverable):**
- #152 Graph store (schema + 4 tools) · #153 Credential migration (PAT→3 Apps) ·
  #154 Broadcast ingress · #155 Scribe + cadence · #156 State injection ·
  #157 Delegation transport (ledger, boot sweep, ADR 0001 bridge) · #158 Coder workflow ·
  #150 Ambience→Speaker rename (pre-existing).

**Native blocking edges filed** (verify with `gh api repos/AaronAbuUsama/ambient-agent/issues/<n> --jq .issue_dependencies_summary`):
- #155 ← #152 · #156 ← #152 · #157 ← #154 · #158 ← #157, #153, #156.

**In-flight companions (NOT part of #145, but the arm must be consistent with them):**
- **PR #148** (`docs/glossary-shared-graph`) — adds the CONTEXT.md **"Shared graph"**
  glossary (The Graph, Scribe, Entity, Relation, Confidence, Provenance, Commitment,
  Cross-platform identity). Open, unmerged.
- **PR #151** (`task/138`) — agent-neutral capability wording (#138). Open.
- **ADR 0001** `docs/adr/0001-workflow-result-delivery.md` — the Worker-result delivery
  bridge the contract defers to.
- **ADR 0012** `docs/adr/0012-use-a-personal-token-before-github-app-installations.md` —
  the personal-token deferral #135 retires (superseded-marking deferred to #153).
- The map **#132** (`wayfinder:map`): Destination / Notes / Decisions-so-far / Not-yet-specified (fog) / Out-of-scope.

---

## The sweep — nine consistency axes

Work these deliberately; cite `file:line` or `issue#§` for every finding.

1. **Spec ↔ record fidelity.** For each decision ticket, does the spec's section state the
   ratified decision *correctly and completely*? Flag any claim in the spec that the
   record does not support, and any ratified decision the spec drops or softens.

2. **Spec ↔ issue fidelity.** Each milestone issue should implement exactly its spec
   section(s) — no more, no less. Flag scope a spec section assigns to an issue that the
   issue omits, and scope an issue claims that the spec didn't put there.

3. **Issue ↔ issue coherence.** The seams cross issues — verify they agree at both ends:
   - the **`graphContext` digest field** (#156 defines it; #157 carries it on the job
     input + `worker.result`; #158 consumes it; #155's Workers-read path);
   - the **`worker.result` input member** (#157 creates it; #155 reads it for `works_on`/
     `resolves`; #156 ensures `graphContext` rides on it);
   - the **worker-return-address resolver** (#154 provides `resolveWorkerReturnChat`; #157
     calls it);
   - **idempotency** (#157 states principle C; #158 applies per-issue natural keys, no
     opaque store) — no contradiction;
   - the **four ontology tools** (#152 defines; #155 mounts all/writes; #156 mounts the
     read+resolution subset on the Speaker, `lookup_graph` on Workers) — the read/write
     split must match #142 D5/D6 exactly (`record_relation` Scribe-only).

4. **The five divergence reconciliations — applied *everywhere*, not just named once.**
   a) Speaker **holds** an identity (Planner's App) — #135 supersedes #133's "no identity".
   b) #140 Q3 "coalesced window" = "same conversation, sibling inputs" (#141 Seam #2).
   c) `discusses` is **context signal, not a routing trigger** (#144 unwelded routing).
   d) Scribe cadence is **debounced per burst**, not per input (#149 amends #141 D1).
   e) `buildGraphDigest` is the **Speaker's read context, not a routing primitive** (#142
      reconciliation comment). Check the spec *and* the issues for any lingering statement
      of the pre-reconciliation version (e.g. an issue still calling `discusses` "the
      fan-out edge", or implying a graph query in the routing path).

5. **Vocabulary.** Speaker / Scribe / Worker / the graph used consistently across spec +
   issues; no stray "Ambience"/"Specialist" except as deliberately-labelled retired terms.
   **Known gap to confirm, not re-discover:** PR #148's glossary adds the Shared-graph
   section but leaves the old **"Ambience"** entry and the **"Specialist" (Avoid: Worker)**
   entry — the latter now contradicts the ratified "Worker". Confirm whether that is
   tracked (it is flagged for #148/#150) and whether the spec/issues anywhere depend on the
   stale entries.

6. **Code anchors.** The issues cite real `file:line` (e.g. `dispatch.ts:19`,
   `app.ts:43`, `ingress.ts:201`, `inputs.ts:127`, `coalescer/coalescer.ts:68-142`,
   `pi-subscription.ts:175`, `github-issue-repository.ts:141`). Spot-check that each still
   resolves on `main`. **Expected churn:** anchors under `packages/agents/src/ambience/`
   will move when #150 renames the dir to `speaker/` — that is known, not a defect; just
   confirm the anchors are correct *as of today's `main`*.

7. **Blocking DAG.** Do the native edges match real build order and the spec's §12 table?
   Look for a missing edge (an issue that truly needs a predecessor but isn't blocked) or a
   spurious one. Confirm #150 is intentionally a soft "land first" (no hard edge) per
   Aaron's round-1 ratification.

8. **Map ↔ reality.** After #145's resolution, #132's *Decisions-so-far* should gain the
   #145 line, the *fog* should have the graduated **cadence** and **ambience→speaker
   rename** lines cleared (both now filed as #149/#155 and #150), and the remaining fog
   should be the **monologue agent** (keyless consolidation + overdue-commitment nudges)
   and **hosted/supervisor** items only. **#147 (Reviewer) must be recorded as the one
   open suite decision.** Flag anything stale.

9. **ADR references.** ADR 0001 path/claims cited correctly by #157 and the spec; the
   ADR-0012 supersession is tracked (deferred to #153), not silently dropped.

---

## Known-open items (already identified — don't just re-report these; verify they're handled)

- **Specialist→Worker / Ambience-entry** stale glossary lines (axis 5) — flagged for #148/#150.
- **ADR 0012 superseded-marking** deferred to #153 (axis 9).
- **`ambience/` file anchors** will churn under #150 (axis 6) — cosmetic, expected.
- **#147 Reviewer** is an *open decision*, deliberately excluded from this arm; its
  implementation issue lands after it ratifies, reusing #157 transport + #153 identity +
  the #158 Coder template.

## Deliverable

One findings report, grouped by the nine axes, each finding with a `file:line` or
`issue#§` citation and a one-line "why it's inconsistent". Rank by severity (a wrong
ratified decision > a stale anchor > a wording nit). If an axis is clean, say so
explicitly. **Do not fix anything** — hand the report to Aaron; he decides what to action.

## Pointers

- Read order: this file → `docs/planning/MEMORY-STATE-SPEC.md` → the decision tickets →
  the filed issues. The map #132 body frames the whole arm.
- Issue-tracker ops: `docs/agents/issue-tracker.md` (Wayfinding operations).
- Repo: `AaronAbuUsama/ambient-agent`. Everything is `gh`-readable; nothing here requires a
  running rig.
