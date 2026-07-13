import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "eve/tools";
import type { ConversationSyncBatch, IncomingMessage, MessageRef, Outbound, WhatsAppSession } from "whatsappd";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayStore } from "../../agent/lib/jobs.ts";
import { persistWhatsAppMessages } from "../../agent/lib/whatsapp-messages.ts";
import readThread from "../../agent/tools/whatsapp_read_thread.ts";
import search from "../../agent/tools/whatsapp_search.ts";

const dirs: string[] = [];

const temporaryDatabase = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "wa-chat-store-"));
  dirs.push(dir);
  return join(dir, "gateway.sqlite");
};

const toolContext = (sessionId: string): ToolContext => ({ session: { id: sessionId } }) as ToolContext;

afterEach(() => {
  delete process.env.WA_GATEWAY_DB;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SQLite chat store", () => {
  it("persists and queries useful chronological context within one chat", () => {
    const store = new GatewayStore(temporaryDatabase());
    store.persistMessage({
      id: "m-2",
      chatId: "alpha@g.us",
      direction: "inbound",
      senderId: "bob@s.whatsapp.net",
      senderName: "Bob",
      kind: "text",
      text: "The Profile crash happens after login",
      timestamp: 2_000,
    });
    store.persistMessage({
      id: "m-1",
      chatId: "alpha@g.us",
      direction: "inbound",
      senderId: "alice@s.whatsapp.net",
      senderName: "Alice",
      kind: "text",
      text: "I can reproduce the profile crash",
      timestamp: 1_000,
    });
    store.persistMessage({
      id: "m-other",
      chatId: "beta@g.us",
      direction: "inbound",
      senderId: "mallory@s.whatsapp.net",
      kind: "text",
      text: "profile crash from another chat",
      timestamp: 3_000,
    });

    expect(store.searchMessages("alpha@g.us", "PROFILE CRASH")).toEqual([
      expect.objectContaining({ id: "m-1", senderName: "Alice", timestamp: 1_000 }),
      expect.objectContaining({ id: "m-2", senderName: "Bob", timestamp: 2_000 }),
    ]);
    expect(store.readThread("alpha@g.us", 1)).toEqual([
      expect.objectContaining({ id: "m-2", text: "The Profile crash happens after login" }),
    ]);
    store.close();
  });

  it("upserts a native message id instead of duplicating an outbound echo", () => {
    const store = new GatewayStore(temporaryDatabase());
    const message = {
      id: "wa-native-1",
      chatId: "alpha@g.us",
      direction: "outbound" as const,
      kind: "text",
      text: "I found the earlier report",
      timestamp: 2_000,
    };

    store.persistMessage(message);
    store.persistMessage({ ...message, senderId: "bot@s.whatsapp.net", timestamp: 1_900 });

    expect(store.readThread("alpha@g.us", 10)).toEqual([
      expect.objectContaining({ id: "wa-native-1", direction: "outbound", senderId: "bot@s.whatsapp.net" }),
    ]);
    store.close();
  });
});

describe("voice WhatsApp history tools", () => {
  it("derives the chat from the verified Eve session and cannot read another chat", async () => {
    const path = temporaryDatabase();
    process.env.WA_GATEWAY_DB = path;
    const store = new GatewayStore(path);
    store.set("alpha@g.us", { sessionId: "voice-alpha", streamIndex: 0 });
    store.set("beta@g.us", { sessionId: "voice-beta", streamIndex: 0 });
    store.persistMessage({
      id: "alpha-1",
      chatId: "alpha@g.us",
      direction: "inbound",
      senderName: "Alice",
      kind: "text",
      text: "alpha deployment is blocked",
      timestamp: 1_000,
    });
    store.persistMessage({
      id: "beta-1",
      chatId: "beta@g.us",
      direction: "inbound",
      senderName: "Bob",
      kind: "text",
      text: "beta deployment is blocked",
      timestamp: 2_000,
    });
    store.close();

    const result = await search.execute({ query: "deployment" }, toolContext("voice-alpha"));
    expect(result.messages).toEqual([expect.objectContaining({ text: "alpha deployment is blocked" })]);
    expect(JSON.stringify(result)).not.toContain("beta deployment");

    const recent = await readThread.execute({ limit: 10 }, toolContext("voice-alpha"));
    expect(recent.messages).toEqual([expect.objectContaining({ id: "alpha-1" })]);
    expect(() => search.execute({ query: "deployment" }, toolContext("unmapped-session"))).toThrow(
      /current WhatsApp chat/i,
    );
  });
});

describe("gateway WhatsApp persistence wiring", () => {
  it("installs history capture before session.start emits initial sync", async () => {
    const store = new GatewayStore(temporaryDatabase());
    const syncListeners = new Set<(batch: ConversationSyncBatch) => void | Promise<void>>();
    const history = {
      id: "startup-history",
      chatId: "alpha@g.us",
      from: "alice@s.whatsapp.net",
      pushName: "Alice",
      fromMe: false,
      timestamp: 500,
      live: false,
      isGroup: true,
      kind: "text",
      text: "loaded during initial sync",
    } satisfies ConversationSyncBatch["messages"][number];
    const raw = {
      onMessage() {
        return () => {};
      },
      onConversationSync(listener: (batch: ConversationSyncBatch) => void | Promise<void>) {
        syncListeners.add(listener);
        return () => syncListeners.delete(listener);
      },
      async start() {
        for (const listener of syncListeners) await listener({ chats: [], contacts: [], messages: [history] });
      },
    } as unknown as WhatsAppSession;

    const persisted = persistWhatsAppMessages(raw, store);
    await persisted.session.start();

    expect(store.readThread("alpha@g.us", 10)).toEqual([
      expect.objectContaining({ id: "startup-history", text: "loaded during initial sync" }),
    ]);
    persisted.unsubscribe();
    store.close();
  });

  it("captures inbound and successful outbound traffic once through the shared session", async () => {
    const store = new GatewayStore(temporaryDatabase());
    const listeners = new Set<(message: IncomingMessage) => void | Promise<void>>();
    const syncListeners = new Set<(batch: ConversationSyncBatch) => void | Promise<void>>();
    const sent: Array<{ chatId: string; content: Outbound }> = [];
    const raw = {
      onMessage(listener: (message: IncomingMessage) => void | Promise<void>) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onConversationSync(listener: (batch: ConversationSyncBatch) => void | Promise<void>) {
        syncListeners.add(listener);
        return () => syncListeners.delete(listener);
      },
      async send(chatId: string, content: Outbound): Promise<MessageRef> {
        sent.push({ chatId, content });
        return { id: "out-1", chatId, fromMe: true };
      },
    } as unknown as WhatsAppSession;
    const persisted = persistWhatsAppMessages(raw, store);

    const inbound = {
      id: "in-1",
      chatId: "alpha@g.us",
      from: "alice@s.whatsapp.net",
      pushName: "Alice",
      fromMe: false,
      timestamp: 1_000,
      live: true,
      isGroup: true,
      kind: "text",
      text: "remember the profile crash",
      reply: async () => ({ id: "unused", chatId: "alpha@g.us", fromMe: true }),
    } satisfies IncomingMessage;
    for (const listener of listeners) await listener(inbound);
    const history = { ...inbound, id: "history-1", text: "an older synced report", timestamp: 500, live: false };
    for (const listener of syncListeners) {
      await listener({ chats: [], contacts: [], messages: [history] });
    }
    await persisted.session.send("alpha@g.us", { text: "Yes, I found it" });
    // whatsappd may echo our sent message back through onMessage. It has the same
    // native id and must enrich the existing row, not create a second copy.
    const echo = { ...inbound, id: "out-1", from: "bot@s.whatsapp.net", fromMe: true, text: "Yes, I found it" };
    for (const listener of listeners) await listener(echo);

    expect(sent).toEqual([{ chatId: "alpha@g.us", content: { text: "Yes, I found it" } }]);
    expect(store.readThread("alpha@g.us", 10)).toEqual([
      expect.objectContaining({ id: "history-1", direction: "inbound", text: "an older synced report" }),
      expect.objectContaining({ id: "in-1", direction: "inbound", text: "remember the profile crash" }),
      expect.objectContaining({ id: "out-1", direction: "outbound", text: "Yes, I found it" }),
    ]);

    persisted.unsubscribe();
    store.close();
  });

  it("does not report a successful WhatsApp send as failed when only persistence fails", async () => {
    const store = new GatewayStore(temporaryDatabase());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const raw = {
      onMessage() {
        return () => {};
      },
      onConversationSync() {
        return () => {};
      },
      async send(chatId: string): Promise<MessageRef> {
        return { id: "already-sent", chatId, fromMe: true };
      },
    } as unknown as WhatsAppSession;
    const persisted = persistWhatsAppMessages(raw, store);
    store.close();

    await expect(persisted.session.send("alpha@g.us", { text: "delivered once" })).resolves.toEqual({
      id: "already-sent",
      chatId: "alpha@g.us",
      fromMe: true,
    });
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("sent WhatsApp message already-sent but failed to persist"),
      expect.anything(),
    );
    persisted.unsubscribe();
    error.mockRestore();
  });
});
