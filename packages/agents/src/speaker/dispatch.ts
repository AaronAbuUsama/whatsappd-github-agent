import { dispatch, type DispatchReceipt } from "@flue/runtime";
import { Effect, Layer } from "effect";

import speaker from "./agent.ts";
import type { ConversationWindow } from "@ambient-agent/engine/coalescer/events.ts";
import { WindowDispatchError, WindowDispatcher } from "@ambient-agent/engine/coalescer/ports.ts";
import { admitWindow, type DispatchRetryPolicy } from "@ambient-agent/engine/intake/admission-relay.ts";
import type { ManagedChatInbox } from "@ambient-agent/engine/intake/managed-chat-inbox.ts";
import { speakerActivity } from "./activity-reporter.ts";
import { scribeCoalescer } from "../scribe/coalescer.ts";
import { scribeOffers, type ScribeOffer } from "../scribe/input.ts";
import { attachGraphContext } from "../capabilities/graph/digest.ts";
import { whatsappWindowInput, type SpeakerInput } from "@ambient-agent/engine/inputs.ts";
import type { HistoricalReplayStore } from "@ambient-agent/engine/intake/historical-replay.ts";

let historicalReplay: Pick<HistoricalReplayStore, "liveSlice"> | undefined;
export const configureHistoricalReplayGate = (store: Pick<HistoricalReplayStore, "liveSlice">): (() => void) => {
  const previous = historicalReplay;
  historicalReplay = store;
  return () => {
    if (historicalReplay === store) historicalReplay = previous;
  };
};

export interface SpeakerDispatchRequest {
  readonly id: string;
  readonly input: SpeakerInput;
}

export type DispatchSpeaker = (request: SpeakerDispatchRequest) => Promise<DispatchReceipt>;

export interface SpeakerDispatchDependencies {
  readonly dispatch?: typeof dispatch;
  readonly offerScribe?: (offer: ScribeOffer) => void;
}

export const dispatchSpeaker = async (
  { id, input }: SpeakerDispatchRequest,
  dependencies: SpeakerDispatchDependencies = {},
): Promise<DispatchReceipt> => {
  // The funnel is the one site all three input kinds converge (§5 D2): attach the live
  // graph digest here so the Speaker replies in one turn without a pull round-trip.
  const enriched = attachGraphContext(input);
  try {
    const scribeInput =
      input.type === "brain.directive"
        ? undefined
        : input.type === "whatsapp.window"
          ? (historicalReplay?.liveSlice(input) ?? (historicalReplay === undefined ? input : undefined))
          : input;
    if (scribeInput !== undefined) {
      for (const offer of scribeOffers(scribeInput)) (dependencies.offerScribe ?? scribeCoalescer.offer)(offer);
    }
  } catch (cause) {
    // Scribe is an independent fact-stream arm; its intake failure cannot gate the fast Speaker path.
    console.error("[scribe] fact-stream admission failed; Speaker dispatch will continue", cause);
  }
  const receipt = await (dependencies.dispatch ?? dispatch)(speaker, { id, input: enriched });
  speakerActivity.accepted(receipt, enriched);
  return receipt;
};

export const makeSpeakerWindowDispatcher = (
  inbox: ManagedChatInbox,
  dispatchWindow: DispatchSpeaker = dispatchSpeaker,
  retry?: DispatchRetryPolicy,
): Layer.Layer<WindowDispatcher, never> =>
  Layer.succeed(WindowDispatcher, {
    dispatch: (window: ConversationWindow) =>
      Effect.tryPromise({
        try: () =>
          admitWindow(
            inbox,
            window,
            () => dispatchWindow({ id: window.chatId, input: whatsappWindowInput(window) }),
            retry,
          ),
        catch: (cause) => new WindowDispatchError({ cause }),
      }),
  });
