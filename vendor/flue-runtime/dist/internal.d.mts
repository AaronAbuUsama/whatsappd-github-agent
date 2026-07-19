import { $ as PromptUsage, K as PackagedSkillDirectory, ct as SkillReference, n as AgentDefinition } from "./types-USSZhfC6.mjs";
import { a as StoredAttachment, i as PutAttachmentInput, n as GetAttachmentInput, r as InMemoryAttachmentStore, t as AttachmentStore } from "./attachment-store-Cf3tPUa0.mjs";
import { C as FlueContextConfig, E as initializeRootHarness, M as ConversationStreamStore, N as InMemoryConversationStreamStore, P as SqliteConversationStreamStore, S as DispatchQueue, T as createFlueContext, _ as DirectAgentSubmissionInput, a as AgentSubmission, f as SubmissionAttemptRef, g as AttachedAgentSubmissionAdmission, h as SubmissionSettlementObligation, i as AgentExecutionStore, m as SubmissionDurability, n as AgentDispatchAdmission, o as AgentSubmissionStore, r as AgentDispatchReceipt, u as PersistenceAdapter, v as DispatchAgentSubmissionInput, w as FlueContextInternal, x as DispatchInput, y as createAgentSubmissionSessionHandler } from "./agent-execution-store-BCmrE5Jm.mjs";
import { t as SqlStorage } from "./sql-storage-DNzKo_Mr.mjs";
import { a as ListRunsResponse, c as RunRecord, d as WorkflowRunPointer, i as ListRunsOpts, l as RunStatus, r as EndRunInput, s as RunPointer, t as CreateRunInput, u as RunStore } from "./run-store-tKpCS1yQ.mjs";
import { i as EventStreamStore, o as SqliteEventStreamStore } from "./event-stream-store-CSiWecIp.mjs";
import { B as toHttpResponse, h as RuntimeUnavailableError } from "./errors-CZfAM_Do.mjs";
import { a as hasRegisteredProvider, c as resetProviderRuntime } from "./providers-DHepWsgE.mjs";
import { l as runWithInstrumentationOwner, o as InstrumentationOwner, r as bashFactoryToSessionEnv, s as createInstrumentationOwner } from "./sandbox-9WxaLcPt.mjs";
import { A as assertWorkflowDefinition, C as HandleAgentOptions, D as WorkflowAttachedInvocationResult, E as StartWorkflowAdmissionFn, F as RuntimeActivityGate, I as RuntimeActivityLease, L as createRuntimeActivityGate, M as handleWorkflowRequest, N as invokeDirectAttached, O as WorkflowSchedulingPhases, P as invokeWorkflowAttached, S as FailRecoveredRunOptions, T as InvokeWorkflowAttachedOptions, _ as CreateAgentContextFn, a as HandleRunRouteOptions, b as CreateWorkflowContextOptions, c as configureFlueRuntime, f as handleRunRouteRequest, g as AdmitDetachedWorkflowOptions, i as FlueRuntime, j as failRecoveredRun, k as admitDetachedWorkflow, l as createDefaultFlueApp, n as AgentRecord, o as NodeRuntime, r as CloudflareRuntime, s as WorkflowRecord, v as CreateAgentContextOptions, w as HandleWorkflowOptions, x as DirectAttachedOptions, y as CreateWorkflowContextFn } from "./flue-app-mTWSxItI.mjs";
import { AssistantMessage } from "@earendil-works/pi-ai";
import { Api, Model as Model$1 } from "@earendil-works/pi-ai/compat";
import { AgentMessage } from "@earendil-works/pi-agent-core";
import { Bash, InMemoryFs } from "just-bash";

//#region src/runtime/dev-lifecycle-logger.d.ts
interface AgentInteractionStart {
  agentName: string;
  instanceId: string;
  kind: AgentSubmission['kind'];
  submissionId: string;
  dispatchId?: string;
}
declare function installDevLifecycleLogger(write?: (message: string) => void): {
  onAgentInteractionStart(interaction: AgentInteractionStart): void;
  dispose(): void;
};
//#endregion
//#region src/cloudflare/agent-coordinator.d.ts
declare const CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH = "/__flue/internal/dispatch";
interface CloudflareAgentStorage {
  sql?: SqlStorage;
  transactionSync?<T>(closure: () => T): T;
}
interface CloudflareAgentInstance {
  readonly name: string;
  readonly env: Record<string, unknown>;
  readonly ctx: {
    readonly id: {
      toString(): string;
    };
    readonly storage: CloudflareAgentStorage;
  };
  __unsafe_ensureInitialized(): Promise<void>;
  schedule(delaySeconds: number, callback: string, payload: undefined, options: {
    idempotent: boolean;
  }): Promise<unknown>;
  runFiber(name: string, callback: (ctx: {
    stash(snapshot: unknown): void;
  }) => Promise<void>): Promise<void>;
}
interface CloudflareAgentRecoveredFiberContext {
  readonly name?: string;
  readonly snapshot?: Record<string, unknown>;
}
interface CloudflareAgentPreparedCoordinator {
  readonly agentName: string;
  readonly executionStore: AgentExecutionStore;
  readonly conversationStreamStore: ConversationStreamStore;
  readonly attachmentStore: AttachmentStore;
}
interface CloudflareAgentRuntimeOptions {
  readonly agents: ReadonlyArray<{
    readonly name: string;
    readonly definition: Parameters<typeof createAgentSubmissionSessionHandler>[0];
  }>;
  readonly createContext: (options: {
    readonly executionStore: AgentExecutionStore;
    readonly instance: CloudflareAgentInstance;
    readonly agentName: string;
    readonly request: Request;
    readonly initialEventIndex?: number;
    readonly dispatchId?: string;
  }) => FlueContextInternal;
  readonly runWithInstanceContext: <T>(instance: CloudflareAgentInstance, agentName: string, callback: () => T) => T;
  readonly onInteractionStart?: (interaction: AgentInteractionStart) => void;
}
interface CloudflareAgentRuntime {
  prepare(options: {
    readonly storage: CloudflareAgentStorage;
    readonly className: string;
    readonly agentName: string;
  }): CloudflareAgentPreparedCoordinator;
  attach(instance: CloudflareAgentInstance, prepared: CloudflareAgentPreparedCoordinator): void;
  onStart(instance: CloudflareAgentInstance, inherited: () => Promise<unknown> | unknown): Promise<void>;
  wakeSubmissions(instance: CloudflareAgentInstance): Promise<void>;
  onRequest(instance: CloudflareAgentInstance, request: Request): Promise<Response | null>;
  onFiberRecovered(instance: CloudflareAgentInstance, ctx: CloudflareAgentRecoveredFiberContext, inherited: () => Promise<unknown> | unknown): Promise<unknown>;
}
declare function createCloudflareAgentRuntime(options: CloudflareAgentRuntimeOptions): CloudflareAgentRuntime;
//#endregion
//#region src/sql-attachment-store.d.ts
declare class SqliteAttachmentStore implements AttachmentStore {
  private readonly sql;
  private readonly runTransaction;
  constructor(sql: SqlStorage, runTransaction: <T>(closure: () => T) => T);
  put(input: PutAttachmentInput): Promise<void>;
  get(input: GetAttachmentInput): Promise<StoredAttachment | null>;
  deleteForInstance(streamPath: string): Promise<void>;
  private read;
  private conflict;
}
//#endregion
//#region src/cloudflare/agent-execution-store.d.ts
interface DurableObjectStorage {
  readonly sql?: SqlStorage;
  transactionSync?<T>(closure: () => T): T;
}
declare function createSqlConversationStores(storage: DurableObjectStorage): {
  conversationStreamStore: SqliteConversationStreamStore;
  attachmentStore: SqliteAttachmentStore;
};
//#endregion
//#region src/conversation-projections.d.ts
/**
 * Materialized conversation part. Structurally identical to @flue/sdk's
 * `FlueConversationPart` — the public projection shape. The runtime cannot
 * import the SDK, so the shape is mirrored here and asserted by the snapshot
 * wire contract.
 */
type ConversationUiPart = {
  type: 'text';
  text: string;
  state: 'streaming' | 'done';
} | {
  type: 'reasoning';
  text: string;
  state: 'streaming' | 'done';
} | {
  type: 'file';
  mediaType: string;
  id?: string;
  size?: number;
  url?: string;
  filename?: string;
} | ({
  type: 'dynamic-tool';
  toolName: string;
  toolCallId: string;
} & ({
  state: 'input-available';
  input: unknown;
} | {
  state: 'output-available';
  input: unknown;
  output: unknown;
} | {
  state: 'output-error';
  input: unknown;
  errorText: string;
}));
interface ConversationUiMessage {
  id: string;
  role: 'user' | 'assistant';
  submissionId?: string;
  parts: ConversationUiPart[];
  metadata?: {
    /** Server-authored message creation time as an ISO 8601 string. */timestamp?: string;
    usage?: PromptUsage;
    model?: {
      provider: string;
      id: string;
    };
  };
}
//#endregion
//#region src/conversation-public.d.ts
interface AgentConversationSettlement {
  submissionId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  result?: unknown;
  error?: unknown;
}
/**
 * A materialized conversation read at a durable-stream offset. Wire-compatible
 * with @flue/sdk's `FlueConversationSnapshot`.
 */
interface AgentConversationSnapshot {
  v: 1;
  conversationId: string;
  offset: string;
  messages: ConversationUiMessage[];
  settlements: AgentConversationSettlement[];
}
/**
 * Incremental UI projection protocol carried by the `updates` view.
 * Wire-compatible with @flue/sdk's internal `ConversationStreamChunk`. The
 * canonical record schema is never exposed; these chunks describe only
 * UI-relevant conversation operations.
 */
type ConversationStreamChunkBody = {
  type: 'conversation-reset';
  conversationId: string;
  snapshot: AgentConversationSnapshot;
} | {
  type: 'message-appended';
  conversationId: string;
  message: ConversationUiMessage;
} | {
  type: 'message-started';
  conversationId: string;
  messageId: string;
  submissionId?: string; /** Server-authored generation-start time as an ISO 8601 string. */
  timestamp?: string;
  model?: {
    provider: string;
    id: string;
  };
} | {
  type: 'message-delta';
  conversationId: string;
  messageId: string;
  kind: 'text' | 'reasoning';
  delta: string;
} | {
  type: 'tool-input';
  conversationId: string;
  messageId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
} | {
  type: 'tool-output';
  conversationId: string;
  toolCallId: string;
  output: unknown;
} | {
  type: 'tool-output-error';
  conversationId: string;
  toolCallId: string;
  errorText: string;
} | {
  type: 'message-completed';
  conversationId: string;
  messageId: string;
  usage?: PromptUsage;
} | {
  type: 'submission-settled';
  conversationId: string;
  submissionId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  result?: unknown;
  error?: unknown;
};
/**
 * Monotonic ordering token stamped on every chunk. `batch` is the durable batch
 * ordinal the chunk was projected from; `index` is the chunk's position within
 * that batch's projection. Consumers compare it (lexicographically by `batch`
 * then `index`) to dedupe chunks redelivered under at-least-once transports
 * (e.g. an SSE reconnect). Opaque otherwise — do not interpret the numbers.
 */
type ConversationChunkPosition = {
  batch: number;
  index: number;
};
type ConversationStreamChunk = ConversationStreamChunkBody & {
  position: ConversationChunkPosition;
};
//#endregion
//#region src/node/agent-coordinator.d.ts
interface NodeAgentCoordinator {
  /** Call once at startup to reconcile interrupted work from a previous process. */
  reconcileSubmissions(): Promise<void>;
  /** Admit a dispatch. The submission is persisted durably; processing is asynchronous. */
  admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission>;
  /**
   * Abort all in-flight and queued durable work for an agent instance. Records
   * the durable abort intent on every unsettled submission for the instance
   * and aborts any attempt running in this process. Terminal settlement (the
   * distinct aborted outcome) happens asynchronously; observe it via the
   * conversation/result. Resolves `true` when there was unsettled work to
   * abort, `false` when the instance was idle.
   */
  abortInstance(agentName: string, instanceId: string): Promise<boolean>;
  /**
   * Create a durable admission hook for a specific agent instance. The returned
   * function accepts a direct prompt payload, persists it as a durable submission,
   * and resolves when the submission settles. Pass the result as the
   * `admitAttachedSubmission` option to `handleAgentRequest()` so that direct
   * prompts enter the same durable lifecycle as dispatches.
   */
  createAdmission(agentName: string, instanceId: string): AttachedAgentSubmissionAdmission;
  /**
   * Resolves when all active submissions have settled and no runnable work remains.
   * Useful for tests and graceful shutdown.
   */
  waitForIdle(): Promise<void>;
  /**
   * Graceful shutdown. Stops accepting new work, aborts active submissions
   * at the turn boundary, and waits for settlement with a timeout. Submissions
   * that don't settle within the timeout are abandoned — their expired leases
   * will be reclaimed on next startup via {@link reconcileSubmissions}.
   */
  shutdown(timeoutMs?: number): Promise<void>;
}
/**
 * Create a `DispatchQueue` backed by a `NodeAgentCoordinator`.
 *
 * Dispatches go through proper SQL admission, claim, and settlement
 * instead of fire-and-forget inline processing. The
 * coordinator also reconciles interrupted work from a previous process
 * on startup and drains queued submissions after each dispatch.
 */
declare function createNodeDispatchQueue(coordinator: NodeAgentCoordinator): DispatchQueue;
declare function createNodeAgentCoordinator(options: {
  submissions: AgentSubmissionStore;
  agents: ReadonlyArray<{
    name: string;
    definition: AgentDefinition;
  }>;
  createContext: CreateAgentContextFn;
  conversationStreamStore?: ConversationStreamStore;
  attachmentStore?: AttachmentStore;
  onInteractionStart?: (interaction: AgentInteractionStart) => void;
  activityGate?: RuntimeActivityGate;
}): NodeAgentCoordinator;
//#endregion
//#region src/node/run-store.d.ts
declare class InMemoryRunStore implements RunStore {
  private runs;
  createRun(input: CreateRunInput): Promise<void>;
  endRun(input: EndRunInput): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  lookupRun(runId: string): Promise<WorkflowRunPointer | null>;
  listRuns(opts?: ListRunsOpts): Promise<ListRunsResponse>;
}
//#endregion
//#region src/runtime/handle-conversation-routes.d.ts
declare function handleAgentConversationRead(options: {
  store: ConversationStreamStore;
  path: string;
  request: Request;
}): Promise<Response>;
declare function handleAgentConversationHead(store: ConversationStreamStore, path: string): Promise<Response>;
//#endregion
//#region src/runtime/handle-stream-routes.d.ts
/**
 * DS-compliant HEAD: returns stream metadata without a body.
 * 404 if the stream does not exist.
 */
declare function handleStreamHead(store: EventStreamStore, path: string): Promise<Response>;
interface HandleStreamReadOptions {
  store: EventStreamStore;
  path: string;
  request: Request;
}
/**
 * DS-compliant GET: catch-up, long-poll, or SSE mode based on `?live=` param.
 * 404 if the stream does not exist.
 */
declare function handleStreamRead(opts: HandleStreamReadOptions): Promise<Response>;
//#endregion
//#region src/runtime/ids.d.ts
/**
 * Workflow run ids are opaque: nothing may parse structure out of them. The
 * owning workflow is resolved through the run registry (`runId` →
 * `workflowName`).
 */
declare function generateWorkflowRunId(): string;
//#endregion
//#region src/skill-frontmatter.d.ts
interface ParsedSkillMarkdown {
  name: string;
  description: string;
  body: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  allowedTools?: string[];
}
interface ParseSkillMarkdownOptions {
  directoryName: string;
  path: string;
}
declare function parseSkillMarkdown(content: string, options: ParseSkillMarkdownOptions): ParsedSkillMarkdown;
//#endregion
//#region src/skill-package.d.ts
interface SkillPackageInput {
  name: string;
  description: string;
  files: ReadonlyArray<{
    path: string;
    content: Uint8Array;
  }>;
}
declare function buildPackagedSkill(input: SkillPackageInput): PackagedSkillDirectory;
declare function createSkillReference(directory: PackagedSkillDirectory): SkillReference;
//#endregion
//#region src/sql-run-store.d.ts
declare function createSqlRunStore(sql: SqlStorage): RunStore;
//#endregion
//#region src/internal.d.ts
/**
 * Resolve a `provider-id/model-id` model specifier to a pi-ai Model.
 * Registered provider IDs win over pi-ai's catalog; registrations for
 * catalog provider IDs hydrate metadata from the catalog with the
 * registration's options layered on top.
 */
declare function resolveModel(model: string): Model$1<Api>;
//#endregion
export { type AdmitDetachedWorkflowOptions, type AgentConversationSnapshot, type AgentDispatchAdmission, type AgentDispatchReceipt, type AgentExecutionStore, type AgentInteractionStart, type AgentRecord, type AgentSubmission, type AgentSubmissionStore, type AttachmentStore, Bash, CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH, type CloudflareRuntime, type ConversationStreamChunk, type ConversationStreamStore, type CreateAgentContextFn, type CreateAgentContextOptions, type CreateWorkflowContextFn, type CreateWorkflowContextOptions, type DirectAgentSubmissionInput, type DirectAttachedOptions, type DispatchAgentSubmissionInput, type DispatchInput, type DispatchQueue, type EventStreamStore, type FailRecoveredRunOptions, type FlueContextConfig, type FlueContextInternal, type FlueRuntime, type HandleAgentOptions, type HandleRunRouteOptions, type HandleWorkflowOptions, InMemoryAttachmentStore, InMemoryConversationStreamStore, InMemoryFs, InMemoryRunStore, type InstrumentationOwner, type InvokeWorkflowAttachedOptions, type ListRunsOpts, type ListRunsResponse, type NodeRuntime, type PersistenceAdapter, type RunPointer, type RunRecord, type RunStatus, type RunStore, type RuntimeActivityGate, type RuntimeActivityLease, RuntimeUnavailableError, SqliteConversationStreamStore, SqliteEventStreamStore, type StartWorkflowAdmissionFn, type SubmissionAttemptRef, type SubmissionDurability, type SubmissionSettlementObligation, type WorkflowAttachedInvocationResult, type WorkflowRecord, type WorkflowRunPointer, type WorkflowSchedulingPhases, admitDetachedWorkflow, assertWorkflowDefinition, bashFactoryToSessionEnv, buildPackagedSkill, configureFlueRuntime, createCloudflareAgentRuntime, createDefaultFlueApp, createFlueContext, createInstrumentationOwner, createNodeAgentCoordinator, createNodeDispatchQueue, createRuntimeActivityGate, createSkillReference, createSqlConversationStores, createSqlRunStore, failRecoveredRun, generateWorkflowRunId, handleAgentConversationHead, handleAgentConversationRead, handleRunRouteRequest, handleStreamHead, handleStreamRead, handleWorkflowRequest, hasRegisteredProvider, initializeRootHarness, installDevLifecycleLogger, invokeDirectAttached, invokeWorkflowAttached, parseSkillMarkdown, resetProviderRuntime, resolveModel, runWithInstrumentationOwner, toHttpResponse };