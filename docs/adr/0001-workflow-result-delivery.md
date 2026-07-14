---
status: accepted
date: 2026-07-14
---

# Workflow results reach the ambient agent through one durable-gated bridge

A Bounded Workflow's terminal result must come back to the owning chat's agent
instance as a new input — Flue's contract deliberately ends when the run record
is durably terminal (`invoke()` is admission-only; nothing feeds a result into
an agent conversation). We deliver through ONE generic execution interceptor
registered with `instrument()`, replacing per-workflow sink/interceptor/error
plumbing. Convention: any workflow whose input carries `chatId` gets delivery.
The bridge reads the durable run record (`getRun` → status, input, result,
error in one read) and only dispatches when the run is Durably Terminal, so a
chat is never told an outcome the store cannot back.

Long-run visibility is deliberately split across three surfaces:

1. **Terminal outcome** — the bridge (push, once, durable-gated).
2. **On-demand status** — a chat-bound read tool over the run record (pull).
3. **Milestones** — rare `workflow.progress` inputs a workflow explicitly
   dispatches at domain-significant moments.

`observe()` is telemetry-only (exporters, dashboards, evals). Its documented
contract — subscribers run synchronously on the emission path, returned
promises are not awaited, failures are logged and dropped — makes it a tap,
not a delivery mechanism.

## Considered options

- **Per-workflow sink + name-keyed interceptor** (the original shape):
  ~120 lines of ceremony per capability, split-brain wiring in app boot, and
  the pattern's return path owned by its least general participant.
- **Workflow self-delivery** (dispatch at the tail of `run()`): fewest lines,
  but dispatches before the run is Durably Terminal — a crash in that window
  tells the chat "completed" about a run recovery shows as active, violating
  the recovery contract (docs/architecture/ambience-recovery.md).
- **`observe()`-based delivery**: one registration for all workflows, but
  delivery is fire-and-forget by documented contract and it repurposes the
  telemetry surface as control flow — two reliability stories for the same
  consumer.
