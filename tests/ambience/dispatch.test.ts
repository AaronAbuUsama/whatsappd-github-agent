import { describe, expect, it } from "vite-plus/test";
import { Duration, Effect, Layer, Queue, Ref, Schedule } from "effect";
import * as v from "valibot";

import * as Coalescer from "../../src/coalescer/coalescer.ts";
import { configLayer } from "../../src/coalescer/config.ts";
import type { IncomingMessage } from "../../src/coalescer/events.ts";
import { inMemoryWindowStore, queueEventSource } from "../../src/coalescer/mocks.ts";
import { makeAmbienceWindowDispatcher, type AmbienceDispatchRequest } from "../../src/ambience/dispatch.ts";
import { createFakeWhatsAppHost } from "../../src/host/fake-whatsapp-host.ts";
import type { WhatsAppHost } from "../../src/host/whatsapp-host.ts";
import { createSayTool } from "../../src/tools/whatsapp/say.ts";

const BOT = "bot@s.whatsapp.net";
const CHAT = "team@g.us";

let sequence = 0;
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

describe("production Coalescer-to-Ambience dispatch", () => {
  it("dispatches one complete coalesced window to the continuing instance identified by chatId", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Queue.unbounded<IncomingMessage>();
          const dispatches = yield* Ref.make<readonly AmbienceDispatchRequest[]>([]);
          const dispatch = async (request: AmbienceDispatchRequest) => {
            await Effect.runPromise(Ref.update(dispatches, (current) => [...current, request]));
            return { dispatchId: "dispatch-27", acceptedAt: "2026-07-13T00:00:00.000Z" };
          };

          yield* Effect.forkScoped(
            Coalescer.run.pipe(
              Effect.provide(
                Layer.mergeAll(
                  queueEventSource(source),
                  inMemoryWindowStore(),
                  makeAmbienceWindowDispatcher(dispatch),
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
                  expect.objectContaining({ text: "first", pushName: "Alice" }),
                  expect.objectContaining({ text: "second", pushName: "Alice" }),
                ],
              },
            },
          ]);
        }),
      ),
    );
  });
});

describe("say", () => {
  it("is the explicit speech capability and finalizes typing after one successful send", async () => {
    const host = createFakeWhatsAppHost();
    const say = createSayTool(CHAT, host);

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

  it("does not retry an uncertain send and still finalizes typing after failure", async () => {
    const host = createFakeWhatsAppHost();
    host.failNextSend(new Error("provider outcome unknown"));
    const say = createSayTool(CHAT, host);

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
    const say = createSayTool(CHAT, host);

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
    } as unknown as WhatsAppHost;
    const say = createSayTool(CHAT, malformedHost);
    const result = await say.run({ input: { text: "validate the receipt" } });

    expect(v.safeParse(say.output, result).success).toBe(false);
  });
});
