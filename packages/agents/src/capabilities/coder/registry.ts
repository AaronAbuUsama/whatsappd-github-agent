import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The coding-job registry (#211) — the durable map from a Coder-authored pull request back
 * to the coding job that owns it, so a REQUEST_CHANGES review can find the exact issue,
 * branch, and configured budgets to repair against. It preserves the issue/PR JOURNEY and
 * the verification/review budgets, and NOTHING GitHub owns: no review bodies, no thread
 * state, no head sha — those are refetched live at repair time (§8 principle 4; GitHub is
 * the durable boundary between runs). Being registered is also the safety key: a row exists
 * only because the Coder itself opened that PR on its own `agent/coder/issue-N` branch, so
 * an external contributor's or fork-headed PR is never in the registry and never repaired.
 */
export interface CodingJobRecord {
  readonly repository: string;
  readonly prNumber: number;
  readonly issue: number;
  readonly branch: string;
  readonly base: string;
  readonly maxVerificationRounds: number;
  readonly maxReviewCycles: number;
  /** Repair cycles already consumed. Bumped atomically when a repair is admitted. */
  readonly reviewCycle: number;
}

/**
 * The atomic decision for one qualifying REQUEST_CHANGES review, keyed on the review id so a
 * webhook redelivery or a repeated identical review event converges rather than launching a
 * second run / demoting twice. `launched` consumes one repair cycle; `over-budget` is the
 * qualifying rejection that would exceed the configured budget — it launches NO run and the
 * caller demotes the PR to draft with one idempotent lifecycle comment; `duplicate` is a
 * review id already decided (idempotent no-op); `unregistered` is not a Coder-owned PR.
 */
export type RepairDecision =
  | { readonly status: "launched"; readonly job: CodingJobRecord }
  | { readonly status: "over-budget"; readonly job: CodingJobRecord }
  | { readonly status: "duplicate"; readonly previous: "launched" | "over-budget" }
  | { readonly status: "unregistered" };

export interface CodingJobRegistry {
  /** Record (or refresh) a Coder-owned PR's journey and budgets. Preserves `reviewCycle`. */
  upsert(job: Omit<CodingJobRecord, "reviewCycle">): void;
  get(repository: string, prNumber: number): CodingJobRecord | undefined;
  /** Atomically decide and record one review's repair, consuming a cycle only when launched. */
  admitRepair(repository: string, prNumber: number, reviewId: number): RepairDecision;
  close(): void;
}

interface CodingJobRow {
  repository: string;
  pr_number: number;
  issue: number;
  branch: string;
  base: string;
  max_verification_rounds: number;
  max_review_cycles: number;
  review_cycle: number;
}

const key = (repository: string, prNumber: number): [string, number] => [repository.toLowerCase(), prNumber];

const hydrate = (row: CodingJobRow): CodingJobRecord => ({
  repository: row.repository,
  prNumber: row.pr_number,
  issue: row.issue,
  branch: row.branch,
  base: row.base,
  maxVerificationRounds: row.max_verification_rounds,
  maxReviewCycles: row.max_review_cycles,
  reviewCycle: row.review_cycle,
});

export const createCodingJobRegistry = (databasePath: string): CodingJobRegistry => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS coding_jobs (
      repository TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      issue INTEGER NOT NULL,
      branch TEXT NOT NULL,
      base TEXT NOT NULL,
      max_verification_rounds INTEGER NOT NULL,
      max_review_cycles INTEGER NOT NULL,
      review_cycle INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (repository, pr_number)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS coding_job_repairs (
      repository TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      review_id INTEGER NOT NULL,
      outcome TEXT NOT NULL,
      PRIMARY KEY (repository, pr_number, review_id)
    ) STRICT;
  `);
  const upsert = database.prepare(`
    INSERT INTO coding_jobs (repository, pr_number, issue, branch, base, max_verification_rounds, max_review_cycles)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repository, pr_number) DO UPDATE SET
      issue = excluded.issue,
      branch = excluded.branch,
      base = excluded.base,
      max_verification_rounds = excluded.max_verification_rounds,
      max_review_cycles = excluded.max_review_cycles
  `);
  const select = database.prepare("SELECT * FROM coding_jobs WHERE repository = ? AND pr_number = ?");
  const selectRepair = database.prepare(
    "SELECT outcome FROM coding_job_repairs WHERE repository = ? AND pr_number = ? AND review_id = ?",
  );
  const insertRepair = database.prepare(
    "INSERT INTO coding_job_repairs (repository, pr_number, review_id, outcome) VALUES (?, ?, ?, ?)",
  );
  const bumpCycle = database.prepare(
    "UPDATE coding_jobs SET review_cycle = review_cycle + 1 WHERE repository = ? AND pr_number = ?",
  );

  const get = (repository: string, prNumber: number): CodingJobRecord | undefined => {
    const [repo] = key(repository, prNumber);
    const row = select.get(repo, prNumber) as CodingJobRow | undefined;
    return row === undefined ? undefined : hydrate(row);
  };

  return {
    upsert: (job) => {
      const [repo, prNumber] = key(job.repository, job.prNumber);
      upsert.run(repo, prNumber, job.issue, job.branch, job.base, job.maxVerificationRounds, job.maxReviewCycles);
    },
    get,
    admitRepair: (repository, prNumber, reviewId) => {
      const [repo, pr] = key(repository, prNumber);
      const job = get(repo, pr);
      if (job === undefined) return { status: "unregistered" };
      const decided = selectRepair.get(repo, pr, reviewId) as { outcome: string } | undefined;
      if (decided !== undefined) {
        return { status: "duplicate", previous: decided.outcome === "launched" ? "launched" : "over-budget" };
      }
      if (job.reviewCycle >= job.maxReviewCycles) {
        insertRepair.run(repo, pr, reviewId, "over-budget");
        return { status: "over-budget", job };
      }
      bumpCycle.run(repo, pr);
      insertRepair.run(repo, pr, reviewId, "launched");
      return { status: "launched", job: { ...job, reviewCycle: job.reviewCycle + 1 } };
    },
    close: () => database.close(),
  };
};
