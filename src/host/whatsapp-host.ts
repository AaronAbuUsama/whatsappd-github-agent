export type WhatsAppSayResult =
  | { readonly delivery: "sent"; readonly messageId: string; readonly typing: "cleared" }
  | {
      readonly delivery: "sent";
      readonly messageId: string;
      readonly typing: "unknown";
      readonly typingError: string;
    }
  | {
      readonly delivery: "failed";
      readonly deliveryError: string;
      readonly typing: "cleared";
    }
  | {
      readonly delivery: "failed";
      readonly deliveryError: string;
      readonly typing: "unknown";
      readonly typingError: string;
    }
  | {
      readonly delivery: "unknown";
      readonly deliveryError: string;
      readonly typing: "cleared";
    }
  | {
      readonly delivery: "unknown";
      readonly deliveryError: string;
      readonly typing: "unknown";
      readonly typingError: string;
    };

export interface WhatsAppHost {
  /** Own the full typing/send/finalization attempt and report observed state without retrying. */
  readonly say: (chatId: string, text: string) => Promise<WhatsAppSayResult>;
}

let configuredHost: WhatsAppHost | undefined;

export const configureWhatsAppHost = (host: WhatsAppHost): void => {
  configuredHost = host;
};

export const getWhatsAppHost = (): WhatsAppHost => {
  if (configuredHost === undefined) {
    throw new Error("The WhatsApp Host is not configured for Ambience.");
  }
  return configuredHost;
};
