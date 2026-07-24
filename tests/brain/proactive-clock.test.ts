import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { wakeBrain, type DispatchBrain } from "../../packages/agents/src/brain/dispatch.ts";
import { createBrainInbox, type BrainInbox } from "../../packages/engine/src/brain/inbox.ts";
import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// createBrainInbox prepares a statement against conversation_events, so the schema must exist first.
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ambient-proactive-clock-"));
  roots.push(root);
  const databasePath = join(root, "application.sqlite");
  createConversationArchive(databasePath).close();
  return databasePath;
};

const openInbox = (databasePath: string, now: () => string) =>
  createBrainInbox(databasePath, { providerChatIdForSurface: () => "chat@g.us", now });

// A self-scheduled wake is a local effect of an open, dispatched Batch (ADR 0006). Drive one into being
// by admitting a sweep, claiming it, and marking it dispatched — the realistic "Brain handling a sweep
// self-schedules a follow-up" flow.
const dispatchedBatch = (inbox: BrainInbox) => {
  inbox.runProactiveClock();
  const batch = inbox.claimBatch()!;
  return inbox.markBatchDispatched(batch.id, { dispatchId: `d:${batch.id}`, acceptedAt: batch.createdAt });
};

describe("proactive clock — Scheduled Wake + coalesced Proactive Sweep (§6, ADR 0006)", () => {
  it("admits exactly one outstanding Proactive Sweep and never a duplicate while it is outstanding", () => {
    let clock = 0;
    const inbox = openInbox(fixture(), () => `2026-07-22T12:00:0${clock}.000Z`);

    clock = 1;
    expect(inbox.runProactiveClock()).toEqual({ admittedSweep: true, admittedWakes: 0 });

    // A second tick while the first sweep is still outstanding (unclaimed) admits nothing.
    clock = 2;
    expect(inbox.runProactiveClock()).toEqual({ admittedSweep: false, admittedWakes: 0 });
    expect(inbox.pendingScheduledWakes()).toHaveLength(1);

    // Still outstanding once claimed into a Batch but not yet settled — no duplicate.
    clock = 3;
    const batch = inbox.claimBatch();
    expect(batch?.scheduledWakes).toHaveLength(1);
    expect(batch?.scheduledWakes[0]?.kind).toBe("sweep");
    expect(inbox.runProactiveClock()).toEqual({ admittedSweep: false, admittedWakes: 0 });

    // Settle the sweep's Batch, then a new tick admits the next sweep.
    clock = 4;
    inbox.markBatchDispatched(batch!.id, { dispatchId: "d1", acceptedAt: "2026-07-22T12:00:04.000Z" });
    inbox.recordSilence(batch!.id, "Nothing overdue this sweep.");
    inbox.settleBatch(batch!.id);
    clock = 5;
    expect(inbox.runProactiveClock()).toEqual({ admittedSweep: true, admittedWakes: 0 });
    inbox.close();
  });

  it("a transient wake failure leaves the sweep Batch open, and the next wake re-dispatches it (no wedge)", async () => {
    let clock = 0;
    const inbox = openInbox(fixture(), () => `2026-07-22T12:00:0${clock}.000Z`);
    clock = 1;
    inbox.runProactiveClock();

    // wakeBrain claims the sweep Batch, then the dispatch throws: the Batch is now open but undispatched.
    const failing: DispatchBrain = () => Promise.reject(new Error("transient dispatch failure"));
    await expect(wakeBrain(inbox, failing)).rejects.toThrow("transient");

    // The guard correctly sees it as still outstanding, so no duplicate sweep — but liveness must not wedge.
    clock = 2;
    expect(inbox.runProactiveClock()).toEqual({ admittedSweep: false, admittedWakes: 0 });

    // The next successful wake re-dispatches the SAME still-open Batch rather than leaving it stuck forever.
    clock = 3;
    const dispatched: string[] = [];
    const ok: DispatchBrain = (request) => {
      dispatched.push(request.input.batch.id);
      return Promise.resolve({ dispatchId: "d-ok", acceptedAt: "2026-07-22T12:00:03.000Z" });
    };
    const batch = await wakeBrain(inbox, ok);
    expect(batch?.dispatch?.dispatchId).toBe("d-ok");
    expect(batch?.scheduledWakes[0]?.kind).toBe("sweep");
    expect(dispatched).toHaveLength(1);
    inbox.close();
  });

  it("records a Brain Effect that commits with the wake row and settles with its Batch (ADR 0006)", () => {
    const inbox = openInbox(fixture(), () => "2026-07-22T12:00:00.000Z");
    const batch = dispatchedBatch(inbox);
    const wake = inbox.scheduleWake({ batchId: batch.id, reason: "chase the deploy", dueAt: "2026-07-22T14:00:00.000Z" });

    const effects = inbox.effects(batch.id).filter((e) => e.kind === "schedule_wake");
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({ kind: "schedule_wake", wakeId: wake.id, status: "completed" });

    // The completed effect lets the creating Batch settle cleanly — the wake is owned, not orphaned.
    expect(() => inbox.settleBatch(batch.id)).not.toThrow();
    inbox.close();
  });

  it("requires an open dispatched Batch and content-addresses the wake so a retry coalesces", () => {
    const inbox = openInbox(fixture(), () => "2026-07-22T12:00:00.000Z");
    expect(() =>
      inbox.scheduleWake({ batchId: "brain-batch:nope", reason: "x", dueAt: "2026-07-22T14:00:00.000Z" }),
    ).toThrow("not open and dispatched");
    const batch = dispatchedBatch(inbox);
    const wake = inbox.scheduleWake({ batchId: batch.id, reason: "chase", dueAt: "2026-07-22T14:00:00.000Z" });
    expect(wake.id).toMatch(/^scheduled-wake:[a-f0-9]{64}$/u);
    expect(inbox.scheduleWake({ batchId: batch.id, reason: "chase", dueAt: "2026-07-22T14:00:00.000Z" })).toEqual(wake);
    inbox.close();
  });

  it("gives two independent Batches distinct wakes for the same reason+time, and both fire (no collapse)", () => {
    let now = "2026-07-22T12:01:00.000Z";
    const inbox = openInbox(fixture(), () => now);

    const first = dispatchedBatch(inbox);
    const wakeA = inbox.scheduleWake({ batchId: first.id, reason: "chase the loop", dueAt: "2026-07-22T14:00:00.000Z" });
    inbox.recordSilence(first.id, "done a");
    inbox.settleBatch(first.id);

    now = "2026-07-22T12:02:00.000Z";
    const second = dispatchedBatch(inbox);
    // Same reason + same dueAt, but a genuinely separate scheduling decision → a distinct owed wake.
    const wakeB = inbox.scheduleWake({ batchId: second.id, reason: "chase the loop", dueAt: "2026-07-22T14:00:00.000Z" });
    inbox.recordSilence(second.id, "done b");
    inbox.settleBatch(second.id);

    expect(wakeB.id).not.toBe(wakeA.id);

    // Past the due time: both distinct wakes are independently admitted (not collapsed to one).
    now = "2026-07-22T15:00:00.000Z";
    expect(inbox.runProactiveClock().admittedWakes).toBe(2);
    const firedIds = (inbox.claimBatch()?.scheduledWakes ?? []).filter((w) => w.kind === "scheduled").map((w) => w.id);
    expect(new Set(firedIds)).toEqual(new Set([wakeA.id, wakeB.id]));
    inbox.close();
  });

  it("a reschedule cancels the named predecessor so only the replacement fires", () => {
    const databasePath = fixture();
    const scheduling = openInbox(databasePath, () => "2026-07-22T12:00:00.000Z");
    const batch = dispatchedBatch(scheduling);
    const predecessor = scheduling.scheduleWake({ batchId: batch.id, reason: "chase the review", dueAt: "2026-07-22T14:00:00.000Z" });
    const replacement = scheduling.scheduleWake({
      batchId: batch.id,
      reason: "chase the review",
      dueAt: "2026-07-22T16:00:00.000Z",
      predecessorId: predecessor.id,
    });
    expect(replacement.id).not.toBe(predecessor.id);
    scheduling.recordSilence(batch.id, "rescheduled");
    scheduling.settleBatch(batch.id);
    scheduling.close();

    // Past BOTH due times: only the replacement fires; the cancelled predecessor never does.
    const inbox = openInbox(databasePath, () => "2026-07-22T18:00:00.000Z");
    expect(inbox.runProactiveClock().admittedWakes).toBe(1);
    const fired = (inbox.claimBatch()?.scheduledWakes ?? []).filter((w) => w.kind === "scheduled");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.id).toBe(replacement.id);
    expect(fired[0]?.dueAt).toBe("2026-07-22T16:00:00.000Z");
    inbox.close();
  });

  it("a due wake survives restart and fires exactly once", () => {
    const databasePath = fixture();
    const scheduling = openInbox(databasePath, () => "2026-07-22T12:00:00.000Z");
    const creating = dispatchedBatch(scheduling);
    scheduling.scheduleWake({ batchId: creating.id, reason: "chase the overdue review", dueAt: "2026-07-22T14:00:00.000Z" });
    scheduling.recordSilence(creating.id, "Scheduled a follow-up; nothing else this sweep.");
    scheduling.settleBatch(creating.id); // free the frontier, then crash before the wake ever came due
    scheduling.close();

    // Restart AFTER it is due — boot due scan admits it exactly once.
    const rebooted = openInbox(databasePath, () => "2026-07-22T15:00:00.000Z");
    expect(rebooted.runProactiveClock().admittedWakes).toBe(1);
    // A second due scan on the same live process does not re-admit it.
    expect(rebooted.runProactiveClock().admittedWakes).toBe(0);

    const batch = rebooted.claimBatch();
    const wakes = batch?.scheduledWakes.filter((w) => w.kind === "scheduled") ?? [];
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.reason).toBe("chase the overdue review");
    expect(wakes[0]?.dueAt).toBe("2026-07-22T14:00:00.000Z");
    rebooted.close();

    // Restart again: the wake is already claimed, so no further tick re-fires it.
    const again = openInbox(databasePath, () => "2026-07-22T16:00:00.000Z");
    expect(again.runProactiveClock().admittedWakes).toBe(0);
    expect(again.pendingScheduledWakes().filter((w) => w.kind === "scheduled")).toHaveLength(0);
    again.close();
  });

  it("normalizes a non-UTC-offset dueAt to canonical UTC so it fires when the instant is actually due", () => {
    const databasePath = fixture();
    const inbox = openInbox(databasePath, () => "2026-07-22T12:30:00.000Z");
    const batch = dispatchedBatch(inbox);
    // +02:00 14:00 is 12:00 UTC — already past a 12:30 UTC now. Raw-string ordering would wrongly skip it.
    const wake = inbox.scheduleWake({ batchId: batch.id, reason: "offset check", dueAt: "2026-07-22T14:00:00.000+02:00" });
    expect(wake.dueAt).toBe("2026-07-22T12:00:00.000Z");
    inbox.recordSilence(batch.id, "done");
    inbox.settleBatch(batch.id);
    expect(inbox.runProactiveClock().admittedWakes).toBe(1);
    inbox.close();
  });

  it("does not admit a wake that is not yet due", () => {
    const inbox = openInbox(fixture(), () => "2026-07-22T12:00:00.000Z");
    const batch = dispatchedBatch(inbox);
    inbox.scheduleWake({ batchId: batch.id, reason: "future check", dueAt: "2026-07-22T18:00:00.000Z" });
    inbox.recordSilence(batch.id, "done");
    inbox.settleBatch(batch.id);
    // now < dueAt → the sweep is admitted but the future wake is not.
    expect(inbox.runProactiveClock()).toEqual({ admittedSweep: true, admittedWakes: 0 });
    expect(inbox.pendingScheduledWakes().filter((w) => w.kind === "scheduled")).toHaveLength(0);
    inbox.close();
  });

  it("rejects a non-ISO due time", () => {
    const inbox = openInbox(fixture(), () => "2026-07-22T12:00:00.000Z");
    const batch = dispatchedBatch(inbox);
    expect(() => inbox.scheduleWake({ batchId: batch.id, reason: "bad", dueAt: "whenever" })).toThrow("ISO-8601");
    inbox.close();
  });
});
