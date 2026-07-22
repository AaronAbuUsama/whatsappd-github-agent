import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SurfaceDeliveryStatus = "attempting" | "sent" | "failed" | "uncertain";
export type DirectiveOutcomeStatus = "delivered" | "failed" | "uncertain" | "settled_without_say";

export interface SurfaceDelivery {
  readonly id: string;
  readonly directiveId: string;
  readonly surfaceId: string;
  readonly providerChatId: string;
  readonly text: string;
  readonly status: SurfaceDeliveryStatus;
  readonly providerMessageId?: string;
  readonly conversationEventId?: string;
  readonly error?: string;
  readonly attemptedAt: string;
  readonly settledAt?: string;
}

export type DirectiveOutcome =
  | {
      readonly directiveId: string;
      readonly deliveryId: string;
      readonly surfaceId: string;
      readonly status: "delivered";
      readonly providerMessageId: string;
      readonly conversationEventId: string;
    }
  | {
      readonly directiveId: string;
      readonly deliveryId?: string;
      readonly surfaceId: string;
      readonly status: "failed" | "uncertain";
      readonly error: string;
      readonly providerMessageId?: string;
      readonly conversationEventId?: string;
    }
  | {
      readonly directiveId: string;
      readonly surfaceId: string;
      readonly status: "settled_without_say";
      readonly reason: string;
    };

export type SurfaceDeliveryResult =
  | { readonly delivery: "sent"; readonly messageId: string }
  | { readonly delivery: "failed" | "unknown"; readonly deliveryError: string };

export type SurfaceDeliveryClaim =
  | { readonly kind: "attempt"; readonly delivery: SurfaceDelivery }
  | { readonly kind: "settled"; readonly outcome: DirectiveOutcome };

export interface SurfaceDeliveryStore {
  readonly claim: (directiveId: string, providerChatId: string, text: string) => SurfaceDeliveryClaim;
  readonly settle: (deliveryId: string, result: SurfaceDeliveryResult) => DirectiveOutcome;
  readonly settleWithoutSay: (directiveId: string, reason: string) => DirectiveOutcome;
  readonly failWithoutSay: (directiveId: string, error: string) => DirectiveOutcome;
  readonly delivery: (directiveId: string) => SurfaceDelivery | undefined;
  readonly outcome: (directiveId: string) => DirectiveOutcome | undefined;
  readonly directiveForDispatch: (
    dispatchId: string,
  ) => { readonly directiveId: string; readonly surfaceId: string } | undefined;
  readonly close: () => void;
}

export interface SurfaceDeliveryStoreOptions {
  readonly providerChatIdForSurface: (surfaceId: string) => string | undefined;
  readonly now?: () => string;
}

interface DirectiveRow {
  readonly payload_json: string;
  readonly status: string;
}

interface DeliveryRow {
  readonly delivery_id: string;
  readonly directive_id: string;
  readonly surface_id: string;
  readonly provider_chat_id: string;
  readonly text: string;
  readonly status: SurfaceDeliveryStatus;
  readonly provider_message_id: string | null;
  readonly conversation_event_id: string | null;
  readonly error: string | null;
  readonly attempted_at: string;
  readonly settled_at: string | null;
}

interface OutcomeRow {
  readonly directive_id: string;
  readonly delivery_id: string | null;
  readonly surface_id: string;
  readonly status: DirectiveOutcomeStatus;
  readonly provider_message_id: string | null;
  readonly conversation_event_id: string | null;
  readonly detail: string | null;
}

const required = (value: string, label: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty.`);
  return normalized;
};

const deliveryId = (directiveId: string): string =>
  `surface-delivery:${createHash("sha256").update(directiveId).digest("hex")}`;

const hydrateDelivery = (row: DeliveryRow): SurfaceDelivery => ({
  id: row.delivery_id,
  directiveId: row.directive_id,
  surfaceId: row.surface_id,
  providerChatId: row.provider_chat_id,
  text: row.text,
  status: row.status,
  ...(row.provider_message_id === null ? {} : { providerMessageId: row.provider_message_id }),
  ...(row.conversation_event_id === null ? {} : { conversationEventId: row.conversation_event_id }),
  ...(row.error === null ? {} : { error: row.error }),
  attemptedAt: row.attempted_at,
  ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
});

const hydrateOutcome = (row: OutcomeRow): DirectiveOutcome => {
  if (row.status === "delivered") {
    return {
      directiveId: row.directive_id,
      deliveryId: row.delivery_id!,
      surfaceId: row.surface_id,
      status: "delivered",
      providerMessageId: row.provider_message_id!,
      conversationEventId: row.conversation_event_id!,
    };
  }
  if (row.status === "settled_without_say") {
    return {
      directiveId: row.directive_id,
      surfaceId: row.surface_id,
      status: "settled_without_say",
      reason: row.detail!,
    };
  }
  return {
    directiveId: row.directive_id,
    ...(row.delivery_id === null ? {} : { deliveryId: row.delivery_id }),
    surfaceId: row.surface_id,
    status: row.status,
    error: row.detail!,
    ...(row.provider_message_id === null ? {} : { providerMessageId: row.provider_message_id }),
    ...(row.conversation_event_id === null ? {} : { conversationEventId: row.conversation_event_id }),
  };
};

/** Application-owned proof boundary between one Brain Directive and one Surface send. */
export const createSurfaceDeliveryStore = (
  databasePath: string,
  options: SurfaceDeliveryStoreOptions,
): SurfaceDeliveryStore => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS surface_deliveries (
      delivery_id TEXT PRIMARY KEY,
      directive_id TEXT NOT NULL UNIQUE REFERENCES brain_effects(effect_id),
      surface_id TEXT NOT NULL REFERENCES surfaces(surface_id),
      provider_chat_id TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('attempting', 'sent', 'failed', 'uncertain')),
      provider_message_id TEXT,
      conversation_event_id TEXT,
      error TEXT,
      attempted_at TEXT NOT NULL,
      settled_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS directive_outcomes (
      directive_id TEXT PRIMARY KEY REFERENCES brain_effects(effect_id),
      delivery_id TEXT UNIQUE REFERENCES surface_deliveries(delivery_id),
      surface_id TEXT NOT NULL REFERENCES surfaces(surface_id),
      status TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'uncertain', 'settled_without_say')),
      provider_message_id TEXT,
      conversation_event_id TEXT,
      detail TEXT,
      settled_at TEXT NOT NULL
    ) STRICT;
  `);

  const selectDirective = database.prepare(`
    SELECT payload_json, status FROM brain_effects
     WHERE effect_id = ? AND kind = 'prompt_speaker'
  `);
  const selectDirectiveByDispatch = database.prepare(`
    SELECT effect_id, payload_json FROM brain_effects
     WHERE dispatch_id = ? AND kind = 'prompt_speaker' AND status = 'accepted'
  `);
  const selectDelivery = database.prepare("SELECT * FROM surface_deliveries WHERE directive_id = ?");
  const selectDeliveryById = database.prepare("SELECT * FROM surface_deliveries WHERE delivery_id = ?");
  const selectOutcome = database.prepare("SELECT * FROM directive_outcomes WHERE directive_id = ?");
  const selectArchiveEvidence = database.prepare(`
    SELECT event_id FROM conversation_events
     WHERE event_id = ? AND provider_message_id = ? AND chat_id = ? AND direction = 'outbound'
  `);
  const insertDelivery = database.prepare(`
    INSERT INTO surface_deliveries
      (delivery_id, directive_id, surface_id, provider_chat_id, text, status, attempted_at)
    VALUES (?, ?, ?, ?, ?, 'attempting', ?)
  `);
  const settleDelivery = database.prepare(`
    UPDATE surface_deliveries
       SET status = ?, provider_message_id = ?, conversation_event_id = ?, error = ?, settled_at = ?
     WHERE delivery_id = ?
  `);
  const upsertOutcome = database.prepare(`
    INSERT INTO directive_outcomes
      (directive_id, delivery_id, surface_id, status, provider_message_id, conversation_event_id, detail, settled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(directive_id) DO UPDATE SET
      delivery_id = excluded.delivery_id,
      surface_id = excluded.surface_id,
      status = excluded.status,
      provider_message_id = excluded.provider_message_id,
      conversation_event_id = excluded.conversation_event_id,
      detail = excluded.detail,
      settled_at = excluded.settled_at
  `);

  const directiveSurface = (rawDirectiveId: string): { readonly directiveId: string; readonly surfaceId: string } => {
    const directiveId = required(rawDirectiveId, "Directive id");
    const row = selectDirective.get(directiveId) as DirectiveRow | undefined;
    if (row === undefined) throw new Error(`Directive ${directiveId} does not exist.`);
    if (row.status !== "pending" && row.status !== "accepted") {
      throw new Error(`Directive ${directiveId} is not dispatchable.`);
    }
    const payload = JSON.parse(row.payload_json) as { readonly surfaceId?: unknown };
    if (typeof payload.surfaceId !== "string" || payload.surfaceId.trim().length === 0) {
      throw new Error(`Directive ${directiveId} has no Surface.`);
    }
    return { directiveId, surfaceId: payload.surfaceId };
  };

  const readOutcome = (directiveId: string): DirectiveOutcome | undefined => {
    const row = selectOutcome.get(directiveId) as OutcomeRow | undefined;
    return row === undefined ? undefined : hydrateOutcome(row);
  };

  const recordOutcome = (
    delivery: DeliveryRow,
    status: "delivered" | "failed" | "uncertain",
    values: { readonly providerMessageId?: string; readonly conversationEventId?: string; readonly detail?: string },
  ): DirectiveOutcome => {
    const now = options.now?.() ?? new Date().toISOString();
    upsertOutcome.run(
      delivery.directive_id,
      delivery.delivery_id,
      delivery.surface_id,
      status,
      values.providerMessageId ?? null,
      values.conversationEventId ?? null,
      values.detail ?? null,
      now,
    );
    return readOutcome(delivery.directive_id)!;
  };

  const settleNoDelivery = (
    rawDirectiveId: string,
    status: "failed" | "settled_without_say",
    detail: string,
  ): DirectiveOutcome => {
    const { directiveId, surfaceId } = directiveSurface(rawDirectiveId);
    const normalizedDetail = required(detail, status === "failed" ? "Directive failure" : "Directive silence reason");
    database.exec("BEGIN IMMEDIATE");
    try {
      const existing = readOutcome(directiveId);
      if (existing !== undefined) {
        database.exec("COMMIT");
        return existing;
      }
      const delivery = selectDelivery.get(directiveId) as DeliveryRow | undefined;
      if (delivery !== undefined) {
        const uncertain = "The Directive already has an unresolved Surface Delivery; it cannot be settled as unsaid.";
        const now = options.now?.() ?? new Date().toISOString();
        settleDelivery.run("uncertain", null, null, uncertain, now, delivery.delivery_id);
        const outcome = recordOutcome(delivery, "uncertain", { detail: uncertain });
        database.exec("COMMIT");
        return outcome;
      }
      upsertOutcome.run(
        directiveId,
        null,
        surfaceId,
        status,
        null,
        null,
        normalizedDetail,
        options.now?.() ?? new Date().toISOString(),
      );
      const outcome = readOutcome(directiveId)!;
      database.exec("COMMIT");
      return outcome;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  };

  return {
    claim: (rawDirectiveId, rawProviderChatId, rawText) => {
      const { directiveId, surfaceId } = directiveSurface(rawDirectiveId);
      const providerChatId = required(rawProviderChatId, "Speaker provider chat id");
      const text = required(rawText, "Directive message text");
      const activeProviderChatId = options.providerChatIdForSurface(surfaceId);
      if (activeProviderChatId !== providerChatId) {
        throw new Error(`Speaker ${providerChatId} is not the active binding for Surface ${surfaceId}.`);
      }
      database.exec("BEGIN IMMEDIATE");
      try {
        const existingOutcome = readOutcome(directiveId);
        if (existingOutcome !== undefined) {
          database.exec("COMMIT");
          return { kind: "settled", outcome: existingOutcome };
        }
        const existingDelivery = selectDelivery.get(directiveId) as DeliveryRow | undefined;
        if (existingDelivery !== undefined) {
          const detail =
            "A previous Surface Delivery attempt did not reach a proven terminal result; blind retry is forbidden.";
          const now = options.now?.() ?? new Date().toISOString();
          settleDelivery.run("uncertain", null, null, detail, now, existingDelivery.delivery_id);
          const outcome = recordOutcome(existingDelivery, "uncertain", { detail });
          database.exec("COMMIT");
          return { kind: "settled", outcome };
        }
        const id = deliveryId(directiveId);
        insertDelivery.run(
          id,
          directiveId,
          surfaceId,
          providerChatId,
          text,
          options.now?.() ?? new Date().toISOString(),
        );
        const delivery = hydrateDelivery(selectDeliveryById.get(id) as unknown as DeliveryRow);
        database.exec("COMMIT");
        return { kind: "attempt", delivery };
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    settle: (rawDeliveryId, result) => {
      const id = required(rawDeliveryId, "Surface Delivery id");
      database.exec("BEGIN IMMEDIATE");
      try {
        const delivery = selectDeliveryById.get(id) as DeliveryRow | undefined;
        if (delivery === undefined) throw new Error(`Surface Delivery ${id} does not exist.`);
        const existing = readOutcome(delivery.directive_id);
        if (existing?.status === "delivered") {
          database.exec("COMMIT");
          return existing;
        }
        const now = options.now?.() ?? new Date().toISOString();
        let outcome: DirectiveOutcome;
        if (result.delivery === "sent") {
          const eventId = `arrival:${delivery.provider_chat_id}:${result.messageId}`;
          const evidence = selectArchiveEvidence.get(eventId, result.messageId, delivery.provider_chat_id) as
            | { readonly event_id: string }
            | undefined;
          if (evidence === undefined) {
            const detail = `Provider acknowledged ${result.messageId}, but the outbound Conversation Archive event is missing.`;
            settleDelivery.run("uncertain", result.messageId, null, detail, now, id);
            outcome = recordOutcome(delivery, "uncertain", { providerMessageId: result.messageId, detail });
          } else {
            settleDelivery.run("sent", result.messageId, evidence.event_id, null, now, id);
            outcome = recordOutcome(delivery, "delivered", {
              providerMessageId: result.messageId,
              conversationEventId: evidence.event_id,
            });
          }
        } else {
          const status = result.delivery === "failed" ? "failed" : "uncertain";
          settleDelivery.run(status, null, null, result.deliveryError, now, id);
          outcome = recordOutcome(delivery, status, { detail: result.deliveryError });
        }
        database.exec("COMMIT");
        return outcome;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    settleWithoutSay: (directiveId, reason) => settleNoDelivery(directiveId, "settled_without_say", reason),
    failWithoutSay: (directiveId, error) => settleNoDelivery(directiveId, "failed", error),
    delivery: (directiveId) => {
      const row = selectDelivery.get(required(directiveId, "Directive id")) as DeliveryRow | undefined;
      return row === undefined ? undefined : hydrateDelivery(row);
    },
    outcome: (directiveId) => readOutcome(required(directiveId, "Directive id")),
    directiveForDispatch: (rawDispatchId) => {
      const row = selectDirectiveByDispatch.get(required(rawDispatchId, "Speaker dispatch id")) as
        | { readonly effect_id: string; readonly payload_json: string }
        | undefined;
      if (row === undefined) return undefined;
      const payload = JSON.parse(row.payload_json) as { readonly surfaceId?: unknown };
      return typeof payload.surfaceId === "string"
        ? { directiveId: row.effect_id, surfaceId: payload.surfaceId }
        : undefined;
    },
    close: () => database.close(),
  };
};
