import { beforeEach, describe, expect, it } from "vite-plus/test";
import { Duration, Effect, Layer, Queue, Ref, Schedule } from "effect";
import * as v from "valibot";

import * as Coalescer from "../../packages/engine/src/coalescer/coalescer.ts";
import { configLayer } from "../../packages/engine/src/coalescer/config.ts";
import type { IncomingMessage } from "../../packages/engine/src/coalescer/events.ts";
import { inMemoryWindowStore, queueEventSource } from "../../packages/test-support/src/coalescer-mocks.ts";
import {
  configureHistoricalReplayGate,
  dispatchSpeaker,
  makeSpeakerWindowDispatcher,
  type SpeakerDispatchRequest,
} from "../../packages/agents/src/speaker/dispatch.ts";
import { createReactTool, createSayTool } from "../../packages/agents/src/capabilities/whatsapp-participation/tools.ts";
import {
  configureWhatsAppParticipationPort,
  type WhatsAppOutboundPort,
} from "../../packages/agents/src/capabilities/whatsapp-participation/whatsapp-port.ts";
import { createFakeWhatsAppHost } from "../../packages/test-support/src/fake-whatsapp-host.ts";
import type { ManagedChatInbox, WindowAdmission } from "../../packages/engine/src/intake/managed-chat-inbox.ts";

const BOT = "bot@s.whatsapp.net";
const CHAT = "team@g.us";

const sayToolFor = (host: WhatsAppOutboundPort) => {
  configureWhatsAppParticipationPort({ say: host.say, react: host.react, readThread: () => [], search: () => [] });
  return createSayTool(CHAT);
};

let sequence = 0;
beforeEach(() => {
  sequence = 0;
});
const message = (text: string, overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: `m-${++sequence}`,
  chatId: CHAT,
  from: "alice@s.whatsapp.net",
  pushName: "Alice",
  text,
  timestamp: sequence * 1_000,
  isGroup: true,
  fromMe: false,
  live: true,
  mentions: [],
  ...overrides,
});

const awaitRef = <A>(ref: Ref.Ref<A>, predicate: (value: A) => boolean) =>
  Ref.get(ref).pipe(
    Effect.flatMap((value) => (predicate(value) ? Effect.succeed(value) : Effect.fail(new Error("retry")))),
    Effect.retry(Schedule.spaced(Duration.millis(10))),
    Effect.timeoutOrElse({
      duration: Duration.seconds(5),
      orElse: () => Effect.fail(new Error("condition never held")),
    }),
  );

describe("production Coalescer-to-Speaker dispatch", () => {
  it("admits the raw fact stream even when Speaker admission fails", async () => {
    const offered: string[] = [];
    const observed = message("scribe survives");
    await expect(
      dispatchSpeaker(
        {
          id: CHAT,
          input: {
            type: "whatsapp.window",
            windowId: "window-failed-speaker",
            chatId: CHAT,
            reason: "capacity",
            messages: [{ ...observed, mentions: [...observed.mentions] }],
            updates: [],
          },
        },
        {
          offerScribe: ({ input }) => {
            if (input.type === "whatsapp.window") offered.push(input.messages[0]!.id);
          },
          dispatch: async () => {
            throw new Error("Speaker unavailable");
          },
        },
      ),
    ).rejects.toThrow("Speaker unavailable");
    expect(offered).toHaveLength(1);
  });

  it("still dispatches the Speaker when Scribe intake throws", async () => {
    const observed = message("speaker survives");
    const restore = configureHistoricalReplayGate({
      liveSlice: () => {
        throw new Error("Scribe store unavailable");
      },
    });
    try {
      await expect(
        dispatchSpeaker(
          {
            id: CHAT,
            input: {
              type: "whatsapp.window",
              windowId: "window-failed-scribe",
              chatId: CHAT,
              reason: "capacity",
              messages: [{ ...observed, mentions: [...observed.mentions] }],
              updates: [],
            },
          },
          {
            dispatch: async () => ({
              dispatchId: "speaker-dispatch-survived",
              acceptedAt: "2026-07-22T00:00:00.000Z",
            }),
          },
        ),
      ).resolves.toMatchObject({ dispatchId: "speaker-dispatch-survived" });
    } finally {
      restore();
    }
  });

  it("dispatches one complete coalesced window to the continuing instance identified by chatId", async () => {
    const admissions = new Map<string, WindowAdmission>();
    const inbox = {
      markDone: (windowId: string, receipt: { dispatchId: string; acceptedAt: string }) => {
        admissions.set(windowId, { status: "done", windowId, ...receipt });
      },
      markFailed: (windowId: string, reason: string) => {
        admissions.set(windowId, { status: "failed", windowId, reason });
      },
    } as unknown as ManagedChatInbox;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Queue.unbounded<IncomingMessage>();
          const dispatches = yield* Ref.make<readonly SpeakerDispatchRequest[]>([]);
          const dispatch = async (request: SpeakerDispatchRequest) => {
            await Effect.runPromise(Ref.update(dispatches, (current) => [...current, request]));
            return { dispatchId: "dispatch-27", acceptedAt: "2026-07-13T00:00:00.000Z" };
          };

          yield* Effect.forkScoped(
            Coalescer.run.pipe(
              Effect.provide(
                Layer.mergeAll(
                  queueEventSource(source),
                  inMemoryWindowStore(),
                  makeSpeakerWindowDispatcher(inbox, dispatch),
                  configLayer({ botIds: [BOT], debounceWindow: Duration.millis(25) }),
                ),
              ),
            ),
          );

          yield* Queue.offer(source, message("first"));
          yield* Queue.offer(source, message("second"));

          const seen = yield* awaitRef(dispatches, (current) => current.length === 1);
          expect(seen).toEqual([
            {
              id: CHAT,
              input: {
                type: "whatsapp.window",
                windowId: "window-1",
                chatId: CHAT,
                reason: "debounce",
                messages: [
                  expect.objectContaining({ text: "first", pushName: "Alice", evidenceId: `arrival:${CHAT}:m-1` }),
                  expect.objectContaining({ text: "second", pushName: "Alice", evidenceId: `arrival:${CHAT}:m-2` }),
                ],
                updates: [],
              },
            },
          ]);
          expect(admissions.get("window-1")).toEqual({
            status: "done",
            windowId: "window-1",
            dispatchId: "dispatch-27",
            acceptedAt: "2026-07-13T00:00:00.000Z",
          });
        }),
      ),
    );
  });
});

describe("say", () => {
  it("is the explicit speech capability and finalizes typing after one successful send", async () => {
    const host = createFakeWhatsAppHost();
    const say = sayToolFor(host);

    await expect(say.run({ input: { text: "hello group" } })).resolves.toEqual({
      delivery: "sent",
      messageId: "fake-message-1",
      typing: "cleared",
    });
    expect(host.events()).toEqual([
      { kind: "typing", chatId: CHAT, on: true },
      {
        kind: "send",
        chatId: CHAT,
        text: "hello group",
        outcome: "sent",
        messageId: "fake-message-1",
      },
      { kind: "typing", chatId: CHAT, on: false },
    ]);
  });

  it("forwards an explicit reply target to the chat-bound host", async () => {
    const host = createFakeWhatsAppHost();
    const say = sayToolFor(host);

    await expect(
      say.run({
        input: {
          text: "reply in context",
          replyTo: "incoming-27",
        },
      }),
    ).resolves.toMatchObject({ delivery: "sent" });
    expect(host.events()).toContainEqual({
      kind: "send",
      chatId: CHAT,
      text: "reply in context",
      replyTo: "incoming-27",
      outcome: "sent",
      messageId: "fake-message-1",
    });
  });

  it("does not retry an uncertain send and still finalizes typing after failure", async () => {
    const host = createFakeWhatsAppHost();
    host.failNextSend(new Error("provider outcome unknown"));
    const say = sayToolFor(host);

    await expect(say.run({ input: { text: "send once" } })).resolves.toEqual({
      delivery: "unknown",
      deliveryError: "provider outcome unknown",
      typing: "cleared",
    });
    expect(host.events()).toEqual([
      { kind: "typing", chatId: CHAT, on: true },
      {
        kind: "send",
        chatId: CHAT,
        text: "send once",
        outcome: "unknown",
        error: "provider outcome unknown",
      },
      { kind: "typing", chatId: CHAT, on: false },
    ]);
  });

  it("preserves a confirmed message receipt when typing finalization is uncertain", async () => {
    const host = createFakeWhatsAppHost();
    host.failNextTypingFinalization(new Error("typing cleanup outcome unknown"));
    const say = sayToolFor(host);

    await expect(say.run({ input: { text: "delivered once" } })).resolves.toEqual({
      delivery: "sent",
      messageId: "fake-message-1",
      typing: "unknown",
      typingError: "typing cleanup outcome unknown",
    });
    expect(host.events()).toEqual([
      { kind: "typing", chatId: CHAT, on: true },
      {
        kind: "send",
        chatId: CHAT,
        text: "delivered once",
        outcome: "sent",
        messageId: "fake-message-1",
      },
      {
        kind: "typing",
        chatId: CHAT,
        on: false,
        outcome: "unknown",
        error: "typing cleanup outcome unknown",
      },
    ]);
  });

  it("declares a runtime output schema that rejects a malformed host receipt", async () => {
    const malformedHost = {
      say: async () => ({ delivery: "sent", messageId: "", typing: "cleared" }),
      react: async () => ({ delivery: "sent", messageId: "", typing: "cleared" }),
    } as unknown as WhatsAppOutboundPort;
    const say = sayToolFor(malformedHost);
    const result = await say.run({ input: { text: "validate the receipt" } });

    expect(v.safeParse(say.output, result).success).toBe(false);
  });
});

describe("react", () => {
  it("records one chat-bound reaction without manufacturing typing activity", async () => {
    const host = createFakeWhatsAppHost();
    configureWhatsAppParticipationPort({
      say: host.say,
      react: host.react,
      readThread: () => [],
      search: () => [],
    });
    const react = createReactTool(CHAT);

    await expect(react.run({ input: { messageId: "incoming-27", emoji: "👀" } })).resolves.toEqual({
      delivery: "sent",
      messageId: "fake-message-1",
    });
    expect(host.events()).toEqual([{ kind: "react", chatId: CHAT, messageId: "incoming-27", emoji: "👀" }]);
  });
});
