import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { SpeakerInput } from "../inputs.ts";

export type ScribeObservationSource = "live" | "historical_replay";

export interface ScribeObservation {
  readonly evidenceId: string;
  readonly occurredAt: number;
  readonly source: ScribeObservationSource;
  readonly input: SpeakerInput;
}

export interface ScribeAttempt {
  readonly id: string;
  readonly status: "active" | "completed" | "failed" | "interrupted";
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly error?: string;
}

export interface ScribeBatch {
  readonly id: string;
  readonly evidenceIds: readonly string[];
  readonly inputs: readonly SpeakerInput[];
  readonly attempts: readonly ScribeAttempt[];
}

export interface ScribeInbox {
  admit(observations: readonly ScribeObservation[]): number;
  claimWave(maximumBatches?: number, maximumObservations?: number): readonly ScribeBatch[];
  beginAttempt(batchId: string, attemptId: string): void;
  completeAttempt(batchId: string, attemptId: string): void;
  failAttempt(batchId: string, attemptId: string, error: string): void;
  isEvidenceComplete(evidenceIds: readonly string[]): boolean;
  close(): void;
}

export interface ScribeInboxOptions {
  readonly now?: () => number;
  /** Only the owning runtime boot may recover attempts left active by a previous process. */
  readonly recoverInterruptedAttempts?: boolean;
}

interface ObservationRow {
  evidence_id: string;
  input_json: string;
}

interface BatchRow {
  batch_id: string;
}

interface AttemptRow {
  attempt_id: string;
  status: ScribeAttempt["status"];
  started_at_ms: number;
  finished_at_ms: number | null;
  error: string | null;
}

const required = (value: string, name: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} must not be empty.`);
  return normalized;
};

const batchId = (evidenceIds: readonly string[]): string =>
  `scribe-batch:${createHash("sha256").update(JSON.stringify(evidenceIds)).digest("hex")}`;

export const createScribeInbox = (databasePath: string, options: ScribeInboxOptions = {}): ScribeInbox => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const now = options.now ?? Date.now;
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS scribe_batches (
      batch_id TEXT PRIMARY KEY,
      created_at_ms INTEGER NOT NULL,
      active_attempt_id TEXT,
      completed_at_ms INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS scribe_observations (
      observation_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      evidence_id TEXT NOT NULL UNIQUE,
      occurred_at_ms INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('live','historical_replay')),
      input_json TEXT NOT NULL,
      admitted_at_ms INTEGER NOT NULL,
      batch_id TEXT REFERENCES scribe_batches(batch_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS scribe_observations_pending_idx
      ON scribe_observations(batch_id, occurred_at_ms, observation_sequence);
    CREATE TABLE IF NOT EXISTS scribe_attempts (
      attempt_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES scribe_batches(batch_id),
      status TEXT NOT NULL CHECK (status IN ('active','completed','failed','interrupted')),
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      error TEXT
    ) STRICT;
  `);

  if (options.recoverInterruptedAttempts === true) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const reopenedAt = now();
      database
        .prepare("UPDATE scribe_attempts SET status = 'interrupted', finished_at_ms = ? WHERE status = 'active'")
        .run(reopenedAt);
      database.prepare("UPDATE scribe_batches SET active_attempt_id = NULL WHERE completed_at_ms IS NULL").run();
      database.exec("COMMIT");
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  }

  const transaction = <T>(work: () => T): T => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  };
  const selectBatchObservations = database.prepare(`
    SELECT evidence_id, input_json FROM scribe_observations
     WHERE batch_id = ? ORDER BY observation_sequence
  `);
  const selectAttempts = database.prepare(`
    SELECT attempt_id, status, started_at_ms, finished_at_ms, error FROM scribe_attempts
     WHERE batch_id = ? ORDER BY started_at_ms, rowid
  `);
  const hydrateBatch = (id: string): ScribeBatch => {
    const observations = selectBatchObservations.all(id) as unknown as ObservationRow[];
    const attempts = (selectAttempts.all(id) as unknown as AttemptRow[]).map(
      (row): ScribeAttempt => ({
        id: row.attempt_id,
        status: row.status,
        startedAt: row.started_at_ms,
        ...(row.finished_at_ms === null ? {} : { finishedAt: row.finished_at_ms }),
        ...(row.error === null ? {} : { error: row.error }),
      }),
    );
    return {
      id,
      evidenceIds: observations.map(({ evidence_id }) => evidence_id),
      inputs: observations.map(({ input_json }) => JSON.parse(input_json) as SpeakerInput),
      attempts,
    };
  };

  return {
    admit: (observations) =>
      transaction(() => {
        const insert = database.prepare(`
          INSERT OR IGNORE INTO scribe_observations
            (evidence_id, occurred_at_ms, source, input_json, admitted_at_ms)
          VALUES (?, ?, ?, ?, ?)
        `);
        let admitted = 0;
        for (const observation of observations) {
          const evidenceId = required(observation.evidenceId, "Scribe observation evidence id");
          if (!Number.isFinite(observation.occurredAt)) {
            throw new Error(`Scribe observation ${evidenceId} requires a finite occurrence time.`);
          }
          admitted += Number(
            insert.run(
              evidenceId,
              observation.occurredAt,
              observation.source,
              JSON.stringify(observation.input),
              now(),
            ).changes,
          );
        }
        return admitted;
      }),
    claimWave: (requestedBatches = 4, requestedObservations = 50) =>
      transaction(() => {
        const maximumBatches = Math.max(1, Math.min(Math.trunc(requestedBatches), 4));
        const maximumObservations = Math.max(1, Math.min(Math.trunc(requestedObservations), 200));
        const open = database
          .prepare(`SELECT batch_id FROM scribe_batches
            WHERE completed_at_ms IS NULL AND active_attempt_id IS NULL
            ORDER BY created_at_ms, rowid LIMIT ?`)
          .all(maximumBatches) as unknown as BatchRow[];
        const ids = open.map(({ batch_id }) => batch_id);
        const availableSlots = maximumBatches - ids.length;
        if (availableSlots > 0) {
          const pending = database
            .prepare(`SELECT evidence_id FROM scribe_observations WHERE batch_id IS NULL
              ORDER BY CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END, occurred_at_ms, observation_sequence
              LIMIT ?`)
            .all(maximumObservations) as unknown as Array<{ readonly evidence_id: string }>;
          const batchCount = Math.min(availableSlots, pending.length);
          const size = batchCount === 0 ? 0 : Math.ceil(pending.length / batchCount);
          const insertBatch = database.prepare("INSERT INTO scribe_batches (batch_id, created_at_ms) VALUES (?, ?)");
          const assign = database.prepare(
            "UPDATE scribe_observations SET batch_id = ? WHERE evidence_id = ? AND batch_id IS NULL",
          );
          for (let offset = 0; offset < pending.length; offset += size) {
            const evidenceIds = pending.slice(offset, offset + size).map(({ evidence_id }) => evidence_id);
            const id = batchId(evidenceIds);
            insertBatch.run(id, now());
            for (const evidenceId of evidenceIds) {
              if (assign.run(id, evidenceId).changes !== 1) {
                throw new Error(`Scribe observation ${evidenceId} lost its Batch assignment.`);
              }
            }
            ids.push(id);
          }
        }
        return ids.map(hydrateBatch);
      }),
    beginAttempt: (rawBatchId, rawAttemptId) =>
      transaction(() => {
        const id = required(rawBatchId, "Scribe Batch id");
        const attemptId = required(rawAttemptId, "Scribe attempt id");
        const claimed = database
          .prepare(`UPDATE scribe_batches SET active_attempt_id = ?
            WHERE batch_id = ? AND completed_at_ms IS NULL AND active_attempt_id IS NULL`)
          .run(attemptId, id);
        if (claimed.changes !== 1) throw new Error(`Scribe Batch ${id} is not available for an attempt.`);
        database
          .prepare(`INSERT INTO scribe_attempts
            (attempt_id, batch_id, status, started_at_ms) VALUES (?, ?, 'active', ?)`)
          .run(attemptId, id, now());
      }),
    completeAttempt: (rawBatchId, rawAttemptId) =>
      transaction(() => {
        const id = required(rawBatchId, "Scribe Batch id");
        const attemptId = required(rawAttemptId, "Scribe attempt id");
        const finishedAt = now();
        const attempt = database
          .prepare(`UPDATE scribe_attempts SET status = 'completed', finished_at_ms = ?
            WHERE attempt_id = ? AND batch_id = ? AND status = 'active'`)
          .run(finishedAt, attemptId, id);
        const batch = database
          .prepare(`UPDATE scribe_batches SET active_attempt_id = NULL, completed_at_ms = ?
            WHERE batch_id = ? AND active_attempt_id = ? AND completed_at_ms IS NULL`)
          .run(finishedAt, id, attemptId);
        if (attempt.changes !== 1 || batch.changes !== 1) {
          throw new Error(`Scribe attempt ${attemptId} is not active for Batch ${id}.`);
        }
      }),
    failAttempt: (rawBatchId, rawAttemptId, rawError) =>
      transaction(() => {
        const id = required(rawBatchId, "Scribe Batch id");
        const attemptId = required(rawAttemptId, "Scribe attempt id");
        const error = required(rawError, "Scribe attempt failure").slice(0, 1_000);
        const finishedAt = now();
        const attempt = database
          .prepare(`UPDATE scribe_attempts SET status = 'failed', finished_at_ms = ?, error = ?
            WHERE attempt_id = ? AND batch_id = ? AND status = 'active'`)
          .run(finishedAt, error, attemptId, id);
        const batch = database
          .prepare(`UPDATE scribe_batches SET active_attempt_id = NULL
            WHERE batch_id = ? AND active_attempt_id = ? AND completed_at_ms IS NULL`)
          .run(id, attemptId);
        if (attempt.changes !== 1 || batch.changes !== 1) {
          throw new Error(`Scribe attempt ${attemptId} is not active for Batch ${id}.`);
        }
      }),
    isEvidenceComplete: (rawEvidenceIds) => {
      const evidenceIds = [...new Set(rawEvidenceIds.map((id) => required(id, "Scribe evidence id")))];
      if (evidenceIds.length === 0) return true;
      const placeholders = evidenceIds.map(() => "?").join(",");
      const row = database
        .prepare(`SELECT count(*) AS count FROM scribe_observations AS observation
          JOIN scribe_batches AS batch ON batch.batch_id = observation.batch_id
          WHERE observation.evidence_id IN (${placeholders}) AND batch.completed_at_ms IS NOT NULL`)
        .get(...evidenceIds) as { readonly count: number };
      return row.count === evidenceIds.length;
    },
    close: () => database.close(),
  };
};
