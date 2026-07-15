import { dispatch, type DispatchReceipt } from "@flue/runtime";
import { Effect, Layer } from "effect";

import ambience from "../agents/ambience.ts";
import type { ConversationWindow } from "../coalescer/events.ts";
import { WindowDispatchError, WindowDispatcher } from "../coalescer/ports.ts";
import { admitWindow, type DispatchRetryPolicy } from "../intake/admission-relay.ts";
import type { ManagedChatInbox } from "../intake/managed-chat-inbox.ts";
import { whatsappWindowInput, type AmbienceInput } from "./events.ts";

export interface AmbienceDispatchRequest {
  readonly id: string;
  readonly input: AmbienceInput;
}

export type DispatchAmbience = (request: AmbienceDispatchRequest) => Promise<DispatchReceipt>;

export const dispatchAmbience = ({ id, input }: AmbienceDispatchRequest): Promise<DispatchReceipt> =>
  dispatch(ambience, { id, input });

export const makeAmbienceWindowDispatcher = (
  inbox: ManagedChatInbox,
  dispatchWindow: DispatchAmbience = dispatchAmbience,
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
