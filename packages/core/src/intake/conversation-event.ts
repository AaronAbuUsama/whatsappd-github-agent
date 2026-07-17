import type { BinaryInput, InboundMessage, MessageRef, Outbound, ReceiptStatus, Update } from "whatsappd";

export type ConversationDirection = "inbound" | "outbound";

export interface ConversationArrivalPayload {
  readonly live: boolean;
  readonly isGroup: boolean;
  readonly messageKind: string;
  readonly text: string;
  /** Explicit application admission for the provider-acknowledged smoke stimulus; the conversation fact remains outbound. */
  readonly applicationAdmission?: "smoke-canary";
  readonly context?: InboundMessage["context"];
  readonly addressing?: InboundMessage["addressing"];
  readonly flags?: InboundMessage["flags"];
  readonly media?: {
    readonly mimetype?: string;
    readonly fileLength?: number;
    readonly fileName?: string;
    readonly seconds?: number;
    readonly ptt?: boolean;
    readonly width?: number;
    readonly height?: number;
    readonly caption?: string;
  };
}

interface ConversationEventBase {
  readonly id: string;
  readonly providerMessageId: string;
  readonly chatId: string;
  readonly senderId?: string;
  readonly senderName?: string;
  readonly direction: ConversationDirection;
  readonly occurredAt: number;
}

export interface ConversationArrival extends ConversationEventBase {
  readonly kind: "arrival";
  readonly senderId: string;
  readonly payload: ConversationArrivalPayload;
}

export interface ConversationEdit extends ConversationEventBase {
  readonly kind: "edit";
  readonly payload: {
    readonly messageKind: InboundMessage["kind"];
    readonly text: string;
  };
}

export interface ConversationReaction extends ConversationEventBase {
  readonly kind: "reaction";
  readonly payload: {
    readonly by?: string;
    readonly emoji?: string;
    readonly removed: boolean;
  };
}

export interface ConversationReceipt extends ConversationEventBase {
  readonly kind: "receipt";
  readonly payload: {
    readonly by?: string;
    readonly status: ReceiptStatus;
  };
}

export interface ConversationRevocation extends ConversationEventBase {
  readonly kind: "revocation";
  readonly payload: { readonly by?: string };
}

export type ConversationEvent =
  | ConversationArrival
  | ConversationEdit
  | ConversationReaction
  | ConversationReceipt
  | ConversationRevocation;

const canonicalActor = (jid: string | undefined): string | null =>
  jid?.replace(/:\d+(?=@)/, "") ?? null;

export const conversationMutationFingerprint = (
  event: ConversationEdit | ConversationReaction | ConversationRevocation,
): string => {
  const scope = conversationMutationScope(event);
  const detail = event.kind === "edit"
    ? [event.payload.messageKind, event.payload.text]
    : event.kind === "reaction"
      ? [event.payload.emoji ?? null, event.payload.removed]
      : [];
  return JSON.stringify([scope, detail]);
};

export const conversationMutationScope = (
  event: ConversationEdit | ConversationReaction | ConversationRevocation,
): string => JSON.stringify([
  event.kind,
  event.chatId,
  event.providerMessageId,
  event.kind === "edit" ? null : canonicalActor(event.payload.by ?? event.senderId),
]);

const messageText = (message: InboundMessage): string => {
  switch (message.kind) {
    case "text":
      return message.text;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return message.text ?? "";
    case "location":
      return [message.name, message.address, `${message.lat}, ${message.lng}`].filter(Boolean).join(" — ");
    case "contacts":
      return message.contacts.map(({ name }) => name ?? "contact").join(", ");
    case "poll":
      return `${message.name}: ${message.options.join(", ")}`;
    case "unsupported":
      return `[unsupported: ${message.rawType}]`;
  }
};

const mediaMetadata = (message: InboundMessage): ConversationArrivalPayload["media"] => {
  if (
    message.kind !== "image" &&
    message.kind !== "video" &&
    message.kind !== "audio" &&
    message.kind !== "document" &&
    message.kind !== "sticker"
  ) {
    return undefined;
  }
  const { mimetype, fileLength, fileName, seconds, ptt, width, height, caption } = message.media;
  return {
    ...(mimetype === undefined ? {} : { mimetype }),
    ...(fileLength === undefined ? {} : { fileLength }),
    ...(fileName === undefined ? {} : { fileName }),
    ...(seconds === undefined ? {} : { seconds }),
    ...(ptt === undefined ? {} : { ptt }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(caption === undefined ? {} : { caption }),
  };
};

type OutboundArrivalDetails = Pick<ConversationArrivalPayload, "messageKind" | "text"> & {
  readonly media?: ConversationArrivalPayload["media"];
};

const binaryLength = (input: BinaryInput): number | undefined => Buffer.isBuffer(input) ? input.length : undefined;

const outboundDetails = (content: Outbound): OutboundArrivalDetails => {
  if ("text" in content) return { messageKind: "text", text: content.text };
  if ("image" in content) {
    const fileLength = binaryLength(content.image);
    return {
      messageKind: "image",
      text: content.caption ?? "",
      media: {
        ...(fileLength === undefined ? {} : { fileLength }),
        ...(content.caption === undefined ? {} : { caption: content.caption }),
      },
    };
  }
  if ("video" in content) {
    const fileLength = binaryLength(content.video);
    return {
      messageKind: "video",
      text: content.caption ?? "",
      media: {
        ...(fileLength === undefined ? {} : { fileLength }),
        ...(content.caption === undefined ? {} : { caption: content.caption }),
      },
    };
  }
  if ("audio" in content) {
    const fileLength = binaryLength(content.audio);
    return {
      messageKind: "audio",
      text: "",
      media: {
        ...(fileLength === undefined ? {} : { fileLength }),
        ...(content.mimetype === undefined ? {} : { mimetype: content.mimetype }),
        ...(content.seconds === undefined ? {} : { seconds: content.seconds }),
        ...(content.ptt === undefined ? {} : { ptt: content.ptt }),
      },
    };
  }
  if ("document" in content) {
    const fileLength = binaryLength(content.document);
    return {
      messageKind: "document",
      text: content.caption ?? content.fileName,
      media: {
        mimetype: content.mimetype,
        fileName: content.fileName,
        ...(fileLength === undefined ? {} : { fileLength }),
        ...(content.caption === undefined ? {} : { caption: content.caption }),
      },
    };
  }
  if ("sticker" in content) {
    const fileLength = binaryLength(content.sticker);
    return {
      messageKind: "sticker",
      text: "",
      media: fileLength === undefined ? {} : { fileLength },
    };
  }
  if ("location" in content) {
    return {
      messageKind: "location",
      text: [content.location.name, content.location.address, `${content.location.lat}, ${content.location.lng}`]
        .filter(Boolean)
        .join(" — "),
    };
  }
  if ("contacts" in content) {
    return { messageKind: "contacts", text: content.contacts.displayName ?? "contacts" };
  }
  throw new Error("Message mutations must be normalized as update events.");
};

export const conversationArrival = (message: InboundMessage): ConversationArrival => {
  const media = mediaMetadata(message);
  return {
    id: `arrival:${message.chatId}:${message.id}`,
    kind: "arrival",
    providerMessageId: message.id,
    chatId: message.chatId,
    senderId: message.from,
    ...(message.pushName === undefined ? {} : { senderName: message.pushName }),
    direction: message.fromMe ? "outbound" : "inbound",
    occurredAt: message.timestamp,
    payload: {
      live: message.live,
      isGroup: message.isGroup,
      messageKind: message.kind,
      text: messageText(message),
      ...(message.context === undefined ? {} : { context: message.context }),
      ...(message.addressing === undefined ? {} : { addressing: message.addressing }),
      ...(message.flags === undefined ? {} : { flags: message.flags }),
      ...(media === undefined ? {} : { media }),
    },
  };
};

export const smokeCanaryArrival = (message: InboundMessage): ConversationArrival => {
  const arrival = conversationArrival(message);
  return {
    ...arrival,
    payload: { ...arrival.payload, applicationAdmission: "smoke-canary" },
  };
};

export const conversationSent = (
  ref: MessageRef,
  content: Outbound,
  senderId: string,
  occurredAt: number,
): ConversationEvent => {
  if ("react" in content) {
    return {
      id: `sent-reaction:${JSON.stringify([ref.chatId, ref.id])}`,
      kind: "reaction",
      providerMessageId: content.react.to.id,
      chatId: content.react.to.chatId,
      senderId,
      direction: "outbound",
      occurredAt,
      payload: { by: senderId, emoji: content.react.emoji, removed: content.react.emoji === "" },
    };
  }
  if ("edit" in content) {
    return {
      id: `sent-edit:${JSON.stringify([ref.chatId, ref.id])}`,
      kind: "edit",
      providerMessageId: content.edit.target.id,
      chatId: content.edit.target.chatId,
      senderId,
      direction: "outbound",
      occurredAt,
      payload: { messageKind: "text", text: content.edit.text },
    };
  }
  if ("delete" in content) {
    return {
      id: `sent-revocation:${JSON.stringify([ref.chatId, ref.id])}`,
      kind: "revocation",
      providerMessageId: content.delete.id,
      chatId: content.delete.chatId,
      senderId,
      direction: "outbound",
      occurredAt,
      payload: { by: senderId },
    };
  }
  return {
    id: `arrival:${ref.chatId}:${ref.id}`,
    kind: "arrival",
    providerMessageId: ref.id,
    chatId: ref.chatId,
    senderId,
    direction: "outbound",
    occurredAt,
    payload: {
      live: true,
      isGroup: ref.chatId.endsWith("@g.us"),
      ...outboundDetails(content),
    },
  };
};

const updateIdentity = (update: Update, kind: ConversationEvent["kind"], detail: string): string =>
  `${kind}:${JSON.stringify([update.ref.chatId, update.ref.id, update.at ?? null, detail])}`;

export const conversationUpdate = (
  update: Update,
): ConversationEdit | ConversationReaction | ConversationReceipt | ConversationRevocation => {
  const base = {
    providerMessageId: update.ref.id,
    chatId: update.ref.chatId,
    ...(update.ref.participant === undefined ? {} : { senderId: update.ref.participant }),
    direction: update.ref.fromMe ? "outbound" : "inbound",
    occurredAt: update.at ?? (update.kind === "edit" ? update.message.timestamp : 0),
  } as const;
  switch (update.kind) {
    case "edit":
      return {
        ...base,
        id: updateIdentity(
          update,
          "edit",
          JSON.stringify([update.message.timestamp, update.message.kind, messageText(update.message)]),
        ),
        kind: "edit",
        payload: { messageKind: update.message.kind, text: messageText(update.message) },
      };
    case "reaction":
      return {
        ...base,
        id: updateIdentity(
          update,
          "reaction",
          JSON.stringify([update.by ?? null, update.removed, update.emoji ?? null]),
        ),
        kind: "reaction",
        payload: {
          ...(update.by === undefined ? {} : { by: update.by }),
          ...(update.emoji === undefined ? {} : { emoji: update.emoji }),
          removed: update.removed,
        },
      };
    case "receipt":
      return {
        ...base,
        id: updateIdentity(update, "receipt", JSON.stringify([update.by ?? null, update.status])),
        kind: "receipt",
        payload: {
          ...(update.by === undefined ? {} : { by: update.by }),
          status: update.status,
        },
      };
    case "revoke":
      return {
        ...base,
        id: updateIdentity(update, "revocation", update.by ?? "unknown"),
        kind: "revocation",
        payload: update.by === undefined ? {} : { by: update.by },
      };
  }
};
