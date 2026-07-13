import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { SessionState } from "eve/client";
import type { GithubResult } from "../subagents/github/lib/output-schema.ts";
import { keyedSessionLock, type SessionStore } from "../../src/coalescer/doorway.ts";

export type JobStatus = "pending" | "running" | "report_pending" | "reporting" | "done" | "failed";

export interface DelegationJob {
  readonly id: string;
  readonly voiceSessionId: string;
  readonly chatId?: string;
  readonly kind: "github";
  readonly task: string;
  readonly status: JobStatus;
  readonly attempts: number;
  readonly workerState?: SessionState;
  readonly result?: GithubResult;
  readonly error?: string;
}

export type MessageDirection = "inbound" | "outbound";

export interface StoredWhatsAppMessage {
  readonly id: string;
  readonly chatId: string;
  readonly direction: MessageDirection;
  readonly senderId?: string;
  readonly senderName?: string;
  readonly kind: string;
  readonly text: string;
  readonly timestamp: number;
}

interface MessageRow {
  message_id: string;
  chat_id: string;
  direction: MessageDirection;
  sender_id: string | null;
  sender_name: string | null;
  kind: string;
  text: string;
  timestamp_ms: number;
}

interface JobRow {
  id: string;
  voice_session_id: string;
  chat_id: string | null;
  kind: "github";
  task: string;
  status: JobStatus;
  attempts: number;
  worker_state_json: string | null;
  result_json: string | null;
  error: string | null;
}

const decodeJob = (row: JobRow): DelegationJob => ({
  id: row.id,
  voiceSessionId: row.voice_session_id,
  ...(row.chat_id === null ? {} : { chatId: row.chat_id }),
  kind: row.kind,
  task: row.task,
  status: row.status,
  attempts: row.attempts,
  ...(row.worker_state_json === null ? {} : { workerState: JSON.parse(row.worker_state_json) as SessionState }),
  ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as GithubResult }),
  ...(row.error === null ? {} : { error: row.error }),
});

const decodeMessage = (row: MessageRow): StoredWhatsAppMessage => ({
  id: row.message_id,
  chatId: row.chat_id,
  direction: row.direction,
  ...(row.sender_id === null ? {} : { senderId: row.sender_id }),
  ...(row.sender_name === null ? {} : { senderName: row.sender_name }),
  kind: row.kind,
  text: row.text,
  timestamp: row.timestamp_ms,
});

const escapeLike = (query: string): string => query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

export const gatewayDatabasePath = (): string =>
  process.env.WA_GATEWAY_DB ?? join(process.env.WHATSAPP_STORE_DIR ?? ".wa-auth", "gateway.sqlite");

/** Durable queue plus the corrected chatId -> SessionState resume map. */
export class GatewayStore implements SessionStore {
  readonly #db: DatabaseSync;
  readonly runExclusive = keyedSessionLock();

  constructor(path = gatewayDatabasePath()) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS voice_sessions (
        chat_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        voice_session_id TEXT NOT NULL,
        chat_id TEXT,
        kind TEXT NOT NULL CHECK (kind = 'github'),
        task TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'report_pending', 'reporting', 'done', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        worker_state_json TEXT,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        sender_id TEXT,
        sender_name TEXT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, created_at);
      CREATE INDEX IF NOT EXISTS messages_chat_time_idx ON messages(chat_id, timestamp_ms, message_id);
    `);
    const columns = this.#db.prepare("PRAGMA table_info(jobs)").all() as unknown as Array<{ name: string }>;
    if (!columns.some(({ name }) => name === "worker_state_json")) {
      this.#db.exec("ALTER TABLE jobs ADD COLUMN worker_state_json TEXT");
    }
  }

  close(): void {
    this.#db.close();
  }

  /** Startup-only crash recovery. Do not run this from short-lived tool connections. */
  reclaimRunning(): number {
    return Number(
      this.#db
        .prepare(
          `UPDATE jobs
              SET status = CASE status WHEN 'running' THEN 'pending' ELSE 'report_pending' END,
                  updated_at = datetime('now')
            WHERE status IN ('running', 'reporting')`,
        )
        .run().changes,
    );
  }

  get(chatId: string): SessionState | undefined {
    const row = this.#db.prepare("SELECT state_json FROM voice_sessions WHERE chat_id = ?").get(chatId) as
      | { state_json: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.state_json) as SessionState);
  }

  set(chatId: string, state: SessionState): void {
    if (state.sessionId === undefined) throw new Error(`Cannot persist voice session for ${chatId} without sessionId`);
    this.#db
      .prepare(
        `INSERT INTO voice_sessions (chat_id, session_id, state_json, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(chat_id) DO UPDATE SET
           session_id = excluded.session_id,
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      )
      .run(chatId, state.sessionId, JSON.stringify(state));
  }

  chatIdForVoiceSession(sessionId: string): string | undefined {
    const row = this.#db.prepare("SELECT chat_id FROM voice_sessions WHERE session_id = ?").get(sessionId) as
      | { chat_id: string }
      | undefined;
    return row?.chat_id;
  }

  persistMessage(message: StoredWhatsAppMessage): void {
    this.#db
      .prepare(
        `INSERT INTO messages
          (chat_id, message_id, direction, sender_id, sender_name, kind, text, timestamp_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(chat_id, message_id) DO UPDATE SET
           direction = excluded.direction,
           sender_id = COALESCE(excluded.sender_id, messages.sender_id),
           sender_name = COALESCE(excluded.sender_name, messages.sender_name),
           kind = excluded.kind,
           text = CASE WHEN excluded.text <> '' THEN excluded.text ELSE messages.text END,
           timestamp_ms = MIN(messages.timestamp_ms, excluded.timestamp_ms)`,
      )
      .run(
        message.chatId,
        message.id,
        message.direction,
        message.senderId ?? null,
        message.senderName ?? null,
        message.kind,
        message.text,
        message.timestamp,
      );
  }

  searchMessages(chatId: string, query: string, limit = 50): readonly StoredWhatsAppMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages
            WHERE chat_id = ? AND text LIKE ? ESCAPE '\\' COLLATE NOCASE
            ORDER BY timestamp_ms DESC, message_id DESC
            LIMIT ?
         ) ORDER BY timestamp_ms, message_id`,
      )
      .all(chatId, `%${escapeLike(query)}%`, Math.max(1, Math.min(limit, 100))) as unknown as MessageRow[];
    return rows.map(decodeMessage);
  }

  readThread(chatId: string, limit = 30): readonly StoredWhatsAppMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages
            WHERE chat_id = ?
            ORDER BY timestamp_ms DESC, message_id DESC
            LIMIT ?
         ) ORDER BY timestamp_ms, message_id`,
      )
      .all(chatId, Math.max(1, Math.min(limit, 100))) as unknown as MessageRow[];
    return rows.map(decodeMessage);
  }

  enqueue(input: { voiceSessionId: string; kind: "github"; task: string; id?: string }): string {
    const id = input.id ?? randomUUID();
    const inserted = this.#db
      .prepare(
        `INSERT OR IGNORE INTO jobs
          (id, voice_session_id, kind, task, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))`,
      )
      .run(id, input.voiceSessionId, input.kind, input.task);
    if (inserted.changes === 0) {
      const existing = this.#db.prepare("SELECT voice_session_id, kind, task FROM jobs WHERE id = ?").get(id) as
        | { voice_session_id: string; kind: "github"; task: string }
        | undefined;
      if (
        existing === undefined ||
        existing.voice_session_id !== input.voiceSessionId ||
        existing.kind !== input.kind ||
        existing.task !== input.task
      ) {
        throw new Error(`Delegated job id collision for ${id}`);
      }
    }
    return id;
  }

  /** Compensate a synchronous tool failure only while the runner cannot have claimed the job. */
  cancelPending(id: string): boolean {
    return this.#db.prepare("DELETE FROM jobs WHERE id = ? AND status = 'pending'").run(id).changes === 1;
  }

  claimPending(limit: number): readonly DelegationJob[] {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.#db
        .prepare(
          `SELECT jobs.*,
                  voice_sessions.chat_id AS resolved_chat_id
             FROM jobs
             JOIN voice_sessions ON voice_sessions.session_id = jobs.voice_session_id
            WHERE jobs.status IN ('pending', 'report_pending')
            ORDER BY jobs.created_at, jobs.id
            LIMIT ?`,
        )
        .all(limit) as unknown as (JobRow & { resolved_chat_id: string })[];
      const claim = this.#db.prepare(
        `UPDATE jobs
            SET status = ?, chat_id = ?, attempts = attempts + ?, updated_at = datetime('now')
          WHERE id = ? AND status = ?`,
      );
      const claimed = rows.flatMap((row) => {
        const nextStatus: JobStatus = row.status === "pending" ? "running" : "reporting";
        const changed = claim.run(nextStatus, row.resolved_chat_id, row.status === "pending" ? 1 : 0, row.id, row.status).changes;
        return changed === 0
          ? []
          : [
              decodeJob({
                ...row,
                chat_id: row.resolved_chat_id,
                status: nextStatus,
                attempts: row.attempts + (row.status === "pending" ? 1 : 0),
              }),
            ];
      });
      this.#db.exec("COMMIT");
      return claimed;
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  queueResult(id: string, result: GithubResult): void {
    this.#db
      .prepare(
        `UPDATE jobs
            SET status = 'report_pending', result_json = ?, error = NULL, updated_at = datetime('now')
          WHERE id = ? AND status = 'running'`,
      )
      .run(JSON.stringify(result), id);
  }

  checkpointWorker(id: string, state: SessionState): void {
    if (state.sessionId === undefined) throw new Error(`Cannot checkpoint worker ${id} without sessionId`);
    this.#db
      .prepare(
        `UPDATE jobs SET worker_state_json = ?, updated_at = datetime('now')
          WHERE id = ? AND status = 'running'`,
      )
      .run(JSON.stringify(state), id);
  }

  queueFailure(id: string, error: string): void {
    this.#db
      .prepare(
        `UPDATE jobs
            SET status = 'report_pending', result_json = NULL, error = ?, updated_at = datetime('now')
          WHERE id = ? AND status = 'running'`,
      )
      .run(error, id);
  }

  complete(id: string): void {
    this.#db
      .prepare(
        `UPDATE jobs
            SET status = 'done', error = NULL, updated_at = datetime('now')
          WHERE id = ? AND status IN ('report_pending', 'reporting')`,
      )
      .run(id);
  }

  fail(id: string): void {
    this.#db
      .prepare(
        `UPDATE jobs
            SET status = 'failed', updated_at = datetime('now')
          WHERE id = ? AND status IN ('report_pending', 'reporting')`,
      )
      .run(id);
  }

  deferReport(id: string, error: string): void {
    this.#db
      .prepare(
        `UPDATE jobs
            SET status = 'report_pending', error = COALESCE(error, ?), updated_at = datetime('now')
          WHERE id = ? AND status IN ('report_pending', 'reporting')`,
      )
      .run(error, id);
  }

  getJob(id: string): DelegationJob | undefined {
    const row = this.#db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as unknown as JobRow | undefined;
    return row === undefined ? undefined : decodeJob(row);
  }

  listJobs(): readonly DelegationJob[] {
    return (this.#db.prepare("SELECT * FROM jobs ORDER BY created_at, id").all() as unknown as JobRow[]).map(decodeJob);
  }
}
