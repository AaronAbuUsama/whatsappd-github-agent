# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues via the `gh` CLI; external PRs are not a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to the default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Codex desktop milestone orchestration

```text
CODEX DESKTOP APP ONLY

This protocol depends on Codex desktop thread tools such as list_projects,
create_thread, set_thread_title, wait_threads, read_thread, and
send_message_to_thread. Do not claim to follow it in another coding agent or
tool that does not provide those capabilities.

PURPOSE

Run multiple independent milestone tickets concurrently while one primary
Codex task remains the orchestrator. Each worker owns one coherent slice in an
isolated worktree, produces a real PR into the named integration branch, and
babysits that PR through CI and review. Workers do not merge their own PRs.

ORCHESTRATOR RESPONSIBILITIES

1. Ground the live frontier before dispatching.
   - Read the map/parent issue and every candidate child issue from GitHub.
   - Read native sub-issue and blocking edges; do not infer the DAG only from
     prose in an issue body.
   - Check assignees, open/merged PRs, CI, and whether an apparently open
     blocker is already implemented or stale.
   - Close or correct stale administrative gates before launching workers.

2. Partition by real ownership, not arbitrary worker count.
   - Parallelize only slices that can make useful progress independently.
   - Combine tickets that share the same central files or abstraction seam
     into one ordered worker lane to avoid predictable merge conflicts.
   - State dependencies inside a lane explicitly, for example: implement
     #181 before #180 in the same worktree.
   - Give every worker exclusive responsibility for named issues and files or
     modules. Tell every worker that other workers are active and that it must
     not revert their changes.

3. Create Codex worktree threads from the integration branch.
   - Call list_projects and use the returned projectId.
   - Call create_thread with target.type=project and
     environment.type=worktree.
   - Set startingState to the existing integration branch requested for the
     milestone, never to a dirty primary checkout.
   - Use the model/reasoning requested by the user. When the user asks for
     xhigh, set thinking=xhigh on every created coding thread.
   - After each queued worktree materializes, identify it by its actual owned
     issue from the prompt, not by creation order.
   - Rename it with set_thread_title using exactly:
       MILESTONE: #issue - short description
     Example:
       SAAS: #182 - per-tenant secret storage

4. Give every worker the complete worker contract below in its initial prompt.
   Do not assume a worker knows the integration branch, PR base, review loop,
   merge authority, account-access policy, or reporting format.

5. Supervise without taking over worker branches.
   - Use wait_threads with cursors for compact progress across all live tasks.
   - Use read_thread only when a progress snapshot is insufficient.
   - Use send_message_to_thread for corrections, new constraints, or answers.
   - Do not busy-poll or narrate unchanged snapshots.
   - When the integration branch advances, tell affected workers to update or
     rebase, resolve conflicts within their owned scope, rerun verification,
     and repeat review on the new head.

6. Keep product decisions with the orchestrator/user.
   - A worker must make every reversible step before stopping at a decision.
   - A decision request must show the actual code/problem, callers and blast
     radius, concrete code or diff options, and scores for floor-first,
     reversibility, blast radius, correctness/integrity, parallelizability,
     and fit with the existing system.
   - The orchestrator presents the narrow decision to the user and sends the
     answer back to the waiting worker.

7. Integrate only after independently checking the receipt.
   - Confirm the PR targets the intended integration branch.
   - Confirm the latest head, not an older commit, is CI-green and reviewed.
   - Confirm every review conversation has a reply and zero review threads are
     unresolved.
   - Confirm the PR body records scope, verification, proof boundaries, and
     Closes #issue links.
   - Confirm every material claim has reviewer-visible evidence from the
     current PR head. Browser/UI claims require uploaded media in the PR.
   - Workers leave merge-ready PRs open. The orchestrator/user chooses merge
     order after considering dependencies and interactions between parallel
     PRs.
   - After merge, verify GitHub closed every owned issue. Integration branches
     may not trigger GitHub's default-branch auto-close behavior, so manually
     comment with the merged PR/commit and close any issue that remains open.

WORKER THREAD CONTRACT

1. Start correctly.
   - Read AGENTS.md and the live owned issue(s) first.
   - Use codebase-memory graph tools before grep/file search for code discovery.
   - Fetch the remote integration branch, verify the worktree is based on its
     latest commit, and create a codex/ feature branch.
   - Never edit, clean, or commit from the user's dirty primary checkout.

2. Keep ownership narrow.
   - Work only on the assigned issue(s) and named seam.
   - Other workers are active: do not reset, delete, or revert their work.
   - Reuse existing helpers and dependencies. Build the smallest complete
     change that satisfies the acceptance proof.
   - Preserve security, validation, accessibility, and data integrity.

3. Prove the work.
   - Leave the smallest runnable regression check for non-trivial logic.
   - Run focused tests plus the repository checks proportionate to risk.
   - Use Chrome for browser and account work when the user says the required
     sessions are logged in. Try the logged-in session before requesting
     credentials. Ask for human action only at a true gate such as scanning a
     fresh WhatsApp QR.
   - Separate mechanically green, browser/runtime proven, and human-only proof
     in the PR body and final receipt.

4. Attach reviewer-visible PR evidence.
   - Every PR must include an Evidence section. Evidence must be accessible
     from the PR; a local path or "tested manually" is not evidence.
   - For non-visual code, include exact commands and concise results, API/CLI
     receipts, logs, or other proof tied to the current PR head.
   - For browser/UI work, upload a short video or GIF whenever practical. At
     minimum, upload screenshots showing the claimed flow or state working in
     the real browser. Cover relevant success/error, light/dark, and responsive
     states when they are part of the claim.
   - Refresh evidence after any change that invalidates it. Evidence from an
     older head is not proof of the current head.
   - Never expose secrets, access tokens, credentials, pairing QR/codes,
     private customer data, or unrelated personal information. Redact before
     uploading.
   - If a claim cannot be proven, say so explicitly and list it as human-only
     or not yet proven instead of implying that it passed.

5. Open a real PR.
   - Push the feature branch and open a ready-for-review PR into the named
     integration branch; do not default to draft.
   - Link the map and use Closes #issue for every implementation ticket owned
     by the PR.
   - Put reviewer-visible evidence and uploaded-media links in the PR body's
     Evidence section.
   - Do not merge the PR and do not prematurely close its GitHub issue while
     the PR remains unmerged.

PR BABYSITTING AND REVIEW-CONVERSATION LOOP

A push is not completion. Continue until the latest PR head is CI-green,
Codex has reviewed that head with no remaining findings/approval/👍, and the
unresolved review-thread count is zero.

1. After the initial push, wait for CI and the automatic Codex review, then
   post a top-level PR comment containing @codex review.

2. Inspect all review surfaces:
   - top-level PR conversation comments;
   - submitted reviews;
   - inline review comments and threads;
   - unresolved review threads;
   - CI annotations and failures.

3. Give every review comment an explicit disposition. Never only change code
   and leave the conversation unanswered.
   - Fixed: reply with what changed, the commit SHA, and the verification run.
     Example: "Fixed in abc1234: validate the tenant before claiming the
     lease. Added the concurrent-claim regression test; focused suite passes."
   - Not fixing: reply with the concrete reason and evidence, such as scope,
     an invariant, existing behavior, or a counterexample. Do not dismiss a
     finding without proof.
   - Question/clarification: answer directly with code or runtime evidence.

4. Resolve/close every review thread after posting its disposition and after
   the requested change is present on the PR head. Do not request re-review
   with stale unanswered or unresolved conversations.

5. If any finding requires a change:
   - implement and verify the fix;
   - commit and push it;
   - reply to the finding with the new commit and evidence;
   - resolve the thread;
   - wait for CI on the new head;
   - post @codex review again.

6. Repeat the full inspection after every push. Approval or a thumbs-up on an
   older commit does not approve a newer head. New findings restart the loop.

7. Before reporting merge-ready, verify all of the following:
   - latest-head CI is green;
   - the latest-head Codex review has no remaining findings/approval/👍;
   - every actionable comment has a written disposition;
   - unresolved review-thread count is zero;
   - the PR is conflict-free against the integration branch;
   - the PR body and issue links are current.

8. Do not merge. Return a final receipt to the orchestrator containing:
   - owned issue(s);
   - branch and final commit;
   - PR URL and base branch;
   - checks run and CI state;
   - reviewer-visible evidence links or artifacts;
   - Codex review evidence;
   - unresolved-thread count (must be zero);
   - remaining human-only proof or decisions.

ISSUE CLOSURE

- Review findings/comments: the worker replies to and resolves every thread as
  part of babysitting.
- Owned GitHub tickets: the PR carries Closes #issue, but the worker leaves the
  ticket open while the unmerged PR is waiting for orchestration.
- After merge: the orchestrator verifies closure and manually comments/closes
  any ticket that remained open because the PR targeted an integration branch.
```
