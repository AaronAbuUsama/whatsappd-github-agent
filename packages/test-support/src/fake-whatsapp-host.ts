import {
  type WhatsAppDeliveryResult,
  type WhatsAppOutboundPort,
  type WhatsAppSayResult,
  withTypingResult,
} from "@ambient-agent/core/capabilities/whatsapp-participation/whatsapp-port.ts";

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
      readonly replyTo?: string;
      readonly outcome: "sent";
      readonly messageId: string;
    }
  | {
      readonly kind: "send";
      readonly chatId: string;
      readonly text: string;
      readonly replyTo?: string;
      readonly outcome: "failed" | "unknown";
      readonly error: string;
    }
  | {
      readonly kind: "react";
      readonly chatId: string;
      readonly messageId: string;
      readonly emoji: string;
    };

export interface FakeWhatsAppHost extends WhatsAppOutboundPort {
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
    say: async (chatId, text, replyTo): Promise<WhatsAppSayResult> => {
      recorded.push({ kind: "typing", chatId, on: true });
      const sendError = nextSendError;
      nextSendError = undefined;
      let delivery: WhatsAppDeliveryResult;
      if (sendError !== undefined) {
        recorded.push({
          kind: "send",
          chatId,
          text,
          ...(replyTo === undefined ? {} : { replyTo }),
          outcome: sendError.delivery,
          error: sendError.error.message,
        });
        delivery = { delivery: sendError.delivery, deliveryError: sendError.error.message };
      } else {
        const messageId = `fake-message-${++nextMessage}`;
        recorded.push({
          kind: "send",
          chatId,
          text,
          ...(replyTo === undefined ? {} : { replyTo }),
          outcome: "sent",
          messageId,
        });
        delivery = { delivery: "sent", messageId };
      }

      const typingError = nextTypingError;
      nextTypingError = undefined;
      if (typingError === undefined) recorded.push({ kind: "typing", chatId, on: false });
      else recorded.push({ kind: "typing", chatId, on: false, outcome: "unknown", error: typingError.message });
      return withTypingResult(delivery, typingError?.message);
    },
    react: async (chatId, messageId, emoji): Promise<WhatsAppDeliveryResult> => {
      recorded.push({ kind: "react", chatId, messageId, emoji });
      return { delivery: "sent", messageId: `fake-message-${++nextMessage}` };
    },
  };
};
