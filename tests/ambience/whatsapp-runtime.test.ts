import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect } from "effect";
import type {
  ConversationSyncBatch,
  IncomingMessage as WhatsAppMessage,
  MessageRef,
  Outbound,
  WhatsAppSession,
} from "whatsappd";
import { afterEach, describe, expect, it } from "vitest";

import type { AmbienceAdmissionRequest } from "../../src/ambience/admission.ts";
import { makeChatGate } from "../../src/coalescer/chat-gate.ts";
import { createWhatsAppHistory, persistWhatsAppMessages } from "../../src/host/whatsapp-history.ts";
import { createWhatsAppHost, runWhatsAppSession } from "../../src/host/whatsapp-runtime.ts";
import { createReadWhatsAppThreadTool, createSearchWhatsAppHistoryTool } from "../../src/tools/whatsapp/history.ts";
import { createSayTool } from "../../src/tools/whatsapp/say.ts";

const CHAT = "managed-31@g.us";
const OTHER_CHAT = "unmanaged-31@g.us";
const BOT = "15550000000@s.whatsapp.net";
const dirs: string[] = [];

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const temporaryHistory = () => {
  const directory = mkdtempSync(join(tmpdir(), "ambience-whatsapp-"));
  dirs.push(directory);
  return createWhatsAppHistory(join(directory, "history.sqlite"));
};

const fakeSession = (options: { readonly sendError?: Error; readonly typingOffError?: Error } = {}) => {
  const messageListeners = new Set<(message: WhatsAppMessage) => void | Promise<void>>();
  const syncListeners = new Set<(batch: ConversationSyncBatch) => void | Promise<void>>();
  const sent: Array<{ chatId: string; content: Outbound }> = [];
  const typing: Array<{ chatId: string; on: boolean }> = [];
  let nextMessage = 0;
  const session = {
    onMessage(listener: (message: WhatsAppMessage) => void | Promise<void>) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
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
    identity: () => ({ jid: "15550000000:7@s.whatsapp.net" }),
  } as unknown as WhatsAppSession;
  return { session, messageListeners, syncListeners, sent, typing };
};

const inbound = (overrides: {
  readonly id?: string;
  readonly chatId?: string;
  readonly live?: boolean;
  readonly fromMe?: boolean;
  readonly text?: string;
  readonly timestamp?: number;
} = {}): WhatsAppMessage => ({
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
} as WhatsAppMessage);

describe("paired whatsappd -> Coalescer -> Ambience seam", () => {
  it("uses one managed session for gated ingress, history, Ambience admission, and explicit say", async () => {
    const history = temporaryHistory();
    const fake = fakeSession();
    const persisted = persistWhatsAppMessages(fake.session, history);
    const admissions: AmbienceAdmissionRequest[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runWhatsAppSession(persisted.session, {
              gate: makeChatGate({ groupIds: CHAT }),
              history,
              coalescer: { debounceWindow: Duration.millis(10), maxWait: Duration.millis(20) },
              admit: async (admission) => {
                admissions.push(admission);
                return { dispatchId: "dispatch-whatsapp-31", acceptedAt: "2026-07-13T00:00:00.000Z" };
              },
            }),
          );
          yield* Effect.yieldNow();

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
              await listener(inbound({ id: "ignored-31", chatId: OTHER_CHAT }));
            }
            for (const listener of fake.messageListeners) await listener(inbound());
          });
          yield* Effect.sleep(Duration.millis(50));

          expect(admissions).toEqual([
            {
              id: CHAT,
              input: expect.objectContaining({
                type: "whatsapp.window",
                chatId: CHAT,
                reason: "debounce",
                messages: [expect.objectContaining({ id: "inbound-31", text: "quiet production-path input" })],
              }),
            },
          ]);
          expect(fake.sent).toEqual([]);

          const say = createSayTool(CHAT);
          expect(yield* Effect.promise(() => Promise.resolve(say.run({ input: { text: "one controlled reply" } })))).toEqual({
            delivery: "sent",
            messageId: "real-host-message-1",
            typing: "cleared",
          });
          expect(fake.typing).toEqual([
            { chatId: CHAT, on: true },
            { chatId: CHAT, on: false },
          ]);
          expect(fake.sent).toEqual([{ chatId: CHAT, content: { text: "one controlled reply" } }]);

          history.persist({
            id: "other-chat-message",
            chatId: OTHER_CHAT,
            direction: "inbound",
            kind: "text",
            text: "must remain isolated",
            timestamp: 500,
          });
          const read = createReadWhatsAppThreadTool(CHAT);
          const search = createSearchWhatsAppHistoryTool(CHAT);
          expect(read.run({ input: { limit: 10 } })).toMatchObject({
            messages: [
              expect.objectContaining({ id: "history-sync-31", text: "older synced context" }),
              expect.objectContaining({ id: "inbound-31", direction: "inbound" }),
              expect.objectContaining({ id: "real-host-message-1", direction: "outbound" }),
            ],
          });
          expect(history.readThread(CHAT, 10).filter(({ id }) => id === "history-sync-31")).toHaveLength(1);
          expect(search.run({ input: { query: "controlled reply" } })).toMatchObject({
            messages: [expect.objectContaining({ id: "real-host-message-1", chatId: CHAT })],
          });
          expect(JSON.stringify(read.run({ input: { limit: 10 } }))).not.toContain("must remain isolated");
        }),
      ),
    );

    persisted.unsubscribe();
    history.close();
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
