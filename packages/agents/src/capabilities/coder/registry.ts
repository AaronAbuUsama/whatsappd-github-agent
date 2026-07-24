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
 * The read-only verdict for one REQUEST_CHANGES review, keyed on the review id so a repeated
 * identical review (a webhook redelivery, or the Brain re-processing an unsettled Batch after a
 * crash) converges rather than launching a second run / demoting twice. `duplicate` is a review
 * already reserved (idempotent no-op); `unregistered` is not a Coder PR. `within-budget` means the
 * reservation SUCCEEDED and a cycle is already consumed (call `releaseRepair` if the launch fails).
 */
export type RepairCheck =
  | { readonly status: "within-budget"; readonly job: CodingJobRecord }
  | { readonly status: "over-budget"; readonly job: CodingJobRecord }
  | { readonly status: "duplicate"; readonly previous: "launched" | "over-budget" }
  | { readonly status: "unregistered" };

export interface CodingJobRegistry {
  /** Record (or refresh) a Coder-owned PR's journey and budgets. Preserves `reviewCycle`. */
  upsert(job: Omit<CodingJobRecord, "reviewCycle">): void;
  get(repository: string, prNumber: number): CodingJobRecord | undefined;
  /**
   * Atomically decide AND reserve one review's repair, in a single `BEGIN IMMEDIATE` transaction, so
   * the budget check and the cycle reservation are one step — two concurrent review events can never
   * both pass the same under-limit check and both launch (finding 3, round 3). On `within-budget` it
   * has already recorded the review id and consumed a cycle; on `over-budget` it recorded the review
   * id (no cycle); `duplicate`/`unregistered` reserve nothing. Call `releaseRepair` iff the subsequent
   * side effect fails, to undo the reservation so a genuine retry can re-reserve (never a wasted cycle).
   *
   * ponytail: residual crash-window tradeoff. Reserving BEFORE the launch (to close the race above)
   * means a process crash in the gap between this commit and launchSpecialistWork's own durable write
   * leaves the review permanently `duplicate` with no run — but that gap is two back-to-back synchronous
   * local SQLite writes with no I/O or await between them (this store and the inbox are separate DBs, so
   * a single transaction can't span both). Deliberately accepted, matching this codebase's precedent for
   * narrow crash-window gaps; upgrade path = boot reconciliation of reserved-but-un-launched reviews.
   */
  reserveRepair(repository: string, prNumber: number, reviewId: number): RepairCheck;
  /** Undo a reservation whose side effect failed: delete the review id and, for a launch, give back the cycle. */
  releaseRepair(repository: string, prNumber: number, reviewId: number): void;
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
  const deleteRepair = database.prepare(
    "DELETE FROM coding_job_repairs WHERE repository = ? AND pr_number = ? AND review_id = ? RETURNING outcome",
  );
  const bumpCycle = database.prepare(
    "UPDATE coding_jobs SET review_cycle = review_cycle + 1 WHERE repository = ? AND pr_number = ?",
  );
  const dropCycle = database.prepare(
    "UPDATE coding_jobs SET review_cycle = max(0, review_cycle - 1) WHERE repository = ? AND pr_number = ?",
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
    reserveRepair: (repository, prNumber, reviewId) => {
      const [repo, pr] = key(repository, prNumber);
      // BEGIN IMMEDIATE takes the write lock up front, so the budget read and the cycle bump are one
      // atomic step: a second concurrent reserve blocks here, then sees the already-consumed cycle (or
      // the already-recorded review id) and can never pass the same under-limit check twice (finding 3).
      database.exec("BEGIN IMMEDIATE");
      try {
        const job = get(repo, pr);
        if (job === undefined) {
          database.exec("COMMIT");
          return { status: "unregistered" };
        }
        const decided = selectRepair.get(repo, pr, reviewId) as { outcome: string } | undefined;
        if (decided !== undefined) {
          database.exec("COMMIT");
          return { status: "duplicate", previous: decided.outcome === "launched" ? "launched" : "over-budget" };
        }
        if (job.reviewCycle >= job.maxReviewCycles) {
          insertRepair.run(repo, pr, reviewId, "over-budget");
          database.exec("COMMIT");
          return { status: "over-budget", job };
        }
        insertRepair.run(repo, pr, reviewId, "launched");
        bumpCycle.run(repo, pr);
        database.exec("COMMIT");
        return { status: "within-budget", job: { ...job, reviewCycle: job.reviewCycle + 1 } };
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    releaseRepair: (repository, prNumber, reviewId) => {
      const [repo, pr] = key(repository, prNumber);
      database.exec("BEGIN IMMEDIATE");
      try {
        const removed = deleteRepair.get(repo, pr, reviewId) as { outcome: string } | undefined;
        if (removed?.outcome === "launched") dropCycle.run(repo, pr);
        database.exec("COMMIT");
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    close: () => database.close(),
  };
};
