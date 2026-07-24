import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createScribeInbox } from "../../packages/engine/src/scribe/inbox.ts";
import type { SpeakerInput } from "../../packages/engine/src/inputs.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const observation = (chatId: string, id: string, occurredAt: number, source: "live" | "historical_replay") => {
  const input: SpeakerInput = {
    type: "whatsapp.window",
    windowId: `${source}:${id}`,
    chatId,
    reason: "capacity",
    messages: [
      {
        id,
        evidenceId: `arrival:${chatId}:${id}`,
        chatId,
        from: "person@s.whatsapp.net",
        text: id,
        timestamp: occurredAt,
        isGroup: true,
        fromMe: false,
        live: source === "live",
        mentions: [],
      },
    ],
    updates: [],
    eventOrder: [id],
  };
  return { evidenceId: `arrival:${chatId}:${id}`, occurredAt, source, input } as const;
};

describe("durable global Scribe inbox", () => {
  it("deduplicates live and replay admission and claims one chronological cross-chat wave", () => {
    const inbox = createScribeInbox(":memory:", { now: () => 100 });
    const early = observation("chat-b", "early", 10, "historical_replay");
    const middle = observation("chat-a", "middle", 20, "live");
    const late = observation("chat-b", "late", 30, "live");

    expect(inbox.admit([late, early, middle])).toBe(3);
    expect(inbox.admit([{ ...early, source: "live" }])).toBe(0);

    const wave = inbox.claimWave(2, 50);
    expect(wave).toHaveLength(2);
    expect(wave.flatMap(({ evidenceIds }) => evidenceIds)).toEqual([
      early.evidenceId,
      middle.evidenceId,
      late.evidenceId,
    ]);
    expect(wave.flatMap(({ inputs }) => inputs.map((input) => (input.type === "whatsapp.window" ? input.chatId : input.type)))).toEqual([
      "chat-b",
      "chat-a",
      "chat-b",
    ]);
    inbox.close();
  });

  it("reopens exact unfinished Batch membership after restart and records fresh attempts", () => {
    const root = mkdtempSync(join(tmpdir(), "scribe-inbox-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const first = createScribeInbox(path, { now: () => 100 });
    first.admit([
      observation("chat-a", "one", 10, "live"),
      observation("chat-b", "two", 20, "historical_replay"),
    ]);
    const original = first.claimWave(1, 50)[0]!;
    first.beginAttempt(original.id, "scribe-attempt:first");
    first.close();

    const reopened = createScribeInbox(path, { now: () => 200, recoverInterruptedAttempts: true });
    const recovered = reopened.claimWave(1, 50)[0]!;
    expect(recovered.id).toBe(original.id);
    expect(recovered.evidenceIds).toEqual(original.evidenceIds);
    expect(recovered.inputs).toEqual(original.inputs);
    expect(recovered.attempts).toEqual([
      { id: "scribe-attempt:first", status: "interrupted", startedAt: 100, finishedAt: 200 },
    ]);

    reopened.beginAttempt(recovered.id, "scribe-attempt:second");
    reopened.completeAttempt(recovered.id, "scribe-attempt:second");
    expect(reopened.claimWave(1, 50)).toEqual([]);
    expect(reopened.isEvidenceComplete(recovered.evidenceIds)).toBe(true);
    reopened.close();
  });

  it("returns a failed Batch to the durable pending frontier without changing its identity", () => {
    const inbox = createScribeInbox(":memory:", { now: () => 100 });
    inbox.admit([observation("chat-a", "retry", 10, "live")]);
    const batch = inbox.claimWave(1, 50)[0]!;
    inbox.beginAttempt(batch.id, "scribe-attempt:one");
    inbox.failAttempt(batch.id, "scribe-attempt:one", "model unavailable");

    const retried = inbox.claimWave(1, 50)[0]!;
    expect(retried.id).toBe(batch.id);
    expect(retried.attempts).toEqual([
      {
        id: "scribe-attempt:one",
        status: "failed",
        error: "model unavailable",
        startedAt: 100,
        finishedAt: 100,
      },
    ]);
    inbox.close();
  });

  it("does not interrupt a live attempt when Historical Replay opens the same inbox", () => {
    const root = mkdtempSync(join(tmpdir(), "scribe-inbox-concurrent-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const live = createScribeInbox(path, { now: () => 100 });
    live.admit([observation("chat-a", "active", 10, "live")]);
    const batch = live.claimWave(1, 50)[0]!;
    live.beginAttempt(batch.id, "scribe-attempt:active");

    const replay = createScribeInbox(path, { now: () => 200 });
    expect(replay.claimWave(1, 50)).toEqual([]);
    replay.close();

    expect(() => live.completeAttempt(batch.id, "scribe-attempt:active")).not.toThrow();
    live.close();
  });
});
