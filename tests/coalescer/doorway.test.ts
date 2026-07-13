/**
 * The doorway voice (#6): the say-only delivery contract, the session-resume
 * correction from #4, and the say-harvest — verified end to end through the REAL
 * Coalescer with a mock `Outbound` and a scripted model.
 *
 * The load-bearing assertion (DoD #3): the group receives ONLY what the model
 * emits via `say`; the model's prose is present in the turn result yet is never
 * delivered. And pure chatter — a turn where the model calls no `say` — stays
 * silent even though the turn genuinely ran.
 *
 * These use the LIVE clock (plain `it` + `Effect.runPromise`), not `TestClock`,
 * because the doorway voice awaits a real promise (the model turn); we poll the
 * collecting outbound until it settles rather than advancing virtual time.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Layer, Queue, Ref, Schedule } from "effect";
import type { Client, HandleMessageStreamEvent } from "eve/client";
import * as Coalescer from "../../src/coalescer/coalescer.ts";
import { configLayer } from "../../src/coalescer/config.ts";
import {
  doorwayVoice,
  eveVoiceModel,
  harvestSays,
  memorySessionStore,
  type VoiceModel,
  type VoiceTurnResult,
} from "../../src/coalescer/doorway.ts";
import type { FireReason, IncomingMessage } from "../../src/coalescer/events.ts";
import { collectingOutbound, type OutboundEvent, queueEventSource } from "../../src/coalescer/mocks.ts";

const BOT = "bot@s.whatsapp.net";
const CHAT = "team@g.us";

let seq = 0;
const mkMsg = (text: string, over: Partial<IncomingMessage> = {}): IncomingMessage => {
  const n = ++seq;
  return {
    id: `m${n}`,
    chatId: CHAT,
    from: "u@s.whatsapp.net",
    pushName: "U",
    text,
    timestamp: n * 1000,
    isGroup: true,
    fromMe: false,
    live: true,
    mentions: [],
    ...over,
  };
};

// ── Synthetic Eve turn events ────────────────────────────────────────────────
// A `say` call surfaces as a `tool-call` action inside an `actions.requested`
// event; the model's prose surfaces as `message.completed`. We build both so the
// harvest is exercised against a realistically-shaped stream.

const sayAction = (callId: string, text: string) => ({ kind: "tool-call", toolName: "say", callId, input: { text } });

const actionsRequested = (actions: readonly unknown[]): HandleMessageStreamEvent =>
  ({ type: "actions.requested", data: { actions, sequence: 0, stepIndex: 0, turnId: "t1" } }) as unknown as HandleMessageStreamEvent;

const messageCompleted = (text: string): HandleMessageStreamEvent =>
  ({ type: "message.completed", data: { text, finishReason: "stop" } }) as unknown as HandleMessageStreamEvent;

/** A scripted model that records every turn it was asked to run, then returns a canned result. */
const scriptedModel = (
  script: (message: string, reason: FireReason) => VoiceTurnResult,
  calls?: Ref.Ref<readonly { readonly message: string; readonly reason: FireReason }[]>,
): VoiceModel => ({
  turn: async (_chatId, message, reason) => {
    if (calls) await Effect.runPromise(Ref.update(calls, (c) => [...c, { message, reason }]));
    return script(message, reason);
  },
});

/** Fork the REAL Coalescer over a test source + the doorway voice + a collecting outbound. */
const startDoorway = (
  source: Queue.Dequeue<IncomingMessage>,
  outbound: Ref.Ref<readonly OutboundEvent[]>,
  model: VoiceModel,
  debounce = Duration.millis(40),
) =>
  Effect.forkScoped(
    Coalescer.run.pipe(
      Effect.provide(
        Layer.mergeAll(
          queueEventSource(source),
          doorwayVoice(model).pipe(Layer.provide(collectingOutbound(outbound))),
          configLayer({ botIds: [BOT], debounceWindow: debounce }),
        ),
      ),
    ),
  );

/** Poll a Ref (live clock) until the predicate holds or we time out, returning the value. */
const awaitRef = <A>(ref: Ref.Ref<A>, pred: (a: A) => boolean) =>
  Ref.get(ref).pipe(
    Effect.flatMap((a) => (pred(a) ? Effect.succeed(a) : Effect.fail(new Error("retry")))),
    Effect.retry(Schedule.spaced(Duration.millis(10))),
    Effect.timeoutFail({ duration: Duration.seconds(5), onTimeout: () => new Error("condition never held") }),
  );

const replies = (o: readonly OutboundEvent[]): readonly string[] =>
  o.filter((e) => e.kind === "reply").map((e) => e.text);

describe("doorway voice — say-only delivery through the Coalescer", () => {
  it("delivers ONLY the model's say lines; its prose never reaches the group", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Queue.unbounded<IncomingMessage>();
          const outbound = yield* Ref.make<readonly OutboundEvent[]>([]);

          const PROSE = "internal reasoning the group must never see";
          const model = scriptedModel(() => ({
            // The model both "thinks" (prose) AND says two lines. Only the says may land.
            events: [actionsRequested([sayAction("c1", "on it 👍"), sayAction("c2", "opened #42")]), messageCompleted(PROSE)],
            message: PROSE,
            status: "waiting",
          }));
          yield* startDoorway(source, outbound, model);

          // An @-mention fires immediately.
          yield* Queue.offer(source, mkMsg("@bot file that", { mentions: [BOT] }));

          const o = yield* awaitRef(outbound, (evts) => replies(evts).length >= 2);
          // Exactly the two say lines, in order — and nothing else.
          expect(o).toEqual([
            { kind: "reply", chatId: CHAT, text: "on it 👍" },
            { kind: "reply", chatId: CHAT, text: "opened #42" },
          ]);
          // The prose is nowhere in what the group received.
          expect(replies(o)).not.toContain(PROSE);
          expect(JSON.stringify(o)).not.toContain(PROSE);
        }),
      ),
    );
  });

  it("stays silent on chatter — the turn runs, calls no say, and nothing is delivered", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Queue.unbounded<IncomingMessage>();
          const outbound = yield* Ref.make<readonly OutboundEvent[]>([]);
          const calls = yield* Ref.make<readonly { readonly message: string; readonly reason: FireReason }[]>([]);

          // The model chooses silence: no say calls, though it still "thinks".
          const model = scriptedModel(
            () => ({ events: [messageCompleted("nah, not for me")], message: "nah, not for me", status: "waiting" }),
            calls,
          );
          yield* startDoorway(source, outbound, model);

          yield* Queue.offer(source, mkMsg("lol nice weekend everyone"));

          // The ambient turn actually ran (proves this is chosen silence, not a turn that never fired)...
          yield* awaitRef(calls, (c) => c.length >= 1);
          const c = yield* Ref.get(calls);
          expect(c[0]!.reason).toBe("debounce");
          // ...and it delivered nothing.
          expect(yield* Ref.get(outbound)).toHaveLength(0);
        }),
      ),
    );
  });
});

describe("harvestSays", () => {
  it("pulls say inputs in call order and ignores prose + other tools", () => {
    const events = [
      actionsRequested([sayAction("a", "first"), { kind: "tool-call", toolName: "delegate", callId: "b", input: { instruction: "x" } }]),
      messageCompleted("prose in the middle"),
      actionsRequested([sayAction("c", "second")]),
    ];
    expect(harvestSays(events)).toEqual(["first", "second"]);
  });

  it("dedupes say calls by callId and drops empty text", () => {
    const events = [
      actionsRequested([sayAction("dup", "hello")]),
      actionsRequested([sayAction("dup", "hello"), sayAction("empty", "")]),
    ];
    expect(harvestSays(events)).toEqual(["hello"]);
  });

  it("keeps the LAST complete text when one call streams incrementally", () => {
    // Same callId, growing input across events — the complete line must win, not the partial.
    const events = [
      actionsRequested([sayAction("stream", "on i")]),
      actionsRequested([sayAction("stream", "on it — opened #42")]),
    ];
    expect(harvestSays(events)).toEqual(["on it — opened #42"]);
  });

  it("returns nothing for a silent turn (no say calls)", () => {
    expect(harvestSays([messageCompleted("thinking, but staying quiet")])).toEqual([]);
  });
});

describe("eveVoiceModel — resumes the SAME session by SessionState (the #4 correction)", () => {
  it("opens fresh on the first turn, then resumes from the captured SessionState", async () => {
    const sels: unknown[] = [];
    let counter = 0;
    const fakeClient = {
      session(sel: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let state: any = sel && typeof sel === "object" ? { ...(sel as object) } : { streamIndex: 0 };
        return {
          get state() {
            return state;
          },
          async send() {
            sels.push(sel);
            const sessionId = state.sessionId ?? `sess-${++counter}`;
            state = { ...state, sessionId, streamIndex: (state.streamIndex ?? 0) + 1 };
            return {
              async result() {
                return { events: [], message: "prose", status: "waiting", sessionId, data: undefined, inputRequests: [] };
              },
            };
          },
        };
      },
    } as unknown as Client;

    const store = memorySessionStore();
    const model = eveVoiceModel(fakeClient, store);

    await model.turn(CHAT, "hello", "mention");
    // First turn: no prior state → opened fresh (undefined selector), and we captured a sessionId.
    expect(sels[0]).toBeUndefined();
    expect(store.get(CHAT)?.sessionId).toBe("sess-1");

    await model.turn(CHAT, "remember that?", "debounce");
    // Second turn: resumed from the SAME captured SessionState — NOT a bare token, NOT undefined.
    // This is exactly what makes multi-turn memory work (a fresh session each turn is memoryless).
    expect(sels[1]).toEqual({ sessionId: "sess-1", streamIndex: 1 });
    expect(store.get(CHAT)?.sessionId).toBe("sess-1");
  });

  it("binds a newly-created session to its chat before tools run", async () => {
    let releaseResult!: () => void;
    const resultStarted = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const fakeClient = {
      session() {
        const state = { streamIndex: 0 };
        return {
          get state() {
            return state;
          },
          async send() {
            return {
              sessionId: "sess-first-turn",
              continuationToken: "opaque",
              async result() {
                await resultStarted;
                return { events: [], message: "prose", status: "waiting" };
              },
            };
          },
        };
      },
    } as unknown as Client;
    const store = memorySessionStore();
    const turn = eveVoiceModel(fakeClient, store).turn(CHAT, "look back", "mention");

    await expect.poll(() => store.get(CHAT)?.sessionId).toBe("sess-first-turn");
    releaseResult();
    await turn;
  });
});
