import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type IssueOperationStatus = "attempting" | "completed" | "uncertain" | "failed" | "abandoned";
export type IssueOperationResolution = "reconciled" | "accepted-observed" | "abandoned" | "retried";
export type IssueOperationKind =
  | "create-issue"
  | "update-issue"
  | "create-comment"
  | "update-comment"
  | "delete-comment"
  | "set-issue-state";

export interface IssueOperationRecord {
  readonly operationId: string;
  readonly kind: IssueOperationKind;
  readonly repository: string;
  readonly status: IssueOperationStatus;
  readonly issueNumber?: number;
  readonly target?: Readonly<Record<string, unknown>>;
  readonly error?: string;
  readonly resolution?: IssueOperationResolution;
  readonly replacementOperationId?: string;
  readonly startedAt: string;
  readonly settledAt?: string;
}

export interface IssueCreateCorrelation {
  readonly completedIssueNumbers: readonly number[];
  readonly hasPendingCreate: boolean;
}

interface IssueOperationRow {
  operation_id: string;
  kind: IssueOperationKind;
  repository: string;
  status: IssueOperationStatus;
  issue_number: number | null;
  target_json: string | null;
  error: string | null;
  resolution: IssueOperationResolution | null;
  replacement_operation_id: string | null;
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
  ...(row.resolution === null ? {} : { resolution: row.resolution }),
  ...(row.replacement_operation_id === null ? {} : { replacementOperationId: row.replacement_operation_id }),
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
  resolveUncertain(input: {
    readonly operationId: string;
    readonly status: "completed" | "abandoned";
    readonly resolution: IssueOperationResolution;
    readonly settledAt: string;
    readonly issueNumber?: number;
    readonly replacementOperationId?: string;
  }): IssueOperationRecord;
  retryUncertain(input: {
    readonly operationId: string;
    readonly replacementOperationId: string;
    readonly startedAt: string;
  }): { readonly previous: IssueOperationRecord; readonly replacement: IssueOperationRecord };
  uncertainForDiagnosis(limit: number): readonly IssueOperationRecord[];
  markExamined(operationId: string, examinedAt: string): void;
  correlateCreateIssues(repository: string, issueNumbers: readonly number[]): IssueCreateCorrelation;
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
      kind TEXT NOT NULL CHECK (kind IN (
        'create-issue', 'update-issue', 'create-comment', 'update-comment', 'delete-comment', 'set-issue-state'
      )),
      repository TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('attempting', 'completed', 'uncertain', 'failed', 'abandoned')),
      issue_number INTEGER,
      target_json TEXT,
      error TEXT,
      resolution TEXT CHECK (resolution IS NULL OR resolution IN ('reconciled', 'accepted-observed', 'abandoned', 'retried')),
      replacement_operation_id TEXT,
      started_at TEXT NOT NULL,
      settled_at TEXT
    ) STRICT
  `;
  const existing = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'github_issue_operations'")
    .get() as { sql: string } | undefined;
  if (existing === undefined) {
    database.exec(createTable);
  } else if (
    !existing.sql.includes("'abandoned'") ||
    !existing.sql.includes("replacement_operation_id") ||
    ["update-issue", "create-comment", "update-comment", "delete-comment", "set-issue-state"].some(
      (kind) => !existing.sql.includes(`'${kind}'`),
    )
  ) {
    const legacyTarget = existing.sql.includes("target_json") ? "target_json" : "NULL";
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE github_issue_operations RENAME TO github_issue_operations_legacy;
        ${createTable};
        INSERT INTO github_issue_operations
          (operation_id, kind, repository, status, issue_number, target_json, error, started_at, settled_at)
        SELECT operation_id, kind, repository, status, issue_number, ${legacyTarget}, error, started_at, settled_at
          FROM github_issue_operations_legacy;
        DROP TABLE github_issue_operations_legacy;
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
  database.exec(`
    CREATE TABLE IF NOT EXISTS github_issue_operation_examinations (
      operation_id TEXT PRIMARY KEY,
      examined_at TEXT NOT NULL,
      FOREIGN KEY (operation_id) REFERENCES github_issue_operations(operation_id)
    ) STRICT;
  `);
  database
    .prepare(`
      UPDATE github_issue_operations
         SET status = 'uncertain',
             error = 'Process restarted after the provider mutation began',
             settled_at = ?
       WHERE status = 'attempting'
    `)
    .run(new Date().toISOString());
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
  const resolveUncertain = database.prepare(`
    UPDATE github_issue_operations
       SET status = ?, issue_number = COALESCE(?, issue_number), error = NULL,
           resolution = ?, replacement_operation_id = ?, settled_at = ?
     WHERE operation_id = ? AND status = 'uncertain'
  `);
  const select = database.prepare("SELECT * FROM github_issue_operations WHERE operation_id = ?");
  const list = database.prepare("SELECT * FROM github_issue_operations ORDER BY started_at, operation_id");
  const uncertainForDiagnosis = database.prepare(`
    SELECT o.*
      FROM github_issue_operations o
      LEFT JOIN github_issue_operation_examinations e ON e.operation_id = o.operation_id
     WHERE o.status = 'uncertain'
     ORDER BY e.examined_at IS NOT NULL, e.examined_at, o.started_at, o.operation_id
     LIMIT ?
  `);
  const markExamined = database.prepare(`
    INSERT INTO github_issue_operation_examinations (operation_id, examined_at)
    VALUES (?, ?)
    ON CONFLICT(operation_id) DO UPDATE SET examined_at = excluded.examined_at
  `);
  const completedCreateIssue = database.prepare(`
    SELECT 1
      FROM github_issue_operations
     WHERE kind = 'create-issue'
       AND status = 'completed'
       AND repository = ? COLLATE NOCASE
       AND issue_number = ?
     LIMIT 1
  `);
  const pendingCreateIssue = database.prepare(`
    SELECT 1
      FROM github_issue_operations
     WHERE kind = 'create-issue'
       AND status IN ('attempting', 'uncertain')
       AND repository = ? COLLATE NOCASE
     LIMIT 1
  `);
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
    resolveUncertain: ({ operationId, status, resolution, settledAt, issueNumber, replacementOperationId }) => {
      const result = resolveUncertain.run(
        status,
        issueNumber ?? null,
        resolution,
        replacementOperationId ?? null,
        settledAt,
        operationId,
      );
      if (result.changes !== 1) throw new Error(`Issue operation ${operationId} is not Uncertain.`);
      return get(operationId)!;
    },
    retryUncertain: ({ operationId, replacementOperationId, startedAt }) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const previous = get(operationId);
        if (previous?.status !== "uncertain") throw new Error(`Issue operation ${operationId} is not Uncertain.`);
        insert.run(
          replacementOperationId,
          previous.kind,
          previous.repository,
          previous.issueNumber ?? null,
          previous.target === undefined ? null : JSON.stringify(previous.target),
          startedAt,
        );
        const resolution = resolveUncertain.run(
          "abandoned",
          null,
          "retried",
          replacementOperationId,
          startedAt,
          operationId,
        );
        if (resolution.changes !== 1) throw new Error(`Issue operation ${operationId} is not Uncertain.`);
        database.exec("COMMIT");
        return { previous: get(operationId)!, replacement: get(replacementOperationId)! };
      } catch (cause) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the transition failure that triggered rollback.
        }
        throw cause;
      }
    },
    uncertainForDiagnosis: (limit) =>
      (uncertainForDiagnosis.all(Math.max(0, Math.floor(limit))) as unknown as IssueOperationRow[]).map(hydrate),
    markExamined: (operationId, examinedAt) => {
      const operation = get(operationId);
      if (operation === undefined) throw new Error(`Issue operation ${operationId} does not exist.`);
      markExamined.run(operationId, examinedAt);
    },
    correlateCreateIssues: (repository, issueNumbers) => ({
      completedIssueNumbers: [...new Set(issueNumbers)].filter(
        (issueNumber) => completedCreateIssue.get(repository, issueNumber) !== undefined,
      ),
      hasPendingCreate: pendingCreateIssue.get(repository) !== undefined,
    }),
    get,
    list: () => (list.all() as unknown as IssueOperationRow[]).map(hydrate),
    close: () => database.close(),
  };
};
