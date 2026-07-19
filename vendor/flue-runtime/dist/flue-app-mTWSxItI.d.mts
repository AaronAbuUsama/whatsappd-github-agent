import { s as JsonValue } from "./tool-types-CcKIl663.mjs";
import { G as NamedAgentDispatchRequest, b as FlueEventCallback, dt as WorkflowRouteHandler, ft as WorkflowRunsHandler, gt as ActionInputSchema, h as DispatchReceipt, ht as ActionInput, l as AttachedAgentEventCallback, m as DirectAgentPayload, mt as ActionDefinition, n as AgentDefinition, pt as ActionContext, r as AgentDispatchRequest, vt as ActionOutputSchema } from "./types-USSZhfC6.mjs";
import { t as AttachmentStore } from "./attachment-store-Cf3tPUa0.mjs";
import { M as ConversationStreamStore, S as DispatchQueue, g as AttachedAgentSubmissionAdmission, w as FlueContextInternal } from "./agent-execution-store-BCmrE5Jm.mjs";
import { _ as FlueTraceCarrier, u as RunStore } from "./run-store-tKpCS1yQ.mjs";
import { i as EventStreamStore } from "./event-stream-store-CSiWecIp.mjs";
import * as v from "valibot";
import { Context, Hono, MiddlewareHandler } from "hono";

//#region src/workflow-definition.d.ts
type InlineRunResult<S extends ActionOutputSchema | undefined> = S extends ActionOutputSchema ? v.InferInput<S> : JsonValue | undefined;
interface WorkflowDefinition<TAction extends ActionDefinition = ActionDefinition> {
  readonly __flueWorkflowDefinition: true;
  readonly agent: AgentDefinition;
  readonly action: TAction;
}
type ExtractedWorkflowOptions<TAction extends ActionDefinition> = {
  agent: AgentDefinition;
  action: TAction;
  input?: never;
  output?: never;
  run?: never;
};
type InlineWorkflowOptions<TInput extends ActionInputSchema | undefined, TOutput extends ActionOutputSchema | undefined> = {
  agent: AgentDefinition;
  action?: never;
  input?: TInput;
  output?: TOutput;
  run(context: ActionContext<TInput>): InlineRunResult<TOutput> | Promise<InlineRunResult<TOutput>>;
};
declare function defineWorkflow<TAction extends ActionDefinition>(options: ExtractedWorkflowOptions<TAction>): WorkflowDefinition<TAction>;
declare function defineWorkflow<const TInput extends ActionInputSchema | undefined = undefined, const TOutput extends ActionOutputSchema | undefined = undefined>(options: InlineWorkflowOptions<TInput, TOutput>): WorkflowDefinition<ActionDefinition<TInput, TOutput>>;
//#endregion
//#region src/runtime/runtime-activity-gate.d.ts
interface RuntimeActivityLease {
  release(): void;
}
interface RuntimeActivityGate {
  enter(): RuntimeActivityLease;
  pause(): void;
  waitForIdle(): Promise<void>;
}
declare function createRuntimeActivityGate(): RuntimeActivityGate;
//#endregion
//#region src/runtime/handle-agent.d.ts
declare function assertWorkflowDefinition(value: unknown, name: string): asserts value is WorkflowDefinition;
/**
 * Caller-provided context factory. Differs per-target:
 *   - Node: env=process.env with adapter-backed canonical conversation stores.
 *   - Cloudflare: env=DO env with Durable Object canonical conversation stores.
 */
interface CreateAgentContextOptions {
  id: string;
  agentName: string;
  request: Request;
  initialEventIndex?: number;
  dispatchId?: string;
}
type CreateAgentContextFn = (options: CreateAgentContextOptions) => FlueContextInternal;
interface CreateWorkflowContextOptions {
  runId: string;
  request: Request;
  initialEventIndex?: number;
}
type CreateWorkflowContextFn = (options: CreateWorkflowContextOptions) => FlueContextInternal;
interface WorkflowSchedulingPhases {
  admitted: Promise<void>;
  completion: Promise<unknown>;
}
type StartWorkflowAdmissionFn = (runId: string, run: () => Promise<unknown>) => WorkflowSchedulingPhases;
interface HandleAgentOptions {
  request: Request;
  id: string;
  agentName: string;
  conversationStreamStore: ConversationStreamStore;
  admitAttachedSubmission: AttachedAgentSubmissionAdmission;
}
interface HandleWorkflowOptions {
  request: Request;
  workflowName: string;
  workflow: WorkflowDefinition;
  createContext: CreateWorkflowContextFn;
  startWorkflowAdmission?: StartWorkflowAdmissionFn;
  runStore?: RunStore;
  eventStreamStore: EventStreamStore;
  runId?: string;
  activityGate?: RuntimeActivityGate;
}
declare function handleWorkflowRequest(opts: HandleWorkflowOptions): Promise<Response>;
interface InvokeWorkflowAttachedOptions {
  workflowName: string;
  runId: string;
  workflow: WorkflowDefinition;
  input: unknown;
  request: Request;
  createContext: CreateWorkflowContextFn;
  onEvent?: FlueEventCallback;
  runStore?: RunStore;
  eventStreamStore: EventStreamStore;
}
interface DirectAttachedOptions {
  payload: DirectAgentPayload;
  admitAttachedSubmission: AttachedAgentSubmissionAdmission;
  onEvent?: AttachedAgentEventCallback;
  traceCarrier?: FlueTraceCarrier;
}
interface WorkflowAttachedInvocationResult {
  runId: string;
  result: unknown;
}
interface FailRecoveredRunOptions {
  workflowName: string;
  runId: string;
  request: Request;
  createContext: CreateWorkflowContextFn;
  error: unknown;
  runStore?: RunStore;
  eventStreamStore: EventStreamStore;
}
interface AdmitDetachedWorkflowOptions {
  workflowName: string;
  workflow: WorkflowDefinition;
  input: unknown;
  request: Request;
  createContext: CreateWorkflowContextFn;
  startWorkflowAdmission?: StartWorkflowAdmissionFn;
  runStore?: RunStore;
  eventStreamStore: EventStreamStore;
  runId?: string;
  activityGate?: RuntimeActivityGate;
}
declare function admitDetachedWorkflow(opts: AdmitDetachedWorkflowOptions): Promise<{
  runId: string;
}>;
declare function failRecoveredRun(opts: FailRecoveredRunOptions): Promise<void>;
declare function invokeDirectAttached(opts: DirectAttachedOptions): ReturnType<AttachedAgentSubmissionAdmission>;
declare function invokeWorkflowAttached(opts: InvokeWorkflowAttachedOptions): Promise<WorkflowAttachedInvocationResult>;
//#endregion
//#region src/runtime/invoke.d.ts
interface WorkflowInvocationReceipt {
  readonly runId: string;
}
type WorkflowInvokeRequest<TWorkflow extends WorkflowDefinition> = TWorkflow['action'] extends ActionDefinition<infer TInput, any> ? TInput extends ActionInputSchema ? {
  readonly input: ActionInput<TWorkflow['action']>;
} : {
  readonly input?: never;
} : never;
//#endregion
//#region src/runtime/flue-app.d.ts
interface AgentRecord {
  name: string;
  definition: AgentDefinition;
  description?: string;
  route?: MiddlewareHandler;
  /**
   * Opt-in gate for `GET /agents/:name/:id/attachments/:attachmentId`. When
   * absent, the attachment-download endpoint returns 404. When present, it runs
   * as middleware before bytes are served, so the agent author authorizes and
   * scopes access (the bytes may contain sensitive content).
   */
  attachments?: MiddlewareHandler;
}
interface WorkflowRecord {
  name: string;
  definition: WorkflowDefinition;
  route?: WorkflowRouteHandler;
  runs?: WorkflowRunsHandler;
}
interface RuntimeBase {
  devMode?: boolean;
  temporaryLocalExposure?: boolean;
  agents: AgentRecord[];
  workflows: WorkflowRecord[];
  channelHandlers?: Record<string, Record<string, (c: Context) => Response | Promise<Response>>>;
  dispatchQueue: DispatchQueue;
  admitWorkflow: (input: {
    workflowName: string;
    input: unknown;
  }) => Promise<{
    runId: string;
  }>;
  activityGate?: RuntimeActivityGate;
}
interface NodeRuntime extends RuntimeBase {
  target: 'node';
  createWorkflowContext: CreateWorkflowContextFn;
  createAgentAdmission: (agentName: string, instanceId: string) => AttachedAgentSubmissionAdmission;
  /**
   * Abort all in-flight and queued durable work for an agent instance.
   * Resolves `true` when there was unsettled work to abort. Terminal
   * settlement (the distinct aborted outcome) happens asynchronously.
   */
  abortAgentInstance: (agentName: string, instanceId: string) => Promise<boolean>;
  runStore: RunStore;
  eventStreamStore: EventStreamStore;
  conversationStreamStore: ConversationStreamStore;
  attachmentStore: AttachmentStore;
}
interface CloudflareRuntime extends RuntimeBase {
  target: 'cloudflare';
  routeAgentRequest: (request: Request, env: unknown, target: {
    agentName: string;
    instanceId: string;
  }) => Promise<Response | null>;
  /**
   * Forward a new workflow run to its per-workflow Durable Object instance.
   * The `instanceId` is the freshly generated run id — workflows have one
   * instance per run, so the two values are the same. Required when
   * {@link target} is `'cloudflare'`.
   *
   * Returning `null` means "no DO matched" — the caller renders a
   * `RouteNotFoundError` envelope so the response shape stays
   * consistent with every other miss.
   */
  routeWorkflowRequest: (request: Request, env: unknown, target: {
    workflowName: string;
    instanceId: string;
  }) => Promise<Response | null>;
  /** Cloudflare-only forwarding hook for registry-resolved run requests. */
  routeRunRequest: (request: Request, env: unknown, target: {
    workflowName: string;
    runId: string;
  }) => Promise<Response | null>;
  /**
   * Cloudflare-only factory for the request-scoped run index client
   * (cross-deployment lookup/listing over the `FlueRegistry` index DO).
   */
  createRunIndexForRequest: (env: unknown) => RunListing | undefined;
}
type FlueRuntime = NodeRuntime | CloudflareRuntime;
/** Cross-deployment run lookup/listing surface of a {@link RunStore}. */
type RunListing = Pick<RunStore, 'lookupRun' | 'listRuns'>;
/** One built agent in the deployment manifest, as returned by `listAgents()`. */
interface AgentManifestEntry {
  /** Addressable agent name — the `agents/<name>.ts` module name. */
  name: string;
  /** Static description from the agent module's `description` export. */
  description?: string;
  /** Transports the agent is exposed over. */
  transports: {
    http?: true;
  };
  /** Whether the module default-exports an agent definition. */
  defined: boolean;
}
/**
 * Accepts input for asynchronous delivery to a continuing agent session.
 *
 * Resolves after the current runtime admits and queues the input. It does not
 * wait for model processing, tool calls, or an agent reply. The returned
 * `dispatchId` identifies delivery and is not a workflow `runId`; dispatched
 * input does not create workflow-run history.
 *
 * The agent-definition overload requires a value default-exported by exactly one
 * discovered `agents/<name>.ts` module. The named overload targets a discovered
 * agent module by name.
 *
 * Delivery durability depends on the generated target. Node uses a
 * process-lifetime in-memory queue by default. Cloudflare durably admits work
 * to the target agent Durable Object and may retry processing after an
 * interruption. Cloudflare processing can therefore be at-least-once; design
 * external side effects to be idempotent.
 */
declare function dispatch(agent: AgentDefinition, request: AgentDispatchRequest): Promise<DispatchReceipt>;
declare function dispatch(request: NamedAgentDispatchRequest): Promise<DispatchReceipt>;
declare function invoke<TWorkflow extends WorkflowDefinition>(workflow: TWorkflow, request: WorkflowInvokeRequest<TWorkflow>): Promise<WorkflowInvocationReceipt>;
/**
 * Not part of the public API — exposed via `@flue/runtime/internal` only
 * because the generated entry imports it from a stable bare specifier.
 */
declare function configureFlueRuntime(cfg: FlueRuntime): void;
/**
 * Creates a mountable Hono sub-app for Flue's public HTTP API.
 * Routes are relative to the application-chosen mount prefix.
 *
 * The mounted sub-app exposes:
 *
 * - `POST /agents/:name/:id` — send a prompt (202 admission; `?wait=result` for a sync JSON result)
 * - `GET/HEAD /agents/:name/:id` — DS event stream read
 * - `POST /workflows/:name` — start a workflow run (202 admission; `?wait=result` for a sync JSON result)
 * - `GET/HEAD /runs/:runId` — DS run event stream read
 *
 * Agent and workflow routes are available only when the corresponding module
 * opts into HTTP transport. Event streams use the Durable Streams protocol
 * (catch-up, long-poll, SSE) and are read-only.
 */
declare function flue(): Hono;
/**
 * Build the default outer Hono app used when no user `app.ts` is
 * present. Mounts `flue()` at root, renders canonical Flue envelopes
 * for unmatched paths and any thrown errors.
 *
 * Lives in @flue/runtime rather than the generated entry so that user
 * projects on the Cloudflare target — whose `node_modules` does not
 * declare `hono` directly — don't have to add it themselves just to
 * keep the no-`app.ts` default behavior working. When a user does
 * write an `app.ts`, they own this composition and must `pnpm add
 * hono` (or equivalent) themselves.
 */
declare function createDefaultFlueApp(): Hono;
interface HandleRunRouteOptions {
  runStore?: RunStore;
  workflowName: string;
  runId: string;
}
/** Serve run metadata (`RunRecord`) for a workflow-scoped run lookup. */
declare function handleRunRouteRequest(opts: HandleRunRouteOptions): Promise<Response>;
//#endregion
export { assertWorkflowDefinition as A, HandleAgentOptions as C, WorkflowAttachedInvocationResult as D, StartWorkflowAdmissionFn as E, RuntimeActivityGate as F, RuntimeActivityLease as I, createRuntimeActivityGate as L, handleWorkflowRequest as M, invokeDirectAttached as N, WorkflowSchedulingPhases as O, invokeWorkflowAttached as P, WorkflowDefinition as R, FailRecoveredRunOptions as S, InvokeWorkflowAttachedOptions as T, CreateAgentContextFn as _, HandleRunRouteOptions as a, CreateWorkflowContextOptions as b, configureFlueRuntime as c, flue as d, handleRunRouteRequest as f, AdmitDetachedWorkflowOptions as g, WorkflowInvokeRequest as h, FlueRuntime as i, failRecoveredRun as j, admitDetachedWorkflow as k, createDefaultFlueApp as l, WorkflowInvocationReceipt as m, AgentRecord as n, NodeRuntime as o, invoke as p, CloudflareRuntime as r, WorkflowRecord as s, AgentManifestEntry as t, dispatch as u, CreateAgentContextOptions as v, HandleWorkflowOptions as w, DirectAttachedOptions as x, CreateWorkflowContextFn as y, defineWorkflow as z };