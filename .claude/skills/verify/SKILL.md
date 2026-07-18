---
name: verify
description: Behavior-verify the ambient-agent runtime by driving the real WhatsApp thread → GitHub, on the live code-factory rig. Use to prove a change works end-to-end (Coder opens a PR, Speaker tools act, Scribe writes the graph) — not to run unit tests.
---

# Verify ambient-agent (runtime, not tests)

Verification here is **runtime observation of the real product**: drive the WhatsApp
thread as a user would, watch the agent act on GitHub and the graph, capture evidence.
Unit tests and typecheck are CI's job — they prove nothing about whether the live
system behaves. Do not run them here.

## The surfaces

| Layer | How you reach it |
|---|---|
| WhatsApp thread (the human interface) | the **Chrome tab** at web.whatsapp.com, Tst group `120363410063306573@g.us`, driven via `mcp__claude-in-chrome__*` |
| The runtime | ssh **code-factory**, tmux session `ambient`, data-dir `~/validate-88/issue126-data` |
| GitHub (what the agent did) | `gh` against `AaronAbuUsama/ambient-agent` — PRs, issues, authors, diffs |
| State | `~/validate-88/issue126-data/application.sqlite` (graph_entities/relations/identities, delegation_launches) |

## Build → deploy → drive (the loop)

1. **Build the tarball** from the branch under test:
   `pnpm run build && npm pack` → `ambient-agent-<v>.tgz` (rename with the short SHA).
2. **Ship + restart** on the rig:
   `scp` the tgz to `code-factory:~/validate-88/`, then in tmux session `ambient`:
   `npx --yes --package=file:$HOME/validate-88/<tgz> ambient-agent --data-dir $HOME/validate-88/issue126-data start`
   Confirm `curl -s localhost:42069/health` → `ok:true, runtime.state:healthy, whatsapp.phase:online`.
   Sanity: `... smoke` → expect 6/6 PASS.
3. **Drive the Tst group** in the Chrome tab (WhatsApp Web must be logged in): type as a
   user — never call internals. Send with the composer, screenshot each reply.
4. **Capture evidence per scenario** into `docs/proof/evidence/<scenario>/`:
   - screen recording / screenshots of the WhatsApp exchange (the human-visible proof),
   - rig log slice: `tmux capture-pane -t ambient -p -S -N` or the `~/validate-88/*-start.log`,
   - DB delta: a scripted SELECT over `application.sqlite` before/after,
   - GitHub: `gh pr view <n> --json author,isDraft,body,files` + `gh pr diff <n>`.

## The core arc (create → code → PR)

Drive these in one continuous session; each step's pass criteria is observable:

1. **File an issue** — "file an issue: add a CODEOWNERS file assigning everything to me."
   → PASS when the issue is created and its author is `ambient-planner[bot]` (`gh issue view`).
2. **Code it** — "now code issue #N."
   → PASS when the Speaker acks non-blockingly, a ledger row appears
   (`select * from delegation_launches`), and a **PR by `ambient-coder[bot]`** lands with a
   **rich, ANSI-free, model-authored body** (`gh pr view --json author,body`). Green issue → non-draft.
3. **Seam #1** — after the result: `works_on` + `resolves` edges in `graph_relations`.

## Probes (push past the happy path)

- `check_jobs` mid/post-run — "what jobs have you run?" → lists the run + status.
- Full Speaker tool sweep (cheap): `react`, `whatsapp_read_thread`, `whatsapp_search`,
  the `github_*` issue tools (under `ambient-planner[bot]`), `lookup_graph`, `merge_entities`.
- Scribe smoke: send a commitment ("I'll do X by Friday") → row in `graph_entities` (commitment,
  `made_by` exactly-one, due normalized).
- A malformed request (nonexistent issue #) → honest error, not a crash.

## Report

Append a dated verdict table to `docs/proof/behavior-battery.md`: scenario · PASS/FAIL ·
evidence path · one-line observation. Lead findings with anything that made you pause.

## Gotchas

- WhatsApp Web logged out → can't drive; needs a phone QR scan (Aaron).
- Orca/desktop-app path needs the Orca app running; the Chrome tab is the reliable surface.
- The rig's `/tmp` is `noexec` — a Coder run that shells out to `/tmp` fails EACCES unless the
  build under test sets a workspace-local `TMPDIR` (that's #172).
