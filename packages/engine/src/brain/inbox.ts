import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DispatchReceipt } from "@flue/runtime";

export interface IntentDraft {
  readonly sourceSurfaceId: string;
  readonly interpretation: string;
  readonly evidenceIds: readonly string[];
}

export interface Intent {
  readonly id: string;
  readonly sourceSurfaceId: string;
  readonly interpretation: string;
  readonly evidenceIds: readonly string[];
  readonly admittedAt: string;
}

export interface BrainBatch {
  readonly id: string;
  readonly createdAt: string;
  readonly intents: readonly Intent[];
  readonly dispatch?: DispatchReceipt;
}

export interface DirectiveBrief {
  readonly summary: string;
  readonly evidenceIds: readonly string[];
}

export interface SpeakerDirective {
  readonly id: string;
  readonly surfaceId: string;
  readonly objective: string;
  readonly brief: DirectiveBrief;
}

export interface PromptSpeakerEffect {
  readonly id: string;
  readonly batchId: string;
  readonly kind: "prompt_speaker";
  readonly directive: SpeakerDirective;
  readonly status: "pending" | "accepted";
  readonly dispatch?: DispatchReceipt;
}

export interface StaySilentEffect {
  readonly id: string;
  readonly batchId: string;
  readonly kind: "stay_silent";
  readonly reason: string;
  readonly status: "completed";
}

export type BrainEffect = PromptSpeakerEffect | StaySilentEffect;

export interface BrainBatchSettlement {
  readonly batchId: string;
  readonly status: "settled";
  readonly settledAt: string;
}

interface IntentRow {
  intent_id: string;
  source_surface_id: string;
  interpretation: string;
  evidence_ids_json: string;
  admitted_at: string;
}

interface BatchRow {
  batch_id: string;
  created_at: string;
  dispatch_id: string | null;
  accepted_at: string | null;
  settled_at: string | null;
}

interface EffectRow {
  effect_id: string;
  batch_id: string;
  kind: "prompt_speaker" | "stay_silent";
  payload_json: string;
  status: "pending" | "accepted" | "completed";
  dispatch_id: string | null;
  accepted_at: string | null;
}

export interface BrainInbox {
  admitIntent(draft: IntentDraft): Intent;
  intent(intentId: string): Intent | undefined;
  pendingIntents(): readonly Intent[];
  claimBatch(limit?: number): BrainBatch | undefined;
  markBatchDispatched(batchId: string, receipt: DispatchReceipt): BrainBatch;
  recordPrompt(input: {
    readonly batchId: string;
    readonly surfaceId: string;
    readonly objective: string;
    readonly brief: DirectiveBrief;
  }): PromptSpeakerEffect;
  recordSilence(batchId: string, reason: string): StaySilentEffect;
  effects(batchId: string): readonly BrainEffect[];
  pendingPrompts(): readonly PromptSpeakerEffect[];
  markPromptAccepted(effectId: string, receipt: DispatchReceipt): PromptSpeakerEffect;
  settleBatch(batchId: string): BrainBatchSettlement;
  close(): void;
}

export interface BrainInboxOptions {
  /** Resolve the Surface's current provider chat binding in trusted application code. */
  readonly providerChatIdForSurface: (surfaceId: string) => string | undefined;
  readonly now?: () => string;
}

const hydrate = (row: IntentRow): Intent => ({
  id: row.intent_id,
  sourceSurfaceId: row.source_surface_id,
  interpretation: row.interpretation,
  evidenceIds: JSON.parse(row.evidence_ids_json) as string[],
  admittedAt: row.admitted_at,
});

const required = (value: string, name: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} must not be empty.`);
  return normalized;
};

const canonicalEvidence = (evidenceIds: readonly string[]): readonly string[] => {
  const ids = [...new Set(evidenceIds.map((id) => required(id, "Intent evidence id")))].sort();
  if (ids.length === 0) throw new Error("An Intent requires at least one evidence id.");
  return ids;
};

const intentId = (sourceSurfaceId: string, interpretation: string, evidenceIds: readonly string[]): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify([sourceSurfaceId, interpretation, evidenceIds]))
    .digest("hex");
  return `intent:${digest}`;
};

const batchId = (inputIds: readonly string[]): string =>
  `brain-batch:${createHash("sha256").update(JSON.stringify(inputIds)).digest("hex")}`;

const effectId = (batch: string, kind: BrainEffect["kind"], payload: unknown): string =>
  `brain-effect:${createHash("sha256").update(JSON.stringify([batch, kind, payload])).digest("hex")}`;

/**
 * The application-owned Speaker Intent admission boundary (ADR 0002).
 *
 * Intent identity comes from its canonical meaning and immutable evidence, never
 * a Flue dispatch. The Intent and its Brain-inbox reference are inserted in one
 * transaction, so an exact retry or restart returns the original admission.
 */
export const createBrainInbox = (databasePath: string, options: BrainInboxOptions): BrainInbox => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS brain_intents (
      intent_id TEXT PRIMARY KEY,
      source_surface_id TEXT NOT NULL,
      interpretation TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      admitted_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS brain_batches (
      batch_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      dispatch_id TEXT,
      accepted_at TEXT,
      settled_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS brain_inbox_inputs (
      input_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind = 'speaker_intent'),
      intent_id TEXT NOT NULL UNIQUE REFERENCES brain_intents(intent_id),
      admitted_at TEXT NOT NULL,
      batch_id TEXT REFERENCES brain_batches(batch_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS brain_effects (
      effect_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES brain_batches(batch_id),
      kind TEXT NOT NULL CHECK (kind IN ('prompt_speaker', 'stay_silent')),
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'completed')),
      dispatch_id TEXT,
      accepted_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
  `);

  const evidence = database.prepare("SELECT chat_id FROM conversation_events WHERE event_id = ?");
  const insertIntent = database.prepare(`
    INSERT OR IGNORE INTO brain_intents
      (intent_id, source_surface_id, interpretation, evidence_ids_json, admitted_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertInboxInput = database.prepare(`
    INSERT OR IGNORE INTO brain_inbox_inputs (input_id, kind, intent_id, admitted_at)
    VALUES (?, 'speaker_intent', ?, ?)
  `);
  const selectIntent = database.prepare("SELECT * FROM brain_intents WHERE intent_id = ?");
  const selectPending = database.prepare(`
    SELECT intent.*
      FROM brain_inbox_inputs AS input
      JOIN brain_intents AS intent ON intent.intent_id = input.intent_id
     WHERE input.batch_id IS NULL
     ORDER BY input.admitted_at, input.rowid
  `);
  const selectOpenBatch = database.prepare(`
    SELECT batch_id, created_at, dispatch_id, accepted_at, settled_at FROM brain_batches
     WHERE settled_at IS NULL
     ORDER BY created_at, batch_id
     LIMIT 1
  `);
  const selectBatchIntents = database.prepare(`
    SELECT intent.*
      FROM brain_inbox_inputs AS input
      JOIN brain_intents AS intent ON intent.intent_id = input.intent_id
     WHERE input.batch_id = ?
     ORDER BY input.admitted_at, input.rowid
  `);
  const selectReadyInputIds = database.prepare(`
    SELECT input_id FROM brain_inbox_inputs
     WHERE batch_id IS NULL
     ORDER BY admitted_at, rowid
     LIMIT ?
  `);
  const insertBatch = database.prepare("INSERT INTO brain_batches (batch_id, created_at) VALUES (?, ?)");
  const claimInput = database.prepare("UPDATE brain_inbox_inputs SET batch_id = ? WHERE input_id = ? AND batch_id IS NULL");
  const updateBatchDispatch = database.prepare(`
    UPDATE brain_batches SET dispatch_id = ?, accepted_at = ?
     WHERE batch_id = ? AND dispatch_id IS NULL
  `);
  const selectBatch = database.prepare(`
    SELECT batch_id, created_at, dispatch_id, accepted_at, settled_at FROM brain_batches WHERE batch_id = ?
  `);
  const selectOpenBatchById = database.prepare(`
    SELECT batch_id, created_at, dispatch_id, accepted_at, settled_at
      FROM brain_batches WHERE batch_id = ? AND settled_at IS NULL
  `);
  const selectEffect = database.prepare("SELECT * FROM brain_effects WHERE effect_id = ?");
  const selectEffects = database.prepare("SELECT * FROM brain_effects WHERE batch_id = ? ORDER BY created_at, effect_id");
  const selectPendingPrompts = database.prepare(
    "SELECT * FROM brain_effects WHERE kind = 'prompt_speaker' AND status = 'pending' ORDER BY created_at, effect_id",
  );
  const insertEffect = database.prepare(`
    INSERT OR IGNORE INTO brain_effects
      (effect_id, batch_id, kind, payload_json, status, completed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const acceptPrompt = database.prepare(`
    UPDATE brain_effects SET status = 'accepted', dispatch_id = ?, accepted_at = ?
     WHERE effect_id = ? AND kind = 'prompt_speaker' AND status = 'pending'
  `);
  const settle = database.prepare("UPDATE brain_batches SET settled_at = ? WHERE batch_id = ? AND settled_at IS NULL");
  const unsettledEffectCount = database.prepare(`
    SELECT count(*) AS count FROM brain_effects WHERE batch_id = ? AND status = 'pending'
  `);
  const effectCount = database.prepare("SELECT count(*) AS count FROM brain_effects WHERE batch_id = ?");
  const hydrateEffect = (row: EffectRow): BrainEffect => {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    if (row.kind === "stay_silent") {
      return {
        id: row.effect_id,
        batchId: row.batch_id,
        kind: "stay_silent",
        reason: payload.reason as string,
        status: "completed",
      };
    }
    const directive = payload as unknown as Omit<SpeakerDirective, "id">;
    return {
      id: row.effect_id,
      batchId: row.batch_id,
      kind: "prompt_speaker",
      directive: { id: row.effect_id, ...directive },
      status: row.status as "pending" | "accepted",
      ...(row.dispatch_id === null || row.accepted_at === null
        ? {}
        : { dispatch: { dispatchId: row.dispatch_id, acceptedAt: row.accepted_at } }),
    };
  };
  const hydrateBatch = (row: BatchRow): BrainBatch => ({
    id: row.batch_id,
    createdAt: row.created_at,
    intents: (selectBatchIntents.all(row.batch_id) as unknown as IntentRow[]).map(hydrate),
    ...(row.dispatch_id === null || row.accepted_at === null
      ? {}
      : { dispatch: { dispatchId: row.dispatch_id, acceptedAt: row.accepted_at } }),
  });

  return {
    admitIntent: (draft) => {
      const sourceSurfaceId = required(draft.sourceSurfaceId, "Intent source Surface id");
      const interpretation = required(draft.interpretation, "Intent interpretation");
      const evidenceIds = canonicalEvidence(draft.evidenceIds);
      const providerChatId = options.providerChatIdForSurface(sourceSurfaceId);
      if (providerChatId === undefined) throw new Error(`Surface ${sourceSurfaceId} has no active provider binding.`);

      for (const evidenceId of evidenceIds) {
        const row = evidence.get(evidenceId) as { chat_id: string } | undefined;
        if (row === undefined) throw new Error(`Intent evidence ${evidenceId} does not exist.`);
        if (row.chat_id !== providerChatId) {
          throw new Error(`Intent evidence ${evidenceId} does not belong to Surface ${sourceSurfaceId}.`);
        }
      }

      const id = intentId(sourceSurfaceId, interpretation, evidenceIds);
      database.exec("BEGIN IMMEDIATE");
      try {
        const admittedAt = options.now?.() ?? new Date().toISOString();
        insertIntent.run(id, sourceSurfaceId, interpretation, JSON.stringify(evidenceIds), admittedAt);
        insertInboxInput.run(id, id, admittedAt);
        database.exec("COMMIT");
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }

      return hydrate(selectIntent.get(id) as unknown as IntentRow);
    },
    intent: (id) => {
      const row = selectIntent.get(id) as unknown as IntentRow | undefined;
      return row === undefined ? undefined : hydrate(row);
    },
    pendingIntents: () => (selectPending.all() as unknown as IntentRow[]).map(hydrate),
    claimBatch: (limit = 50) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const open = selectOpenBatch.get() as BatchRow | undefined;
        if (open !== undefined) {
          database.exec("COMMIT");
          return hydrateBatch(open);
        }
        const ready = selectReadyInputIds.all(Math.max(1, Math.min(Math.trunc(limit), 100))) as unknown as {
          input_id: string;
        }[];
        if (ready.length === 0) {
          database.exec("COMMIT");
          return undefined;
        }
        const id = batchId(ready.map(({ input_id }) => input_id));
        const createdAt = options.now?.() ?? new Date().toISOString();
        insertBatch.run(id, createdAt);
        for (const { input_id } of ready) claimInput.run(id, input_id);
        database.exec("COMMIT");
        return hydrateBatch({
          batch_id: id,
          created_at: createdAt,
          dispatch_id: null,
          accepted_at: null,
          settled_at: null,
        });
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    markBatchDispatched: (id, receipt) => {
      if (!receipt.dispatchId || !Number.isFinite(Date.parse(receipt.acceptedAt))) {
        throw new Error(`Brain Batch ${id} has an invalid Flue admission receipt.`);
      }
      updateBatchDispatch.run(receipt.dispatchId, receipt.acceptedAt, id);
      const row = selectBatch.get(id) as BatchRow | undefined;
      if (row === undefined) throw new Error(`Brain Batch ${id} does not exist.`);
      return hydrateBatch(row);
    },
    recordPrompt: ({ batchId: rawBatchId, surfaceId: rawSurfaceId, objective: rawObjective, brief }) => {
      const claimedBatchId = required(rawBatchId, "Brain Batch id");
      const batch = selectOpenBatchById.get(claimedBatchId) as BatchRow | undefined;
      if (batch === undefined || batch.dispatch_id === null) throw new Error(`Brain Batch ${claimedBatchId} is not open and dispatched.`);
      const surfaceId = required(rawSurfaceId, "Directive Surface id");
      if (options.providerChatIdForSurface(surfaceId) === undefined) {
        throw new Error(`Surface ${surfaceId} has no active provider binding.`);
      }
      const objective = required(rawObjective, "Directive objective");
      const summary = required(brief.summary, "Directive Brief summary");
      const evidenceIds = canonicalEvidence(brief.evidenceIds);
      for (const evidenceId of evidenceIds) {
        if (evidence.get(evidenceId) === undefined) throw new Error(`Directive evidence ${evidenceId} does not exist.`);
      }
      const payload = { surfaceId, objective, brief: { summary, evidenceIds } };
      const id = effectId(claimedBatchId, "prompt_speaker", payload);
      const createdAt = options.now?.() ?? new Date().toISOString();
      insertEffect.run(id, claimedBatchId, "prompt_speaker", JSON.stringify(payload), "pending", null, createdAt);
      return hydrateEffect(selectEffect.get(id) as unknown as EffectRow) as PromptSpeakerEffect;
    },
    recordSilence: (rawBatchId, rawReason) => {
      const claimedBatchId = required(rawBatchId, "Brain Batch id");
      const batch = selectOpenBatchById.get(claimedBatchId) as BatchRow | undefined;
      if (batch === undefined || batch.dispatch_id === null) throw new Error(`Brain Batch ${claimedBatchId} is not open and dispatched.`);
      const reason = required(rawReason, "Deliberate silence reason");
      const payload = { reason };
      const id = effectId(claimedBatchId, "stay_silent", payload);
      const completedAt = options.now?.() ?? new Date().toISOString();
      insertEffect.run(id, claimedBatchId, "stay_silent", JSON.stringify(payload), "completed", completedAt, completedAt);
      return hydrateEffect(selectEffect.get(id) as unknown as EffectRow) as StaySilentEffect;
    },
    effects: (id) => (selectEffects.all(id) as unknown as EffectRow[]).map(hydrateEffect),
    pendingPrompts: () => (selectPendingPrompts.all() as unknown as EffectRow[]).map(hydrateEffect) as PromptSpeakerEffect[],
    markPromptAccepted: (id, receipt) => {
      if (!receipt.dispatchId || !Number.isFinite(Date.parse(receipt.acceptedAt))) {
        throw new Error(`Brain Effect ${id} has an invalid Flue admission receipt.`);
      }
      acceptPrompt.run(receipt.dispatchId, receipt.acceptedAt, id);
      const row = selectEffect.get(id) as unknown as EffectRow | undefined;
      if (row === undefined || row.kind !== "prompt_speaker") throw new Error(`Prompt Effect ${id} does not exist.`);
      return hydrateEffect(row) as PromptSpeakerEffect;
    },
    settleBatch: (id) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = selectBatch.get(id) as BatchRow | undefined;
        if (row === undefined) throw new Error(`Brain Batch ${id} does not exist.`);
        if (row.settled_at !== null) {
          database.exec("COMMIT");
          return { batchId: id, status: "settled" as const, settledAt: row.settled_at };
        }
        const total = (effectCount.get(id) as { count: number }).count;
        const pending = (unsettledEffectCount.get(id) as { count: number }).count;
        if (total === 0 || pending > 0) throw new Error(`Brain Batch ${id} has effects that are not durably accepted.`);
        const settledAt = options.now?.() ?? new Date().toISOString();
        settle.run(settledAt, id);
        database.exec("COMMIT");
        return { batchId: id, status: "settled" as const, settledAt };
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    close: () => database.close(),
  };
};
