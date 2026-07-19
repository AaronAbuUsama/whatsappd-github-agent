import { x as FlueEventContext } from "./types-USSZhfC6.mjs";

//#region src/execution-interceptor.d.ts
type FlueExecutionOperation = {
  type: 'workflow';
  runId: string;
  workflowName: string;
  phase: 'start' | 'resume';
  startedAt: string;
} | {
  type: 'agent';
  operationId: string;
  operationKind: 'prompt' | 'skill' | 'task';
} | {
  type: 'model';
  turnId: string;
} | {
  type: 'tool';
  toolCallId: string;
  toolName: string;
} | {
  type: 'task';
  taskId: string;
};
interface FlueTraceCarrier {
  traceparent: string;
  tracestate?: string;
}
interface FlueExecutionContext {
  eventContext?: FlueEventContext;
  runId?: string;
  instanceId?: string;
  submissionId?: string;
  dispatchId?: string;
  agentName?: string;
  conversationId?: string;
  harness?: string;
  session?: string;
  operationId?: string;
  turnId?: string;
  taskId?: string;
  traceCarrier?: FlueTraceCarrier;
}
type FlueExecutionInterceptor = <T>(operation: FlueExecutionOperation, ctx: FlueExecutionContext, next: () => Promise<T>) => Promise<T>;
//#endregion
//#region src/runtime/run-store.d.ts
type RunStatus = 'active' | 'completed' | 'errored';
interface RunRecord {
  runId: string;
  workflowName: string;
  status: RunStatus;
  startedAt: string;
  input?: unknown;
  traceCarrier?: FlueTraceCarrier;
  endedAt?: string;
  isError?: boolean;
  durationMs?: number;
  result?: unknown;
  error?: unknown;
}
/**
 * Listing/lookup projection of a {@link RunRecord}: every field except the
 * potentially large `input`, `result`, and `error` values. Single-database
 * adapters back pointers with a column-subset select over the run records.
 */
interface WorkflowRunPointer {
  runId: string;
  workflowName: string;
}
interface RunPointer extends WorkflowRunPointer {
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  isError?: boolean;
}
interface CreateRunInput {
  runId: string;
  workflowName: string;
  startedAt: string;
  input: unknown;
  traceCarrier?: FlueTraceCarrier;
}
interface EndRunInput {
  runId: string;
  endedAt: string;
  isError: boolean;
  durationMs: number;
  result?: unknown;
  error?: unknown;
}
interface ListRunsOpts {
  status?: RunStatus;
  workflowName?: string;
  limit?: number;
  cursor?: string;
}
interface ListRunsResponse {
  runs: RunPointer[];
  nextCursor?: string;
}
declare const DEFAULT_LIST_LIMIT = 100;
declare const MAX_LIST_LIMIT = 1000;
interface CursorTuple {
  startedAt: string;
  runId: string;
}
declare function encodeRunCursor(pointer: {
  startedAt: string;
  runId: string;
}): string;
declare function decodeRunCursor(cursor: string | undefined): CursorTuple | undefined;
/**
 * Workflow-run persistence: one record per run, plus pointer lookup and
 * cursor-paginated listing over the same records.
 */
interface RunStore {
  /**
   * Persist a new `active` run record.
   *
   * Idempotent, first-writer-wins: when a record with the same `runId`
   * already exists, the call is a no-op and the existing record — including
   * any terminal status, result, or error — is preserved. SQL backends
   * implement this with `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`.
   */
  createRun(input: CreateRunInput): Promise<void>;
  /**
   * Finalize a run record with its terminal status. A no-op when no record
   * exists for `runId`.
   */
  endRun(input: EndRunInput): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  /** Minimal ownership pointer for authorizing a run route. */
  lookupRun(runId: string): Promise<WorkflowRunPointer | null>;
  /**
   * List run pointers newest-first (`startedAt` descending, then `runId`
   * descending), filtered by `status`/`workflowName` and paginated via the
   * opaque cursor returned in {@link ListRunsResponse.nextCursor}.
   */
  listRuns(opts?: ListRunsOpts): Promise<ListRunsResponse>;
}
//#endregion
export { FlueTraceCarrier as _, ListRunsResponse as a, RunRecord as c, WorkflowRunPointer as d, decodeRunCursor as f, FlueExecutionOperation as g, FlueExecutionInterceptor as h, ListRunsOpts as i, RunStatus as l, FlueExecutionContext as m, DEFAULT_LIST_LIMIT as n, MAX_LIST_LIMIT as o, encodeRunCursor as p, EndRunInput as r, RunPointer as s, CreateRunInput as t, RunStore as u };