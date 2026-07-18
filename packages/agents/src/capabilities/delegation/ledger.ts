import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The run ledger — LAUNCH MEMORY, not an idempotency key (MEMORY-STATE-SPEC §8,
 * principle 4). It records every Specialist launch (which chat asked, which `runId`
 * Flue admitted) so two operations can find it again across restarts: `check_jobs`
 * lists a chat's launches and reads their live status, and the boot sweep converts
 * any launch left unsettled by a crash into an `interrupted` result. A relaunched
 * dead job is a NEW `runId` — idempotency lives on GitHub state, never here.
 */
export interface RunLaunchRecord {
  readonly runId: string;
  readonly chatId?: string;
  readonly workflow: string;
  readonly launchedAt: string;
  readonly settledAt?: string;
}

export interface RunLedger {
  record(input: { runId: string; chatId?: string; workflow: string; launchedAt: string }): void;
  /** Mark a launch settled once its result has been delivered (or determined unroutable). No-op if already settled. */
  settle(runId: string, settledAt: string): void;
  get(runId: string): RunLaunchRecord | undefined;
  /** Every launch still awaiting delivery — the boot sweep's worklist. */
  unsettled(): readonly RunLaunchRecord[];
  /** A chat's launches, newest first — `check_jobs`'s worklist. */
  forChat(chatId: string, limit?: number): readonly RunLaunchRecord[];
  close(): void;
}

interface RunLaunchRow {
  run_id: string;
  chat_id: string | null;
  workflow: string;
  launched_at: string;
  settled_at: string | null;
}

const hydrate = (row: RunLaunchRow): RunLaunchRecord => ({
  runId: row.run_id,
  ...(row.chat_id === null ? {} : { chatId: row.chat_id }),
  workflow: row.workflow,
  launchedAt: row.launched_at,
  ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
});

export const createRunLedger = (databasePath: string): RunLedger => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS delegation_launches (
      run_id TEXT PRIMARY KEY,
      chat_id TEXT,
      workflow TEXT NOT NULL,
      launched_at TEXT NOT NULL,
      settled_at TEXT
    ) STRICT;
  `);
  const insert = database.prepare(`
    INSERT INTO delegation_launches (run_id, chat_id, workflow, launched_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(run_id) DO NOTHING
  `);
  const settle = database.prepare(`
    UPDATE delegation_launches SET settled_at = ? WHERE run_id = ? AND settled_at IS NULL
  `);
  const select = database.prepare("SELECT * FROM delegation_launches WHERE run_id = ?");
  const selectUnsettled = database.prepare(
    "SELECT * FROM delegation_launches WHERE settled_at IS NULL ORDER BY launched_at, run_id",
  );
  const selectForChat = database.prepare(
    "SELECT * FROM delegation_launches WHERE chat_id = ? ORDER BY launched_at DESC, run_id DESC LIMIT ?",
  );
  return {
    record: ({ runId, chatId, workflow, launchedAt }) => {
      insert.run(runId, chatId ?? null, workflow, launchedAt);
    },
    settle: (runId, settledAt) => {
      settle.run(settledAt, runId);
    },
    get: (runId) => {
      const row = select.get(runId) as RunLaunchRow | undefined;
      return row === undefined ? undefined : hydrate(row);
    },
    unsettled: () => (selectUnsettled.all() as unknown as RunLaunchRow[]).map(hydrate),
    forChat: (chatId, limit = 20) => (selectForChat.all(chatId, limit) as unknown as RunLaunchRow[]).map(hydrate),
    close: () => database.close(),
  };
};
