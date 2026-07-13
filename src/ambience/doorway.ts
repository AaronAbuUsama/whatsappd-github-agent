import { dispatch, type DispatchReceipt } from "@flue/runtime";
import { Effect, Layer } from "effect";

import ambience from "../agents/ambience.ts";
import type { ConversationWindow } from "../coalescer/events.ts";
import { Conversationalist, ConversationError } from "../coalescer/ports.ts";
import { whatsappWindowInput, type AmbienceInput } from "./events.ts";

export interface AmbienceAdmission {
  readonly id: string;
  readonly input: AmbienceInput;
}

export type AdmitAmbience = (admission: AmbienceAdmission) => Promise<DispatchReceipt>;

export const dispatchAmbience = ({ id, input }: AmbienceAdmission): Promise<DispatchReceipt> =>
  dispatch(ambience, { id, input });

export const makeAmbienceDoorway = (
  admit: AdmitAmbience = dispatchAmbience,
): Layer.Layer<Conversationalist> =>
  Layer.succeed(Conversationalist, {
    turn: (window: ConversationWindow) =>
      Effect.tryPromise({
        try: () => admit({ id: window.chatId, input: whatsappWindowInput(window) }),
        catch: (cause) => new ConversationError({ cause }),
      }).pipe(Effect.asVoid),
  });

export const ambienceDoorway = makeAmbienceDoorway();
