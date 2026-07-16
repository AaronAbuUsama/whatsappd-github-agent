import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { windowContents } from "../../src/coalescer/events.ts";
import { createConversationArchive } from "../../src/intake/conversation-archive.ts";
import { conversationArrival, conversationUpdate, smokeCanaryArrival } from "../../src/intake/conversation-event.ts";
import { inspectWindowDeliveryCounts } from "../../src/intake/managed-chat-inbox.ts";
import { createTestManagedChatInbox as createManagedChatInbox } from "../support/managed-chat-inbox.ts";
import type { IncomingMessage, Update } from "whatsappd";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "ambient-managed-inbox-"));
  roots.push(root);
  return join(root, "application.sqlite");
};

const message = (id: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage =>
  ({
    id,
    chatId: "managed@g.us",
    from: "15551112222@s.whatsapp.net",
    pushName: "Alice",
    fromMe: false,
    timestamp: Number(id.replace(/\D/g, "")) || 1,
    live: true,
    isGroup: true,
    kind: "text",
    text: id,
    reply: async () => ({ id: "reply", chatId: "managed@g.us", fromMe: true }),
    ...overrides,
  }) as IncomingMessage;

describe("Managed Chat Inbox", () => {
  it("atomically archives all facts but accepts only configured live inbound arrivals", () => {
    const archive = createConversationArchive(fixture());
    const inbox = createManagedChatInbox(archive, {
      allowed: (chatId) => chatId === "managed@g.us",
    });

    expect(inbox.recorder.append(conversationArrival(message("m1")))).toBe(true);
    expect(inbox.recorder.append(conversationArrival(message("m2", { chatId: "unmanaged@g.us" })))).toBe(true);
    expect(inbox.recorder.append(conversationArrival(message("m3", { live: false })))).toBe(true);
    expect(inbox.recorder.append(conversationArrival(message("m4", { fromMe: true })))).toBe(true);

    expect(archive.events()).toHaveLength(4);
    expect(inbox.unwindowed().map(({ id }) => id)).toEqual(["m1"]);
    archive.close();
  });

  it("persists an observed reaction-only Window across restart and excludes receipts", () => {
    const path = fixture();
    const archive = createConversationArchive(path);
    const inbox = createManagedChatInbox(archive, {
      allowed: (chatId) => chatId === "managed@g.us",
      createId: () => "window-reaction",
    });
    const ref = { id: "agent-message", chatId: "managed@g.us", fromMe: true } as const;
    const reaction = conversationUpdate({
      kind: "reaction",
      ref,
      at: 2_000,
      by: "15551112222@s.whatsapp.net",
      emoji: "👍",
      removed: false,
    });
    const receipt = conversationUpdate({
      kind: "receipt",
      ref,
      at: 2_100,
      by: "15551112222@s.whatsapp.net",
      status: "read",
    } satisfies Update);

    expect(inbox.recorder.append(reaction)).toBe(true);
    expect(inbox.recorder.append(receipt)).toBe(true);
    expect(inbox.unwindowed()).toEqual([reaction]);
    const window = inbox.createWindow({
      chatId: "managed@g.us",
      ...windowContents(inbox.unwindowed()),
      reason: "debounce",
    });
    expect(window).toMatchObject({ messages: [], updates: [reaction] });
    archive.close();

    const reopenedArchive = createConversationArchive(path);
    const reopened = createManagedChatInbox(reopenedArchive, { allowed: () => true });
    expect(reopened.pendingWindows()).toEqual([window]);
    reopenedArchive.close();
  });

  it("rolls Archive and projection writes back when Inbox acceptance fails", () => {
    const archive = createConversationArchive(fixture());
    const inbox = createManagedChatInbox(archive, { allowed: () => true });
    archive.transaction(({ database }) => {
      database.exec(`
        CREATE TRIGGER fail_managed_inbox
        BEFORE INSERT ON managed_chat_inbox
        BEGIN SELECT RAISE(ABORT, 'injected inbox failure'); END;
      `);
    });

    expect(() => inbox.recorder.append(conversationArrival(message("m1")))).toThrow("injected inbox failure");
    expect(archive.events()).toEqual([]);
    expect(archive.readThread("managed@g.us")).toEqual([]);
    expect(inbox.unwindowed()).toEqual([]);
    archive.close();
  });

  it("leaves every accepted arrival pending when Window creation fails", () => {
    const archive = createConversationArchive(fixture());
    const inbox = createManagedChatInbox(archive, { allowed: () => true });
    inbox.recorder.append(conversationArrival(message("m1")));
    inbox.recorder.append(conversationArrival(message("m2")));
    archive.transaction(({ database }) => {
      database.exec(`
        CREATE TRIGGER fail_managed_window
        BEFORE INSERT ON managed_chat_windows
        BEGIN SELECT RAISE(ABORT, 'injected window failure'); END;
      `);
    });

    expect(() =>
      inbox.createWindow({
        chatId: "managed@g.us",
        ...windowContents(inbox.unwindowed()),
        reason: "debounce",
      }),
    ).toThrow("injected window failure");
    expect(inbox.unwindowed().map(({ id }) => id)).toEqual(["m1", "m2"]);
    expect(inbox.pendingWindows()).toEqual([]);
    archive.close();
  });

  it("preserves observed order and stable Window identity across restart", () => {
    const path = fixture();
    const archive = createConversationArchive(path);
    let nextWindow = 0;
    let currentTime = 5_000;
    const inbox = createManagedChatInbox(archive, {
      allowed: () => true,
      createId: () => `window-stable-${++nextWindow}`,
      now: () => currentTime,
    });
    inbox.recorder.append(conversationArrival(message("m1", { timestamp: 3_000 })));
    inbox.recorder.append(conversationArrival(message("m2", { timestamp: 1_000 })));
    inbox.recorder.append(conversationArrival(message("m3", { timestamp: 2_000 })));

    expect(inbox.unwindowed().map(({ id }) => id)).toEqual(["m1", "m2", "m3"]);
    expect(() =>
      inbox.createWindow({
        chatId: "managed@g.us",
        ...windowContents(inbox.unwindowed().slice(1, 2)),
        reason: "debounce",
      }),
    ).toThrow("must claim the oldest pending events in observed order");
    const window = inbox.createWindow({
      chatId: "managed@g.us",
      ...windowContents(inbox.unwindowed().slice(0, 2)),
      reason: "capacity",
    });
    expect(window).toMatchObject({ id: "window-stable-1", reason: "capacity" });
    expect(window.messages.map(({ id }) => id)).toEqual(["m1", "m2"]);
    expect(inbox.unwindowed().map(({ id }) => id)).toEqual(["m3"]);
    expect(
      inbox.createWindow({
        chatId: "managed@g.us",
        messages: window.messages,
        updates: window.updates,
        reason: "debounce",
      }),
    ).toEqual(window);
    expect(() =>
      inbox.createWindow({
        chatId: "managed@g.us",
        messages: window.messages.slice(0, 1),
        updates: [],
        reason: "debounce",
      }),
    ).toThrow("already belongs to a different Window assignment");
    currentTime = 4_000;
    const secondWindow = inbox.createWindow({
      chatId: "managed@g.us",
      ...windowContents(inbox.unwindowed()),
      reason: "debounce",
    });
    const windowedIds = inbox.pendingWindows().flatMap(({ messages }) => messages.map(({ id }) => id));
    expect(windowedIds).toEqual(["m1", "m2", "m3"]);
    expect(new Set(windowedIds).size).toBe(3);
    expect(inbox.admission(window.id)).toEqual({ status: "pending", windowId: "window-stable-1" });
    archive.close();

    const reopenedArchive = createConversationArchive(path);
    const reopened = createManagedChatInbox(reopenedArchive, { allowed: () => true });
    expect(reopened.pendingWindows()).toEqual([window, secondWindow]);
    expect(reopened.unwindowed()).toEqual([]);
    reopenedArchive.close();
  });

  it("settles a pending Window as done or failed exactly once, terminally", () => {
    const path = fixture();
    const archive = createConversationArchive(path);
    let nextWindow = 0;
    const inbox = createManagedChatInbox(archive, {
      allowed: () => true,
      createId: () => `window-${++nextWindow}`,
      now: () => 1_000,
    });
    inbox.recorder.append(conversationArrival(message("m1")));
    const done = inbox.createWindow({ chatId: "managed@g.us", ...windowContents(inbox.unwindowed()), reason: "debounce" });
    inbox.recorder.append(conversationArrival(message("m2")));
    const failed = inbox.createWindow({ chatId: "managed@g.us", ...windowContents(inbox.unwindowed()), reason: "debounce" });

    inbox.markDone(done.id, { dispatchId: "dispatch-1", acceptedAt: "2026-07-15T01:00:00.000Z" });
    inbox.markFailed(failed.id, "Flue unreachable after bounded retries");

    expect(inbox.admission(done.id)).toEqual({
      status: "done",
      windowId: "window-1",
      dispatchId: "dispatch-1",
      acceptedAt: "2026-07-15T01:00:00.000Z",
    });
    expect(inbox.admission(failed.id)).toEqual({
      status: "failed",
      windowId: "window-2",
      reason: "Flue unreachable after bounded retries",
    });
    expect(inbox.pendingWindows()).toEqual([]);
    expect(() => inbox.markDone(done.id, { dispatchId: "again", acceptedAt: "2026-07-15T01:01:00.000Z" })).toThrow(
      "cannot transition to done from done",
    );
    expect(() => inbox.markFailed(done.id, "late failure")).toThrow("cannot transition to failed from done");
    expect(() => inbox.markDone(failed.id, { dispatchId: "late", acceptedAt: "2026-07-15T01:01:00.000Z" })).toThrow(
      "cannot transition to done from failed",
    );
    archive.close();

    const reopenedArchive = createConversationArchive(path);
    const reopened = createManagedChatInbox(reopenedArchive, { allowed: () => true });
    expect(reopened.pendingWindows()).toEqual([]);
    expect(reopened.admissions("failed")).toEqual([
      { status: "failed", windowId: "window-2", reason: "Flue unreachable after bounded retries" },
    ]);
    reopenedArchive.close();
  });

  it("does not re-admit a settled smoke canary when the Inbox reopens", () => {
    const path = fixture();
    const archive = createConversationArchive(path);
    const inbox = createManagedChatInbox(archive, {
      allowed: (chatId) => chatId === "managed@g.us",
      createId: () => "window-smoke-settled",
    });
    const canary = message("smoke-settled", {
      fromMe: true,
      live: false,
      text: "SMOKE abc123 — ignore",
    });
    expect(inbox.recorder.append(smokeCanaryArrival(canary))).toBe(true);
    const window = inbox.createWindow({
      chatId: "managed@g.us",
      ...windowContents(inbox.unwindowed()),
      reason: "debounce",
    });
    inbox.markDone(window.id, { dispatchId: "dispatch-smoke", acceptedAt: "2026-07-16T18:00:00.000Z" });
    archive.close();

    const reopenedArchive = createConversationArchive(path);
    const reopened = createManagedChatInbox(reopenedArchive, {
      allowed: (chatId) => chatId === "managed@g.us",
    });
    expect(reopened.unwindowed()).toEqual([]);
    expect(reopened.pendingWindows()).toEqual([]);
    expect(reopened.admission(window.id)).toEqual({
      status: "done",
      windowId: "window-smoke-settled",
      dispatchId: "dispatch-smoke",
      acceptedAt: "2026-07-16T18:00:00.000Z",
    });
    expect(reopened.recorder.append(smokeCanaryArrival(canary))).toBe(false);
    expect(reopened.pendingWindows()).toEqual([]);
    reopenedArchive.close();
  });

  it("never blocks a chat: later arrivals stay reachable beside a failed Window", () => {
    const archive = createConversationArchive(fixture());
    const inbox = createManagedChatInbox(archive, { allowed: () => true, createId: () => "window-failed" });
    inbox.recorder.append(conversationArrival(message("m1")));
    const window = inbox.createWindow({ chatId: "managed@g.us", ...windowContents(inbox.unwindowed()), reason: "debounce" });
    inbox.markFailed(window.id, "dispatch failed after bounded retries");

    inbox.recorder.append(conversationArrival(message("m2")));
    expect(inbox.unwindowed().map(({ id }) => id)).toEqual(["m2"]);
    expect(inbox.pending(inbox.unwindowed()[0]!)?.id).toBe("m2");
    archive.close();
  });

  it("migrates every legacy five-state admission row per the ADR 0014 mapping", () => {
    const path = fixture();
    const archive = createConversationArchive(path);
    let nextWindow = 0;
    const inbox = createManagedChatInbox(archive, {
      allowed: () => true,
      createId: () => `legacy-${++nextWindow}`,
    });
    for (const id of ["m1", "m2", "m3", "m4", "m5"]) {
      inbox.recorder.append(conversationArrival(message(id)));
      inbox.createWindow({ chatId: "managed@g.us", ...windowContents(inbox.unwindowed()), reason: "debounce" });
    }
    archive.transaction(({ database }) =>
      database.exec(`
        DROP INDEX managed_chat_admissions_status_idx;
        ALTER TABLE managed_chat_admissions RENAME TO managed_chat_admissions_new;
        CREATE TABLE managed_chat_admissions (
          window_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'admitted', 'uncertain', 'abandoned')),
          attempt_id TEXT,
          dispatch_id TEXT,
          accepted_at TEXT,
          reason TEXT,
          updated_at_ms INTEGER NOT NULL,
          FOREIGN KEY (window_id) REFERENCES managed_chat_windows(window_id),
          CHECK (
            (status = 'pending' AND attempt_id IS NULL AND dispatch_id IS NULL AND accepted_at IS NULL AND reason IS NULL)
            OR (status = 'dispatching' AND attempt_id IS NOT NULL AND dispatch_id IS NULL AND accepted_at IS NULL AND reason IS NULL)
            OR (status = 'admitted' AND attempt_id IS NOT NULL AND dispatch_id IS NOT NULL AND accepted_at IS NOT NULL AND reason IS NULL)
            OR (status IN ('uncertain', 'abandoned') AND attempt_id IS NOT NULL AND dispatch_id IS NULL AND accepted_at IS NULL AND reason IS NOT NULL)
          )
        ) STRICT;
        DROP TABLE managed_chat_admissions_new;
        INSERT INTO managed_chat_admissions (window_id, status, attempt_id, dispatch_id, accepted_at, reason, updated_at_ms) VALUES
          ('legacy-1', 'pending', NULL, NULL, NULL, NULL, 1),
          ('legacy-2', 'dispatching', 'attempt-2', NULL, NULL, NULL, 2),
          ('legacy-3', 'admitted', 'attempt-3', 'dispatch-3', '2026-07-14T00:00:00.000Z', NULL, 3),
          ('legacy-4', 'uncertain', 'attempt-4', NULL, NULL, 'provider outcome unknown', 4),
          ('legacy-5', 'abandoned', 'attempt-5', NULL, NULL, 'operator abandoned this Window', 5);
        CREATE TABLE managed_chat_admission_resolutions (window_id TEXT PRIMARY KEY);
        CREATE TABLE managed_chat_admission_examinations (window_id TEXT PRIMARY KEY);
      `),
    );
    archive.close();

    const reopenedArchive = createConversationArchive(path);
    const reopened = createManagedChatInbox(reopenedArchive, { allowed: () => true });
    expect(reopened.admissions()).toEqual([
      { status: "pending", windowId: "legacy-1" },
      { status: "pending", windowId: "legacy-2" },
      {
        status: "done",
        windowId: "legacy-3",
        dispatchId: "dispatch-3",
        acceptedAt: "2026-07-14T00:00:00.000Z",
      },
      { status: "pending", windowId: "legacy-4" },
      { status: "failed", windowId: "legacy-5", reason: "operator abandoned this Window" },
    ]);
    expect(reopened.pendingWindows().map(({ id }) => id)).toEqual(["legacy-1", "legacy-2", "legacy-4"]);
    reopenedArchive.transaction(({ database }) => {
      const sql = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'managed_chat_admissions'")
        .get() as { readonly sql: string };
      expect(sql.sql).not.toContain("uncertain");
      expect(sql.sql).not.toContain("dispatching");
      expect(sql.sql).not.toContain("abandoned");
      for (const table of ["managed_chat_admission_resolutions", "managed_chat_admission_examinations"]) {
        expect(
          database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        ).toBeUndefined();
      }
    });
    reopenedArchive.close();
  });

  it("backfills pending admissions for windows predating the ledger", () => {
    const path = fixture();
    const archive = createConversationArchive(path);
    let nextWindow = 0;
    const inbox = createManagedChatInbox(archive, {
      allowed: () => true,
      createId: () => `preledger-${++nextWindow}`,
    });
    for (const id of ["m1", "m2"]) {
      inbox.recorder.append(conversationArrival(message(id)));
      inbox.createWindow({ chatId: "managed@g.us", ...windowContents(inbox.unwindowed()), reason: "debounce" });
    }
    archive.transaction(({ database }) =>
      database.exec(`
        DROP INDEX managed_chat_admissions_status_idx;
        DROP TABLE managed_chat_admissions;
      `),
    );
    archive.close();

    const reopenedArchive = createConversationArchive(path);
    const reopened = createManagedChatInbox(reopenedArchive, { allowed: () => true });
    expect(reopened.admissions()).toEqual([
      { status: "pending", windowId: "preledger-1" },
      { status: "pending", windowId: "preledger-2" },
    ]);
    expect(reopened.pendingWindows().map(({ id }) => id)).toEqual(["preledger-1", "preledger-2"]);
    reopenedArchive.close();
  });

  it("counts pending and failed batches read-only for status", () => {
    const path = fixture();
    expect(inspectWindowDeliveryCounts(path)).toEqual({ pending: 0, failed: 0 });
    const archive = createConversationArchive(path);
    let nextWindow = 0;
    const inbox = createManagedChatInbox(archive, { allowed: () => true, createId: () => `window-${++nextWindow}` });
    inbox.recorder.append(conversationArrival(message("m1")));
    inbox.createWindow({ chatId: "managed@g.us", ...windowContents(inbox.unwindowed()), reason: "debounce" });
    inbox.recorder.append(conversationArrival(message("m2")));
    const failing = inbox.createWindow({ chatId: "managed@g.us", ...windowContents(inbox.unwindowed()), reason: "debounce" });
    inbox.markFailed(failing.id, "dispatch failed after bounded retries");
    archive.close();

    expect(inspectWindowDeliveryCounts(path)).toEqual({ pending: 1, failed: 1 });
  });
});
