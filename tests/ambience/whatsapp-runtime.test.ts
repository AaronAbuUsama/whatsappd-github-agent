import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect } from "effect";
import type {
  ConversationSyncBatch,
  IncomingMessage as WhatsAppMessage,
  MessageRef,
  Outbound,
  Status,
  Update,
  WhatsAppSession,
} from "whatsappd";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { AmbienceDispatchRequest } from "../../src/ambience/dispatch.ts";
import { makeChatGate } from "../../src/coalescer/chat-gate.ts";
import { createWhatsAppHost, runWhatsAppSession } from "../../src/host/whatsapp-runtime.ts";
import { createConversationArchive } from "../../src/intake/conversation-archive.ts";
import { createReadWhatsAppThreadTool, createSearchWhatsAppHistoryTool } from "../../src/tools/whatsapp/history.ts";
import { createSayTool } from "../../src/tools/whatsapp/say.ts";
import { createWhatsAppAccount } from "../../src/whatsapp/account.ts";

const CHAT = "managed-31@g.us";
const OTHER_CHAT = "unmanaged-31@g.us";
const BOT = "15550000000@s.whatsapp.net";
const dirs: string[] = [];

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const temporaryArchive = () => {
  const directory = mkdtempSync(join(tmpdir(), "ambience-whatsapp-"));
  dirs.push(directory);
  return {
    archive: createConversationArchive(join(directory, "application.sqlite")),
    storeDirectory: join(directory, "whatsapp"),
  };
};

const fakeSession = (options: { readonly sendError?: Error; readonly typingOffError?: Error } = {}) => {
  const messageListeners = new Set<(message: WhatsAppMessage) => void | Promise<void>>();
  const syncListeners = new Set<(batch: ConversationSyncBatch) => void | Promise<void>>();
  const updateListeners = new Set<(update: Update) => void | Promise<void>>();
  const statusListeners = new Set<(status: Status) => void | Promise<void>>();
  const sent: Array<{ chatId: string; content: Outbound }> = [];
  const typing: Array<{ chatId: string; on: boolean }> = [];
  let nextMessage = 0;
  let status: Status = { phase: "disconnected" };
  const session = {
    get status() {
      return status;
    },
    onStatus(listener: (next: Status) => void | Promise<void>) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onMessage(listener: (message: WhatsAppMessage) => void | Promise<void>) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onUpdate(listener: (update: Update) => void | Promise<void>) {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    onConversationSync(listener: (batch: ConversationSyncBatch) => void | Promise<void>) {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
    async send(chatId: string, content: Outbound): Promise<MessageRef> {
      sent.push({ chatId, content });
      if (options.sendError) throw options.sendError;
      return { id: `real-host-message-${++nextMessage}`, chatId, fromMe: true };
    },
    async setTyping(chatId: string, on: boolean): Promise<void> {
      typing.push({ chatId, on });
      if (!on && options.typingOffError) throw options.typingOffError;
    },
    async start(): Promise<void> {
      status = { phase: "online" };
      for (const listener of statusListeners) await listener(status);
    },
    async stop(): Promise<void> {},
    identity: () => ({ jid: "15550000000:7@s.whatsapp.net" }),
  } as unknown as WhatsAppSession;
  return { session, messageListeners, syncListeners, sent, typing };
};

const inbound = (
  overrides: {
    readonly id?: string;
    readonly chatId?: string;
    readonly live?: boolean;
    readonly fromMe?: boolean;
    readonly text?: string;
    readonly timestamp?: number;
  } = {},
): WhatsAppMessage =>
  ({
    id: "inbound-31",
    chatId: CHAT,
    from: "15551112222@s.whatsapp.net",
    pushName: "Alice",
    fromMe: false,
    timestamp: 1_000,
    live: true,
    isGroup: true,
    kind: "text",
    text: "quiet production-path input",
    reply: async () => ({ id: "unused", chatId: CHAT, fromMe: true }),
    ...overrides,
  }) as WhatsAppMessage;

describe("paired whatsappd -> Coalescer -> Ambience seam", () => {
  it("uses one managed session for gated ingress, history, Ambience dispatch, and explicit say", async () => {
    const { archive, storeDirectory } = temporaryArchive();
    const fake = fakeSession();
    const account = createWhatsAppAccount({
      storeDirectory,
      archive,
      sessionFactory: () => fake.session,
    });
    await account.authenticate({});
    const dispatches: AmbienceDispatchRequest[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runWhatsAppSession(account.session(), {
              gate: makeChatGate({ groupIds: CHAT }),
              history: archive,
              coalescer: { debounceWindow: Duration.millis(10), maxWait: Duration.millis(20) },
              dispatch: async (request) => {
                dispatches.push(request);
                return {
                  dispatchId: "dispatch-whatsapp-31",
                  acceptedAt: "2026-07-13T00:00:00.000Z",
                };
              },
            }),
          );
          yield* Effect.yieldNow;

          yield* Effect.promise(async () => {
            const synced = inbound({
              id: "history-sync-31",
              live: false,
              text: "older synced context",
              timestamp: 500,
            });
            for (const listener of fake.syncListeners) {
              await listener({ chats: [], contacts: [], messages: [synced] });
            }
            // The same native ID may appear again during reconnect/history replay.
            // It enriches one row rather than manufacturing a second message.
            for (const listener of fake.messageListeners) await listener(synced);
            for (const listener of fake.messageListeners) {
              await listener(inbound({ id: "ignored-31", chatId: OTHER_CHAT, text: "must remain isolated" }));
            }
            for (const listener of fake.messageListeners) await listener(inbound());
          });
          yield* Effect.sleep(Duration.millis(50));

          expect(dispatches).toEqual([
            {
              id: CHAT,
              input: expect.objectContaining({
                type: "whatsapp.window",
                chatId: CHAT,
                reason: "debounce",
                messages: [
                  expect.objectContaining({
                    id: "inbound-31",
                    text: "quiet production-path input",
                  }),
                ],
              }),
            },
          ]);
          expect(fake.sent).toEqual([]);

          const say = createSayTool(CHAT);
          expect(
            yield* Effect.promise(() => Promise.resolve(say.run({ input: { text: "one controlled reply" } }))),
          ).toEqual({
            delivery: "sent",
            messageId: "real-host-message-1",
            typing: "cleared",
          });
          expect(fake.typing).toEqual([
            { chatId: CHAT, on: true },
            { chatId: CHAT, on: false },
          ]);
          expect(fake.sent).toEqual([{ chatId: CHAT, content: { text: "one controlled reply" } }]);

          const read = createReadWhatsAppThreadTool(CHAT);
          const search = createSearchWhatsAppHistoryTool(CHAT);
          expect(read.run({ input: { limit: 10 } })).toMatchObject({
            messages: [
              expect.objectContaining({ id: "history-sync-31", text: "older synced context" }),
              expect.objectContaining({ id: "inbound-31", direction: "inbound" }),
              expect.objectContaining({ id: "real-host-message-1", direction: "outbound" }),
            ],
          });
          expect(archive.readThread(CHAT, 10).filter(({ id }) => id === "history-sync-31")).toHaveLength(1);
          expect(search.run({ input: { query: "controlled reply" } })).toMatchObject({
            messages: [expect.objectContaining({ id: "real-host-message-1", chatId: CHAT })],
          });
          expect(JSON.stringify(read.run({ input: { limit: 10 } }))).not.toContain("must remain isolated");
        }),
      ),
    );

    await account.stop();
    archive.close();
  });
});

describe("real WhatsApp Host outcome boundary", () => {
  it("does not retry a rejected send and clears typing after the unknown outcome", async () => {
    const fake = fakeSession({ sendError: new Error("provider outcome unknown") });
    const host = createWhatsAppHost(fake.session);

    await expect(host.say(CHAT, "send exactly once")).resolves.toEqual({
      delivery: "unknown",
      deliveryError: "provider outcome unknown",
      typing: "cleared",
    });
    expect(fake.sent).toEqual([{ chatId: CHAT, content: { text: "send exactly once" } }]);
    expect(fake.typing).toEqual([
      { chatId: CHAT, on: true },
      { chatId: CHAT, on: false },
    ]);
  });

  it("reports whatsappd's pre-provider offline rejection as a known failure", async () => {
    const fake = fakeSession({ sendError: new Error("not online (phase: backing_off)") });
    const host = createWhatsAppHost(fake.session);

    await expect(host.say(CHAT, "cannot leave this process")).resolves.toEqual({
      delivery: "failed",
      deliveryError: "not online (phase: backing_off)",
      typing: "cleared",
    });
    expect(fake.sent).toHaveLength(1);
    expect(fake.typing.at(-1)).toEqual({ chatId: CHAT, on: false });
  });

  it("keeps a confirmed message ID when typing cleanup is uncertain", async () => {
    const fake = fakeSession({ typingOffError: new Error("typing cleanup outcome unknown") });
    const host = createWhatsAppHost(fake.session);

    await expect(host.say(CHAT, "confirmed delivery")).resolves.toEqual({
      delivery: "sent",
      messageId: "real-host-message-1",
      typing: "unknown",
      typingError: "typing cleanup outcome unknown",
    });
    expect(fake.typing.at(-1)).toEqual({ chatId: CHAT, on: false });
  });
});
