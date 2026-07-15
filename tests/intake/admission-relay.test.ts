import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { admitWindow } from "../../src/intake/admission-relay.ts";
import { createConversationArchive } from "../../src/intake/conversation-archive.ts";
import { conversationArrival } from "../../src/intake/conversation-event.ts";
import { createManagedChatInbox } from "../../src/intake/managed-chat-inbox.ts";
import type { IncomingMessage } from "whatsappd";

const CHAT = "managed-admission@g.us";
const roots: string[] = [];
const noDelay = { attempts: 3, delayMs: () => 0 };

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "ambient-admission-relay-"));
  roots.push(root);
  const archive = createConversationArchive(join(root, "application.sqlite"));
  let windowSequence = 0;
  const inbox = createManagedChatInbox(archive, {
    allowed: () => true,
    createId: () => `window-${++windowSequence}`,
    now: () => 1_000,
  });
  const arrival = {
    id: "message-1",
    chatId: CHAT,
    from: "alice@s.whatsapp.net",
    pushName: "Alice",
    fromMe: false,
    timestamp: 1_000,
    live: true,
    isGroup: true,
    kind: "text",
    text: "wake Ambience at least once",
    reply: async () => ({ id: "reply", chatId: CHAT, fromMe: true }),
  } as IncomingMessage;
  inbox.recorder.append(conversationArrival(arrival));
  const window = inbox.createWindow({
    chatId: CHAT,
    messages: inbox.unwindowed(),
    reason: "debounce",
  });
  return { archive, inbox, window };
};

describe("Admission Relay", () => {
  it("settles a dispatched Window as done with the returned receipt", async () => {
    const { archive, inbox, window } = fixture();

    await admitWindow(inbox, window, async () => ({
      dispatchId: "dispatch-1",
      acceptedAt: "2026-07-15T01:00:00.000Z",
    }));

    expect(inbox.admission(window.id)).toEqual({
      status: "done",
      windowId: "window-1",
      dispatchId: "dispatch-1",
      acceptedAt: "2026-07-15T01:00:00.000Z",
    });
    expect(inbox.pendingWindows()).toEqual([]);
    archive.close();
  });

  it("retries a failing dispatch within its bound and still settles done", async () => {
    const { archive, inbox, window } = fixture();
    let calls = 0;

    await admitWindow(
      inbox,
      window,
      async () => {
        calls += 1;
        if (calls < 3) throw new Error(`transient failure ${calls}`);
        return { dispatchId: "dispatch-retried", acceptedAt: "2026-07-15T01:00:30.000Z" };
      },
      noDelay,
    );

    expect(calls).toBe(3);
    expect(inbox.admission(window.id)).toMatchObject({ status: "done", dispatchId: "dispatch-retried" });
    archive.close();
  });

  it("settles a Window as terminally failed after bounded retries and keeps the chat open", async () => {
    const { archive, inbox, window } = fixture();
    let calls = 0;

    await expect(
      admitWindow(
        inbox,
        window,
        async () => {
          calls += 1;
          throw new Error("Flue unreachable");
        },
        noDelay,
      ),
    ).rejects.toThrow("Flue unreachable");

    expect(calls).toBe(3);
    expect(inbox.admission(window.id)).toEqual({
      status: "failed",
      windowId: "window-1",
      reason: "Flue unreachable",
    });
    expect(inbox.pendingWindows()).toEqual([]);
    // The chat is never blocked: a later arrival remains reachable.
    expect(inbox.pendingArrival(CHAT, "message-1")).toBeUndefined();
    archive.close();
  });

  it("leaves a Window pending for startup re-dispatch when the done write is lost", async () => {
    const { archive, inbox, window } = fixture();
    archive.transaction(({ database }) => {
      database.exec(`
        CREATE TRIGGER fail_done_write
        BEFORE UPDATE OF status ON managed_chat_admissions
        WHEN NEW.status = 'done'
        BEGIN SELECT RAISE(ABORT, 'injected done-write failure'); END;
      `);
    });
    let calls = 0;

    await admitWindow(inbox, window, async () => {
      calls += 1;
      return { dispatchId: "dispatch-accepted", acceptedAt: "2026-07-15T01:01:00.000Z" };
    });

    expect(calls).toBe(1);
    expect(inbox.admission(window.id)).toEqual({ status: "pending", windowId: "window-1" });
    archive.close();

    const reopenedArchive = createConversationArchive(join(roots.at(-1)!, "application.sqlite"));
    const reopened = createManagedChatInbox(reopenedArchive, { allowed: () => true });
    expect(reopened.pendingWindows()).toEqual([window]);
    reopenedArchive.close();
  });

  it("surfaces both causes when neither the dispatch nor the failed state can be recorded", async () => {
    const { archive, inbox, window } = fixture();
    archive.transaction(({ database }) => {
      database.exec(`
        CREATE TRIGGER fail_failed_write
        BEFORE UPDATE OF status ON managed_chat_admissions
        WHEN NEW.status = 'failed'
        BEGIN SELECT RAISE(ABORT, 'injected failed-write failure'); END;
      `);
    });

    await expect(
      admitWindow(
        inbox,
        window,
        async () => {
          throw new Error("Flue unreachable");
        },
        { attempts: 1, delayMs: () => 0 },
      ),
    ).rejects.toThrow("failed state could not be recorded");

    expect(inbox.admission(window.id)).toEqual({ status: "pending", windowId: "window-1" });
    archive.close();
  });
});
