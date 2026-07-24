import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";
import { createHistoricalReplayStore } from "../../packages/engine/src/intake/historical-replay.ts";
import type { ConversationEvent } from "../../packages/engine/src/intake/conversation-event.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const arrival = (chatId: string, id: string, occurredAt: number): ConversationEvent => ({
  id: `arrival:${chatId}:${id}`,
  kind: "arrival",
  providerMessageId: id,
  chatId,
  senderId: "person@s.whatsapp.net",
  direction: "inbound",
  occurredAt,
  payload: { live: false, isGroup: true, messageKind: "text", text: id },
});

describe("global Historical Replay", () => {
  it("migrates the legacy per-chat cursor table and removes the obsolete surface", () => {
    const root = mkdtempSync(join(tmpdir(), "historical-replay-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE scribe_backfills (
      chat_id TEXT PRIMARY KEY, mode TEXT NOT NULL, phase TEXT NOT NULL,
      snapshot_high_water INTEGER, snapshot_unknown_time INTEGER,
      snapshot_occurred_at_ms INTEGER, snapshot_sequence INTEGER,
      after_sequence INTEGER NOT NULL DEFAULT 0, run_id TEXT, last_error TEXT,
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
    INSERT INTO scribe_backfills
      (chat_id, mode, phase, after_sequence, updated_at_ms)
      VALUES ('chat', 'live', 'tail', 42, 1);`);
    database.close();

    const store = createHistoricalReplayStore(path, () => 2);
    expect(store.get("chat")).toMatchObject({ chatId: "chat", mode: "live", afterSequence: 42 });
    store.close();

    const inspected = new DatabaseSync(path);
    expect(
      inspected.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scribe_backfills'").get(),
    ).toBeUndefined();
    inspected.close();
  });

  it("hands empty Surface snapshots directly to live without a workflow run", () => {
    const root = mkdtempSync(join(tmpdir(), "historical-replay-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const archive = createConversationArchive(path);
    archive.close();
    const store = createHistoricalReplayStore(path, () => 1);
    expect(store.admit("chat")).toBe(true);
    store.captureSnapshots();
    expect(store.nextBatch()).toBeUndefined();
    expect(store.advance()).toBe(1);
    expect(store.advance()).toBe(1);
    expect(store.get("chat")).toMatchObject({ mode: "live", phase: "tail", afterSequence: 0 });
    store.close();
  });

  it("builds one bounded chronological batch across chats and skips receipt-only prompts", () => {
    const root = mkdtempSync(join(tmpdir(), "historical-replay-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const archive = createConversationArchive(path);
    archive.append(arrival("chat-a", "late", 20));
    archive.append(arrival("chat-b", "early", 10));
    archive.append(arrival("chat-b", "last", 30));
    archive.append({
      id: "receipt-1",
      kind: "receipt",
      providerMessageId: "early",
      chatId: "chat-a",
      direction: "inbound",
      occurredAt: 25,
      payload: { status: "read" },
    });
    archive.close();
    const store = createHistoricalReplayStore(path, () => 1);
    expect(store.admit("chat-a")).toBe(true);
    expect(store.admit("chat-b")).toBe(true);
    expect(store.admit("chat-a")).toBe(false);
    store.captureSnapshots();
    const batch = store.nextBatch(4)!;
    expect(batch.inputs.flatMap(({ messages }) => messages.map(({ id }) => id))).toEqual(["early", "late", "last"]);
    expect(batch.inputs.map(({ chatId }) => chatId)).toEqual(["chat-b", "chat-a", "chat-b"]);
    expect(batch.archiveEventCount).toBe(4);
    expect(batch.receiptCount).toBe(1);
    store.checkpoint(batch);
    expect(store.nextBatch()).toBeUndefined();
    expect(store.advance()).toBe(2);
    expect(store.advance()).toBe(2);
    expect(store.advance()).toBe(0);
    store.close();
  });

  it("does not promote one Surface to live ahead of the global replay frontier", () => {
    const root = mkdtempSync(join(tmpdir(), "historical-replay-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const archive = createConversationArchive(path);
    archive.append(arrival("chat-b", "still-replaying", 10));
    archive.close();
    const store = createHistoricalReplayStore(path, () => 1);
    store.admit("chat-a");
    store.admit("chat-b");
    store.captureSnapshots();

    expect(store.advance()).toBe(0);
    expect(store.get("chat-a")?.phase).toBe("snapshot");
    const batch = store.nextBatch()!;
    store.checkpoint(batch);
    expect(store.advance()).toBe(2);
    expect(store.states().map(({ phase }) => phase)).toEqual(["tail", "tail"]);
    expect(store.advance()).toBe(2);
    expect(store.states().map(({ mode }) => mode)).toEqual(["live", "live"]);
    store.close();
  });

  it("moves a drained snapshot to the shared tail without waiting on an older tail scanner", () => {
    const root = mkdtempSync(join(tmpdir(), "historical-replay-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const archive = createConversationArchive(path);
    archive.close();
    const store = createHistoricalReplayStore(path, () => 1);
    store.admit("chat-a");
    store.captureSnapshots();
    expect(store.advance()).toBe(1);

    const later = createConversationArchive(path);
    later.append(arrival("chat-a", "tail-pending", 20));
    later.append(arrival("chat-b", "snapshot-first", 10));
    later.close();
    store.admit("chat-b");
    store.captureSnapshots();

    const snapshot = store.nextBatch(1)!;
    expect(snapshot.inputs[0]!.chatId).toBe("chat-b");
    store.checkpoint(snapshot);
    expect(store.advance()).toBe(1);
    expect(store.get("chat-b")?.phase).toBe("tail");
    expect(store.nextBatch()).toBeUndefined();
    expect(store.advance()).toBe(2);
    expect(store.nextBatch(1)!.inputs[0]!.messages[0]!.id).toBe("tail-pending");
    store.close();
  });

  it("uses the chronological tail cursor without replaying a higher rowid twice", () => {
    const root = mkdtempSync(join(tmpdir(), "historical-replay-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const archive = createConversationArchive(path);
    archive.close();
    const store = createHistoricalReplayStore(path, () => 1);
    store.admit("chat");
    store.captureSnapshots();
    expect(store.advance()).toBe(1);

    const tail = createConversationArchive(path);
    tail.append(arrival("chat", "later-time-lower-rowid", 30));
    tail.append(arrival("chat", "earlier-time-higher-rowid", 20));
    tail.close();

    expect(store.nextBatch()).toBeUndefined();
    expect(store.advance()).toBe(1);
    const first = store.nextBatch(1)!;
    expect(first.inputs[0]!.messages[0]!.id).toBe("earlier-time-higher-rowid");
    store.checkpoint(first);
    const second = store.nextBatch(1)!;
    expect(second.inputs[0]!.messages[0]!.id).toBe("later-time-lower-rowid");
    store.checkpoint(second);
    expect(store.nextBatch()).toBeUndefined();
    store.close();
  });

  it("rolls a late older-timestamp event into a new tail cohort instead of skipping it", () => {
    const root = mkdtempSync(join(tmpdir(), "historical-replay-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const archive = createConversationArchive(path);
    archive.close();
    const store = createHistoricalReplayStore(path, () => 1);
    store.admit("chat");
    store.captureSnapshots();
    expect(store.advance()).toBe(1);

    const firstTail = createConversationArchive(path);
    firstTail.append(arrival("chat", "checkpointed-at-30", 30));
    firstTail.close();
    expect(store.advance()).toBe(1);
    const first = store.nextBatch()!;
    store.checkpoint(first);

    const late = createConversationArchive(path);
    late.append(arrival("chat", "arrived-late-at-20", 20));
    late.close();
    expect(store.nextBatch()).toBeUndefined();
    expect(store.advance()).toBe(1);
    const recovered = store.nextBatch()!;
    expect(recovered.inputs[0]!.messages[0]!.id).toBe("arrived-late-at-20");
    store.close();
  });

  it("resumes a disabled live Surface from its disable cutoff without replaying older evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "historical-replay-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const archive = createConversationArchive(path);
    archive.close();
    const store = createHistoricalReplayStore(path, () => 1);
    store.admit("chat");
    store.captureSnapshots();
    store.advance();
    store.advance();

    const beforeDisable = createConversationArchive(path);
    beforeDisable.append(arrival("chat", "before-disable", 30));
    beforeDisable.close();
    store.disable("chat");
    const whileDisabled = createConversationArchive(path);
    whileDisabled.append(arrival("chat", "while-disabled", 20));
    whileDisabled.close();

    expect(store.retry("chat")).toBe(true);
    expect(store.nextBatch()).toBeUndefined();
    expect(store.advance()).toBe(1);
    const recovered = store.nextBatch()!;
    expect(recovered.inputs.flatMap(({ messages }) => messages.map(({ id }) => id))).toEqual(["while-disabled"]);
    store.close();
  });

  it("filters a buffered live Window at the durable cutoff", () => {
    const root = mkdtempSync(join(tmpdir(), "historical-replay-"));
    roots.push(root);
    const path = join(root, "application.sqlite");
    const archive = createConversationArchive(path);
    archive.append(arrival("chat", "before", 10));
    archive.close();
    const store = createHistoricalReplayStore(path);
    store.admit("chat");
    store.captureSnapshots();
    const batch = store.nextBatch()!;
    store.checkpoint(batch);
    store.advance();
    store.advance();
    const again = createConversationArchive(path);
    again.append(arrival("chat", "after", 20));
    again.close();
    const sliced = store.liveSlice({
      type: "whatsapp.window",
      windowId: "window",
      chatId: "chat",
      reason: "capacity",
      messages: [
        {
          id: "before",
          chatId: "chat",
          from: "p",
          text: "before",
          timestamp: 10,
          isGroup: true,
          fromMe: false,
          live: true,
          mentions: [],
        },
        {
          id: "after",
          chatId: "chat",
          from: "p",
          text: "after",
          timestamp: 20,
          isGroup: true,
          fromMe: false,
          live: true,
          mentions: [],
        },
      ],
      updates: [],
      eventOrder: ["before", "after"],
    });
    expect(sliced?.messages.map(({ id }) => id)).toEqual(["after"]);
    expect(sliced?.eventOrder).toEqual(["after"]);
    store.close();
  });
});
