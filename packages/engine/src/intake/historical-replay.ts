import { DatabaseSync } from "node:sqlite";

import type { ConversationWindow } from "../coalescer/events.ts";
import type { WhatsAppWindowInput } from "../inputs.ts";
import { whatsappWindowInput } from "../inputs.ts";
import { decodeIncoming, decodeUpdate, type InboxEventRow } from "./managed-chat-inbox.ts";

export type HistoricalReplayMode = "catching_up" | "live" | "failed" | "disabled";
export type HistoricalReplayPhase = "snapshot" | "tail";

export interface HistoricalReplaySurfaceState {
  readonly chatId: string;
  readonly mode: HistoricalReplayMode;
  readonly phase: HistoricalReplayPhase;
  readonly snapshotHighWater?: number;
  readonly snapshotUnknownTime?: number;
  readonly snapshotOccurredAt?: number;
  readonly snapshotSequence?: number;
  readonly afterSequence: number;
  readonly runId?: string;
  readonly lastError?: string;
}

interface StateRow {
  chat_id: string;
  mode: HistoricalReplayMode;
  phase: HistoricalReplayPhase;
  snapshot_high_water: number | null;
  snapshot_unknown_time: number | null;
  snapshot_occurred_at_ms: number | null;
  snapshot_sequence: number | null;
  after_sequence: number;
  run_id: string | null;
  last_error: string | null;
}

interface ArchiveRow extends InboxEventRow {
  archive_sequence: number;
}

interface ReplayCursor {
  readonly chatId: string;
  readonly phase: HistoricalReplayPhase;
  readonly throughSequence: number;
  readonly unknownTime: number;
  readonly occurredAt: number;
}

export interface HistoricalReplayBatch {
  readonly inputs: readonly WhatsAppWindowInput[];
  readonly cursors: readonly ReplayCursor[];
  readonly archiveEventCount: number;
  readonly receiptCount: number;
}

export interface HistoricalReplayStore {
  get(chatId: string): HistoricalReplaySurfaceState | undefined;
  states(): readonly HistoricalReplaySurfaceState[];
  admit(chatId: string): boolean;
  retry(chatId: string): boolean;
  setRunId(runId: string): void;
  disable(chatId: string): void;
  captureSnapshots(): void;
  nextBatch(limit?: number): HistoricalReplayBatch | undefined;
  checkpoint(batch: HistoricalReplayBatch): void;
  advance(): number;
  fail(errorCode: string): void;
  liveSlice(input: WhatsAppWindowInput): WhatsAppWindowInput | undefined;
  close(): void;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS historical_replay_surfaces (
    chat_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('catching_up','live','failed','disabled')),
    phase TEXT NOT NULL CHECK (phase IN ('snapshot','tail')),
    snapshot_high_water INTEGER,
    snapshot_unknown_time INTEGER,
    snapshot_occurred_at_ms INTEGER,
    snapshot_sequence INTEGER,
    after_sequence INTEGER NOT NULL DEFAULT 0,
    run_id TEXT,
    last_error TEXT,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;
`;

const hydrate = (row: StateRow): HistoricalReplaySurfaceState => ({
  chatId: row.chat_id,
  mode: row.mode,
  phase: row.phase,
  ...(row.snapshot_high_water === null ? {} : { snapshotHighWater: row.snapshot_high_water }),
  ...(row.snapshot_unknown_time === null ? {} : { snapshotUnknownTime: row.snapshot_unknown_time }),
  ...(row.snapshot_occurred_at_ms === null ? {} : { snapshotOccurredAt: row.snapshot_occurred_at_ms }),
  ...(row.snapshot_sequence === null ? {} : { snapshotSequence: row.snapshot_sequence }),
  afterSequence: row.after_sequence,
  ...(row.run_id === null ? {} : { runId: row.run_id }),
  ...(row.last_error === null ? {} : { lastError: row.last_error }),
});

const chronological = (left: ArchiveRow, right: ArchiveRow): number => {
  const leftUnknown = left.occurred_at_ms === 0 ? 1 : 0;
  const rightUnknown = right.occurred_at_ms === 0 ? 1 : 0;
  return (
    leftUnknown - rightUnknown ||
    left.occurred_at_ms - right.occurred_at_ms ||
    left.archive_sequence - right.archive_sequence
  );
};

const inputsFrom = (rows: readonly ArchiveRow[]): readonly WhatsAppWindowInput[] => {
  const inputs: WhatsAppWindowInput[] = [];
  let group: ArchiveRow[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    const chatId = group[0]!.chat_id;
    const ordered = group.map((row) =>
      row.kind === "arrival"
        ? { message: decodeIncoming(row), update: undefined }
        : { message: undefined, update: decodeUpdate(row) },
    );
    const window: ConversationWindow = {
      id: `historical-replay:${group[0]!.archive_sequence}:${group.at(-1)!.archive_sequence}`,
      chatId,
      messages: ordered.flatMap(({ message }) => (message === undefined ? [] : [message])),
      updates: ordered.flatMap(({ update }) => (update === undefined ? [] : [update])),
      eventOrder: ordered.map(({ message, update }) => (message ?? update!).id),
      reason: "capacity",
    };
    inputs.push(whatsappWindowInput(window));
    group = [];
  };
  for (const row of rows) {
    if (group[0]?.chat_id !== undefined && group[0].chat_id !== row.chat_id) flush();
    group.push(row);
  }
  flush();
  return inputs;
};

export const createHistoricalReplayStore = (
  databasePath: string,
  now: () => number = Date.now,
): HistoricalReplayStore => {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  database.exec(SCHEMA);
  const legacy = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'scribe_backfills'")
    .get();
  if (legacy !== undefined) {
    database.exec(`BEGIN IMMEDIATE;
      INSERT OR IGNORE INTO historical_replay_surfaces
        (chat_id, mode, phase, snapshot_high_water, snapshot_unknown_time,
         snapshot_occurred_at_ms, snapshot_sequence, after_sequence, run_id,
         last_error, updated_at_ms)
      SELECT chat_id, mode, phase, snapshot_high_water, snapshot_unknown_time,
         snapshot_occurred_at_ms, snapshot_sequence, after_sequence, run_id,
         last_error, updated_at_ms FROM scribe_backfills;
      UPDATE historical_replay_surfaces SET snapshot_high_water = after_sequence,
        snapshot_unknown_time = NULL,
        snapshot_occurred_at_ms = NULL, snapshot_sequence = NULL
        WHERE phase = 'tail';
      DROP TABLE scribe_backfills;
      COMMIT;`);
  }
  const select = database.prepare("SELECT * FROM historical_replay_surfaces WHERE chat_id = ?");
  const get = (chatId: string): HistoricalReplaySurfaceState | undefined => {
    const row = select.get(chatId) as unknown as StateRow | undefined;
    return row === undefined ? undefined : hydrate(row);
  };
  const states = (): readonly HistoricalReplaySurfaceState[] =>
    (database.prepare("SELECT * FROM historical_replay_surfaces ORDER BY chat_id").all() as unknown as StateRow[]).map(
      hydrate,
    );
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
  const rowsFor = (state: HistoricalReplaySurfaceState, limit: number): readonly ArchiveRow[] => {
    if (state.phase === "snapshot") {
      if (state.snapshotHighWater === undefined) return [];
      return database
        .prepare(`SELECT rowid AS archive_sequence, * FROM conversation_events
        WHERE chat_id = ? AND rowid <= ? AND (? IS NULL OR
          (CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END, occurred_at_ms, rowid) > (?, ?, ?))
        ORDER BY CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END, occurred_at_ms, rowid LIMIT ?`)
        .all(
          state.chatId,
          state.snapshotHighWater,
          state.snapshotSequence ?? null,
          state.snapshotUnknownTime ?? null,
          state.snapshotOccurredAt ?? null,
          state.snapshotSequence ?? null,
          limit,
        ) as unknown as ArchiveRow[];
    }
    if (state.snapshotHighWater === undefined) return [];
    return database
      .prepare(`SELECT rowid AS archive_sequence, * FROM conversation_events
      WHERE chat_id = ? AND rowid > ? AND rowid <= ? AND (? IS NULL OR
        (CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END, occurred_at_ms, rowid) > (?, ?, ?))
      ORDER BY CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END, occurred_at_ms, rowid LIMIT ?`)
      .all(
        state.chatId,
        state.afterSequence,
        state.snapshotHighWater,
        state.snapshotSequence ?? null,
        state.snapshotUnknownTime ?? null,
        state.snapshotOccurredAt ?? null,
        state.snapshotSequence ?? null,
        limit,
      ) as unknown as ArchiveRow[];
  };
  const hasRows = (state: HistoricalReplaySurfaceState): boolean => rowsFor(state, 1).length > 0;

  return {
    get,
    states,
    admit: (chatId) =>
      transaction(() => {
        if (get(chatId) !== undefined) return false;
        database
          .prepare(`INSERT INTO historical_replay_surfaces
        (chat_id, mode, phase, after_sequence, updated_at_ms) VALUES (?, 'catching_up', 'snapshot', 0, ?)`)
          .run(chatId, now());
        return true;
      }),
    retry: (chatId) =>
      transaction(
        () =>
          database
            .prepare(`UPDATE historical_replay_surfaces SET
      mode = 'catching_up', run_id = NULL, last_error = NULL, updated_at_ms = ?
      WHERE chat_id = ? AND mode IN ('failed','disabled')`)
            .run(now(), chatId).changes === 1,
      ),
    setRunId: (runId) => {
      database
        .prepare("UPDATE historical_replay_surfaces SET run_id = ?, updated_at_ms = ? WHERE mode = 'catching_up'")
        .run(runId, now());
    },
    disable: (chatId) =>
      transaction(() => {
        database
          .prepare(`UPDATE historical_replay_surfaces SET
        after_sequence = CASE WHEN mode = 'live' THEN COALESCE((SELECT MAX(rowid) FROM conversation_events WHERE chat_id = ?), 0) ELSE after_sequence END,
        snapshot_high_water = CASE WHEN mode = 'live' THEN COALESCE((SELECT MAX(rowid) FROM conversation_events WHERE chat_id = ?), 0) ELSE snapshot_high_water END,
        snapshot_unknown_time = CASE WHEN mode = 'live' THEN NULL ELSE snapshot_unknown_time END,
        snapshot_occurred_at_ms = CASE WHEN mode = 'live' THEN NULL ELSE snapshot_occurred_at_ms END,
        snapshot_sequence = CASE WHEN mode = 'live' THEN NULL ELSE snapshot_sequence END,
        mode = 'disabled', run_id = NULL, updated_at_ms = ? WHERE chat_id = ?`)
          .run(chatId, chatId, now(), chatId);
      }),
    captureSnapshots: () =>
      transaction(() => {
        for (const state of states().filter(({ mode }) => mode === "catching_up")) {
          database
            .prepare(`UPDATE historical_replay_surfaces SET snapshot_high_water =
          (SELECT COALESCE(MAX(rowid), 0) FROM conversation_events WHERE chat_id = ?), updated_at_ms = ?
          WHERE chat_id = ? AND mode = 'catching_up' AND snapshot_high_water IS NULL`)
            .run(state.chatId, now(), state.chatId);
        }
      }),
    nextBatch: (requestedLimit = 50) => {
      const limit = Math.max(1, Math.min(requestedLimit, 50));
      const candidates = states()
        .filter(({ mode }) => mode === "catching_up")
        .flatMap((state) => rowsFor(state, limit))
        .sort(chronological)
        .slice(0, limit);
      if (candidates.length === 0) return undefined;
      const visible = candidates.filter(({ kind }) => kind !== "receipt");
      const cursors = new Map<string, ReplayCursor>();
      for (const row of candidates) {
        const state = get(row.chat_id)!;
        cursors.set(row.chat_id, {
          chatId: row.chat_id,
          phase: state.phase,
          throughSequence: row.archive_sequence,
          unknownTime: row.occurred_at_ms === 0 ? 1 : 0,
          occurredAt: row.occurred_at_ms,
        });
      }
      return {
        inputs: inputsFrom(visible),
        cursors: [...cursors.values()],
        archiveEventCount: candidates.length,
        receiptCount: candidates.length - visible.length,
      };
    },
    checkpoint: (batch) =>
      transaction(() => {
        for (const cursor of batch.cursors) {
          database
            .prepare(`UPDATE historical_replay_surfaces SET snapshot_unknown_time = ?,
            snapshot_occurred_at_ms = ?, snapshot_sequence = ?, updated_at_ms = ?
            WHERE chat_id = ? AND mode = 'catching_up' AND phase = ?`)
            .run(cursor.unknownTime, cursor.occurredAt, cursor.throughSequence, now(), cursor.chatId, cursor.phase);
        }
      }),
    advance: () =>
      transaction(() => {
        const catchingUp = states().filter(({ mode }) => mode === "catching_up");
        if (catchingUp.length === 0) return 0;
        const snapshots = catchingUp.filter(({ phase }) => phase === "snapshot");
        if (snapshots.length > 0) {
          if (snapshots.some(hasRows)) return 0;
          return Number(
            database
              .prepare(`UPDATE historical_replay_surfaces SET phase = 'tail',
                after_sequence = snapshot_high_water,
                snapshot_high_water = (SELECT COALESCE(MAX(rowid), 0) FROM conversation_events
                  WHERE chat_id = historical_replay_surfaces.chat_id),
                snapshot_unknown_time = NULL,
                snapshot_occurred_at_ms = NULL, snapshot_sequence = NULL, updated_at_ms = ?
                WHERE mode = 'catching_up' AND phase = 'snapshot'`)
              .run(now()).changes,
          );
        }
        if (catchingUp.some(hasRows)) return 0;
        const hasNewTailRows = catchingUp.some((state) => {
          const row = database
            .prepare("SELECT COALESCE(MAX(rowid), 0) AS high_water FROM conversation_events WHERE chat_id = ?")
            .get(state.chatId) as { high_water: number };
          return row.high_water > (state.snapshotHighWater ?? state.afterSequence);
        });
        if (hasNewTailRows) {
          return Number(
            database
              .prepare(`UPDATE historical_replay_surfaces SET
                after_sequence = snapshot_high_water,
                snapshot_high_water = (SELECT COALESCE(MAX(rowid), 0) FROM conversation_events
                  WHERE chat_id = historical_replay_surfaces.chat_id),
                snapshot_unknown_time = NULL, snapshot_occurred_at_ms = NULL,
                snapshot_sequence = NULL, updated_at_ms = ?
                WHERE mode = 'catching_up' AND phase = 'tail'`)
              .run(now()).changes,
          );
        }
        let transitions = 0;
        for (const state of catchingUp) {
          transitions += Number(
            database
              .prepare(`UPDATE historical_replay_surfaces SET mode = 'live', run_id = NULL,
                after_sequence = snapshot_high_water,
                snapshot_unknown_time = NULL, snapshot_occurred_at_ms = NULL, snapshot_sequence = NULL,
                last_error = NULL, updated_at_ms = ?
                WHERE chat_id = ? AND mode = 'catching_up' AND phase = 'tail'`)
              .run(now(), state.chatId).changes,
          );
        }
        return transitions;
      }),
    fail: (errorCode) =>
      transaction(() => {
        database
          .prepare(`UPDATE historical_replay_surfaces SET mode = 'failed', run_id = NULL,
        last_error = ?, updated_at_ms = ? WHERE mode = 'catching_up'`)
          .run(errorCode.slice(0, 200), now());
      }),
    liveSlice: (input) =>
      transaction(() => {
        const state = get(input.chatId);
        if (state === undefined) return input;
        if (state.mode !== "live") return undefined;
        const ids = [
          ...input.messages.map((message) => message.evidenceId ?? `arrival:${input.chatId}:${message.id}`),
          ...input.updates.map((update) => update.id),
        ];
        if (ids.length === 0) return undefined;
        const placeholders = ids.map(() => "?").join(",");
        const rows = database
          .prepare(
            `SELECT event_id, rowid AS archive_sequence FROM conversation_events WHERE event_id IN (${placeholders})`,
          )
          .all(...ids) as unknown as Array<{ event_id: string; archive_sequence: number }>;
        const keep = new Set(
          rows.filter((row) => row.archive_sequence > state.afterSequence).map((row) => row.event_id),
        );
        const messages = input.messages.filter((message) =>
          keep.has(message.evidenceId ?? `arrival:${input.chatId}:${message.id}`),
        );
        const updates = input.updates.filter((update) => keep.has(update.id));
        if (messages.length + updates.length === 0) return undefined;
        const retainedIds = new Set([...messages.map((message) => message.id), ...updates.map((update) => update.id)]);
        return {
          ...input,
          messages,
          updates,
          ...(input.eventOrder === undefined
            ? {}
            : { eventOrder: input.eventOrder.filter((id) => retainedIds.has(id)) }),
        };
      }),
    close: () => database.close(),
  };
};
