import { dispatch, type DispatchReceipt } from "@flue/runtime";
import { Effect, Layer } from "effect";

import speaker from "./agent.ts";
import type { ConversationWindow } from "@ambient-agent/engine/coalescer/events.ts";
import { WindowDispatchError, WindowDispatcher } from "@ambient-agent/engine/coalescer/ports.ts";
import { admitWindow, type DispatchRetryPolicy } from "@ambient-agent/engine/intake/admission-relay.ts";
import type { ManagedChatInbox } from "@ambient-agent/engine/intake/managed-chat-inbox.ts";
import { speakerActivity } from "./activity-reporter.ts";
import { scribeCoalescer } from "../scribe/coalescer.ts";
import { whatsappWindowInput, type SpeakerInput } from "@ambient-agent/engine/inputs.ts";

export interface SpeakerDispatchRequest {
  readonly id: string;
  readonly input: SpeakerInput;
}

export type DispatchSpeaker = (request: SpeakerDispatchRequest) => Promise<DispatchReceipt>;

export const dispatchSpeaker = async ({ id, input }: SpeakerDispatchRequest): Promise<DispatchReceipt> => {
  const receipt = await dispatch(speaker, { id, input });
  speakerActivity.accepted(receipt, input);
  scribeCoalescer.offer({ id, input }); // Scribe — debounced + detached; failures never touch the Speaker (#155)
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
