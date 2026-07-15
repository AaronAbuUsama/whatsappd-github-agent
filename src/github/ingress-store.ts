import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type GitHubIngressStatus = "received" | "unsupported" | "uncorrelated" | "done" | "failed";

export interface GitHubIngressRecord {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly repository?: string;
  readonly chatId?: string;
  readonly ambience?: string;
  readonly dispatchId?: string;
  readonly acceptedAt?: string;
  readonly status: GitHubIngressStatus;
  readonly error?: string;
  readonly receivedAt: string;
  readonly settledAt?: string;
}

interface GitHubIngressRow {
  delivery_id: string;
  event_name: string;
  repository: string | null;
  chat_id: string | null;
  ambience: string | null;
  dispatch_id: string | null;
  accepted_at: string | null;
  status: GitHubIngressStatus;
  error: string | null;
  received_at: string;
  settled_at: string | null;
}

const hydrate = (row: GitHubIngressRow): GitHubIngressRecord => ({
  deliveryId: row.delivery_id,
  eventName: row.event_name,
  ...(row.repository ? { repository: row.repository } : {}),
  ...(row.chat_id ? { chatId: row.chat_id } : {}),
  ...(row.ambience ? { ambience: row.ambience } : {}),
  ...(row.dispatch_id ? { dispatchId: row.dispatch_id } : {}),
  ...(row.accepted_at ? { acceptedAt: row.accepted_at } : {}),
  status: row.status,
  ...(row.error ? { error: row.error } : {}),
  receivedAt: row.received_at,
  ...(row.settled_at ? { settledAt: row.settled_at } : {}),
});

export interface GitHubIngressStore {
  claim(deliveryId: string, eventName: string, receivedAt: string): boolean;
  settle(
    deliveryId: string,
    update:
      | {
          readonly status: "done";
          readonly repository: string;
          readonly chatId: string;
          readonly ambience: "ambience";
          readonly dispatchId: string;
          readonly acceptedAt: string;
          readonly error?: undefined;
          readonly settledAt: string;
        }
      | {
          readonly status: "unsupported" | "uncorrelated" | "failed";
          readonly repository?: string;
          readonly chatId?: string;
          readonly ambience?: string;
          readonly dispatchId?: string;
          readonly acceptedAt?: string;
          readonly error?: string;
          readonly settledAt: string;
        },
  ): void;
  get(deliveryId: string): GitHubIngressRecord | undefined;
  list(): readonly GitHubIngressRecord[];
  close(): void;
}

export const createGitHubIngressStore = (
  databasePath: string,
  now: () => Date = () => new Date(),
  legacyDatabasePath?: string,
): GitHubIngressStore => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000");
  const createTable = `
    CREATE TABLE github_ingress_deliveries (
      delivery_id TEXT PRIMARY KEY,
      event_name TEXT NOT NULL,
      repository TEXT,
      chat_id TEXT,
      ambience TEXT,
      dispatch_id TEXT,
      accepted_at TEXT,
      status TEXT NOT NULL CHECK (status IN ('received', 'unsupported', 'uncorrelated', 'done', 'failed')),
      error TEXT,
      received_at TEXT NOT NULL,
      settled_at TEXT
    ) STRICT
  `;
  // Legacy statuses map to at-least-once semantics (ADR 0014): a settled
  // dispatch is done; anything in flight or ambiguous returns to received so a
  // provider redelivery reprocesses it — a duplicate wake is tolerated.
  const legacyStatusMapping = `
    CASE WHEN status = 'dispatched' THEN 'done'
         WHEN status IN ('received', 'dispatching', 'uncertain') THEN 'received'
         ELSE status END
  `;
  const existing = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'github_ingress_deliveries'")
    .get() as { sql: string } | undefined;
  if (existing === undefined) {
    database.exec(createTable);
  } else if (!existing.sql.includes("'done'")) {
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE github_ingress_deliveries RENAME TO github_ingress_deliveries_legacy;
        ${createTable};
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, repository, chat_id, ambience, dispatch_id, accepted_at, status, error, received_at, settled_at)
        SELECT delivery_id, event_name, repository, chat_id, ambience, dispatch_id,
               ${existing.sql.includes("accepted_at") ? "accepted_at" : "NULL"},
               ${legacyStatusMapping},
               CASE WHEN status IN ('received', 'dispatching', 'uncertain') THEN NULL ELSE error END,
               received_at,
               CASE WHEN status IN ('received', 'dispatching', 'uncertain') THEN NULL ELSE settled_at END
          FROM github_ingress_deliveries_legacy;
        DROP TABLE github_ingress_deliveries_legacy;
        COMMIT;
      `);
    } catch (cause) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Migration may have failed before the transaction began.
      }
      database.close();
      throw cause;
    }
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS github_ingress_migrations (
      migration_id TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL
    ) STRICT
  `);
  if (
    legacyDatabasePath !== undefined &&
    resolve(legacyDatabasePath) !== resolve(databasePath) &&
    existsSync(legacyDatabasePath)
  ) {
    const migrationId = `standalone-ledger-cutover-v1:${resolve(legacyDatabasePath)}`;
    const imported = database
      .prepare("SELECT 1 FROM github_ingress_migrations WHERE migration_id = ?")
      .get(migrationId);
    if (imported === undefined) {
      database.prepare("ATTACH DATABASE ? AS legacy_github_ingress").run(legacyDatabasePath);
      try {
        const source = database
          .prepare(
            "SELECT 1 FROM legacy_github_ingress.sqlite_master WHERE type = 'table' AND name = 'github_ingress_deliveries'",
          )
          .get();
        if (source === undefined) {
          throw new Error(`Legacy GitHub ingress database ${legacyDatabasePath} has no delivery ledger.`);
        }
        const columns = new Set(
          (
            database.prepare("PRAGMA legacy_github_ingress.table_info('github_ingress_deliveries')").all() as Array<{
              name: string;
            }>
          ).map((column) => column.name),
        );
        const conflict = database
          .prepare(`
            SELECT current.delivery_id
              FROM main.github_ingress_deliveries AS current
              JOIN legacy_github_ingress.github_ingress_deliveries AS legacy
                ON legacy.delivery_id = current.delivery_id
             LIMIT 1
          `)
          .get() as { delivery_id: string } | undefined;
        if (conflict !== undefined) {
          throw new Error(
            `Legacy GitHub ingress delivery ${conflict.delivery_id} already exists in application.sqlite; refusing to guess during cutover.`,
          );
        }
        const acceptedAt = columns.has("accepted_at") ? "accepted_at" : "NULL";
        database.exec("BEGIN IMMEDIATE");
        database.exec(`
          INSERT INTO main.github_ingress_deliveries
            (delivery_id, event_name, repository, chat_id, ambience, dispatch_id, accepted_at,
             status, error, received_at, settled_at)
          SELECT delivery_id, event_name, repository, chat_id, ambience, dispatch_id, ${acceptedAt},
                 ${legacyStatusMapping},
                 CASE WHEN status IN ('received', 'dispatching', 'uncertain') THEN NULL ELSE error END,
                 received_at,
                 CASE WHEN status IN ('received', 'dispatching', 'uncertain') THEN NULL ELSE settled_at END
            FROM legacy_github_ingress.github_ingress_deliveries;
        `);
        database
          .prepare("INSERT INTO github_ingress_migrations (migration_id, completed_at) VALUES (?, ?)")
          .run(migrationId, now().toISOString());
        database.exec("COMMIT");
      } catch (cause) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Import validation may fail before its transaction begins.
        }
        throw cause;
      } finally {
        database.exec("DETACH DATABASE legacy_github_ingress");
      }
    }
  }

  const claimStatement = database.prepare(`
    INSERT OR IGNORE INTO github_ingress_deliveries
      (delivery_id, event_name, status, received_at)
    VALUES (?, ?, 'received', ?)
  `);
  const settleStatement = database.prepare(`
    UPDATE github_ingress_deliveries
       SET status = ?, repository = ?, chat_id = ?, ambience = ?, dispatch_id = ?, accepted_at = ?, error = ?, settled_at = ?
     WHERE delivery_id = ? AND status = 'received'
  `);
  const getStatement = database.prepare(`
    SELECT delivery_id, event_name, repository, chat_id, ambience, dispatch_id, accepted_at,
           status, error, received_at, settled_at
      FROM github_ingress_deliveries
     WHERE delivery_id = ?
  `);
  const listStatement = database.prepare(`
    SELECT delivery_id, event_name, repository, chat_id, ambience, dispatch_id, accepted_at,
           status, error, received_at, settled_at
      FROM github_ingress_deliveries
     ORDER BY received_at, delivery_id
  `);

  return {
    claim: (deliveryId, eventName, receivedAt) =>
      claimStatement.run(deliveryId, eventName, receivedAt).changes === 1,
    settle: (deliveryId, update) => {
      if (update.status === "done" && (!update.dispatchId || !Number.isFinite(Date.parse(update.acceptedAt)))) {
        throw new Error(`GitHub delivery ${deliveryId} has an invalid Flue admission receipt.`);
      }
      const result = settleStatement.run(
        update.status,
        update.repository ?? null,
        update.chatId ?? null,
        update.ambience ?? null,
        update.dispatchId ?? null,
        update.acceptedAt ?? null,
        update.error ?? null,
        update.settledAt,
        deliveryId,
      );
      if (result.changes !== 1) throw new Error(`GitHub delivery ${deliveryId} cannot settle as ${update.status}.`);
    },
    get: (deliveryId) => {
      const row = getStatement.get(deliveryId) as GitHubIngressRow | undefined;
      return row ? hydrate(row) : undefined;
    },
    list: () => (listStatement.all() as unknown as GitHubIngressRow[]).map(hydrate),
    close: () => database.close(),
  };
};
