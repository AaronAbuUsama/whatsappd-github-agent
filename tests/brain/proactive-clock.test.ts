import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createBrainInbox } from "../../packages/engine/src/brain/inbox.ts";
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

describe("proactive clock — Scheduled Wake + coalesced Proactive Sweep (§6)", () => {
  it("admits exactly one outstanding Proactive Sweep and never a duplicate while it is outstanding", () => {
    let clock = 0;
    const inbox = openInbox(fixture(), () => `2026-07-22T12:00:0${clock}.000Z`);

    clock = 1;
    const first = inbox.runProactiveClock();
    expect(first).toEqual({ admittedSweep: true, admittedWakes: 0 });

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

  it("content-addresses a self-scheduled wake so the same loop + time coalesces to one row", () => {
    const inbox = openInbox(fixture(), () => "2026-07-22T12:00:00.000Z");
    const wake = inbox.scheduleWake({ reason: "chase the deploy commitment", dueAt: "2026-07-22T14:00:00.000Z" });
    expect(wake.id).toMatch(/^scheduled-wake:[a-f0-9]{64}$/u);
    expect(inbox.scheduleWake({ reason: "chase the deploy commitment", dueAt: "2026-07-22T14:00:00.000Z" })).toEqual(wake);
    inbox.close();
  });

  it("a due wake survives restart and fires exactly once", () => {
    const databasePath = fixture();
    const scheduling = openInbox(databasePath, () => "2026-07-22T12:00:00.000Z");
    scheduling.scheduleWake({ reason: "chase the overdue review", dueAt: "2026-07-22T14:00:00.000Z" });
    scheduling.close(); // crash before the wake ever came due

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

  it("does not admit a wake that is not yet due", () => {
    const databasePath = fixture();
    const inbox = openInbox(databasePath, () => "2026-07-22T12:00:00.000Z");
    inbox.scheduleWake({ reason: "future check", dueAt: "2026-07-22T18:00:00.000Z" });
    // now < dueAt → the sweep is admitted but the future wake is not.
    expect(inbox.runProactiveClock()).toEqual({ admittedSweep: true, admittedWakes: 0 });
    expect(inbox.pendingScheduledWakes().filter((w) => w.kind === "scheduled")).toHaveLength(0);
    inbox.close();
  });

  it("rejects a non-ISO due time", () => {
    const inbox = openInbox(fixture(), () => "2026-07-22T12:00:00.000Z");
    expect(() => inbox.scheduleWake({ reason: "bad", dueAt: "whenever" })).toThrow("ISO-8601");
    inbox.close();
  });
});
