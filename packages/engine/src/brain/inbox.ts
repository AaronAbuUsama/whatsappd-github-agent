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

export interface KnowledgeDeltaDraft {
  readonly scribeBatchId: string;
  readonly attestationIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly projectionVersion: string;
}

export interface KnowledgeDelta extends KnowledgeDeltaDraft {
  readonly id: string;
  readonly admittedAt: string;
}

export interface SpecialistLaunch {
  readonly id: string;
  readonly batchId: string;
  readonly sourceSurfaceId: string;
  readonly evidenceIds: readonly string[];
  readonly specialist: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly requestedAt: string;
  readonly status: "pending" | "accepted";
  readonly runId?: string;
  readonly acceptedAt?: string;
}

export interface SpecialistResultDraft {
  readonly workId: string;
  readonly runId: string;
  readonly status: "ok" | "interrupted";
  readonly result?: unknown;
}

export interface SpecialistResult extends SpecialistResultDraft {
  readonly id: string;
  readonly sourceBatchId: string;
  readonly sourceSurfaceId: string;
  readonly evidenceIds: readonly string[];
  readonly specialist: string;
  readonly admittedAt: string;
}

/**
 * One streamed progress note from a running Bounded Workflow (§3.8). Start is the accepted
 * launch and terminal is the SpecialistResult; a Milestone is the "rare Milestone" in between.
 */
export interface WorkMilestone {
  readonly workId: string;
  readonly note: string;
  readonly at: string;
}

/** An accepted launch with no terminal result yet, plus its latest streamed Milestone. */
export interface ActiveWorkItem {
  readonly workId: string;
  readonly specialist: string;
  readonly sourceSurfaceId: string;
  readonly startedAt: string;
  readonly latestMilestone?: WorkMilestone;
}

/**
 * A GitHub event admitted to the Brain up-inbox (§4). Immutable and provenance-bearing:
 * it carries its delivery identity, repository, and normalized detail so the Brain — never
 * the ingress — decides which Surface(s) hear it, including none. Identity is the delivery,
 * so a provider redelivery admits idempotently.
 */
export interface GitHubEventDraft {
  readonly githubAppId: string;
  readonly deliveryId: string;
  readonly eventName: string;
  readonly action: string;
  readonly repository: string;
  readonly summary: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface GitHubEvent extends GitHubEventDraft {
  readonly id: string;
  readonly admittedAt: string;
}

/**
 * The proactive clock's input to the Brain up-inbox (§6). Two glossary kinds share one durable
 * ledger: a `scheduled` Scheduled Wake — durable exact reconsideration the Brain self-schedules
 * ("check this loop in two hours") — and a `sweep` Proactive Sweep — the coalesced cron/boot floor
 * that admits at most one outstanding sweep so the Brain reviews open loops and overdue commitments.
 * The application database is the source of truth: a due wake survives restart and fires exactly once.
 */
export interface ScheduledWake {
  readonly id: string;
  readonly kind: "scheduled" | "sweep";
  readonly reason: string;
  readonly dueAt: string;
  readonly createdAt: string;
  /** Set when the due scan admits it into the up-inbox; present on every wake carried by a Batch. */
  readonly admittedAt?: string;
}

export interface ProactiveClockTick {
  readonly admittedSweep: boolean;
  readonly admittedWakes: number;
}

export interface BrainBatch {
  readonly id: string;
  readonly createdAt: string;
  readonly intents: readonly Intent[];
  readonly knowledgeDeltas: readonly KnowledgeDelta[];
  readonly specialistResults: readonly SpecialistResult[];
  readonly githubEvents: readonly GitHubEvent[];
  readonly scheduledWakes: readonly ScheduledWake[];
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

export interface FileIssueRequest {
  readonly repository: string;
  readonly kind: "bug" | "feature";
  readonly title: string;
  readonly body: string;
}

/** The terminal outcome of a durable issue filing, recorded so a recovered Batch reports honestly. */
export type FileIssueOutcome =
  | { readonly status: "created" | "reconciled"; readonly issueNumber: number; readonly url: string }
  | {
      readonly status: "duplicate";
      readonly issues: readonly { readonly number: number; readonly url: string; readonly title: string }[];
    }
  | { readonly status: "uncertain"; readonly reason: string };

export interface FileIssueEffect {
  readonly id: string;
  readonly batchId: string;
  readonly kind: "file_issue";
  readonly request: FileIssueRequest;
  readonly status: "pending" | "completed";
  readonly outcome?: FileIssueOutcome;
}

/** The local Brain Effect that creates a Scheduled Wake (ADR 0006): the effect row and the wake row
 * commit together, so a self-scheduled wake is always owned by the Batch that created it. */
export interface ScheduleWakeEffect {
  readonly id: string;
  readonly batchId: string;
  readonly kind: "schedule_wake";
  readonly wakeId: string;
  readonly reason: string;
  readonly dueAt: string;
  readonly status: "completed";
}

/**
 * A single Brain-chosen GitHub issue mutation (the full mutation set beyond file_issue): comment
 * create/update/delete, issue update, and state change (§11 additive capability). Every variant
 * carries its own target repository (owner/repo) — routing is the Brain's, never a config default.
 * delete-comment is provenance-restricted at admission to a comment the Brain itself created.
 */
export type IssueMutation =
  | { readonly kind: "create-comment"; readonly repository: string; readonly number: number; readonly body: string }
  | {
      readonly kind: "update-issue";
      readonly repository: string;
      readonly number: number;
      readonly title?: string;
      readonly body?: string;
      readonly labels?: readonly string[];
      readonly assignees?: readonly string[];
      readonly milestone?: number | null;
    }
  | {
      readonly kind: "update-comment";
      readonly repository: string;
      readonly number: number;
      readonly commentId: number;
      readonly body: string;
    }
  | { readonly kind: "delete-comment"; readonly repository: string; readonly number: number; readonly commentId: number }
  | {
      readonly kind: "set-issue-state";
      readonly repository: string;
      readonly number: number;
      readonly state: "open" | "closed";
      readonly reason: "completed" | "not_planned" | "duplicate" | "reopened";
    };

/** The terminal outcome of one durable issue mutation, recorded so a recovered Batch reports honestly. */
export type IssueMutationOutcome =
  | {
      readonly status: "applied" | "reconciled";
      readonly url?: string;
      readonly commentId?: number;
      readonly issueNumber?: number;
      readonly state?: "open" | "closed";
    }
  // Uncertain still carries what GitHub was observed to have done (e.g. a comment it created whose
  // Operation completion could not be persisted), so the durable effect preserves provenance detail.
  | {
      readonly status: "uncertain";
      readonly reason: string;
      readonly url?: string;
      readonly commentId?: number;
      readonly issueNumber?: number;
      readonly state?: "open" | "closed";
    };

export interface IssueMutationEffect {
  readonly id: string;
  readonly batchId: string;
  readonly kind: "issue_mutation";
  readonly mutation: IssueMutation;
  readonly status: "pending" | "completed";
  readonly outcome?: IssueMutationOutcome;
}

export type BrainEffect =
  | PromptSpeakerEffect
  | StaySilentEffect
  | FileIssueEffect
  | ScheduleWakeEffect
  | IssueMutationEffect;

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

interface KnowledgeDeltaRow {
  delta_id: string;
  scribe_batch_id: string;
  attestation_ids_json: string;
  evidence_ids_json: string;
  projection_version: string;
  admitted_at: string;
}

interface SpecialistLaunchRow {
  work_id: string;
  batch_id: string;
  source_surface_id: string;
  evidence_ids_json: string;
  specialist: string;
  input_json: string;
  requested_at: string;
  status: "pending" | "accepted";
  run_id: string | null;
  accepted_at: string | null;
}

interface SpecialistResultRow {
  result_id: string;
  work_id: string;
  run_id: string;
  source_batch_id: string;
  source_surface_id: string;
  evidence_ids_json: string;
  specialist: string;
  transport_status: "ok" | "interrupted";
  result_json: string | null;
  admitted_at: string;
  batch_id: string | null;
}

interface WorkMilestoneRow {
  milestone_id: string;
  work_id: string;
  note: string;
  at: string;
}

interface GitHubEventRow {
  event_id: string;
  github_app_id: string;
  delivery_id: string;
  event_name: string;
  action: string;
  repository: string;
  summary: string;
  detail_json: string;
  admitted_at: string;
  batch_id: string | null;
}

interface ScheduledWakeRow {
  wake_id: string;
  kind: "scheduled" | "sweep";
  reason: string;
  due_at: string;
  created_at: string;
  admitted_at: string | null;
  cancelled_at: string | null;
  batch_id: string | null;
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
  kind: "prompt_speaker" | "stay_silent" | "file_issue" | "schedule_wake" | "issue_mutation";
  payload_json: string;
  status: "pending" | "accepted" | "completed";
  dispatch_id: string | null;
  accepted_at: string | null;
}

export interface BrainInbox {
  admitIntent(draft: IntentDraft): Intent;
  admitKnowledgeDelta(draft: KnowledgeDeltaDraft): KnowledgeDelta;
  admitGitHubEvent(draft: GitHubEventDraft): GitHubEvent;
  pendingGitHubEvents(): readonly GitHubEvent[];
  /** The GitHub events assigned to one specific Batch — keyed by batch id, not "whatever is open". */
  githubEventsForBatch(batchId: string): readonly GitHubEvent[];
  intent(intentId: string): Intent | undefined;
  pendingIntents(): readonly Intent[];
  pendingKnowledgeDeltas(): readonly KnowledgeDelta[];
  knowledgeCaughtUp(deltaIds: readonly string[]): boolean;
  reserveSpecialistLaunch(input: {
    readonly batchId: string;
    readonly sourceSurfaceId: string;
    readonly specialist: string;
    readonly input: Readonly<Record<string, unknown>>;
    // Explicit provenance for a launch with no source Intent — a GitHub-event-triggered launch (#211)
    // cites the triggering event's own id, exactly as prompt_speaker does (§4). Each id must resolve to
    // a real Conversation event or admitted GitHub up-inbox event. Omitted → derive from source Intents.
    readonly evidenceIds?: readonly string[];
  }): SpecialistLaunch;
  markSpecialistLaunchAccepted(workId: string, runId: string, acceptedAt?: string): SpecialistLaunch;
  specialistLaunch(workId: string): SpecialistLaunch | undefined;
  specialistLaunchByRunId(runId: string): SpecialistLaunch | undefined;
  pendingSpecialistLaunches(): readonly SpecialistLaunch[];
  acceptedSpecialistLaunchesWithoutResult(): readonly SpecialistLaunch[];
  admitSpecialistResult(draft: SpecialistResultDraft): SpecialistResult;
  specialistResultForWork(workId: string): SpecialistResult | undefined;
  pendingSpecialistResults(): readonly SpecialistResult[];
  recordWorkMilestone(input: { readonly workId: string; readonly note: string; readonly at?: string }): void;
  workMilestones(workId: string): readonly WorkMilestone[];
  latestWorkMilestone(workId: string): WorkMilestone | undefined;
  activeWorkItems(): readonly ActiveWorkItem[];
  /** Self-schedule a durable Scheduled Wake (§6, ADR 0006, CONTEXT.md:82). Local Brain Effect of the
   * given open dispatched Batch: the effect row and wake row commit together, and the wake is identified
   * by that effect — a genuine retry of the same (batchId, reason, dueAt) coalesces, but a different
   * Batch's identical request is a distinct owed reconsideration. Pass `predecessorId` to reschedule:
   * the named predecessor is atomically cancelled (it never fires) as the replacement is created. */
  scheduleWake(input: {
    readonly batchId: string;
    readonly reason: string;
    readonly dueAt: string;
    readonly predecessorId?: string;
  }): ScheduledWake;
  /** The cron/boot due scan (§6). Admits one coalesced Proactive Sweep when none is outstanding and
   * admits every due Scheduled Wake exactly once. Returns what it admitted so the caller can wake. */
  runProactiveClock(): ProactiveClockTick;
  /** Admitted-but-unclaimed wakes — the due wakes waiting for the next claimBatch. */
  pendingScheduledWakes(): readonly ScheduledWake[];
  claimBatch(limit?: number): BrainBatch | undefined;
  markBatchDispatched(batchId: string, receipt: DispatchReceipt): BrainBatch;
  recordPrompt(input: {
    readonly batchId: string;
    readonly surfaceId: string;
    readonly objective: string;
    readonly brief: DirectiveBrief;
  }): PromptSpeakerEffect;
  recordSilence(batchId: string, reason: string): StaySilentEffect;
  recordIssueFiling(input: {
    readonly batchId: string;
    readonly sourceSurfaceId: string;
    readonly repository: string;
    readonly kind: "bug" | "feature";
    readonly title: string;
    readonly body: string;
  }): FileIssueEffect;
  completeIssueFiling(effectId: string, outcome: FileIssueOutcome): FileIssueEffect;
  pendingIssueFilings(): readonly FileIssueEffect[];
  recordIssueMutation(input: {
    readonly batchId: string;
    readonly sourceSurfaceId: string;
    readonly mutation: IssueMutation;
  }): IssueMutationEffect;
  completeIssueMutation(effectId: string, outcome: IssueMutationOutcome): IssueMutationEffect;
  pendingIssueMutations(): readonly IssueMutationEffect[];
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

const hydrateKnowledgeDelta = (row: KnowledgeDeltaRow): KnowledgeDelta => ({
  id: row.delta_id,
  scribeBatchId: row.scribe_batch_id,
  attestationIds: JSON.parse(row.attestation_ids_json) as string[],
  evidenceIds: JSON.parse(row.evidence_ids_json) as string[],
  projectionVersion: row.projection_version,
  admittedAt: row.admitted_at,
});

const hydrateSpecialistLaunch = (row: SpecialistLaunchRow): SpecialistLaunch => ({
  id: row.work_id,
  batchId: row.batch_id,
  sourceSurfaceId: row.source_surface_id,
  evidenceIds: JSON.parse(row.evidence_ids_json) as string[],
  specialist: row.specialist,
  input: JSON.parse(row.input_json) as Record<string, unknown>,
  requestedAt: row.requested_at,
  status: row.status,
  ...(row.run_id === null ? {} : { runId: row.run_id }),
  ...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
});

const hydrateSpecialistResult = (row: SpecialistResultRow): SpecialistResult => ({
  id: row.result_id,
  workId: row.work_id,
  runId: row.run_id,
  sourceBatchId: row.source_batch_id,
  sourceSurfaceId: row.source_surface_id,
  evidenceIds: JSON.parse(row.evidence_ids_json) as string[],
  specialist: row.specialist,
  status: row.transport_status,
  ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }),
  admittedAt: row.admitted_at,
});

const hydrateMilestone = (row: WorkMilestoneRow): WorkMilestone => ({
  workId: row.work_id,
  note: row.note,
  at: row.at,
});

const hydrateScheduledWake = (row: ScheduledWakeRow): ScheduledWake => ({
  id: row.wake_id,
  kind: row.kind,
  reason: row.reason,
  dueAt: row.due_at,
  createdAt: row.created_at,
  ...(row.admitted_at === null ? {} : { admittedAt: row.admitted_at }),
});

const hydrateGitHubEvent = (row: GitHubEventRow): GitHubEvent => ({
  id: row.event_id,
  githubAppId: row.github_app_id,
  deliveryId: row.delivery_id,
  eventName: row.event_name,
  action: row.action,
  repository: row.repository,
  summary: row.summary,
  detail: JSON.parse(row.detail_json) as Record<string, unknown>,
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

const canonicalIds = (values: readonly string[], name: string): readonly string[] => {
  const ids = [...new Set(values.map((id) => required(id, name)))].sort();
  if (ids.length === 0) throw new Error(`${name} requires at least one value.`);
  return ids;
};

const intentId = (sourceSurfaceId: string, interpretation: string, evidenceIds: readonly string[]): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify([sourceSurfaceId, interpretation, evidenceIds]))
    .digest("hex");
  return `intent:${digest}`;
};

const knowledgeDeltaId = (draft: Omit<KnowledgeDelta, "id" | "admittedAt">): string =>
  `knowledge-delta:${createHash("sha256")
    .update(JSON.stringify([draft.scribeBatchId, draft.attestationIds, draft.evidenceIds, draft.projectionVersion]))
    .digest("hex")}`;

const specialistWorkId = (
  batch: string,
  sourceSurfaceId: string,
  specialist: string,
  input: Readonly<Record<string, unknown>>,
): string =>
  `brain-work:${createHash("sha256")
    .update(JSON.stringify([batch, sourceSurfaceId, specialist, input]))
    .digest("hex")}`;

const specialistResultId = (workId: string, runId: string): string =>
  `specialist-result:${createHash("sha256").update(JSON.stringify([workId, runId])).digest("hex")}`;

// ponytail: idempotent by (workId, note) — a retried or duplicated waypoint coalesces to one row.
const workMilestoneId = (workId: string, note: string): string =>
  `work-milestone:${createHash("sha256").update(JSON.stringify([workId, note])).digest("hex")}`;

const githubEventId = (githubAppId: string, deliveryId: string): string =>
  `github-event:${createHash("sha256").update(JSON.stringify([githubAppId, deliveryId])).digest("hex")}`;

// A Scheduled Wake is identified by the Brain Batch effect that scheduled it (CONTEXT.md:82), so its id
// is content-addressed by (creating batchId, reason, dueAt): a genuine retry of the SAME scheduling effect
// coalesces (crash-safety dedup), but two independent Batches requesting the same reason+time are two
// distinct owed reconsiderations, not one. A sweep is addressed by its admission instant.
const scheduledWakeId = (batchId: string, reason: string, dueAt: string): string =>
  `scheduled-wake:${createHash("sha256").update(JSON.stringify([batchId, reason, dueAt])).digest("hex")}`;
const proactiveSweepId = (admittedAt: string): string =>
  `proactive-sweep:${createHash("sha256").update(JSON.stringify([admittedAt])).digest("hex")}`;

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
    CREATE TABLE IF NOT EXISTS brain_knowledge_deltas (
      delta_id TEXT PRIMARY KEY,
      scribe_batch_id TEXT NOT NULL,
      attestation_ids_json TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      projection_version TEXT NOT NULL,
      admitted_at TEXT NOT NULL,
      batch_id TEXT REFERENCES brain_batches(batch_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS brain_specialist_launches (
      work_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES brain_batches(batch_id),
      source_surface_id TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      specialist TEXT NOT NULL,
      input_json TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
      run_id TEXT UNIQUE,
      accepted_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS brain_specialist_results (
      result_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL UNIQUE REFERENCES brain_specialist_launches(work_id),
      run_id TEXT NOT NULL UNIQUE,
      source_batch_id TEXT NOT NULL,
      source_surface_id TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      specialist TEXT NOT NULL,
      transport_status TEXT NOT NULL CHECK (transport_status IN ('ok', 'interrupted')),
      result_json TEXT,
      admitted_at TEXT NOT NULL,
      batch_id TEXT REFERENCES brain_batches(batch_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS brain_work_milestones (
      milestone_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL REFERENCES brain_specialist_launches(work_id),
      note TEXT NOT NULL,
      at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS brain_github_events (
      event_id TEXT PRIMARY KEY,
      github_app_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      action TEXT NOT NULL,
      repository TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      admitted_at TEXT NOT NULL,
      batch_id TEXT REFERENCES brain_batches(batch_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS brain_scheduled_wakes (
      wake_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'sweep')),
      reason TEXT NOT NULL,
      due_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      admitted_at TEXT,
      cancelled_at TEXT,
      batch_id TEXT REFERENCES brain_batches(batch_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS brain_effects (
      effect_id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL REFERENCES brain_batches(batch_id),
      kind TEXT NOT NULL CHECK (kind IN ('prompt_speaker', 'stay_silent', 'file_issue', 'schedule_wake', 'issue_mutation')),
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'completed')),
      dispatch_id TEXT,
      accepted_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
  `);

  // The brain_effects kind CHECK is on a STRICT table — an in-place ALTER cannot widen it, so an
  // existing install is migrated by rename-copy-drop (operation-store.ts template) to admit new kinds
  // ('file_issue', then 'schedule_wake', then 'issue_mutation'). The guard keys on the newest kind so any
  // older-era install (file_issue-only OR schedule_wake-only) still rebuilds to gain 'issue_mutation' —
  // and every table that already has 'issue_mutation' necessarily has the earlier kinds too.
  // brain_effects is also the FK target of surface_deliveries and directive_outcomes (surfaces/delivery.ts):
  // SQLite repoints a child table's FK clause to follow a RENAME, so renaming brain_effects away would
  // otherwise leave those two tables referencing the dropped `_legacy` table. Rebuild whichever of the
  // three tables actually need it, independently: a child can be left dangling on a `_legacy` name from an
  // earlier partial run even after brain_effects itself is already widened (e.g. a prior attempt whose
  // DROP happened to succeed because no rows referenced it yet), so "brain_effects already has
  // 'file_issue'" alone is not sufficient to skip repairing the children.
  const tableSql = (name: string): string | undefined =>
    (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) as
      | { sql: string }
      | undefined)?.sql;
  const effectsSql = tableSql("brain_effects");
  const surfaceDeliveriesSql = tableSql("surface_deliveries");
  const directiveOutcomesSql = tableSql("directive_outcomes");

  const rebuildEffects = effectsSql !== undefined && !effectsSql.includes("'issue_mutation'");
  const surfaceDeliveriesDangling = surfaceDeliveriesSql?.includes("brain_effects_legacy") === true;
  const directiveOutcomesDangling =
    directiveOutcomesSql?.includes("brain_effects_legacy") === true ||
    directiveOutcomesSql?.includes("surface_deliveries_legacy") === true;
  // Renaming surface_deliveries re-repoints directive_outcomes' FK on delivery_id, so directive_outcomes
  // must be rebuilt whenever surface_deliveries is, even if directive_outcomes wasn't dangling on its own.
  const rebuildSurfaceDeliveries = surfaceDeliveriesSql !== undefined && (rebuildEffects || surfaceDeliveriesDangling);
  const rebuildDirectiveOutcomes =
    directiveOutcomesSql !== undefined && (rebuildEffects || rebuildSurfaceDeliveries || directiveOutcomesDangling);

  if (rebuildEffects || rebuildSurfaceDeliveries || rebuildDirectiveOutcomes) {
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        ${
          rebuildEffects
            ? `
        ALTER TABLE brain_effects RENAME TO brain_effects_legacy;
        CREATE TABLE brain_effects (
          effect_id TEXT PRIMARY KEY,
          batch_id TEXT NOT NULL REFERENCES brain_batches(batch_id),
          kind TEXT NOT NULL CHECK (kind IN ('prompt_speaker', 'stay_silent', 'file_issue', 'schedule_wake', 'issue_mutation')),
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'completed')),
          dispatch_id TEXT,
          accepted_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO brain_effects
          (effect_id, batch_id, kind, payload_json, status, dispatch_id, accepted_at, completed_at, created_at)
        SELECT effect_id, batch_id, kind, payload_json, status, dispatch_id, accepted_at, completed_at, created_at
          FROM brain_effects_legacy;
        `
            : ""
        }
        ${
          rebuildSurfaceDeliveries
            ? `
        ALTER TABLE surface_deliveries RENAME TO surface_deliveries_legacy;
        CREATE TABLE surface_deliveries (
          delivery_id TEXT PRIMARY KEY,
          directive_id TEXT NOT NULL UNIQUE REFERENCES brain_effects(effect_id),
          surface_id TEXT NOT NULL REFERENCES surfaces(surface_id),
          provider_chat_id TEXT NOT NULL,
          text TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('attempting', 'sent', 'failed', 'uncertain')),
          provider_message_id TEXT,
          conversation_event_id TEXT,
          error TEXT,
          attempted_at TEXT NOT NULL,
          settled_at TEXT
        ) STRICT;
        INSERT INTO surface_deliveries
          (delivery_id, directive_id, surface_id, provider_chat_id, text, status, provider_message_id,
           conversation_event_id, error, attempted_at, settled_at)
        SELECT delivery_id, directive_id, surface_id, provider_chat_id, text, status, provider_message_id,
               conversation_event_id, error, attempted_at, settled_at
          FROM surface_deliveries_legacy;
        `
            : ""
        }
        ${
          rebuildDirectiveOutcomes
            ? `
        ALTER TABLE directive_outcomes RENAME TO directive_outcomes_legacy;
        CREATE TABLE directive_outcomes (
          directive_id TEXT PRIMARY KEY REFERENCES brain_effects(effect_id),
          delivery_id TEXT UNIQUE REFERENCES surface_deliveries(delivery_id),
          surface_id TEXT NOT NULL REFERENCES surfaces(surface_id),
          status TEXT NOT NULL CHECK (status IN ('delivered', 'failed', 'uncertain', 'settled_without_say')),
          provider_message_id TEXT,
          conversation_event_id TEXT,
          detail TEXT,
          settled_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO directive_outcomes
          (directive_id, delivery_id, surface_id, status, provider_message_id, conversation_event_id, detail, settled_at)
        SELECT directive_id, delivery_id, surface_id, status, provider_message_id, conversation_event_id, detail, settled_at
          FROM directive_outcomes_legacy;
        DROP TABLE directive_outcomes_legacy;
        `
            : ""
        }
        ${rebuildSurfaceDeliveries ? "DROP TABLE surface_deliveries_legacy;" : ""}
        ${rebuildEffects ? "DROP TABLE brain_effects_legacy;" : ""}
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
  const insertKnowledgeDelta = database.prepare(`
    INSERT OR IGNORE INTO brain_knowledge_deltas
      (delta_id, scribe_batch_id, attestation_ids_json, evidence_ids_json, projection_version, admitted_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectKnowledgeDelta = database.prepare("SELECT * FROM brain_knowledge_deltas WHERE delta_id = ?");
  const selectIntent = database.prepare("SELECT * FROM brain_intents WHERE intent_id = ?");
  const selectPending = database.prepare(`
    SELECT intent.*
      FROM brain_inbox_inputs AS input
      JOIN brain_intents AS intent ON intent.intent_id = input.intent_id
     WHERE input.batch_id IS NULL
     ORDER BY input.admitted_at, input.rowid
  `);
  const selectPendingKnowledge = database.prepare(`
    SELECT * FROM brain_knowledge_deltas WHERE batch_id IS NULL ORDER BY admitted_at, rowid
  `);
  const insertGitHubEvent = database.prepare(`
    INSERT OR IGNORE INTO brain_github_events
      (event_id, github_app_id, delivery_id, event_name, action, repository, summary, detail_json, admitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectGitHubEvent = database.prepare("SELECT * FROM brain_github_events WHERE event_id = ?");
  const selectPendingGitHubEvents = database.prepare(
    "SELECT * FROM brain_github_events WHERE batch_id IS NULL ORDER BY admitted_at, rowid",
  );
  const selectBatchGitHubEvents = database.prepare(
    "SELECT * FROM brain_github_events WHERE batch_id = ? ORDER BY admitted_at, rowid",
  );
  const claimGitHubEvent = database.prepare(
    "UPDATE brain_github_events SET batch_id = ? WHERE event_id = ? AND batch_id IS NULL",
  );
  const insertScheduledWake = database.prepare(`
    INSERT OR IGNORE INTO brain_scheduled_wakes (wake_id, kind, reason, due_at, created_at, admitted_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const selectScheduledWake = database.prepare("SELECT * FROM brain_scheduled_wakes WHERE wake_id = ?");
  const selectPendingScheduledWakes = database.prepare(
    "SELECT * FROM brain_scheduled_wakes WHERE batch_id IS NULL AND admitted_at IS NOT NULL AND cancelled_at IS NULL ORDER BY admitted_at, rowid",
  );
  // Reschedule = cancel the named predecessor + create a replacement (CONTEXT.md:82). Idempotent: a
  // retried reschedule finds the predecessor already cancelled and no-ops.
  const cancelScheduledWake = database.prepare(
    "UPDATE brain_scheduled_wakes SET cancelled_at = ? WHERE wake_id = ? AND cancelled_at IS NULL",
  );
  const selectBatchScheduledWakes = database.prepare(
    "SELECT * FROM brain_scheduled_wakes WHERE batch_id = ? ORDER BY admitted_at, rowid",
  );
  const claimScheduledWake = database.prepare(
    "UPDATE brain_scheduled_wakes SET batch_id = ? WHERE wake_id = ? AND batch_id IS NULL",
  );
  // A Proactive Sweep is outstanding from admission until its Batch settles; the coalescing guard (§6).
  const outstandingSweepCount = database.prepare(`
    SELECT count(*) AS count FROM brain_scheduled_wakes AS wake
     LEFT JOIN brain_batches AS batch ON batch.batch_id = wake.batch_id
     WHERE wake.kind = 'sweep' AND (wake.batch_id IS NULL OR batch.settled_at IS NULL)
  `);
  // Fires each due Scheduled Wake exactly once (admitted_at IS NULL guard); survives restart.
  // ponytail: ISO-8601 UTC string comparison for due_at, matching digest.ts isOverdue; upgrade to
  // epoch-ms storage if non-UTC or non-ISO dues ever appear.
  const admitDueScheduledWakes = database.prepare(
    "UPDATE brain_scheduled_wakes SET admitted_at = ? WHERE kind = 'scheduled' AND admitted_at IS NULL AND cancelled_at IS NULL AND due_at <= ?",
  );
  const selectSpecialistLaunch = database.prepare("SELECT * FROM brain_specialist_launches WHERE work_id = ?");
  const selectSpecialistLaunchByRunId = database.prepare(
    "SELECT * FROM brain_specialist_launches WHERE run_id = ?",
  );
  const selectPendingSpecialistLaunches = database.prepare(
    "SELECT * FROM brain_specialist_launches WHERE status = 'pending' ORDER BY requested_at, work_id",
  );
  const selectUnreturnedSpecialistLaunches = database.prepare(`
    SELECT launch.* FROM brain_specialist_launches AS launch
     LEFT JOIN brain_specialist_results AS result ON result.work_id = launch.work_id
     WHERE launch.status = 'accepted' AND result.work_id IS NULL
     ORDER BY launch.accepted_at, launch.work_id
  `);
  const insertSpecialistLaunch = database.prepare(`
    INSERT OR IGNORE INTO brain_specialist_launches
      (work_id, batch_id, source_surface_id, evidence_ids_json, specialist, input_json, requested_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  const acceptSpecialistLaunch = database.prepare(`
    UPDATE brain_specialist_launches SET status = 'accepted', run_id = ?, accepted_at = ?
     WHERE work_id = ? AND status = 'pending'
  `);
  const insertWorkMilestone = database.prepare(
    "INSERT OR IGNORE INTO brain_work_milestones (milestone_id, work_id, note, at) VALUES (?, ?, ?, ?)",
  );
  // rowid ordering is insertion (chronological) order — robust to same-millisecond `at` ties.
  const selectWorkMilestones = database.prepare("SELECT * FROM brain_work_milestones WHERE work_id = ? ORDER BY rowid");
  const selectLatestWorkMilestone = database.prepare(
    "SELECT * FROM brain_work_milestones WHERE work_id = ? ORDER BY rowid DESC LIMIT 1",
  );
  const insertSpecialistResult = database.prepare(`
    INSERT OR IGNORE INTO brain_specialist_results
      (result_id, work_id, run_id, source_batch_id, source_surface_id, evidence_ids_json,
       specialist, transport_status, result_json, admitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectSpecialistResult = database.prepare("SELECT * FROM brain_specialist_results WHERE result_id = ?");
  const selectSpecialistResultForWork = database.prepare(
    "SELECT * FROM brain_specialist_results WHERE work_id = ?",
  );
  const selectPendingSpecialistResults = database.prepare(`
    SELECT * FROM brain_specialist_results WHERE batch_id IS NULL ORDER BY admitted_at, rowid
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
  const selectBatchKnowledge = database.prepare(`
    SELECT * FROM brain_knowledge_deltas WHERE batch_id = ? ORDER BY admitted_at, rowid
  `);
  const selectBatchSpecialistResults = database.prepare(`
    SELECT * FROM brain_specialist_results WHERE batch_id = ? ORDER BY admitted_at, rowid
  `);
  const selectReadyInputIds = database.prepare(`
    SELECT input_id, kind FROM (
      SELECT input_id, 'speaker_intent' AS kind, admitted_at, rowid AS input_order
        FROM brain_inbox_inputs WHERE batch_id IS NULL
      UNION ALL
      SELECT delta_id AS input_id, 'knowledge_delta' AS kind, admitted_at, rowid AS input_order
        FROM brain_knowledge_deltas WHERE batch_id IS NULL
      UNION ALL
      SELECT result_id AS input_id, 'specialist_result' AS kind, admitted_at, rowid AS input_order
        FROM brain_specialist_results WHERE batch_id IS NULL
      UNION ALL
      SELECT event_id AS input_id, 'github_event' AS kind, admitted_at, rowid AS input_order
        FROM brain_github_events WHERE batch_id IS NULL
      UNION ALL
      SELECT wake_id AS input_id, 'scheduled_wake' AS kind, admitted_at, rowid AS input_order
        FROM brain_scheduled_wakes WHERE batch_id IS NULL AND admitted_at IS NOT NULL AND cancelled_at IS NULL
    ) ORDER BY admitted_at, kind, input_order LIMIT ?
  `);
  const insertBatch = database.prepare("INSERT INTO brain_batches (batch_id, created_at) VALUES (?, ?)");
  const claimInput = database.prepare("UPDATE brain_inbox_inputs SET batch_id = ? WHERE input_id = ? AND batch_id IS NULL");
  const claimKnowledge = database.prepare(
    "UPDATE brain_knowledge_deltas SET batch_id = ? WHERE delta_id = ? AND batch_id IS NULL",
  );
  const claimSpecialistResult = database.prepare(
    "UPDATE brain_specialist_results SET batch_id = ? WHERE result_id = ? AND batch_id IS NULL",
  );
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
  const selectPendingFilings = database.prepare(
    "SELECT * FROM brain_effects WHERE kind = 'file_issue' AND status = 'pending' ORDER BY created_at, effect_id",
  );
  const completeFiling = database.prepare(`
    UPDATE brain_effects SET status = 'completed', payload_json = ?, completed_at = ?
     WHERE effect_id = ? AND kind = 'file_issue' AND status = 'pending'
  `);
  const selectPendingMutations = database.prepare(
    "SELECT * FROM brain_effects WHERE kind = 'issue_mutation' AND status = 'pending' ORDER BY created_at, effect_id",
  );
  const completeMutation = database.prepare(`
    UPDATE brain_effects SET status = 'completed', payload_json = ?, completed_at = ?
     WHERE effect_id = ? AND kind = 'issue_mutation' AND status = 'pending'
  `);
  // Every completed Brain-authored comment mutation, so delete-comment can be restricted to the
  // Brain's own comments (provenance-checked against real recorded filing history, never "any comment").
  const selectCompletedMutations = database.prepare(
    "SELECT payload_json FROM brain_effects WHERE kind = 'issue_mutation' AND status = 'completed'",
  );
  const settle = database.prepare("UPDATE brain_batches SET settled_at = ? WHERE batch_id = ? AND settled_at IS NULL");
  const unsettledEffectCount = database.prepare(`
    SELECT count(*) AS count FROM brain_effects WHERE batch_id = ? AND status = 'pending'
  `);
  const effectCount = database.prepare("SELECT count(*) AS count FROM brain_effects WHERE batch_id = ?");
  const specialistLaunchCount = database.prepare(
    "SELECT count(*) AS count FROM brain_specialist_launches WHERE batch_id = ?",
  );
  const pendingSpecialistLaunchCount = database.prepare(
    "SELECT count(*) AS count FROM brain_specialist_launches WHERE batch_id = ? AND status = 'pending'",
  );
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
    if (row.kind === "file_issue") {
      const { outcome, ...request } = payload as unknown as FileIssueRequest & { outcome?: FileIssueOutcome };
      return {
        id: row.effect_id,
        batchId: row.batch_id,
        kind: "file_issue",
        request,
        status: row.status as "pending" | "completed",
        ...(outcome === undefined ? {} : { outcome }),
      };
    }
    if (row.kind === "schedule_wake") {
      return {
        id: row.effect_id,
        batchId: row.batch_id,
        kind: "schedule_wake",
        wakeId: payload.wakeId as string,
        reason: payload.reason as string,
        dueAt: payload.dueAt as string,
        status: "completed",
      };
    }
    if (row.kind === "issue_mutation") {
      const { outcome, ...mutation } = payload as unknown as IssueMutation & { outcome?: IssueMutationOutcome };
      return {
        id: row.effect_id,
        batchId: row.batch_id,
        kind: "issue_mutation",
        mutation: mutation as unknown as IssueMutation,
        status: row.status as "pending" | "completed",
        ...(outcome === undefined ? {} : { outcome }),
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
    knowledgeDeltas: (selectBatchKnowledge.all(row.batch_id) as unknown as KnowledgeDeltaRow[]).map(
      hydrateKnowledgeDelta,
    ),
    specialistResults: (
      selectBatchSpecialistResults.all(row.batch_id) as unknown as SpecialistResultRow[]
    ).map(hydrateSpecialistResult),
    githubEvents: (selectBatchGitHubEvents.all(row.batch_id) as unknown as GitHubEventRow[]).map(hydrateGitHubEvent),
    scheduledWakes: (selectBatchScheduledWakes.all(row.batch_id) as unknown as ScheduledWakeRow[]).map(
      hydrateScheduledWake,
    ),
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
    admitKnowledgeDelta: (draft) => {
      const scribeBatchId = required(draft.scribeBatchId, "Scribe Batch id");
      const attestationIds = canonicalIds(draft.attestationIds, "Knowledge Delta Attestation ids");
      const evidenceIds = canonicalIds(draft.evidenceIds, "Knowledge Delta Evidence ids");
      const projectionVersion = required(draft.projectionVersion, "Knowledge Delta Projection version");
      const value = { scribeBatchId, attestationIds, evidenceIds, projectionVersion };
      const id = knowledgeDeltaId(value);
      const admittedAt = options.now?.() ?? new Date().toISOString();
      insertKnowledgeDelta.run(
        id,
        scribeBatchId,
        JSON.stringify(attestationIds),
        JSON.stringify(evidenceIds),
        projectionVersion,
        admittedAt,
      );
      return hydrateKnowledgeDelta(selectKnowledgeDelta.get(id) as unknown as KnowledgeDeltaRow);
    },
    admitGitHubEvent: (draft) => {
      const githubAppId = required(draft.githubAppId, "GitHub event App id");
      const deliveryId = required(draft.deliveryId, "GitHub event delivery id");
      const id = githubEventId(githubAppId, deliveryId);
      insertGitHubEvent.run(
        id,
        githubAppId,
        deliveryId,
        required(draft.eventName, "GitHub event name"),
        required(draft.action, "GitHub event action"),
        required(draft.repository, "GitHub event repository"),
        required(draft.summary, "GitHub event summary"),
        JSON.stringify(draft.detail),
        options.now?.() ?? new Date().toISOString(),
      );
      return hydrateGitHubEvent(selectGitHubEvent.get(id) as unknown as GitHubEventRow);
    },
    pendingGitHubEvents: () =>
      (selectPendingGitHubEvents.all() as unknown as GitHubEventRow[]).map(hydrateGitHubEvent),
    githubEventsForBatch: (batchId) =>
      (selectBatchGitHubEvents.all(required(batchId, "Brain Batch id")) as unknown as GitHubEventRow[]).map(hydrateGitHubEvent),
    scheduleWake: ({ batchId: rawBatchId, reason: rawReason, dueAt: rawDueAt, predecessorId: rawPredecessorId }) => {
      const claimedBatchId = required(rawBatchId, "Brain Batch id");
      const batch = selectOpenBatchById.get(claimedBatchId) as BatchRow | undefined;
      if (batch === undefined || batch.dispatch_id === null) throw new Error(`Brain Batch ${claimedBatchId} is not open and dispatched.`);
      const reason = required(rawReason, "Scheduled Wake reason");
      const rawDue = required(rawDueAt, "Scheduled Wake due time");
      const parsed = Date.parse(rawDue);
      if (!Number.isFinite(parsed)) throw new Error("Scheduled Wake due time must be an ISO-8601 timestamp.");
      // Normalize to canonical UTC so raw-string comparison against `now` (always UTC 'Z') is correct for
      // any offset input — a +02:00 dueAt is the same instant as its UTC form and must sort as such.
      const dueAt = new Date(parsed).toISOString();
      const predecessorId = rawPredecessorId === undefined ? undefined : required(rawPredecessorId, "Predecessor wake id");
      const wakeId = scheduledWakeId(claimedBatchId, reason, dueAt);
      // ADR 0006: the wake row and its owning Brain Effect commit together — a self-scheduled wake is never
      // left unowned if the turn fails before settle. Both are content-addressed by the effect, so an exact
      // retry of this same scheduling Effect no-ops. A reschedule cancels the named predecessor in the same
      // transaction, so the old wake never fires alongside the replacement (CONTEXT.md:82).
      const payload = { wakeId, reason, dueAt, ...(predecessorId === undefined ? {} : { predecessorId }) };
      const effId = effectId(claimedBatchId, "schedule_wake", payload);
      const at = options.now?.() ?? new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        if (predecessorId !== undefined) {
          // Reschedule must actually cancel a real predecessor. 0 rows changed is fine ONLY when the
          // predecessor exists but was already cancelled (an idempotent retry of this same reschedule);
          // if no such wake exists at all, the id is wrong/stale — surface it, don't silently commit a
          // replacement while an unrelated wake stays live and fires alongside it.
          if (cancelScheduledWake.run(at, predecessorId).changes === 0 && selectScheduledWake.get(predecessorId) === undefined) {
            throw new Error(`Predecessor Scheduled Wake ${predecessorId} does not exist; cannot reschedule.`);
          }
        }
        insertScheduledWake.run(wakeId, "scheduled", reason, dueAt, at, null);
        insertEffect.run(effId, claimedBatchId, "schedule_wake", JSON.stringify(payload), "completed", at, at);
        database.exec("COMMIT");
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
      return hydrateScheduledWake(selectScheduledWake.get(wakeId) as unknown as ScheduledWakeRow);
    },
    runProactiveClock: () => {
      const now = options.now?.() ?? new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        let admittedSweep = false;
        if ((outstandingSweepCount.get() as { count: number }).count === 0) {
          insertScheduledWake.run(
            proactiveSweepId(now),
            "sweep",
            "Proactive Sweep: review the Belief Projection for open loops and overdue commitments to chase.",
            now,
            now,
            now,
          );
          admittedSweep = true;
        }
        const admittedWakes = admitDueScheduledWakes.run(now, now).changes as number;
        database.exec("COMMIT");
        return { admittedSweep, admittedWakes };
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    pendingScheduledWakes: () =>
      (selectPendingScheduledWakes.all() as unknown as ScheduledWakeRow[]).map(hydrateScheduledWake),
    intent: (id) => {
      const row = selectIntent.get(id) as unknown as IntentRow | undefined;
      return row === undefined ? undefined : hydrate(row);
    },
    pendingIntents: () => (selectPending.all() as unknown as IntentRow[]).map(hydrate),
    pendingKnowledgeDeltas: () =>
      (selectPendingKnowledge.all() as unknown as KnowledgeDeltaRow[]).map(hydrateKnowledgeDelta),
    knowledgeCaughtUp: (rawDeltaIds) => {
      const deltaIds = [...new Set(rawDeltaIds.map((id) => required(id, "Knowledge Delta id")))];
      if (deltaIds.length === 0) return true;
      const statement = database.prepare(`
        SELECT count(*) AS count FROM brain_knowledge_deltas AS delta
          JOIN brain_batches AS batch ON batch.batch_id = delta.batch_id
         WHERE delta.delta_id IN (${deltaIds.map(() => "?").join(",")}) AND batch.settled_at IS NOT NULL
      `);
      return (statement.get(...deltaIds) as { count: number }).count === deltaIds.length;
    },
    reserveSpecialistLaunch: ({ batchId: rawBatchId, sourceSurfaceId: rawSurfaceId, specialist: rawSpecialist, input, evidenceIds: rawEvidenceIds }) => {
      const requestedBatchId = required(rawBatchId, "Specialist launch Brain Batch id");
      const sourceSurfaceId = required(rawSurfaceId, "Specialist launch source Surface id");
      const specialist = required(rawSpecialist, "Specialist name");
      const batch = selectOpenBatchById.get(requestedBatchId) as BatchRow | undefined;
      if (batch === undefined || batch.dispatch_id === null) {
        throw new Error(`Brain Batch ${requestedBatchId} is not open and dispatched.`);
      }
      let evidenceIds: readonly string[];
      if (rawEvidenceIds !== undefined) {
        // Explicit provenance (a GitHub-event-triggered launch, #211): each cited id must be part of
        // THIS Batch — a GitHub event assigned to it, or evidence backing one of its Intents. Scoping to
        // the batch (not a global existence check) keeps provenance honest: a valid-but-unrelated old
        // event id from some other batch can never authorize this launch. The Intent-derived path below
        // is batch-scoped by construction (selectBatchIntents); this makes the explicit path match.
        evidenceIds = canonicalIds(rawEvidenceIds, "Specialist launch evidence ids");
        const batchEvidence = new Set<string>([
          ...(selectBatchGitHubEvents.all(requestedBatchId) as unknown as GitHubEventRow[]).map(hydrateGitHubEvent).map((event) => event.id),
          ...(selectBatchIntents.all(requestedBatchId) as unknown as IntentRow[]).map(hydrate).flatMap((intent) => [...intent.evidenceIds]),
        ]);
        for (const evidenceId of evidenceIds) {
          if (!batchEvidence.has(evidenceId)) {
            throw new Error(`Specialist launch evidence ${evidenceId} is not part of Brain Batch ${requestedBatchId}.`);
          }
        }
      } else {
        const sourceIntents = (selectBatchIntents.all(requestedBatchId) as unknown as IntentRow[])
          .map(hydrate)
          .filter((intent) => intent.sourceSurfaceId === sourceSurfaceId);
        if (sourceIntents.length === 0) {
          throw new Error(`Surface ${sourceSurfaceId} is not provenance for Brain Batch ${requestedBatchId}.`);
        }
        evidenceIds = canonicalIds(
          sourceIntents.flatMap((intent) => [...intent.evidenceIds]),
          "Specialist launch evidence ids",
        );
      }
      const canonicalInput = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
      const id = specialistWorkId(requestedBatchId, sourceSurfaceId, specialist, canonicalInput);
      insertSpecialistLaunch.run(
        id,
        requestedBatchId,
        sourceSurfaceId,
        JSON.stringify(evidenceIds),
        specialist,
        JSON.stringify(canonicalInput),
        options.now?.() ?? new Date().toISOString(),
      );
      return hydrateSpecialistLaunch(selectSpecialistLaunch.get(id) as unknown as SpecialistLaunchRow);
    },
    markSpecialistLaunchAccepted: (rawWorkId, rawRunId, acceptedAt) => {
      const workId = required(rawWorkId, "Specialist work id");
      const runId = required(rawRunId, "Specialist run id");
      const current = selectSpecialistLaunch.get(workId) as SpecialistLaunchRow | undefined;
      if (current === undefined) throw new Error(`Specialist work ${workId} does not exist.`);
      if (current.run_id !== null && current.run_id !== runId) {
        throw new Error(`Specialist work ${workId} is already bound to run ${current.run_id}.`);
      }
      acceptSpecialistLaunch.run(runId, acceptedAt ?? options.now?.() ?? new Date().toISOString(), workId);
      return hydrateSpecialistLaunch(selectSpecialistLaunch.get(workId) as unknown as SpecialistLaunchRow);
    },
    specialistLaunch: (workId) => {
      const row = selectSpecialistLaunch.get(workId) as SpecialistLaunchRow | undefined;
      return row === undefined ? undefined : hydrateSpecialistLaunch(row);
    },
    specialistLaunchByRunId: (runId) => {
      const row = selectSpecialistLaunchByRunId.get(runId) as SpecialistLaunchRow | undefined;
      return row === undefined ? undefined : hydrateSpecialistLaunch(row);
    },
    pendingSpecialistLaunches: () =>
      (selectPendingSpecialistLaunches.all() as unknown as SpecialistLaunchRow[]).map(hydrateSpecialistLaunch),
    acceptedSpecialistLaunchesWithoutResult: () =>
      (selectUnreturnedSpecialistLaunches.all() as unknown as SpecialistLaunchRow[]).map(hydrateSpecialistLaunch),
    admitSpecialistResult: (draft) => {
      const workId = required(draft.workId, "Specialist result work id");
      const runId = required(draft.runId, "Specialist result run id");
      const launch = selectSpecialistLaunch.get(workId) as SpecialistLaunchRow | undefined;
      if (launch === undefined || launch.status !== "accepted" || launch.run_id !== runId) {
        throw new Error(`Specialist result ${runId} does not match accepted work ${workId}.`);
      }
      const id = specialistResultId(workId, runId);
      insertSpecialistResult.run(
        id,
        workId,
        runId,
        launch.batch_id,
        launch.source_surface_id,
        launch.evidence_ids_json,
        launch.specialist,
        draft.status,
        draft.result === undefined ? null : JSON.stringify(draft.result),
        options.now?.() ?? new Date().toISOString(),
      );
      return hydrateSpecialistResult(selectSpecialistResult.get(id) as unknown as SpecialistResultRow);
    },
    specialistResultForWork: (workId) => {
      const row = selectSpecialistResultForWork.get(workId) as SpecialistResultRow | undefined;
      return row === undefined ? undefined : hydrateSpecialistResult(row);
    },
    pendingSpecialistResults: () =>
      (selectPendingSpecialistResults.all() as unknown as SpecialistResultRow[]).map(hydrateSpecialistResult),
    recordWorkMilestone: ({ workId: rawWorkId, note: rawNote, at }) => {
      const workId = required(rawWorkId, "Work milestone work id");
      const note = required(rawNote, "Work milestone note");
      const stamp = at ?? options.now?.() ?? new Date().toISOString();
      insertWorkMilestone.run(workMilestoneId(workId, note), workId, note, stamp);
    },
    workMilestones: (workId) =>
      (selectWorkMilestones.all(workId) as unknown as WorkMilestoneRow[]).map(hydrateMilestone),
    latestWorkMilestone: (workId) => {
      const row = selectLatestWorkMilestone.get(workId) as WorkMilestoneRow | undefined;
      return row === undefined ? undefined : hydrateMilestone(row);
    },
    activeWorkItems: () =>
      (selectUnreturnedSpecialistLaunches.all() as unknown as SpecialistLaunchRow[]).map((row) => {
        const latest = selectLatestWorkMilestone.get(row.work_id) as WorkMilestoneRow | undefined;
        return {
          workId: row.work_id,
          specialist: row.specialist,
          sourceSurfaceId: row.source_surface_id,
          startedAt: row.accepted_at ?? row.requested_at,
          ...(latest === undefined ? {} : { latestMilestone: hydrateMilestone(latest) }),
        };
      }),
    claimBatch: (limit = 50) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const open = selectOpenBatch.get() as BatchRow | undefined;
        if (open !== undefined) {
          database.exec("COMMIT");
          return hydrateBatch(open);
        }
        const ready = selectReadyInputIds.all(Math.max(1, Math.min(Math.trunc(limit), 100))) as unknown as Array<{
          input_id: string;
          kind: "speaker_intent" | "knowledge_delta" | "specialist_result" | "github_event" | "scheduled_wake";
        }>;
        if (ready.length === 0) {
          database.exec("COMMIT");
          return undefined;
        }
        const id = batchId(ready.map(({ input_id, kind }) => `${kind}:${input_id}`));
        const createdAt = options.now?.() ?? new Date().toISOString();
        insertBatch.run(id, createdAt);
        for (const { input_id, kind } of ready) {
          const result = kind === "speaker_intent"
            ? claimInput.run(id, input_id)
            : kind === "knowledge_delta"
              ? claimKnowledge.run(id, input_id)
              : kind === "specialist_result"
                ? claimSpecialistResult.run(id, input_id)
                : kind === "github_event"
                  ? claimGitHubEvent.run(id, input_id)
                  : claimScheduledWake.run(id, input_id);
          if (result.changes !== 1) throw new Error(`Brain input ${input_id} lost its Batch assignment.`);
        }
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
        // Evidence is real if it is a Conversation event OR an admitted GitHub up-inbox event (§4):
        // a Directive about a pure GitHub-origin Batch cites the event's own id, which has no
        // conversation_events row. The check stays strict — it must resolve in one of the two.
        if (evidence.get(evidenceId) === undefined && selectGitHubEvent.get(evidenceId) === undefined) {
          throw new Error(`Directive evidence ${evidenceId} does not exist.`);
        }
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
    recordIssueFiling: ({
      batchId: rawBatchId,
      sourceSurfaceId: rawSurfaceId,
      repository: rawRepository,
      kind,
      title: rawTitle,
      body: rawBody,
    }) => {
      const claimedBatchId = required(rawBatchId, "Brain Batch id");
      const sourceSurfaceId = required(rawSurfaceId, "File Issue source Surface id");
      const batch = selectOpenBatchById.get(claimedBatchId) as BatchRow | undefined;
      if (batch === undefined || batch.dispatch_id === null) throw new Error(`Brain Batch ${claimedBatchId} is not open and dispatched.`);
      const sourceIntents = (selectBatchIntents.all(claimedBatchId) as unknown as IntentRow[])
        .map(hydrate)
        .filter((intent) => intent.sourceSurfaceId === sourceSurfaceId);
      if (sourceIntents.length === 0) {
        throw new Error(`Surface ${sourceSurfaceId} is not provenance for Brain Batch ${claimedBatchId}.`);
      }
      const request: FileIssueRequest = {
        repository: required(rawRepository, "File Issue repository"),
        kind,
        title: required(rawTitle, "File Issue title"),
        body: required(rawBody, "File Issue body"),
      };
      const id = effectId(claimedBatchId, "file_issue", request);
      const createdAt = options.now?.() ?? new Date().toISOString();
      insertEffect.run(id, claimedBatchId, "file_issue", JSON.stringify(request), "pending", null, createdAt);
      return hydrateEffect(selectEffect.get(id) as unknown as EffectRow) as FileIssueEffect;
    },
    completeIssueFiling: (rawId, outcome) => {
      const id = required(rawId, "File Issue effect id");
      const existing = selectEffect.get(id) as EffectRow | undefined;
      if (existing === undefined || existing.kind !== "file_issue") {
        throw new Error(`File Issue effect ${id} does not exist.`);
      }
      const request = JSON.parse(existing.payload_json) as FileIssueRequest;
      // WHERE status='pending' makes a recovered re-completion a no-op; the durable outcome stands.
      completeFiling.run(
        JSON.stringify({ ...request, outcome }),
        options.now?.() ?? new Date().toISOString(),
        id,
      );
      return hydrateEffect(selectEffect.get(id) as unknown as EffectRow) as FileIssueEffect;
    },
    pendingIssueFilings: () =>
      (selectPendingFilings.all() as unknown as EffectRow[]).map(hydrateEffect) as FileIssueEffect[],
    recordIssueMutation: ({ batchId: rawBatchId, sourceSurfaceId: rawSurfaceId, mutation }) => {
      const claimedBatchId = required(rawBatchId, "Brain Batch id");
      const sourceSurfaceId = required(rawSurfaceId, "Issue Mutation source Surface id");
      const batch = selectOpenBatchById.get(claimedBatchId) as BatchRow | undefined;
      if (batch === undefined || batch.dispatch_id === null) {
        throw new Error(`Brain Batch ${claimedBatchId} is not open and dispatched.`);
      }
      const sourceIntents = (selectBatchIntents.all(claimedBatchId) as unknown as IntentRow[])
        .map(hydrate)
        .filter((intent) => intent.sourceSurfaceId === sourceSurfaceId);
      if (sourceIntents.length === 0) {
        throw new Error(`Surface ${sourceSurfaceId} is not provenance for Brain Batch ${claimedBatchId}.`);
      }
      const repository = required(mutation.repository, "Issue Mutation repository");
      if (mutation.number <= 0) throw new Error("Issue Mutation issue number must be positive.");
      // Delete and edit are RESTRICTED to the Brain's own comments: the target must be one the Brain
      // durably recorded creating, in the same repository and issue. A human's comment (or any comment
      // the Brain never authored) is refused here at admission, so a hallucinated commentId can never
      // durably record a destructive or falsifying effect (GitHub forbids editing others' comments too;
      // this is the authoritative check, not a reliance on provider permissions).
      if (mutation.kind === "delete-comment" || mutation.kind === "update-comment") {
        const authored = (selectCompletedMutations.all() as unknown as { payload_json: string }[]).some((row) => {
          const payload = JSON.parse(row.payload_json) as IssueMutation & { outcome?: IssueMutationOutcome };
          // A recorded commentId is proof the Brain's create landed (it is only ever set when GitHub
          // actually created the comment) — so it authorizes even from an `uncertain`-with-detail
          // outcome (GitHub made the comment but its Operation completion could not be persisted).
          return (
            payload.kind === "create-comment" &&
            payload.repository.toLowerCase() === repository.toLowerCase() &&
            payload.number === mutation.number &&
            payload.outcome !== undefined &&
            payload.outcome.commentId === mutation.commentId
          );
        });
        if (!authored) {
          const verb = mutation.kind === "delete-comment" ? "delete" : "edit";
          throw new Error(
            `Refusing to ${verb} comment ${mutation.commentId} on ${repository}#${mutation.number}: the Brain has ` +
              `no recorded history of creating it. ${verb === "delete" ? "Delete" : "Edit"} is restricted to the ` +
              "Brain's own prior comments.",
          );
        }
      }
      const canonicalMutation = { ...mutation, repository } as IssueMutation;
      const id = effectId(claimedBatchId, "issue_mutation", canonicalMutation);
      const createdAt = options.now?.() ?? new Date().toISOString();
      insertEffect.run(id, claimedBatchId, "issue_mutation", JSON.stringify(canonicalMutation), "pending", null, createdAt);
      return hydrateEffect(selectEffect.get(id) as unknown as EffectRow) as IssueMutationEffect;
    },
    completeIssueMutation: (rawId, outcome) => {
      const id = required(rawId, "Issue Mutation effect id");
      const existing = selectEffect.get(id) as EffectRow | undefined;
      if (existing === undefined || existing.kind !== "issue_mutation") {
        throw new Error(`Issue Mutation effect ${id} does not exist.`);
      }
      const mutation = JSON.parse(existing.payload_json) as IssueMutation;
      // WHERE status='pending' makes a recovered re-completion a no-op; the durable outcome stands.
      completeMutation.run(JSON.stringify({ ...mutation, outcome }), options.now?.() ?? new Date().toISOString(), id);
      return hydrateEffect(selectEffect.get(id) as unknown as EffectRow) as IssueMutationEffect;
    },
    pendingIssueMutations: () =>
      (selectPendingMutations.all() as unknown as EffectRow[]).map(hydrateEffect) as IssueMutationEffect[],
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
        const total = (effectCount.get(id) as { count: number }).count
          + (specialistLaunchCount.get(id) as { count: number }).count;
        const pending = (unsettledEffectCount.get(id) as { count: number }).count;
        const pendingWork = (pendingSpecialistLaunchCount.get(id) as { count: number }).count;
        if (total === 0 || pending + pendingWork > 0) {
          throw new Error(`Brain Batch ${id} has effects that are not durably accepted.`);
        }
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
