import { dispatch, type DispatchReceipt } from "@flue/runtime";
import { Effect, Layer } from "effect";

import ambience from "../agents/ambience.ts";
import type { ConversationWindow } from "../coalescer/events.ts";
import { AmbienceAdmissionError, AmbienceAdmission } from "../coalescer/ports.ts";
import { whatsappWindowInput, type AmbienceInput } from "./events.ts";

export interface AmbienceAdmissionRequest {
  readonly id: string;
  readonly input: AmbienceInput;
}

export type AdmitAmbience = (admission: AmbienceAdmissionRequest) => Promise<DispatchReceipt>;

export const dispatchAmbience = ({ id, input }: AmbienceAdmissionRequest): Promise<DispatchReceipt> =>
  dispatch(ambience, { id, input });

export const makeAmbienceAdmission = (
  admit: AdmitAmbience = dispatchAmbience,
): Layer.Layer<AmbienceAdmission> =>
  Layer.succeed(AmbienceAdmission, {
    admit: (window: ConversationWindow) =>
      Effect.tryPromise({
        try: () => admit({ id: window.chatId, input: whatsappWindowInput(window) }),
        catch: (cause) => new AmbienceAdmissionError({ cause }),
      }).pipe(Effect.asVoid),
  });

export const ambienceAdmission = makeAmbienceAdmission();
