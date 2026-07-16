import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect } from "effect";
import type {
  ConversationSyncBatch,
  IncomingMessage as WhatsAppMessage,
  MessageRef,
  Outbound,
  SendOptions,
  Status,
  Update,
  WhatsAppSession,
} from "whatsappd";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AmbienceDispatchRequest } from "../../src/ambience/dispatch.ts";
import { makeManagedChatGate } from "../../src/coalescer/chat-gate.ts";
import {
  createWhatsAppHost,
  getWhatsAppRuntimeStatus,
  runWhatsAppSession,
  startWhatsAppRuntime,
} from "../../src/host/whatsapp-runtime.ts";
import { createConversationArchive } from "../../src/intake/conversation-archive.ts";
import { conversationArrival } from "../../src/intake/conversation-event.ts";
import { createTestManagedChatInbox as createManagedChatInbox } from "../support/managed-chat-inbox.ts";
import {
  createReactTool,
  createReadWhatsAppThreadTool,
  createSayTool,
  createSearchWhatsAppHistoryTool,
} from "../../src/capabilities/whatsapp-participation/tools.ts";
import { createWhatsAppAccount } from "../../src/whatsapp/account.ts";

const CHAT = "managed-31@g.us";
const OTHER_CHAT = "unmanaged-31@g.us";
const dirs: string[] = [];

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const temporaryArchive = () => {
  const directory = mkdtempSync(join(tmpdir(), "ambience-whatsapp-"));
  dirs.push(directory);
  const applicationDatabase = join(directory, "application.sqlite");
  return {
    applicationDatabase,
    archive: createConversationArchive(applicationDatabase),
    storeDirectory: join(directory, "whatsapp"),
  };
};

const fakeSession = (
  options: { readonly sendError?: Error; readonly typingOffError?: Error; readonly echoSent?: boolean } = {},
) => {
  const messageListeners = new Set<(message: WhatsAppMessage) => void | Promise<void>>();
  const syncListeners = new Set<(batch: ConversationSyncBatch) => void | Promise<void>>();
  const updateListeners = new Set<(update: Update) => void | Promise<void>>();
  const statusListeners = new Set<(status: Status) => void | Promise<void>>();
  const sent: Array<{ chatId: string; content: Outbound; options?: SendOptions }> = [];
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
    async send(chatId: string, content: Outbound, sendOptions?: SendOptions): Promise<MessageRef> {
      sent.push({ chatId, content, ...(sendOptions === undefined ? {} : { options: sendOptions }) });
      if (options.sendError) throw options.sendError;
      const ref = { id: `real-host-message-${++nextMessage}`, chatId, fromMe: true } as const;
      if (options.echoSent && "text" in content) {
        queueMicrotask(() => {
          for (const listener of messageListeners) {
            void listener(inbound({ id: ref.id, chatId, fromMe: true, text: content.text }));
          }
        });
      }
      return ref;
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
  return { session, messageListeners, syncListeners, updateListeners, sent, typing };
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

const location = (): WhatsAppMessage =>
  ({
    ...inbound({ id: "location-31", text: undefined }),
    kind: "location",
    name: "Project HQ",
    address: "1 Stable Way",
    lat: 5.5,
    lng: -0.2,
  }) as unknown as WhatsAppMessage;

describe("paired whatsappd -> Coalescer -> Ambience seam", () => {
  it("admits only the provider-acknowledged SMOKE canary while retaining the outbound conversation fact", async () => {
    const { archive, storeDirectory } = temporaryArchive();
    const fake = fakeSession();
    const gate = makeManagedChatGate([CHAT]);
    const inbox = createManagedChatInbox(archive, {
      allowed: gate.allowed,
      createId: () => "window-smoke-31",
    });
    const canaryText = "SMOKE abc123 — ignore";
    const account = createWhatsAppAccount({
      storeDirectory,
      archive: inbox.recorder,
      sessionFactory: () => fake.session,
    });
    await account.authenticate({});
    const dispatches: AmbienceDispatchRequest[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runWhatsAppSession(account.session(), {
              gate,
              history: archive,
              inbox,
              coalescer: { debounceWindow: Duration.millis(10), maxWait: Duration.millis(20) },
              dispatch: async (request) => {
                dispatches.push(request);
                return { dispatchId: "dispatch-smoke-31", acceptedAt: "2026-07-16T18:00:00.000Z" };
              },
            }),
          );
          yield* Effect.yieldNow;
          yield* Effect.promise(async () => {
            for (const listener of fake.messageListeners) {
              await listener(inbound({ id: "ordinary-self-31", fromMe: true, text: "ordinary self echo" }));
              await listener(inbound({ id: "wrong-smoke-31", fromMe: true, text: "SMOKE wrong — ignore" }));
              await listener(inbound({ id: "matching-self-31", fromMe: true, text: canaryText }));
            }
            await account.sendSmokeCanary!(CHAT, canaryText);
          });
          yield* Effect.sleep(Duration.millis(40));
        }),
      ),
    );

    expect(dispatches).toEqual([
      {
        id: CHAT,
        input: expect.objectContaining({
          type: "whatsapp.window",
          messages: [expect.objectContaining({ id: "real-host-message-1", text: canaryText, fromMe: false })],
        }),
      },
    ]);
    expect(archive.readThread(CHAT, 10)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "ordinary-self-31", direction: "outbound" }),
        expect.objectContaining({ id: "wrong-smoke-31", direction: "outbound" }),
        expect.objectContaining({ id: "matching-self-31", direction: "outbound" }),
        expect.objectContaining({ id: "real-host-message-1", direction: "outbound" }),
      ]),
    );
    await account.stop();
    archive.close();
  });

  it("fails loudly if a provider self-echo archives the SMOKE acknowledgement before local admission", async () => {
    const { archive, storeDirectory } = temporaryArchive();
    const fake = fakeSession({ echoSent: true });
    const account = createWhatsAppAccount({
      storeDirectory,
      archive,
      sessionFactory: () => fake.session,
    });
    await account.authenticate({});

    await expect(account.sendSmokeCanary!(CHAT, "SMOKE abc123 — ignore")).rejects.toThrow(
      "provider-acknowledged smoke message real-host-message-1 was already archived",
    );
    expect(archive.readThread(CHAT, 10)).toEqual([
      expect.objectContaining({ id: "real-host-message-1", direction: "outbound" }),
    ]);
    await account.stop();
    archive.close();
  });

  it("uses one managed session for gated ingress, history, Ambience dispatch, and explicit say", async () => {
    const { archive, storeDirectory } = temporaryArchive();
    const fake = fakeSession();
    const gate = makeManagedChatGate([CHAT]);
    const inbox = createManagedChatInbox(archive, {
      allowed: gate.allowed,
      createId: () => "window-runtime-31",
    });
    const account = createWhatsAppAccount({
      storeDirectory,
      archive: inbox.recorder,
      sessionFactory: () => fake.session,
    });
    await account.authenticate({});
    const dispatches: AmbienceDispatchRequest[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runWhatsAppSession(account.session(), {
              gate,
              history: archive,
              inbox,
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
                windowId: "window-runtime-31",
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
          expect(fake.typing).toEqual([]);

          const say = createSayTool(CHAT);
          expect(
            yield* Effect.promise(() => Promise.resolve(say.run({ input: { text: "one controlled reply" } }))),
          ).toEqual({
            delivery: "sent",
            messageId: "real-host-message-1",
            typing: "cleared",
          });
          expect(
            yield* Effect.promise(() =>
              Promise.resolve(say.run({ input: { text: "one quoted reply", replyTo: "inbound-31" } })),
            ),
          ).toEqual({
            delivery: "sent",
            messageId: "real-host-message-2",
            typing: "cleared",
          });
          const react = createReactTool(CHAT);
          expect(
            yield* Effect.promise(() =>
              Promise.resolve(react.run({ input: { messageId: "inbound-31", emoji: "👀" } })),
            ),
          ).toEqual({
            delivery: "sent",
            messageId: "real-host-message-3",
          });
          expect(fake.typing).toEqual([
            { chatId: CHAT, on: true },
            { chatId: CHAT, on: false },
            { chatId: CHAT, on: true },
            { chatId: CHAT, on: false },
          ]);
          expect(fake.sent).toEqual([
            { chatId: CHAT, content: { text: "one controlled reply" } },
            {
              chatId: CHAT,
              content: { text: "one quoted reply" },
              options: {
                quote: {
                  id: "inbound-31",
                  chatId: CHAT,
                  fromMe: false,
                  participant: "15551112222@s.whatsapp.net",
                },
              },
            },
            {
              chatId: CHAT,
              content: {
                react: {
                  to: {
                    id: "inbound-31",
                    chatId: CHAT,
                    fromMe: false,
                    participant: "15551112222@s.whatsapp.net",
                  },
                  emoji: "👀",
                },
              },
            },
          ]);
          expect(archive.messageState(CHAT, "inbound-31")).toMatchObject({
            reactions: [expect.objectContaining({ emoji: "👀" })],
          });
          yield* Effect.promise(async () => {
            for (const listener of fake.updateListeners) {
              await listener({
                kind: "reaction",
                ref: { id: "inbound-31", chatId: CHAT, fromMe: false },
                at: 2_000,
                by: "15550000000@s.whatsapp.net",
                emoji: "👀",
                removed: false,
              });
            }
          });
          yield* Effect.sleep(Duration.millis(30));
          expect(archive.events(CHAT).filter(({ kind }) => kind === "reaction")).toHaveLength(1);
          expect(dispatches).toHaveLength(1);

          const read = createReadWhatsAppThreadTool(CHAT);
          const search = createSearchWhatsAppHistoryTool(CHAT);
          expect(read.run({ input: { limit: 10 } })).toMatchObject({
            messages: [
              expect.objectContaining({ id: "history-sync-31", text: "older synced context" }),
              expect.objectContaining({ id: "inbound-31", direction: "inbound" }),
              expect.objectContaining({ id: "real-host-message-1", direction: "outbound" }),
              expect.objectContaining({ id: "real-host-message-2", direction: "outbound" }),
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

  it("replays an unwindowed accepted arrival after the application database is reopened", async () => {
    const { applicationDatabase, archive, storeDirectory } = temporaryArchive();
    const fake = fakeSession();
    const gate = makeManagedChatGate([CHAT]);
    const inbox = createManagedChatInbox(archive, { allowed: gate.allowed });
    const account = createWhatsAppAccount({
      storeDirectory,
      archive: inbox.recorder,
      sessionFactory: () => fake.session,
    });
    await account.authenticate({});

    for (const listener of fake.messageListeners) {
      await listener(inbound({ id: "before-coalescer-31", text: "survives the startup gap" }));
    }
    expect(inbox.unwindowed().map(({ id }) => id)).toEqual(["before-coalescer-31"]);
    await account.stop();
    archive.close();

    const reopenedArchive = createConversationArchive(applicationDatabase);
    const reopenedInbox = createManagedChatInbox(reopenedArchive, {
      allowed: gate.allowed,
      createId: () => "window-replayed-31",
    });
    const restartedFake = fakeSession();
    const restartedAccount = createWhatsAppAccount({
      storeDirectory,
      archive: reopenedInbox.recorder,
      sessionFactory: () => restartedFake.session,
    });
    await restartedAccount.authenticate({});
    expect(reopenedInbox.unwindowed().map(({ id }) => id)).toEqual(["before-coalescer-31"]);

    const dispatches: AmbienceDispatchRequest[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runWhatsAppSession(restartedAccount.session(), {
              gate,
              history: reopenedArchive,
              inbox: reopenedInbox,
              coalescer: { debounceWindow: Duration.millis(10), maxWait: Duration.millis(20) },
              dispatch: async (request) => {
                dispatches.push(request);
                return { dispatchId: "dispatch-replayed-31", acceptedAt: "2026-07-15T00:00:00.000Z" };
              },
            }),
          );
          yield* Effect.sleep(Duration.millis(40));

          expect(dispatches).toEqual([
            {
              id: CHAT,
              input: expect.objectContaining({
                type: "whatsapp.window",
                windowId: "window-replayed-31",
                chatId: CHAT,
                reason: "debounce",
                messages: [expect.objectContaining({ id: "before-coalescer-31" })],
              }),
            },
          ]);
          expect(reopenedInbox.unwindowed()).toEqual([]);
          expect(reopenedInbox.pendingWindows()).toEqual([]);
          expect(reopenedInbox.admission("window-replayed-31")).toEqual({
            status: "done",
            windowId: "window-replayed-31",
            dispatchId: "dispatch-replayed-31",
            acceptedAt: "2026-07-15T00:00:00.000Z",
          });
        }),
      ),
    );

    await restartedAccount.stop();
    reopenedArchive.close();
  });

  it("replays a pending Window with its stable identity after restart", async () => {
    const { applicationDatabase, archive } = temporaryArchive();
    const gate = makeManagedChatGate([CHAT]);
    const inbox = createManagedChatInbox(archive, {
      allowed: gate.allowed,
      createId: () => "window-pending-31",
    });
    inbox.recorder.append(conversationArrival(inbound({ id: "pending-window-31" })));
    const pending = inbox.createWindow({
      chatId: CHAT,
      messages: inbox.unwindowed(),
      reason: "debounce",
    });
    expect(inbox.admission(pending.id)).toEqual({ status: "pending", windowId: pending.id });
    archive.close();

    const reopenedArchive = createConversationArchive(applicationDatabase);
    const reopened = createManagedChatInbox(reopenedArchive, { allowed: gate.allowed });
    const fake = fakeSession();
    const dispatches: AmbienceDispatchRequest[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runWhatsAppSession(fake.session, {
              gate,
              history: reopenedArchive,
              inbox: reopened,
              dispatch: async (request) => {
                dispatches.push(request);
                return { dispatchId: "dispatch-pending-31", acceptedAt: "2026-07-15T00:00:30.000Z" };
              },
            }),
          );
          yield* Effect.sleep(Duration.millis(10));
        }),
      ),
    );

    expect(dispatches).toEqual([
      {
        id: CHAT,
        input: expect.objectContaining({
          type: "whatsapp.window",
          windowId: "window-pending-31",
          chatId: CHAT,
        }),
      },
    ]);
    expect(reopened.admission(pending.id)).toEqual({
      status: "done",
      windowId: pending.id,
      dispatchId: "dispatch-pending-31",
      acceptedAt: "2026-07-15T00:00:30.000Z",
    });
    reopenedArchive.close();
  });

  it("keeps a non-text Window payload canonical and does not redispatch it after admission", async () => {
    const { applicationDatabase, archive, storeDirectory } = temporaryArchive();
    const gate = makeManagedChatGate([CHAT]);
    const inbox = createManagedChatInbox(archive, {
      allowed: gate.allowed,
      createId: () => "window-location-31",
    });
    const fake = fakeSession();
    const account = createWhatsAppAccount({
      storeDirectory,
      archive: inbox.recorder,
      sessionFactory: () => fake.session,
    });
    await account.authenticate({});
    const firstDispatches: AmbienceDispatchRequest[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runWhatsAppSession(account.session(), {
              gate,
              history: archive,
              inbox,
              coalescer: { debounceWindow: Duration.millis(10), maxWait: Duration.millis(20) },
              dispatch: async (request) => {
                firstDispatches.push(request);
                return { dispatchId: "dispatch-location-31", acceptedAt: "2026-07-15T00:00:00.000Z" };
              },
            }),
          );
          yield* Effect.yieldNow;
          yield* Effect.promise(async () => {
            for (const listener of fake.messageListeners) await listener(location());
          });
          yield* Effect.sleep(Duration.millis(30));
        }),
      ),
    );
    expect(firstDispatches).toHaveLength(1);
    expect(firstDispatches[0]!.input).toMatchObject({
      windowId: "window-location-31",
      messages: [{ id: "location-31", text: "Project HQ — 1 Stable Way — 5.5, -0.2" }],
    });
    await account.stop();
    archive.close();

    const reopenedArchive = createConversationArchive(applicationDatabase);
    const reopenedInbox = createManagedChatInbox(reopenedArchive, { allowed: gate.allowed });
    const restartedFake = fakeSession();
    const restartedAccount = createWhatsAppAccount({
      storeDirectory,
      archive: reopenedInbox.recorder,
      sessionFactory: () => restartedFake.session,
    });
    await restartedAccount.authenticate({});
    const replayDispatches: AmbienceDispatchRequest[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            runWhatsAppSession(restartedAccount.session(), {
              gate,
              history: reopenedArchive,
              inbox: reopenedInbox,
              dispatch: async (request) => {
                replayDispatches.push(request);
                return { dispatchId: "dispatch-location-replay-31", acceptedAt: "2026-07-15T00:01:00.000Z" };
              },
            }),
          );
          yield* Effect.sleep(Duration.millis(10));
        }),
      ),
    );

    expect(replayDispatches).toEqual([]);
    expect(reopenedInbox.admission("window-location-31")).toEqual({
      status: "done",
      windowId: "window-location-31",
      dispatchId: "dispatch-location-31",
      acceptedAt: "2026-07-15T00:00:00.000Z",
    });
    await restartedAccount.stop();
    reopenedArchive.close();
  });
});

describe("foreground runtime terminal logged_out", () => {
  it("sends the configured canary through WhatsApp and resolves only after observer-backed silent settlement", async () => {
    const { applicationDatabase, storeDirectory, archive } = temporaryArchive();
    archive.close();
    const fake = fakeSession();
    let observer: import("../../src/ambience/observer.ts").AmbienceObserver | undefined;
    let canaryDispatches = 0;
    const runtime = startWhatsAppRuntime({
      storeDirectory,
      applicationDatabase,
      managedChats: [CHAT],
      canaryChat: CHAT,
      sessionFactory: () => fake.session,
      coalescer: { debounceWindow: Duration.millis(10), maxWait: Duration.millis(20) },
      observeActivity: (next) => {
        observer = next;
        queueMicrotask(() => {
          next.windowDispatched({
            windowId: "unrelated-window",
            chatId: CHAT,
            dispatchId: "unrelated-dispatch",
            messageCount: 1,
          });
          next.settledSilent({
            windowId: "unrelated-window",
            chatId: CHAT,
            dispatchId: "unrelated-dispatch",
          });
        });
        return () => {
          observer = undefined;
        };
      },
      dispatch: async (request) => {
        canaryDispatches += 1;
        const dispatchId = "dispatch-live-smoke-31";
        observer?.windowDispatched({
          windowId: request.input.type === "whatsapp.window" ? request.input.windowId : "unexpected",
          chatId: CHAT,
          dispatchId,
          messageCount: 1,
        });
        queueMicrotask(() =>
          observer?.settledSilent({
            windowId: request.input.type === "whatsapp.window" ? request.input.windowId : "unexpected",
            chatId: CHAT,
            dispatchId,
          }),
        );
        return { dispatchId, acceptedAt: "2026-07-16T18:00:00.000Z" };
      },
    });
    await vi.waitFor(() => expect(getWhatsAppRuntimeStatus().phase).toBe("online"));

    await expect(runtime.smokeCanary("abc123", 1_000)).resolves.toEqual({
      chatId: CHAT,
      text: "SMOKE abc123 — ignore",
      stages: ["admission", "dispatch", "settled-silent"],
    });
    expect(canaryDispatches).toBe(1);
    expect(fake.sent).toEqual([{ chatId: CHAT, content: { text: "SMOKE abc123 — ignore" } }]);
    await runtime.stop();
  });

  it("handles the observer lifecycle rejection when the provider send fails first", async () => {
    const { applicationDatabase, storeDirectory, archive } = temporaryArchive();
    archive.close();
    const runtime = startWhatsAppRuntime({
      storeDirectory,
      applicationDatabase,
      managedChats: [CHAT],
      canaryChat: CHAT,
      sessionFactory: () => fakeSession({ sendError: new Error("provider send rejected") }).session,
    });
    await vi.waitFor(() => expect(getWhatsAppRuntimeStatus().phase).toBe("online"));

    await expect(runtime.smokeCanary("abc123", 10)).rejects.toThrow("provider send rejected");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.stop();
  });

  it("fails the runtime status and exits cleanly pointing at the guided re-pair", async () => {
    const { applicationDatabase, storeDirectory, archive } = temporaryArchive();
    archive.close();
    const statusListeners = new Set<(status: Status) => void | Promise<void>>();
    const session = {
      onStatus(listener: (status: Status) => void | Promise<void>) {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      onMessage: () => () => undefined,
      onUpdate: () => () => undefined,
      onConversationSync: () => () => undefined,
      async start() {
        for (const listener of statusListeners) await listener({ phase: "logged_out" } as Status);
      },
      async stop() {},
      identity: () => undefined,
    } as unknown as WhatsAppSession;
    const exits: number[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const runtime = startWhatsAppRuntime({
        storeDirectory,
        applicationDatabase,
        managedChats: [CHAT],
        sessionFactory: () => session,
        exit: (code) => {
          exits.push(code);
        },
      });
      await vi.waitFor(() => expect(exits).toEqual([1]));
      expect(getWhatsAppRuntimeStatus().phase).toBe("failed");
      const written = stderrSpy.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(written).toContain("logged_out");
      expect(written).toContain("ambient-agent repair whatsapp");
      await runtime.stop();
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

describe("real WhatsApp Host outcome boundary", () => {
  it("fails an unavailable quote before starting typing or attempting delivery", async () => {
    const fake = fakeSession();
    const host = createWhatsAppHost(fake.session, () => undefined);

    await expect(host.say(CHAT, "do not pulse typing", "missing-31")).resolves.toEqual({
      delivery: "failed",
      deliveryError: `WhatsApp message missing-31 is not available in ${CHAT}.`,
      typing: "cleared",
    });
    expect(fake.sent).toEqual([]);
    expect(fake.typing).toEqual([]);
  });

  it("fails a reaction to an unavailable message without attempting delivery", async () => {
    const fake = fakeSession();
    const host = createWhatsAppHost(fake.session, () => undefined);

    await expect(host.react(CHAT, "missing-31", "👀")).resolves.toEqual({
      delivery: "failed",
      deliveryError: `WhatsApp message missing-31 is not available in ${CHAT}.`,
    });
    expect(fake.sent).toEqual([]);
    expect(fake.typing).toEqual([]);
  });

  it("reports whatsappd's pre-provider reaction rejection as a known failure", async () => {
    const fake = fakeSession({ sendError: new Error("not online (phase: backing_off)") });
    const host = createWhatsAppHost(fake.session, (_chatId, messageId) => ({
      id: messageId,
      chatId: CHAT,
      fromMe: false,
    }));

    await expect(host.react(CHAT, "incoming-31", "👀")).resolves.toEqual({
      delivery: "failed",
      deliveryError: "not online (phase: backing_off)",
    });
    expect(fake.sent).toEqual([
      {
        chatId: CHAT,
        content: { react: { to: { id: "incoming-31", chatId: CHAT, fromMe: false }, emoji: "👀" } },
      },
    ]);
    expect(fake.typing).toEqual([]);
  });

  it("does not retry a reaction whose provider outcome is unknown", async () => {
    const fake = fakeSession({ sendError: new Error("provider outcome unknown") });
    const host = createWhatsAppHost(fake.session, (_chatId, messageId) => ({
      id: messageId,
      chatId: CHAT,
      fromMe: false,
    }));

    await expect(host.react(CHAT, "incoming-31", "👀")).resolves.toEqual({
      delivery: "unknown",
      deliveryError: "provider outcome unknown",
    });
    expect(fake.sent).toHaveLength(1);
    expect(fake.typing).toEqual([]);
  });

  it("keeps typing visible for a perceptible beat before the send", async () => {
    const fake = fakeSession();
    const host = createWhatsAppHost(fake.session, () => undefined);

    const result = host.say(CHAT, "show typing before this message");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fake.typing).toEqual([{ chatId: CHAT, on: true }]);
    expect(fake.sent).toEqual([]);
    await expect(result).resolves.toMatchObject({ delivery: "sent" });
  });

  it("quotes the requested triggering message without exposing chat selection to the model", async () => {
    const fake = fakeSession();
    const host = createWhatsAppHost(fake.session, (_chatId, messageId) => ({
      id: messageId,
      chatId: CHAT,
      fromMe: false,
      participant: "15551112222@s.whatsapp.net",
    }));

    await host.say(CHAT, "threaded reply", "incoming-31");

    expect(fake.sent).toEqual([
      {
        chatId: CHAT,
        content: { text: "threaded reply" },
        options: {
          quote: {
            id: "incoming-31",
            chatId: CHAT,
            fromMe: false,
            participant: "15551112222@s.whatsapp.net",
          },
        },
      },
    ]);
  });

  it("does not retry a rejected send and clears typing after the unknown outcome", async () => {
    const fake = fakeSession({ sendError: new Error("provider outcome unknown") });
    const host = createWhatsAppHost(fake.session, () => undefined);

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
    const host = createWhatsAppHost(fake.session, () => undefined);

    await expect(host.say(CHAT, "cannot leave this process")).resolves.toEqual({
      delivery: "failed",
      deliveryError: "not online (phase: backing_off)",
      typing: "cleared",
    });
    expect(fake.sent).toHaveLength(1);
    expect(fake.typing.at(-1)).toEqual({ chatId: CHAT, on: false });
  });

  it("clears typing when delivery bookkeeping itself throws", async () => {
    const sendError = new Error("provider outcome unknown");
    Object.defineProperty(sendError, "message", {
      get: () => {
        throw new Error("delivery bookkeeping failed");
      },
    });
    const fake = fakeSession({ sendError });
    const host = createWhatsAppHost(fake.session, () => undefined);

    await expect(host.say(CHAT, "cleanup survives bookkeeping")).rejects.toThrow("delivery bookkeeping failed");
    expect(fake.typing.at(-1)).toEqual({ chatId: CHAT, on: false });
  });

  it("keeps a confirmed message ID when typing cleanup is uncertain", async () => {
    const fake = fakeSession({ typingOffError: new Error("typing cleanup outcome unknown") });
    const host = createWhatsAppHost(fake.session, () => undefined);

    await expect(host.say(CHAT, "confirmed delivery")).resolves.toEqual({
      delivery: "sent",
      messageId: "real-host-message-1",
      typing: "unknown",
      typingError: "typing cleanup outcome unknown",
    });
    expect(fake.typing.at(-1)).toEqual({ chatId: CHAT, on: false });
  });
});
