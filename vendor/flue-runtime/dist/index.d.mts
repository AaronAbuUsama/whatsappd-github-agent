import { a as ToolOutput, i as ToolInputSchema, n as ToolDefinition, o as ToolOutputSchema, r as ToolInput, s as JsonValue, t as ToolContext } from "./tool-types-CcKIl663.mjs";
import { $ as PromptUsage, A as FlueSessions, B as LlmUserMessage, D as FlueObservation, E as FlueLogger, F as LlmThinkingContent, G as NamedAgentDispatchRequest, H as ModelRequestInfo, I as LlmTool, J as PromptImage, K as PackagedSkillDirectory, L as LlmToolCall, M as LlmImageContent, N as LlmMessage, P as LlmTextContent, Q as PromptResultResponse, R as LlmToolResultMessage, T as FlueHarness, U as ModelRequestInput, V as ModelRequest, W as ModelResponse, X as PromptOptions, Y as PromptModel, Z as PromptResponse, _ as FLUE_EVENT_SCHEMA_REVISION, _t as ActionOutput, a as AgentProfile, at as ShellResult, c as AttachedAgentEvent, ct as SkillReference, d as BashLike, dt as WorkflowRouteHandler, et as SandboxFactory, f as CallHandle, ft as WorkflowRunsHandler, g as DurabilityConfig, gt as ActionInputSchema, h as DispatchReceipt, ht as ActionInput, i as AgentInitializerContext, it as ShellOptions, j as LlmAssistantMessage, k as FlueSession, lt as TaskOptions, mt as ActionDefinition, n as AgentDefinition, nt as SessionToolFactory, o as AgentRouteHandler, ot as Skill, p as CompactionConfig, pt as ActionContext, q as PackagedSkillFile, r as AgentDispatchRequest, rt as SessionToolFactoryOptions, s as AgentRuntimeConfig, st as SkillOptions, tt as SessionEnv, u as BashFactory, ut as ThinkingLevel, v as FileStat, vt as ActionOutputSchema, w as FlueFs, x as FlueEventContext, y as FlueEvent, yt as defineAction, z as LlmTurnPurpose } from "./types-USSZhfC6.mjs";
import { a as ListRunsResponse, c as RunRecord, d as WorkflowRunPointer, g as FlueExecutionOperation, h as FlueExecutionInterceptor, i as ListRunsOpts, l as RunStatus, m as FlueExecutionContext, s as RunPointer } from "./run-store-tKpCS1yQ.mjs";
import { A as ToolOutputSerializationError, C as SubmissionAbortedError, D as ToolInputValidationError, E as SubmissionTimeoutError, F as WorkflowAdmissionUnavailableError, I as WorkflowInputSerializationError, L as WorkflowInputUnexpectedError, M as ToolValidationIssue, N as ValidationIssue, O as ToolLegacyDefinitionError, P as WorkflowAdmissionError, R as WorkflowInvocationNotConfiguredError, S as SubagentNotDeclaredError, T as SubmissionRetryExhaustedError, _ as SessionAlreadyExistsError, b as SkillDefinitionValidationError, c as DelegationDepthExceededError, d as OperationFailedError, g as SandboxOperationUnsupportedError, j as ToolOutputValidationError, k as ToolNameConflictError, l as FlueError, m as ProviderRegistrationError, n as ActionOutputSerializationError, o as AttachmentNotAvailableError, p as ProductEventVersionError, r as ActionOutputValidationError, t as ActionInputValidationError, u as InstrumentationAlreadyInstalledError, v as SessionBusyError, w as SubmissionInterruptedError, x as SkillNotRegisteredError, y as SessionNotFoundError, z as WorkflowNotDiscoveredError } from "./errors-CZfAM_Do.mjs";
import { i as ProviderRegistration, o as registerApiProvider, r as HttpProviderRegistration, s as registerProvider } from "./providers-DHepWsgE.mjs";
import { a as FlueInstrumentation, c as instrument, i as createSandboxSessionEnv, n as bash, t as SandboxApi, u as FlueObservationSubscriber } from "./sandbox-9WxaLcPt.mjs";
import { R as WorkflowDefinition, h as WorkflowInvokeRequest, m as WorkflowInvocationReceipt, p as invoke, t as AgentManifestEntry, u as dispatch, z as defineWorkflow } from "./flue-app-mTWSxItI.mjs";
import { t as defineTool } from "./tool-cYDWyO6V.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AgentTool } from "@earendil-works/pi-agent-core";

declare const FRAMEWORK_TOOL_EXCLUSION_SUPPORTED: true;
//#region src/agent-definition.d.ts
/**
 * Validates and returns a reusable agent profile. Use profiles as the baseline
 * for an agent definition or as named subagents available to `session.task()`.
 *
 * Throws when the profile contains unknown fields, invalid capabilities,
 * duplicate capability names, or circular subagents.
 */
declare function defineAgentProfile(profile: AgentProfile): AgentProfile;
/**
 * Defines an agent initializer. Default-export the returned value from an
 * `agents/<name>.ts` module to define an addressable agent, or bind it to a
 * workflow definition.
 *
 * The initializer runs whenever a runner initializes a root harness from the
 * agent definition. Do not treat it as a one-time
 * constructor for a persistent agent instance id. Return a runtime config
 * object with `model: '<provider>/<model>'` or a profile with its own model
 * field.
 */
declare function defineAgent<TEnv = Record<string, any>>(initialize: (context: AgentInitializerContext<TEnv>) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>): AgentDefinition<TEnv>;
/** @deprecated Renamed to {@link defineAgent}. */
declare function createAgent<TEnv = Record<string, any>>(initialize: (context: AgentInitializerContext<TEnv>) => AgentRuntimeConfig | Promise<AgentRuntimeConfig>): AgentDefinition<TEnv>;
//#endregion
//#region src/event-redaction.d.ts
/**
 * Sentinel that replaces raw base64 image bytes in event payloads. Events keep
 * an image's presence and `mimeType` visible without carrying the payload
 * itself, so observers and persisted run history never retain image bytes.
 * Session history (model context) is unaffected and retains the real bytes.
 */
declare const IMAGE_DATA_OMITTED = "[image data omitted from event]";
//#endregion
//#region src/mcp.d.ts
/** Remote MCP transport. */
type McpTransport = 'streamable-http' | 'sse';
/** Options for {@link connectMcpServer}. */
interface McpServerOptions {
  /** MCP server endpoint. */
  url: string | URL;
  /** Defaults to modern streamable HTTP. Use `'sse'` for legacy MCP servers. */
  transport?: McpTransport;
  /** Headers merged into MCP transport requests. */
  headers?: HeadersInit;
  /** Additional MCP transport request configuration. */
  requestInit?: RequestInit;
  /** Custom fetch implementation used by the MCP transport. */
  fetch?: typeof fetch;
  /** Per-request timeout in milliseconds for MCP requests. Defaults to the MCP SDK default (60 seconds). */
  timeoutMs?: number;
  /** Reset the per-request timeout whenever the server sends a progress notification. Defaults to `false`. */
  resetTimeoutOnProgress?: boolean;
}
/** Connection returned by {@link connectMcpServer}. */
interface McpServerConnection {
  /** Server name supplied to {@link connectMcpServer}. */
  name: string;
  /** MCP tools adapted into ordinary Flue tool definitions. */
  tools: ToolDefinition[];
  /** Close the underlying MCP client connection. */
  close(): Promise<void>;
}
/**
 * Connects to a remote MCP server and adapts its listed tools into ordinary
 * Flue tool definitions.
 *
 * Adapted tool names use `mcp__<server>__<tool>`. Unsupported characters are
 * replaced with underscores, and duplicate adapted names are rejected. Close
 * the returned connection when its tools are no longer needed.
 */
declare function connectMcpServer(name: string, options: McpServerOptions): Promise<McpServerConnection>;
//#endregion
//#region src/result.d.ts
/**
 * Thrown when the LLM calls the `give_up` tool, indicating it cannot produce a
 * result that conforms to the required schema. Carries the LLM-supplied
 * `reason` and the assistant transcript leading up to the give-up.
 */
declare class ResultUnavailableError extends Error {
  readonly reason: string;
  readonly assistantText: string;
  constructor(reason: string, assistantText: string);
}
//#endregion
//#region src/runtime/events.d.ts
/**
 * Receives a decorated event and its originating context. Workflow
 * events may carry `runId`; direct and dispatched agent events carry
 * `instanceId` and optional `dispatchId` without becoming workflow runs.
 * Subscriber failures are logged and do not halt dispatch or the originating
 * execution. Returned promises are observed for rejection but are not awaited.
 */
type FlueEventSubscriber = FlueObservationSubscriber;
/**
 * Subscribe to live workflow-run or agent-interaction activity emitted in this isolate.
 * The subscription does not replay durable workflow history or aggregate events
 * across processes or Cloudflare Durable Object isolates.
 *
 * Usage (typically at the top of `app.ts`):

 *
 *     import { observe } from '@flue/runtime';
 *
 *     observe((event, ctx) => {
 *       if (event.type === 'run_end' && event.isError) {
 *         // ship to your error reporter, metrics sink, etc.
 *       }
 *     });
 *
 * The returned function unsubscribes the listener. Most error
 * reporting and telemetry use cases register once at startup and
 * never unsubscribe — the returned function is provided for tests
 * and dynamic-wiring scenarios.
 *
 * Subscribers are invoked synchronously from the event emit path. They should
 * treat events as read-only, remain cheap, and return quickly; returned promises
 * are observed for rejection but are not awaited. Queue substantial work outside
 * the callback rather than blocking emission.
 */
declare function observe(subscriber: FlueEventSubscriber): () => void;
//#endregion
//#region src/runtime/inspect.d.ts
/**
 * Lists workflow-run summaries (`RunPointer`s) newest-first, filtered by
 * `status`/`workflowName` and paginated via the opaque `cursor` returned in
 * {@link ListRunsResponse.nextCursor}.
 */
declare function listRuns(options?: ListRunsOpts): Promise<ListRunsResponse>;
/**
 * Retrieves one workflow-run record, or `null` when no run with this id is
 * recorded.
 */
declare function getRun(runId: string): Promise<RunRecord | null>;
/** Lists the agents built into this deployment. */
declare function listAgents(): Promise<AgentManifestEntry[]>;
//#endregion
//#region src/skill-definition.d.ts
interface DefineSkillOptions {
  name: string;
  description: string;
  instructions?: string;
  license?: string;
  compatibility?: string;
  metadata?: Readonly<Record<string, string>>;
  allowedTools?: string;
  files?: Readonly<Record<string, string | Uint8Array>>;
}
declare function defineSkill(options: DefineSkillOptions): SkillReference;
//#endregion
export { type ActionContext, type ActionDefinition, type ActionInput, type ActionInputSchema, ActionInputValidationError, type ActionOutput, type ActionOutputSchema, ActionOutputSerializationError, ActionOutputValidationError, type AgentDefinition, type AgentDispatchRequest, type AgentInitializerContext, type AgentManifestEntry, type AgentProfile, type AgentRouteHandler, type AgentRuntimeConfig, type AttachedAgentEvent, AttachmentNotAvailableError, type BashFactory, type BashLike, type CallHandle, type CompactionConfig, type DefineSkillOptions, DelegationDepthExceededError, type DispatchReceipt, type DurabilityConfig, FLUE_EVENT_SCHEMA_REVISION, type FileStat, FlueError, type FlueEvent, type FlueEventContext, type FlueEventSubscriber, type FlueExecutionContext, type FlueExecutionInterceptor, type FlueExecutionOperation, type FlueFs, type FlueHarness, type FlueInstrumentation, type FlueLogger, type FlueObservation, type FlueObservationSubscriber, type FlueSession, type FlueSessions, type HttpProviderRegistration, IMAGE_DATA_OMITTED, InstrumentationAlreadyInstalledError, type JsonValue, type ListRunsOpts, type ListRunsResponse, type LlmAssistantMessage, type LlmImageContent, type LlmMessage, type LlmTextContent, type LlmThinkingContent, type LlmTool, type LlmToolCall, type LlmToolResultMessage, type LlmTurnPurpose, type LlmUserMessage, type McpServerConnection, type McpServerOptions, type McpTransport, type ModelRequest, type ModelRequestInfo, type ModelRequestInput, type ModelResponse, type NamedAgentDispatchRequest, OperationFailedError, type PackagedSkillDirectory, type PackagedSkillFile, ProductEventVersionError, type PromptImage, type PromptModel, type PromptOptions, type PromptResponse, type PromptResultResponse, type PromptUsage, type ProviderRegistration, ProviderRegistrationError, ResultUnavailableError, type RunPointer, type RunRecord, type RunStatus, type SandboxApi, type SandboxFactory, SandboxOperationUnsupportedError, SessionAlreadyExistsError, SessionBusyError, type SessionEnv, SessionNotFoundError, type SessionToolFactory, type SessionToolFactoryOptions, type ShellOptions, type ShellResult, type Skill, SkillDefinitionValidationError, SkillNotRegisteredError, type SkillOptions, type SkillReference, SubagentNotDeclaredError, SubmissionAbortedError, SubmissionInterruptedError, SubmissionRetryExhaustedError, SubmissionTimeoutError, type TaskOptions, type ThinkingLevel, type ToolContext, type ToolDefinition, type ToolInput, type ToolInputSchema, ToolInputValidationError, ToolLegacyDefinitionError, ToolNameConflictError, type ToolOutput, type ToolOutputSchema, ToolOutputSerializationError, ToolOutputValidationError, type ToolValidationIssue, type ValidationIssue, WorkflowAdmissionError, WorkflowAdmissionUnavailableError, type WorkflowDefinition, WorkflowInputSerializationError, WorkflowInputUnexpectedError, WorkflowInvocationNotConfiguredError, type WorkflowInvocationReceipt, type WorkflowInvokeRequest, WorkflowNotDiscoveredError, type WorkflowRouteHandler, type WorkflowRunPointer, type WorkflowRunsHandler, bash, connectMcpServer, createAgent, createSandboxSessionEnv, defineAction, defineAgent, defineAgentProfile, defineSkill, defineTool, defineWorkflow, dispatch, getRun, instrument, invoke, listAgents, listRuns, observe, registerApiProvider, registerProvider };
export { FRAMEWORK_TOOL_EXCLUSION_SUPPORTED };