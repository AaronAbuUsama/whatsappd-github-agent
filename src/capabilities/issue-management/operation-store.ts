import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type IssueOperationStatus = "attempting" | "completed" | "uncertain" | "failed";
export type IssueOperationKind = "create-issue" | "update-issue";

export interface IssueOperationRecord {
  readonly operationId: string;
  readonly kind: IssueOperationKind;
  readonly repository: string;
  readonly status: IssueOperationStatus;
  readonly issueNumber?: number;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly error?: string;
  readonly startedAt: string;
  readonly settledAt?: string;
}

interface IssueOperationRow {
  operation_id: string;
  kind: IssueOperationKind;
  repository: string;
  status: IssueOperationStatus;
  issue_number: number | null;
  target_json: string | null;
  error: string | null;
  started_at: string;
  settled_at: string | null;
}

const hydrate = (row: IssueOperationRow): IssueOperationRecord => ({
  operationId: row.operation_id,
  kind: row.kind,
  repository: row.repository,
  status: row.status,
  ...(row.issue_number === null ? {} : { issueNumber: row.issue_number }),
  ...(row.target_json === null ? {} : { target: JSON.parse(row.target_json) as Record<string, unknown> }),
  ...(row.error === null ? {} : { error: row.error }),
  startedAt: row.started_at,
  ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
});

export interface IssueOperationStore {
  begin(input: {
    readonly operationId: string;
    readonly kind: IssueOperationKind;
    readonly repository: string;
    readonly issueNumber?: number;
    readonly target?: Readonly<Record<string, unknown>>;
    readonly startedAt: string;
  }): IssueOperationRecord;
  complete(operationId: string, issueNumber: number, settledAt: string): IssueOperationRecord;
  uncertain(operationId: string, error: string, settledAt: string): IssueOperationRecord;
  fail(operationId: string, error: string, settledAt: string): IssueOperationRecord;
  get(operationId: string): IssueOperationRecord | undefined;
  list(): readonly IssueOperationRecord[];
  close(): void;
}

export const createIssueOperationStore = (databasePath: string): IssueOperationStore => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000");
  const createTable = `
    CREATE TABLE github_issue_operations (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('create-issue', 'update-issue')),
      repository TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('attempting', 'completed', 'uncertain', 'failed')),
      issue_number INTEGER,
      target_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      settled_at TEXT
    ) STRICT
  `;
  const existing = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'github_issue_operations'")
    .get() as { sql: string } | undefined;
  if (existing === undefined) {
    database.exec(createTable);
  } else if (!existing.sql.includes("'update-issue'")) {
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE github_issue_operations RENAME TO github_issue_operations_create_only;
        ${createTable};
        INSERT INTO github_issue_operations
          (operation_id, kind, repository, status, issue_number, target_json, error, started_at, settled_at)
        SELECT operation_id, kind, repository, status, issue_number, NULL, error, started_at, settled_at
          FROM github_issue_operations_create_only;
        DROP TABLE github_issue_operations_create_only;
        COMMIT;
      `);
    } catch (cause) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The migration may have failed before its transaction began.
      }
      database.close();
      throw cause;
    }
  }
  const insert = database.prepare(`
    INSERT INTO github_issue_operations
      (operation_id, kind, repository, status, issue_number, target_json, started_at)
    VALUES (?, ?, ?, 'attempting', ?, ?, ?)
  `);
  const settle = database.prepare(`
    UPDATE github_issue_operations
       SET status = ?, issue_number = COALESCE(?, issue_number), error = ?, settled_at = ?
     WHERE operation_id = ? AND status = 'attempting'
  `);
  const select = database.prepare("SELECT * FROM github_issue_operations WHERE operation_id = ?");
  const list = database.prepare("SELECT * FROM github_issue_operations ORDER BY started_at, operation_id");
  const get = (operationId: string): IssueOperationRecord | undefined => {
    const row = select.get(operationId) as IssueOperationRow | undefined;
    return row === undefined ? undefined : hydrate(row);
  };
  const update = (
    operationId: string,
    status: Exclude<IssueOperationStatus, "attempting">,
    issueNumber: number | null,
    error: string | null,
    settledAt: string,
  ): IssueOperationRecord => {
    const result = settle.run(status, issueNumber, error, settledAt, operationId);
    if (result.changes !== 1) throw new Error(`Issue operation ${operationId} is missing or already settled.`);
    return get(operationId)!;
  };
  return {
    begin: ({ operationId, kind, repository, issueNumber, target, startedAt }) => {
      insert.run(
        operationId,
        kind,
        repository,
        issueNumber ?? null,
        target === undefined ? null : JSON.stringify(target),
        startedAt,
      );
      return get(operationId)!;
    },
    complete: (operationId, issueNumber, settledAt) => update(operationId, "completed", issueNumber, null, settledAt),
    uncertain: (operationId, error, settledAt) => update(operationId, "uncertain", null, error, settledAt),
    fail: (operationId, error, settledAt) => update(operationId, "failed", null, error, settledAt),
    get,
    list: () => (list.all() as unknown as IssueOperationRow[]).map(hydrate),
    close: () => database.close(),
  };
};
