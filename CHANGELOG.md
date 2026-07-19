# ambient-agent

## 0.5.0

### Minor Changes

- e572490: Add the standalone Reviewer GitHub App workflow for automatic, sandboxed pull-request reviews.
- 6fce77f: Run new coding jobs through a deterministic Planner, bounded Coder/Verifier loop, then publish the exact verified workspace as a ready or draft pull request.
- cf9a592: Backfill managed WhatsApp history through each chat's persistent Scribe agent before handing the chat to live extraction.
- 5eecb2b: Add typed Codex-style Reviewer findings and authorized `@reviewer review` pull-request admission.

## 0.4.0

### Minor Changes

- 321241a: Memory & state (milestone 7): the shared graph in application.sqlite with four ontology tools; the silent per-thread Scribe with debounced extraction; proactive graph digests on every Speaker input plus a confirm/resolution surface; GitHub App identities for Coder/Reviewer/Planner replacing the personal token; broadcast GitHub ingress; the delegation transport (run ledger, durable result bridge, boot sweep, check_jobs); and the Coder — the first workflow-wrapped Specialist, opening real PRs under ambient-coder[bot] behind a green-gate.

## 0.3.0

### Minor Changes

- f3d1fe6: Add chat-bound WhatsApp reactions, message-ID quote replies, and persisted participation proof for captured-issue pull-request links.
- e362401: Replace the ambient participation policy with ratified multi-file Ambience and issue-capture skill bundles, add native WhatsApp reply targets, and route pull-request links for issues captured by Ambience.
- 3cb1144: Add the composed live smoke battery and observer-backed WhatsApp canary.
- d9718d1: Carry WhatsApp reactions, edits, and revocations into debounced Ambience Windows while keeping receipts journal-only and removing their obsolete projections.

### Patch Changes

- 8dcc3ae: Harden WhatsApp reactions and Say with native quotes through truthful delivery receipts, grapheme-aware emoji validation, fail-fast message lookup, and provider-echo admission proof.
- cd4a029: Reject malformed smoke canary receipts consistently across the runtime request and station report.
- f1606f7: Show inbound chat text, confirmed Say text, deliberate silence, and perceptible Say-side typing on the default console/runtime path.

## 0.2.2

### Patch Changes

- e54277e: Report the installed package version from the Ambient Agent CLI.

## 0.2.1

### Patch Changes

- 5ea7f9e: Make packaged-runtime verification follow the current package version and document the npm OIDC proof boundary.

## 0.2.0

### Minor Changes

- 7f26ebb: Ship the stable Ambient Agent CLI: validated first-run setup, managed ChatGPT OAuth, WhatsApp service discovery and chat admission, authorized GitHub issue management, local diagnostics and recovery, and the packaged runtime journey.
