import { dispatch, type DispatchReceipt } from "@flue/runtime";
import { Effect, Layer } from "effect";

import speaker from "./agent.ts";
import type { ConversationWindow } from "@ambient-agent/engine/coalescer/events.ts";
import { WindowDispatchError, WindowDispatcher } from "@ambient-agent/engine/coalescer/ports.ts";
import { admitWindow, type DispatchRetryPolicy } from "@ambient-agent/engine/intake/admission-relay.ts";
import type { ManagedChatInbox } from "@ambient-agent/engine/intake/managed-chat-inbox.ts";
import { speakerActivity } from "./activity-reporter.ts";
import { scribeCoalescer } from "../scribe/coalescer.ts";
import { attachGraphContext } from "../capabilities/graph/digest.ts";
import { whatsappWindowInput, type SpeakerInput } from "@ambient-agent/engine/inputs.ts";
import type { ScribeBackfillStore } from "@ambient-agent/engine/intake/scribe-backfill.ts";

let scribeBackfills: Pick<ScribeBackfillStore, "liveSlice"> | undefined;
export const configureScribeBackfillGate = (store: Pick<ScribeBackfillStore, "liveSlice">): void => {
  scribeBackfills = store;
};

export interface SpeakerDispatchRequest {
  readonly id: string;
  readonly input: SpeakerInput;
}

export type DispatchSpeaker = (request: SpeakerDispatchRequest) => Promise<DispatchReceipt>;

export const dispatchSpeaker = async ({ id, input }: SpeakerDispatchRequest): Promise<DispatchReceipt> => {
  // The funnel is the one site all three input kinds converge (§5 D2): attach the live
  // graph digest here so the Speaker replies in one turn without a pull round-trip.
  const enriched = attachGraphContext(input);
  const receipt = await dispatch(speaker, { id, input: enriched });
  speakerActivity.accepted(receipt, enriched);
  const scribeInput = input.type === "brain.directive"
    ? undefined
    : input.type === "whatsapp.window"
      ? (scribeBackfills?.liveSlice(input) ?? (scribeBackfills === undefined ? input : undefined))
      : input;
  if (scribeInput !== undefined) scribeCoalescer.offer({ id, input: scribeInput });
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
