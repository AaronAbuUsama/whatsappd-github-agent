import {
  type WhatsAppDeliveryResult,
  type WhatsAppSayPort,
  type WhatsAppSayResult,
  withTypingResult,
} from "../../src/capabilities/whatsapp-participation/whatsapp-port.ts";

export type FakeWhatsAppEvent =
  | {
      readonly kind: "typing";
      readonly chatId: string;
      readonly on: boolean;
      readonly outcome?: "unknown";
      readonly error?: string;
    }
  | {
      readonly kind: "send";
      readonly chatId: string;
      readonly text: string;
      readonly outcome: "sent";
      readonly messageId: string;
    }
  | {
      readonly kind: "send";
      readonly chatId: string;
      readonly text: string;
      readonly outcome: "failed" | "unknown";
      readonly error: string;
    };

export interface FakeWhatsAppHost extends WhatsAppSayPort {
  readonly events: () => readonly FakeWhatsAppEvent[];
  readonly failNextSend: (error: Error, delivery?: "failed" | "unknown") => void;
  readonly failNextTypingFinalization: (error: Error) => void;
  readonly reset: () => void;
}

export const createFakeWhatsAppHost = (): FakeWhatsAppHost => {
  let recorded: FakeWhatsAppEvent[] = [];
  let nextMessage = 0;
  let nextSendError: { readonly error: Error; readonly delivery: "failed" | "unknown" } | undefined;
  let nextTypingError: Error | undefined;

  return {
    events: () => structuredClone(recorded),
    failNextSend: (error, delivery = "unknown") => {
      nextSendError = { error, delivery };
    },
    failNextTypingFinalization: (error) => {
      nextTypingError = error;
    },
    reset: () => {
      recorded = [];
      nextSendError = undefined;
      nextTypingError = undefined;
    },
    say: async (chatId, text): Promise<WhatsAppSayResult> => {
      recorded.push({ kind: "typing", chatId, on: true });
      const sendError = nextSendError;
      nextSendError = undefined;
      let delivery: WhatsAppDeliveryResult;
      if (sendError !== undefined) {
        recorded.push({ kind: "send", chatId, text, outcome: sendError.delivery, error: sendError.error.message });
        delivery = { delivery: sendError.delivery, deliveryError: sendError.error.message };
      } else {
        const messageId = `fake-message-${++nextMessage}`;
        recorded.push({ kind: "send", chatId, text, outcome: "sent", messageId });
        delivery = { delivery: "sent", messageId };
      }

      const typingError = nextTypingError;
      nextTypingError = undefined;
      if (typingError === undefined) recorded.push({ kind: "typing", chatId, on: false });
      else recorded.push({ kind: "typing", chatId, on: false, outcome: "unknown", error: typingError.message });
      return withTypingResult(delivery, typingError?.message);
    },
  };
};
