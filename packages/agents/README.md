# @ambient-agent/agents

Everything that thinks. Two kinds of thing live here, with an enforced arrow between them:

- **`speaker/` — an agent.** One folder per agent. The agent owns its *identity*: the
  Flue `defineAgent` definition (`agent.ts` — model, instructions, which capabilities it
  mounts), its composition root (`compose.ts`), its dispatch bridge (`dispatch.ts`), its
  observer vocabulary (`observer.ts`), and its activity reporter. Identity stays in
  `instructions`, not in a skill — Flue skills are progressively disclosed, so identity is
  precisely the frame a skill cannot carry (recorded on #131).
- **`capabilities/` — shared units of work, agent-agnostic.** A Capability is "a cohesive
  kind of work the Ambient Agent can perform for the group... the canonical way the product
  grows" (`CONTEXT.md`). Each bundle is: `SKILL.md` (the Skill — policy and process) +
  `tools.ts` (the Tools — validated operations) + a port at the seam + `evals/` (the
  capability's own proof: its deterministic and `.live` suites). Any agent may mount
  any capability; **capabilities may never import from an agent folder** (enforced by
  `tests/speaker/hard-cut.test.ts`). Ratified 2026-07-17; see
  `docs/planning/SHARED-CAPABILITIES-SPEC.md`.

## Current inventory

| Capability | Skill | Tools | Port / seam |
|---|---|---|---|
| `capabilities/issue-management` | Turn chat into well-formed GitHub issues (`SKILL.md` + `references/{labels,report-templates}.md`) | `createIssueManagementTools` — 10 tools with duplicate detection and Operation Identity uncertainty handling | `IssueRepository` (12-method port; production adapter: `@ambient-agent/installation/github-issue-repository.ts`, fakes in test-support) |
| `capabilities/whatsapp-participation` | How to behave in a group chat (`SKILL.md` + `references/rubric-traceability.md`) | `createWhatsAppParticipationTools(id)` — Say, React, read thread, search history; chat-bound per agent instance | `WhatsAppParticipationPort` (configured by the server's WhatsApp runtime; fakes in test-support) |

Agents: `speaker/` — "a continuing private ambient agent instance identified by its
managed WhatsApp chatId." A second agent arrives as a sibling folder mounting the same
capabilities.

## Adding an agent — the playbook

Worked example: a **codography** agent that reviews matching PRs. Five steps, in order:

1. **Identity** — `src/codography/agent.ts`: a Flue `defineAgent` with its own
   instructions ("You are Codography, …"), model choice, and the capabilities it mounts —
   existing ones (`skills: [issueManagement]`) and/or a new one (step 2). Sibling files as
   needed: `compose.ts` (its routes), `dispatch.ts` (its input type + dispatch pairing),
   `observer.ts` (its event vocabulary).
2. **Capability, if the work is new** — `src/capabilities/pr-review/`: `SKILL.md`
   (review policy), `tools.ts` (validated operations), and a port for the outside world
   (the `IssueRepository` pattern: interface here, Octokit adapter in
   `@ambient-agent/installation`). Capabilities never import an agent folder — that's the
   enforced seam that lets Speaker mount `pr-review` later for free.
3. **Intake** — what wakes it up. Speaker is woken by the Coalescer (WhatsApp Windows);
   codography is woken by GitHub webhooks, which already flow through
   `engine/github/ingress.ts` → routes → dispatch. Add a route whose filter is "PR
   matches the criteria" and whose dispatch calls the new agent's `dispatchCodography`.
4. **Activity** — do NOT write a new reporter. `engine/dispatch/dispatch-correlator.ts`
   is the shared machinery; the agent adds only its vocabulary:
   ```ts
   const correlator = createDispatchCorrelator<{ repository: string; prNumber: number }>();
   correlator.subscribe((event, ctx) => { /* "codography.reviewed" logs, observers */ });
   observe(correlator.ingest);   // import-time wiring, same as speaker
   ```
   and calls `correlator.accepted(receipt.dispatchId, context)` in its dispatch.
5. **Discovery + boundaries** — a 3-line re-export stub in `apps/runtime/src/agents/codography.ts`
   (Flue discovers agents by directory), wire its adapters in `app.ts`, and the hard-cut
   boundary test needs no new rule — the existing arrows already cover it.

**What's shared vs. owned:** engine machinery (correlator, ingress, stores, logging) and
`capabilities/` are shared; identity, composition, dispatch, and event vocabulary are the
agent's own. If two agents need the same code and it isn't a capability, it graduates
*down* to engine — never sideways into another agent's folder.

## Dependency arrows

Imports `@ambient-agent/engine` only. Imported by `apps/runtime` (composition + Flue
discovery) and `@ambient-agent/installation` (issue-repository types). `apps/cli`
**never** imports this package (enforced).

## Tested by

`tests/speaker/{agent-boundary,dispatch,issue-management,participation,whatsapp-runtime}.test.ts`,
`tests/logging/agent-activity-reporter.test.ts`; behavior is gated by the eval battery: each
capability's suites live in its own `evals/` folder, cross-capability mechanics and the
rubric judges in `packages/agents/evals/`, and the harness + Braintrust reporting in
test-support. The #113 baseline on this battery gates every structural refactor
("structure changed, behaviour didn't").
