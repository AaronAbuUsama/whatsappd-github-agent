import { n as ToolDefinition } from "./tool-types-CcKIl663.mjs";
import { A as FlueSessions, C as FlueEventInputCallback, O as FlueObservationDetail, S as FlueEventInput, T as FlueHarness, Z as PromptResponse, at as ShellResult, b as FlueEventCallback, c as AttachedAgentEvent, f as CallHandle, h as DispatchReceipt, it as ShellOptions, k as FlueSession, m as DirectAgentPayload, mt as ActionDefinition, n as AgentDefinition, nt as SessionToolFactory, t as AgentConfig, tt as SessionEnv, w as FlueFs, x as FlueEventContext, y as FlueEvent } from "./types-USSZhfC6.mjs";
import { _ as ConversationRecord, d as AssistantMessageStartedRecord, f as AttachmentRef, g as ConversationCreatedRecord, h as CompactionRecord, m as CanonicalToolResultContent, p as CanonicalChildSessionRef, t as AttachmentStore, v as SubmissionSettledRecord } from "./attachment-store-Cf3tPUa0.mjs";
import { t as SqlStorage } from "./sql-storage-DNzKo_Mr.mjs";
import { _ as FlueTraceCarrier, m as FlueExecutionContext, u as RunStore } from "./run-store-tKpCS1yQ.mjs";
import { i as EventStreamStore } from "./event-stream-store-CSiWecIp.mjs";
import { AgentMessage } from "@earendil-works/pi-agent-core";

//#region src/conversation-reducer.d.ts
interface ReducedEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
  submissionId?: string;
}
interface ReducedMessageEntry extends ReducedEntryBase {
  type: 'message';
  message: AgentMessage;
  attachmentRefs?: Map<string, AttachmentRef>;
  /**
   * Validated structured tool output for tool-result entries, distinct from the
   * model-facing `message` content. Present only when the tool declared one.
   */
  toolOutput?: {
    value: unknown;
  };
}
interface ReducedCompactionEntry extends ReducedEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  sourceLeafId: string;
  tokensBefore: number;
  details?: {
    readFiles: string[];
    modifiedFiles: string[];
  };
  usage?: CompactionRecord['usage'];
}
type ReducedEntry = ReducedMessageEntry | ReducedCompactionEntry;
interface ReducedAssistantBlockBase {
  blockId: string;
  blockIndex: number;
}
interface ReducedAssistantTextBlock extends ReducedAssistantBlockBase {
  type: 'text';
  deltas: string[];
  completed: boolean;
  textSignature?: string;
}
interface ReducedAssistantReasoningBlock extends ReducedAssistantBlockBase {
  type: 'reasoning';
  deltas: string[];
  completed: boolean;
  encrypted?: string;
  redacted?: boolean;
}
interface ReducedAssistantToolCallBlock extends ReducedAssistantBlockBase {
  type: 'tool_call';
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}
type ReducedAssistantBlock = ReducedAssistantTextBlock | ReducedAssistantReasoningBlock | ReducedAssistantToolCallBlock;
interface InProgressAssistantMessage {
  messageId: string;
  parentId: string | null;
  timestamp: string;
  submissionId?: string;
  modelInfo: AssistantMessageStartedRecord['modelInfo'];
  blocks: Map<string, ReducedAssistantBlock>;
  blockIndexes: Set<number>;
}
interface ReducedToolOutcome {
  recordId: string;
  assistantMessageId: string;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  content: CanonicalToolResultContent[];
}
interface ReducedConversationStateBase {
  conversationId: string;
  affinityKey: string;
  createdAt: string;
  harness: string;
  session: string;
  entries: Map<string, ReducedEntry>;
  activeLeafId: string | null;
  inProgressMessages: Map<string, InProgressAssistantMessage>;
  toolOutcomes: Map<string, ReducedToolOutcome>;
  childConversations: Map<string, CanonicalChildSessionRef>;
}
type ReducedConversationState = ReducedConversationStateBase & ({
  kind: 'root';
  parentConversationId?: never;
  taskId?: never;
  actionInvocationId?: never;
  agent?: never;
} | {
  kind: 'task';
  parentConversationId: string;
  taskId: string;
  actionInvocationId?: never;
  agent?: string;
} | {
  kind: 'action';
  parentConversationId: string;
  actionInvocationId: string;
  taskId?: never;
  agent?: never;
});
interface ReducedInstanceState {
  recordsThroughOffset: string;
  conversations: Map<string, ReducedConversationState>;
  conversationScopes: Map<string, string>;
  recordsById: Map<string, ConversationRecord>;
}
//#endregion
//#region src/runtime/conversation-stream-store.d.ts
interface ConversationStreamIdentity {
  agentName: string;
  instanceId: string;
}
interface ConversationProducerClaim {
  producerId: string;
  producerEpoch: number;
  incarnation: string;
  nextProducerSequence: number;
  offset: string;
}
interface ConversationStreamBatch {
  offset: string;
  records: ConversationRecord[];
}
interface ConversationStreamReadResult {
  batches: ConversationStreamBatch[];
  nextOffset: string;
  upToDate: boolean;
}
interface ConversationStreamMeta {
  identity: ConversationStreamIdentity;
  incarnation: string;
  nextOffset: string;
  producerId: string | null;
  producerEpoch: number;
  nextProducerSequence: number;
}
interface ConversationStreamStore {
  createStream(path: string, identity: ConversationStreamIdentity): Promise<void>;
  acquireProducer(path: string, producerId: string): Promise<ConversationProducerClaim>;
  /**
   * Appends one batch of canonical records and returns its single offset.
   *
   * **Atomicity is a hard contract requirement.** Every record in
   * `input.records` must be persisted together under one offset, all-or-nothing:
   * a crash or error must never leave a subset of the batch durable. The runtime
   * relies on this for multi-record batches whose partial application would
   * corrupt the conversation graph — most notably `ensureChildConversation()`,
   * which appends the child `conversation_created` and the parent
   * `child_session_retained` in one batch (a partial write would orphan the
   * child). First-party adapters satisfy this by serializing the whole batch
   * into a single row/document write inside one transaction; a custom adapter
   * that splits records across non-atomic writes violates the contract.
   */
  append(input: {
    path: string;
    producerId: string;
    producerEpoch: number;
    incarnation: string;
    producerSequence: number;
    submission?: {
      submissionId: string;
      attemptId: string;
    };
    records: readonly ConversationRecord[];
  }): Promise<{
    offset: string;
  }>;
  read(path: string, options?: {
    offset?: string;
    limit?: number;
  }): Promise<ConversationStreamReadResult>;
  getMeta(path: string): Promise<ConversationStreamMeta | null>;
  delete(path: string): Promise<void>;
  subscribe(path: string, listener: () => void): () => void;
}
/**
 * Shared in-memory listener registry for conversation-stream `subscribe` /
 * `notify`. Every conversation store keeps a process-local fan-out of change
 * listeners keyed by stream path; this class encapsulates the registration,
 * unsubscribe-and-prune, and error-swallowing notify behavior so the stores do
 * not each re-implement the same `Map<string, Set<() => void>>`.
 */
declare class StreamListenerRegistry {
  private listeners;
  subscribe(path: string, listener: () => void): () => void;
  notify(path: string): void;
}
declare class InMemoryConversationStreamStore implements ConversationStreamStore {
  private streams;
  private listeners;
  createStream(path: string, identity: ConversationStreamIdentity): Promise<void>;
  acquireProducer(path: string, producerId: string): Promise<ConversationProducerClaim>;
  append(input: {
    path: string;
    producerId: string;
    producerEpoch: number;
    incarnation: string;
    producerSequence: number;
    submission?: {
      submissionId: string;
      attemptId: string;
    };
    records: readonly ConversationRecord[];
  }): Promise<{
    offset: string;
  }>;
  read(path: string, options?: {
    offset?: string;
    limit?: number;
  }): Promise<ConversationStreamReadResult>;
  getMeta(path: string): Promise<ConversationStreamMeta | null>;
  delete(path: string): Promise<void>;
  subscribe(path: string, listener: () => void): () => void;
  private assertSubmissionOwnership;
  private fail;
}
declare class SqliteConversationStreamStore implements ConversationStreamStore {
  private sql;
  private runTransaction;
  private listeners;
  constructor(sql: SqlStorage, runTransaction: <T>(closure: () => T) => T);
  createStream(path: string, identity: ConversationStreamIdentity): Promise<void>;
  acquireProducer(path: string, producerId: string): Promise<ConversationProducerClaim>;
  append(input: {
    path: string;
    producerId: string;
    producerEpoch: number;
    incarnation: string;
    producerSequence: number;
    submission?: {
      submissionId: string;
      attemptId: string;
    };
    records: readonly ConversationRecord[];
  }): Promise<{
    offset: string;
  }>;
  read(path: string, options?: {
    offset?: string;
    limit?: number;
  }): Promise<ConversationStreamReadResult>;
  getMeta(path: string): Promise<ConversationStreamMeta | null>;
  delete(path: string): Promise<void>;
  subscribe(path: string, listener: () => void): () => void;
  private assertSubmissionAuthorization;
  private fail;
}
//#endregion
//#region src/conversation-writer.d.ts
interface ConversationRecordScope {
  conversationId: string;
  harness: string;
  session: string;
}
interface ConversationAppendOptions {
  submission?: {
    submissionId: string;
    attemptId: string;
  };
}
type ConversationCreationInput = ConversationCreatedRecord extends infer Record ? Record extends ConversationCreatedRecord ? Omit<Record, 'v' | 'id' | 'type' | 'timestamp'> : never : never;
declare class ConversationRecordWriter {
  private readonly store;
  readonly path: string;
  private claim;
  private readonly onFailed?;
  private lifecycle;
  private tail;
  private nextProducerSequence;
  private reducedState;
  private pendingRecords;
  private pendingOptions;
  private pendingTimer;
  private pendingFlush;
  private flushing;
  private resolvePending;
  private rejectPending;
  private constructor();
  static create(options: {
    store: ConversationStreamStore;
    path: string;
    identity: ConversationStreamIdentity;
    producerId: string;
    onFailed?: (writer: ConversationRecordWriter) => void;
  }): Promise<ConversationRecordWriter>;
  loadReducedState(): Promise<ReducedInstanceState>;
  getConversationLeaf(conversationId: string): Promise<string | null>;
  hasConversationEntry(conversationId: string, entryId: string): Promise<boolean>;
  hasRecord(recordId: string): Promise<boolean>;
  getRecord(recordId: string): Promise<ConversationRecord | undefined>;
  getConversation(conversationId: string): Promise<ReducedConversationState | undefined>;
  findInProgressAssistant(conversationId: string, submissionId: string | undefined): Promise<InProgressAssistantMessage | undefined>;
  findConversation(harness: string, session: string): Promise<ReducedConversationState | undefined>;
  get offset(): string;
  get failed(): boolean;
  append(records: readonly ConversationRecord[], options?: ConversationAppendOptions): Promise<{
    offset: string;
  }>;
  enqueue(records: readonly ConversationRecord[], options?: ConversationAppendOptions): Promise<{
    offset: string;
  }>;
  flush(): Promise<{
    offset: string;
  }>;
  private appendBatch;
  private assertActive;
  private fail;
  ensureChildConversation(input: {
    parent: ConversationRecordScope;
    child: Exclude<ConversationCreationInput, {
      kind: 'root';
    }>;
    ref: CanonicalChildSessionRef;
  }): Promise<{
    offset: string;
  }>;
  ensureConversation(input: ConversationCreationInput & {
    timestamp?: string;
  }): Promise<{
    offset: string;
  }>;
}
//#endregion
//#region src/harness.d.ts
declare class Harness implements FlueHarness {
  private instanceId;
  readonly name: string;
  private config;
  private env;
  private eventCallback;
  private agentTools;
  private toolFactory;
  private conversationWriter;
  private attachmentStore;
  private actions;
  private executionContext;
  private scopeName?;
  private scopeDepth;
  private retainSession?;
  readonly sessions: FlueSessions;
  readonly fs: FlueFs;
  private openSessions;
  private pendingSessionOperations;
  private activeShellCalls;
  private scopeAbortController;
  private closePromise;
  constructor(instanceId: string, name: string, config: AgentConfig, env: SessionEnv, eventCallback: FlueEventInputCallback | undefined, agentTools: ToolDefinition[], toolFactory: SessionToolFactory | undefined, conversationWriter: ConversationRecordWriter, attachmentStore: AttachmentStore, actions?: ActionDefinition[], executionContext?: FlueExecutionContext, scopeName?: string | undefined, scopeDepth?: number, retainSession?: ((session: string, conversation: {
    conversationId: string;
    affinityKey: string;
    createdAt: string;
  }, harness: string) => Promise<void>) | undefined, scopeSignal?: AbortSignal);
  session(name?: string): Promise<FlueSession>;
  shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;
  private openSession;
  private runSessionOperation;
  private loadSession;
  private createTaskSession;
  /** Mint a fresh child conversation identity and durably record its creation
   *  plus the parent's retained link. Returns the new child conversation id. */
  private createChildConversation;
  private createActionHarness;
  close(): Promise<void>;
  private emit;
  private decorateEventCallback;
}
//#endregion
//#region src/client.d.ts
interface FlueContextConfig {
  id: string;
  agentName?: string;
  runId?: string;
  dispatchId?: string;
  env: Record<string, any>;
  /**
   * Host-provided agent-config seeds (`resolveModel` and runtime-wide defaults).
   * `systemPrompt`, `skills`, and `model` are
   * runtime-owned — discovered from the session cwd and resolved from the
   * agent definition during harness initialization — so they are not inputs.
   */
  agentConfig: Omit<AgentConfig, 'systemPrompt' | 'skills' | 'model'>;
  createDefaultEnv: () => Promise<SessionEnv>;
  /**
   * The current HTTP request, if any. Surfaced to handlers as `ctx.req`.
   * Build plugins pass the standard Fetch `Request` through; non-HTTP entry
   * points (e.g. future cron triggers) leave it undefined.
   */
  req?: Request;
  initialEventIndex?: number;
  conversationWriter?: ConversationRecordWriter;
  attachmentStore?: AttachmentStore;
}
/** Extends FlueEventContext with server-only methods. */
interface FlueContextInternal extends FlueEventContext {
  readonly runId: string | undefined;
  initializeRootHarness(agent: AgentDefinition): Promise<Harness>;
  createEvent(event: FlueEventInput): FlueEvent;
  publishEvent(event: FlueEvent): void;
  emitEvent(event: FlueEventInput, observation?: FlueObservationDetail): FlueEvent;
  subscribeEvent(callback: FlueEventCallback): () => void;
  flushEventCallbacks(): Promise<void>;
  setEventCallback(callback: FlueEventCallback | undefined): void;
  setSubmissionId(submissionId: string | undefined): void;
  setConversationWriter?(writer: ConversationRecordWriter | undefined): void;
  setAttachmentStore?(store: AttachmentStore | undefined): void;
}
declare function createFlueContext(config: FlueContextConfig): FlueContextInternal;
declare function initializeRootHarness(agent: AgentDefinition, config: FlueContextConfig, emitEvent: (event: FlueEventInput, observation?: FlueObservationDetail) => void): Promise<Harness>;
//#endregion
//#region src/runtime/dispatch-queue.d.ts
interface DispatchInput {
  dispatchId: string;
  agent: string;
  id: string;
  input: unknown;
  acceptedAt: string;
}
interface DispatchQueue {
  enqueue(input: DispatchInput): Promise<DispatchReceipt>;
}
//#endregion
//#region src/runtime/agent-submissions.d.ts
interface DispatchAgentSubmissionInput extends DispatchInput {
  readonly kind: 'dispatch';
  readonly submissionId: string;
  readonly traceCarrier?: FlueTraceCarrier;
}
interface DirectAgentSubmissionInput {
  readonly kind: 'direct';
  readonly submissionId: string;
  readonly agent: string;
  readonly id: string;
  readonly payload: DirectAgentPayload;
  readonly acceptedAt: string;
  readonly traceCarrier?: FlueTraceCarrier;
}
type AgentSubmissionInput = DispatchAgentSubmissionInput | DirectAgentSubmissionInput;
interface AgentSubmissionInterruption {
  readonly submissionId: string;
  readonly kind: AgentSubmissionInput['kind'];
  readonly reason: 'interrupted_before_input_marker' | 'interrupted_after_input_application' | 'exhausted_retry_budget' | 'exceeded_timeout' | 'aborted';
  readonly message: string;
  /** Tool calls that were requested but whose outcomes could not be confirmed. */
  readonly interruptedTools?: ReadonlyArray<{
    readonly name: string;
    readonly id: string;
  }>;
}
type AgentSubmissionInspection = 'absent' | 'completed' | 'continuable' | 'uncertain';
interface ProcessAgentSubmissionOptions {
  submissionAttempt?: SubmissionAttemptRef;
  onInputApplied?: (durability: SubmissionDurability) => Promise<void> | void;
  /** Claim timestamp used as the base for a newly resolved timeout. */
  startedAt?: number;
  /** Absolute timestamp (ms) after which the submission should be aborted. */
  timeoutAt?: number;
}
/**
 * Internal durable-submission executor surface that the submission
 * coordinators drive. `Session` declares conformance so signature drift is
 * caught at compile time.
 */
interface AgentSubmissionSession {
  readonly conversationId: string;
  inspectSubmissionInput(input: AgentSubmissionInput): Promise<AgentSubmissionInspection> | AgentSubmissionInspection;
  reconstructSubmissionResult(input: AgentSubmissionInput): Promise<PromptResponse | undefined> | PromptResponse | undefined;
  processSubmissionInput(input: AgentSubmissionInput, options?: ProcessAgentSubmissionOptions): CallHandle<unknown>;
  recoverInterruptedStream(attempt: SubmissionAttemptRef, turnId?: string): Promise<boolean>;
  recordSubmissionTerminal(input: AgentSubmissionInterruption): Promise<void>;
}
interface AttachedAgentSubmissionReceipt {
  readonly submissionId: string;
  readonly offset?: string;
  readonly result?: unknown;
}
type AttachedAgentSubmissionAdmission = (payload: DirectAgentPayload, onEvent?: (event: AttachedAgentEvent) => Promise<void> | void, waitForResult?: boolean, traceCarrier?: FlueTraceCarrier) => Promise<AttachedAgentSubmissionReceipt>;
declare function createDispatchAgentSubmissionInput(input: DispatchInput): DispatchAgentSubmissionInput;
declare function createAgentSubmissionSessionHandler(agent: AgentDefinition, input: AgentSubmissionInput, execute: (session: AgentSubmissionSession) => Promise<unknown> | unknown): (ctx: FlueContextInternal) => Promise<unknown>;
//#endregion
//#region src/agent-execution-store.d.ts
/** Default maximum total attempts before terminalization. */
declare const DURABILITY_DEFAULT_MAX_ATTEMPTS = 10;
/** Default submission timeout in milliseconds (one hour). */
declare const DURABILITY_DEFAULT_TIMEOUT_MS = 3600000;
/** Default lease duration for submission ownership in milliseconds (30 seconds). */
declare const LEASE_DURATION_MS = 30000;
type AgentSubmissionStatus = 'queued' | 'running' | 'terminalizing' | 'settled';
interface AgentSubmission {
  readonly sequence: number;
  readonly submissionId: string;
  readonly sessionKey: string;
  readonly kind: 'dispatch' | 'direct';
  readonly input: AgentSubmissionInput;
  readonly status: AgentSubmissionStatus;
  readonly acceptedAt: number;
  readonly canonicalReadyAt: number | null;
  readonly attemptId?: string;
  readonly inputAppliedAt?: number;
  readonly recoveryRequestedAt?: number;
  /**
   * When set, abort was requested for this submission. This is a durable
   * abort+recovery *signal*, NOT a terminal classification: the aborted
   * outcome is read only from the settlement (a `submission_aborted` advisory,
   * plus a direct `submission_settled` record with `outcome: 'aborted'`). A
   * submission that completes or fails while this is set still settles
   * completed/failed — the flag merely tells the owning attempt to stop and
   * tells recovery to settle aborted rather than retry. May be present while
   * `queued` (an abort arrived before the submission was ever claimed).
   */
  readonly abortRequestedAt?: number;
  readonly startedAt?: number;
  readonly error?: string;
  readonly attemptCount: number;
  readonly maxRetry: number;
  readonly timeoutAt: number;
  readonly ownerId?: string;
  readonly leaseExpiresAt: number;
}
interface SubmissionSettlementObligation {
  readonly submissionId: string;
  readonly sessionKey: string;
  readonly attemptId: string;
  readonly recordId: string;
  readonly record: SubmissionSettledRecord;
}
interface SubmissionAttemptRef {
  readonly submissionId: string;
  readonly attemptId: string;
}
interface SubmissionClaimRef extends SubmissionAttemptRef {
  readonly ownerId: string;
  readonly leaseExpiresAt: number;
}
interface SubmissionDurability {
  readonly maxRetry: number;
  readonly timeoutAt: number;
}
/**
 * Flue-owned durable evidence that a submission attempt was started and has
 * not yet settled. The Cloudflare coordinator inserts a marker immediately
 * before starting an attempt fiber and deletes it when the attempt settles;
 * reconciliation treats a fresh marker as proof that the attempt may still
 * be running and must not be reconciled as interrupted.
 */
interface AgentAttemptMarker {
  readonly submissionId: string;
  readonly attemptId: string;
  readonly createdAt: number;
}
interface AgentDispatchReceipt {
  readonly submissionId: string;
  readonly acceptedAt: number;
}
type AgentDispatchAdmission = {
  readonly kind: 'submission';
  readonly submission: AgentSubmission;
} | {
  readonly kind: 'retained_receipt';
  readonly receipt: AgentDispatchReceipt;
} | {
  readonly kind: 'conflict';
};
/**
 * Durable submission lifecycle storage.
 *
 * This is one contract for every backend — there are no SQL-only or
 * "expert" tiers. The per-method invariants below are written in terms of
 * observable behavior, not storage primitives, so a non-SQL backend
 * (MongoDB, a key-value store) implements them natively. Where a method is
 * described as atomic, concurrent callers must never both observe success;
 * whether that is achieved with transactions, conditional updates, or
 * unique indexes is the adapter's choice. Verify an implementation with
 * `defineStoreContractTests` from `@flue/runtime/test-utils`.
 *
 * Stability: the lease method group mirrors the durable-execution engine and
 * is subject to change until 1.0. This applies to every backend equally.
 */
interface AgentSubmissionStore {
  /** Return the submission, or `null` when the id is unknown. */
  getSubmission(submissionId: string): Promise<AgentSubmission | null>;
  /** True while any submission is queued or running. */
  hasUnsettledSubmissions(): Promise<boolean>;
  /**
   * Queued submissions that are each the oldest unsettled submission of
   * their session, in admission order. At most one runnable head exists
   * per session; later queued work in the same session is excluded until
   * everything admitted before it has settled.
   */
  listRunnableSubmissions(): Promise<AgentSubmission[]>;
  /** All queued submissions without canonical readiness, in admission order. */
  listUnreadySubmissions(): Promise<AgentSubmission[]>;
  /** All running submissions, in admission order. */
  listRunningSubmissions(): Promise<AgentSubmission[]>;
  /** Direct settlement obligations reserved but not yet finalized. */
  listPendingSubmissionSettlements(): Promise<SubmissionSettlementObligation[]>;
  /**
   * Recovery handoff: atomically move a running submission from `attempt`
   * to `nextAttemptId`, increment `attemptCount`, clear any pending recovery
   * request, and (when given) install the new lease. Returns the updated
   * submission, or `null` — without writing — when the submission is not
   * running under `attempt`.
   */
  replaceSubmissionAttempt(attempt: SubmissionAttemptRef, nextAttemptId: string, lease?: {
    ownerId: string;
    leaseExpiresAt: number;
  }): Promise<AgentSubmission | null>;
  /**
   * Idempotent admission keyed by dispatch id. An exact replay (same id,
   * same payload) returns the already-admitted submission; the same id
   * with a different payload returns `conflict`.
   */
  admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission>;
  /**
   * Admit a direct prompt as a queued submission. Idempotent for an exact
   * replay of the same submission id and payload.
   */
  admitDirect(input: DirectAgentSubmissionInput): Promise<AgentSubmission>;
  /**
   * Mark a newly admitted queued submission's canonical conversation as materialized.
   * Idempotent while queued; returns `null` when the submission is missing or no longer queued.
   */
  markSubmissionCanonicalReady(submissionId: string): Promise<AgentSubmission | null>;
  /**
   * Atomic compare-and-set. Transition the submission from queued to
   * running ONLY when it is currently queued and is the runnable head of
   * its session (no earlier unsettled submission in the same session),
   * recording the attempt id, owner, lease expiry, and start time,
   * incrementing `attemptCount`, resetting `maxRetry` to the system
   * default, and initializing `timeoutAt` when still unset (a previously
   * initialized timeout is preserved across requeue/reclaim). Returns the
   * claimed submission, or `null` when any condition fails. Two concurrent
   * claims for the same submission must never both succeed.
   */
  claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null>;
  /**
   * Record once that the submission's input was canonically applied,
   * installing the supplied durability (or defaults) on first application.
   * Gated on a running submission owned by `attempt`; otherwise `false`.
   */
  markSubmissionInputApplied(attempt: SubmissionAttemptRef, durability?: SubmissionDurability): Promise<boolean>;
  /**
   * Stamp `recoveryRequestedAt` once. Gated on a running submission owned
   * by `attempt`; otherwise `false`.
   */
  requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean>;
  /**
   * Record an abort request for every unsettled submission in a session.
   * Atomically stamps `abortRequestedAt` (COALESCE — first request wins) on
   * each `queued` or `running` submission with the given `sessionKey` and
   * returns their submission ids. It does NOT settle anything and does NOT
   * change `status`: terminal settlement always happens through an
   * attempt-based path (the pre-execution abort check when a queued submission
   * is claimed, the in-flight abort settle, or the recovery abort branch) so a
   * durable canonical terminal record always exists. `terminalizing` and
   * `settled` submissions are left untouched (a committed outcome must not be
   * overridden). Idempotent; returns an empty array when nothing is unsettled.
   */
  requestSessionAbort(sessionKey: string): Promise<string[]>;
  /**
   * Return a running submission to queued — clearing its attempt, owner,
   * and lease — ONLY while input has not been applied and `attempt` owns
   * the submission; otherwise `false`.
   */
  requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean>;
  /**
   * Atomically reserve the exact canonical settlement record as an obligation.
   * Only a running direct submission owned by `attempt` may transition to
   * terminalizing. Exact retries return the existing obligation; conflicting
   * record identities or payloads return `null`.
   */
  reserveSubmissionSettlement(attempt: SubmissionAttemptRef, settlement: {
    recordId: string;
    record: SubmissionSettledRecord;
  }): Promise<SubmissionSettlementObligation | null>;
  /** Finalize an owned terminalizing submission after its canonical record exists. */
  finalizeSubmissionSettlement(attempt: SubmissionAttemptRef, recordId: string): Promise<boolean>;
  /**
   * Settle the submission successfully. Gated on a running submission
   * owned by `attempt`: a stale attempt or an already-settled submission
   * returns `false` and preserves the first terminal state.
   */
  completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean>;
  /**
   * Settle the submission with an error message. Same gating as
   * {@link completeSubmission}: the first terminal state wins.
   */
  failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean>;
  /**
   * Durably record that the attempt was started. Idempotent: re-inserting
   * the same (submissionId, attemptId) keeps the original `createdAt`.
   */
  insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void>;
  /** Delete the marker matching both ids exactly; a no-op when absent. */
  deleteAttemptMarker(attempt: SubmissionAttemptRef): Promise<void>;
  /** All attempt markers. */
  listAttemptMarkers(): Promise<AgentAttemptMarker[]>;
  /**
   * Extend the lease expiry (now + `LEASE_DURATION_MS`) for each listed
   * submission that is running AND owned by `ownerId`. Submissions owned
   * by another coordinator, settled, or unknown are silently skipped.
   */
  renewLeases(ownerId: string, submissionIds: string[]): Promise<void>;
  /**
   * Running submissions whose lease has expired (a positive
   * `leaseExpiresAt` in the past). Queued and settled submissions are
   * never returned.
   */
  listExpiredSubmissions(): Promise<AgentSubmission[]>;
}
interface AgentExecutionStore {
  readonly submissions: AgentSubmissionStore;
}
/** The complete set of stores a {@link PersistenceAdapter} provides. */
interface PersistenceStores {
  /** Durable agent submission lifecycle storage. */
  readonly executionStore: AgentExecutionStore;
  /** Workflow run records, lookup, and listing. */
  readonly runStore: RunStore;
  /** Durable append-only event streams for agents and workflow runs. */
  readonly eventStreamStore: EventStreamStore;
  /** Canonical per-agent-instance conversation streams. */
  readonly conversationStreamStore: ConversationStreamStore;
  /** Immutable attachment bytes referenced by canonical conversation records. */
  readonly attachmentStore: AttachmentStore;
}
/**
 * A persistence adapter provides the {@link PersistenceStores} bundle backed
 * by a specific database. Users configure persistence by creating a `db.ts`
 * file in their source root and default-exporting an adapter.
 *
 * Adapter packages export a factory function that returns this interface.
 * The built-in `sqlite()` adapter is available from `@flue/runtime/node`.
 *
 * Lifecycle: the framework calls `migrate()` (if present) once at startup
 * to bring the store to the current schema/format version, then awaits
 * `connect()` once to obtain every store — an unreachable or misconfigured
 * database fails at boot, not inside the first request. On shutdown,
 * `close()` is called to release resources.
 *
 * Versioning obligation (storage-agnostic): an adapter durably records its
 * schema/format version when it first creates the store, and fails loudly —
 * before reading or writing any data — when opened against a store recorded
 * with an unknown or newer version (e.g. throw
 * `PersistedSchemaVersionError`, exported from `@flue/runtime/adapter`).
 * The built-in SQL adapters implement this with a one-row `flue_meta`
 * key/value table (key `'schema_version'`); non-SQL adapters implement the
 * same obligation natively (a key, a meta document, etc.).
 */
interface PersistenceAdapter {
  /**
   * Open the database and return every store. Awaited once at startup, so
   * async pool setup, remote handshakes, and — for adapters without
   * {@link migrate} — the schema-version check belong here.
   */
  connect(): PersistenceStores | Promise<PersistenceStores>;
  /**
   * Bring the store to the current schema/format version.
   * Called once at startup before {@link connect}. Creates any missing
   * schema, durably records the schema/format version when the store is
   * first created, and fails loudly when the store records an unknown or
   * newer version. Adapters that create schema implicitly (e.g. LMDB) may
   * omit this method, but must still uphold the versioning obligation in
   * their store-creating paths.
   */
  migrate?(): void | Promise<void>;
  /** Gracefully release resources (connection pools, file handles). */
  close?(): void | Promise<void>;
}
//#endregion
export { ConversationStreamMeta as A, FlueContextConfig as C, ConversationProducerClaim as D, initializeRootHarness as E, StreamListenerRegistry as F, ConversationStreamStore as M, InMemoryConversationStreamStore as N, ConversationStreamBatch as O, SqliteConversationStreamStore as P, DispatchQueue as S, createFlueContext as T, DirectAgentSubmissionInput as _, AgentSubmission as a, createDispatchAgentSubmissionInput as b, DURABILITY_DEFAULT_TIMEOUT_MS as c, PersistenceStores as d, SubmissionAttemptRef as f, AttachedAgentSubmissionAdmission as g, SubmissionSettlementObligation as h, AgentExecutionStore as i, ConversationStreamReadResult as j, ConversationStreamIdentity as k, LEASE_DURATION_MS as l, SubmissionDurability as m, AgentDispatchAdmission as n, AgentSubmissionStore as o, SubmissionClaimRef as p, AgentDispatchReceipt as r, DURABILITY_DEFAULT_MAX_ATTEMPTS as s, AgentAttemptMarker as t, PersistenceAdapter as u, DispatchAgentSubmissionInput as v, FlueContextInternal as w, DispatchInput as x, createAgentSubmissionSessionHandler as y };