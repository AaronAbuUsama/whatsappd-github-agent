//#region src/errors.d.ts
/**
 * Complete error framework for Flue.
 *
 * This file contains both the error vocabulary (concrete error classes) and
 * the framework utilities (renderers, type guards, request parsing helpers).
 * Previously split across `errors.ts` and `error-utils.ts`, but consolidated
 * for better LLM comprehension.
 *
 * ──── Why this file exists ────────────────────────────────────────────────
 *
 * Concentrating every error in one file is deliberate. When all errors are
 * visible together, it's easy to:
 *
 *   - Keep message tone and detail level consistent across the codebase.
 *   - Notice duplicates ("oh, we already have an error for this case").
 *   - Establish norms by example — when adding a new error, look at the
 *     neighbors above and copy the pattern.
 *
 * Application code throughout the codebase should reach for one of these
 * classes rather than constructing a `FlueError` ad hoc. If no existing class
 * fits, add one here. That's the entire convention.
 *
 * ──── Two audiences: caller vs. developer ─────────────────────────────────
 *
 * The reader of an error message is one of two distinct audiences:
 *
 *   - The *caller*: an HTTP client. Possibly third-party, possibly hostile,
 *     possibly an end user who shouldn't even know we're built on Flue.
 *     Sees `message` and `details` always.
 *
 *   - The *developer*: the human running the service (`flue dev`, `flue run`,
 *     local debugging). Sees `dev` in addition, but only when the generated
 *     runtime is configured for local development.
 *
 * Every error class must classify its prose by audience. The required-but-
 * possibly-empty shape of both `details` and `dev` is the discipline:
 * forgetting either field is a TypeScript error, and writing `''` is a
 * deliberate "I have nothing for that audience" decision.
 *
 * Concretely:
 *
 *   - `message`     One sentence. Caller-safe. Always rendered.
 *   - `details`     Longer caller-safe prose. About the request itself, the
 *                   contract, what the caller can do to fix it. Always
 *                   rendered. NEVER includes:
 *                     - sibling/neighbor enumeration (leaks namespace)
 *                     - filesystem paths or "agents/" / "skills/" / etc.
 *                       (leaks framework internals)
 *                     - source-code-level fix instructions ("add ... to your
 *                       agent definition") (caller can't act on these)
 *                     - build-time or runtime mechanics
 *   - `dev`         Longer dev-audience prose. Available alternatives,
 *                   filesystem layout, framework guidance, source-code-level
 *                   fix instructions. Rendered ONLY in local development.
 *
 * When in doubt, put information in `dev`. The default is conservative.
 *
 * ──── Conventions for new error classes ───────────────────────────────────
 *
 *   - Class name: PascalCase, suffixed with `Error`. E.g. `AgentNotFoundError`.
 *   - The class owns its `type` constant (snake_case). Set once in the
 *     subclass constructor, never passed by callers. Renaming the wire type
 *     is then a one-line change.
 *   - Constructor takes ONLY structured input data (the values used to build
 *     the message). The constructor assembles `message`, `details`, and
 *     `dev` from that data, so call sites never reinvent phrasing.
 *   - `details` and `dev` are both required strings. Pass `''` only when
 *     there's genuinely nothing more to say for that audience.
 *   - For HTTP errors, the class sets its own `status` (and `headers` where
 *     relevant). Callers do not pick HTTP status codes ad-hoc.
 *
 * Worked example (matches `AgentNotFoundError` below):
 *
 *     new AgentNotFoundError({ name, available });
 *     // builds:
 *     //   message: `Agent "foo" is not registered.`
 *     //   details: `Verify the agent name is correct.`
 *     //   dev:     `Available agents: "echo", "greeter". Agents are
 *     //            loaded from the project root's "agents/" directory at
 *     //            build time. ...`
 *
 * The wire response in production omits `dev`; in `flue dev` / `flue run`
 * it includes `dev`. That separation is what lets the dev field be richly
 * helpful without leaking namespace state to public callers.
 *
 * Counter-example to avoid:
 *
 *     class AgentNotFoundError extends FlueHttpError {
 *       constructor(message: string) {                       // ✗ free-form
 *         super({                                            // ✗ wrong type
 *           type: 'agent_error',
 *           message,
 *           details: 'Available: "x", "y", "z"',             // ✗ leaks names
 *           dev: '',                                         // ✗ wasted field
 *           status: 500,                                     // ✗ wrong status
 *         });
 *       }
 *     }
 *
 * The structured-constructor pattern below is what prevents that drift.
 */
interface FlueErrorOptions {
  /**
   * Stable, machine-readable identifier (snake_case). Set once per subclass.
   * Callers don't pass this — the subclass constructor does.
   */
  type: string;
  /**
   * One-sentence summary of what went wrong. Caller-safe — always rendered
   * on the wire.
   */
  message: string;
  /**
   * Caller-audience longer-form explanation. Always rendered on the wire.
   *
   * Must be safe to expose to any HTTP client, including third-party or
   * hostile callers. Do NOT include sibling enumeration, filesystem paths,
   * framework-internal mechanics, or source-code fix instructions — those
   * belong in `dev`.
   *
   * Required: pass `''` only when there's genuinely nothing more to say to
   * the caller. The required-but-possibly-empty shape is intentional — it
   * forces a deliberate decision rather than a thoughtless omission.
   */
  details: string;
  /**
   * Developer-audience longer-form explanation. Rendered on the wire ONLY
   * when the generated runtime is configured for local development.
   *
   * Use this for everything that helps the developer running the service
   * but shouldn't reach a public caller: available alternatives, filesystem
   * paths, framework guidance, source-code fix instructions, configuration
   * hints.
   *
   * Required: pass `''` only when there's genuinely nothing dev-specific
   * to add (e.g. a malformed-JSON error has nothing to say to the dev that
   * isn't already in `details`).
   */
  dev: string;
  /**
   * Optional structured machine-readable data. Use only when downstream
   * tooling genuinely benefits — most errors should leave this unset.
   */
  meta?: Record<string, unknown>;
  /**
   * The underlying error, when wrapping. Logged server-side; never sent
   * over the wire.
   */
  cause?: unknown;
}
/**
 * Base class for every error Flue throws. Do not instantiate directly in
 * application code — extend it via a subclass below. If a use case isn't
 * covered, add a new subclass here rather than throwing a raw `FlueError`.
 *
 * Exported (and re-exported from the package root) as the catchable base:
 * application code distinguishes Flue failures from arbitrary errors with
 * `err instanceof FlueError`, then narrows via the concrete subclasses or
 * the stable `type` field. Message strings are not API.
 */
declare class FlueError extends Error {
  readonly type: string;
  readonly details: string;
  readonly dev: string;
  readonly meta: Record<string, unknown> | undefined;
  readonly cause: unknown;
  constructor(options: FlueErrorOptions);
}
interface FlueHttpErrorOptions extends FlueErrorOptions {
  /** HTTP status code (4xx or 5xx). */
  status: number;
  /** Additional response headers (e.g. `Allow` for 405). */
  headers?: Record<string, string>;
}
/**
 * Base class for HTTP-layer errors. Adds `status` and optional `headers`.
 * Subclasses set these in the `super({...})` call so the call site doesn't
 * have to think about HTTP semantics.
 */
declare class FlueHttpError extends FlueError {
  readonly status: number;
  readonly headers: Record<string, string> | undefined;
  constructor(options: FlueHttpErrorOptions);
}
declare class RuntimeUnavailableError extends FlueHttpError {
  constructor({
    state
  }: {
    state: 'loading' | 'draining' | 'failed';
  });
}
/**
 * A persisted store records a schema/format version this runtime does not
 * support. Thrown when opening a database stamped by a newer Flue version
 * (e.g. after a rollback) or carrying an unrecognized version marker.
 *
 * Not an HTTP error — this fires when a store is opened (startup, adapter
 * `migrate()`, Durable Object initialization), before any request is served.
 */
declare class ProductEventVersionError extends FlueError {
  constructor({
    storedVersion
  }: {
    storedVersion: unknown;
  });
}
declare class ConversationStreamStoreError extends FlueError {
  constructor({
    operation,
    path,
    reason
  }: {
    operation: string;
    path: string;
    reason: string;
  });
}
declare class AttachmentConflictError extends FlueError {
  constructor({
    path,
    attachmentId
  }: {
    path: string;
    attachmentId: string;
  });
}
declare class AttachmentIntegrityError extends FlueError {
  constructor({
    attachmentId,
    reason
  }: {
    attachmentId: string;
    reason: 'size' | 'digest' | 'chunks';
  });
}
declare class PersistedSchemaVersionError extends FlueError {
  constructor({
    storedVersion,
    supportedVersion
  }: {
    storedVersion: string;
    supportedVersion: number;
  });
}
declare class InstrumentationAlreadyInstalledError extends FlueError {
  constructor();
}
declare class SandboxOperationUnsupportedError extends FlueError {
  constructor({
    operation,
    provider,
    options
  }: {
    operation: string;
    provider: string;
    options: readonly string[];
  });
}
declare class SessionNotFoundError extends FlueError {
  constructor({
    session,
    harness
  }: {
    session: string;
    harness: string;
  });
}
declare class SessionAlreadyExistsError extends FlueError {
  constructor({
    session,
    harness
  }: {
    session: string;
    harness: string;
  });
}
declare class SessionBusyError extends FlueError {
  constructor({
    session,
    activeOperation
  }: {
    session: string;
    activeOperation: string;
  });
}
declare class SkillDefinitionValidationError extends FlueError {
  constructor({
    issues
  }: {
    issues: readonly ValidationIssue[];
  });
}
declare class SkillNotRegisteredError extends FlueError {
  constructor({
    skill,
    available,
    skillsDir
  }: {
    skill: string;
    available: readonly string[];
    skillsDir: string;
  });
}
declare class ProviderRegistrationError extends FlueError {
  constructor({
    providerId
  }: {
    providerId: string;
  });
}
declare class DelegationDepthExceededError extends FlueError {
  constructor({
    maxDepth
  }: {
    maxDepth: number;
  });
}
declare class SubagentNotDeclaredError extends FlueError {
  constructor({
    subagent,
    available
  }: {
    subagent: string;
    available: readonly string[];
  });
}
declare class AttachmentNotAvailableError extends FlueError {
  constructor({
    attachmentId
  }: {
    attachmentId: string;
  });
}
declare class ToolNameConflictError extends FlueError {
  constructor({
    name,
    conflict,
    source,
    reserved
  }: {
    name: string;
    conflict: 'reserved' | 'duplicate';
    source: 'builtin' | 'adapter' | 'framework' | 'custom' | 'action' | 'result';
    reserved?: readonly string[];
  });
}
/**
 * One validation failure from a tool-arguments schema, in Standard Schema's
 * issues shape (https://standardschema.dev). `path` segments are the property
 * keys leading to the failing value.
 */
interface ValidationIssue {
  readonly message: string;
  readonly path?: readonly PropertyKey[];
}
type ToolValidationIssue = ValidationIssue;
declare abstract class ActionValidationError extends FlueError {
  constructor({
    action,
    boundary,
    issues
  }: {
    action: string;
    boundary: 'input' | 'output';
    issues: readonly ValidationIssue[];
  });
}
declare class ActionInputValidationError extends ActionValidationError {
  constructor({
    action,
    issues
  }: {
    action: string;
    issues: readonly ValidationIssue[];
  });
}
declare class ActionOutputValidationError extends ActionValidationError {
  constructor({
    action,
    issues
  }: {
    action: string;
    issues: readonly ValidationIssue[];
  });
}
declare class ActionOutputSerializationError extends FlueError {
  constructor({
    action,
    cause
  }: {
    action: string;
    cause?: unknown;
  });
}
declare class WorkflowInvocationNotConfiguredError extends FlueError {
  constructor();
}
declare class WorkflowNotDiscoveredError extends FlueError {
  constructor();
}
declare class WorkflowInputUnexpectedError extends FlueError {
  constructor();
}
declare class WorkflowInputSerializationError extends FlueError {
  constructor({
    cause
  }: {
    cause: unknown;
  });
}
declare class WorkflowAdmissionUnavailableError extends FlueError {
  constructor();
}
declare class WorkflowAdmissionError extends FlueError {
  constructor({
    workflow,
    cause
  }: {
    workflow: string;
    cause: unknown;
  });
}
/**
 * Model-supplied tool arguments failed the tool's valibot `parameters`
 * schema. Thrown from the tool's wrapped `execute`; the agent loop converts
 * the throw into an error tool-result built from `message`, so the model sees
 * the issues and can retry with corrected arguments. `meta.issues` carries
 * the structured issues in Standard Schema's shape.
 */
declare class ToolLegacyDefinitionError extends FlueError {
  constructor({
    fields
  }: {
    fields: readonly string[];
  });
}
declare class ToolInputValidationError extends FlueError {
  constructor({
    tool,
    issues
  }: {
    tool: string;
    issues: readonly ToolValidationIssue[];
  });
}
declare class ToolOutputValidationError extends FlueError {
  constructor({
    tool,
    issues
  }: {
    tool: string;
    issues: readonly ToolValidationIssue[];
  });
}
declare class ToolOutputSerializationError extends FlueError {
  constructor({
    tool,
    cause
  }: {
    tool: string;
    cause?: unknown;
  });
}
/**
 * A session operation ran but did not complete successfully — the underlying
 * model call errored, or a durable input could not be persisted or recovered.
 * `reason` carries the underlying failure text; it is part of the message so
 * logs and serialized events stay informative, but it is prose, not API.
 */
declare class OperationFailedError extends FlueError {
  constructor({
    operation,
    reason
  }: {
    operation: string;
    reason: string;
  });
}
/**
 * A durable submission was interrupted (process crash, restart, or shutdown)
 * and recovery settled it as failed because resuming or replaying the work
 * was not provably safe. `meta.phase` carries where the interruption left
 * the submission:
 *
 * - `'retry_exhausted_before_input'` — every attempt was interrupted while
 *   the submission was claimed but unstarted, and the shared attempt budget
 *   ran out. No provider work ever happened, so the generic retry-exhaustion
 *   error would misdescribe the failure; the shared `attemptCount`/
 *   `maxAttempts` budget itself is intentional.
 * - `'before_input_marker'` — interrupted with inconsistent pre-marker state
 *   that canonical replay could not safely repair.
 * - `'after_input_application'` — interrupted after input application
 *   without a completed response that recovery could safely resume. When the
 *   interruption left tool calls whose outcomes could not be confirmed,
 *   `meta.interruptedTools` lists them; an unresolved tool call is never
 *   assumed to have completed and is never retried automatically.
 */
declare class SubmissionInterruptedError extends FlueError {
  constructor(input: {
    phase: 'retry_exhausted_before_input';
    attemptCount: number;
    maxAttempts: number;
  } | {
    phase: 'before_input_marker';
  } | {
    phase: 'after_input_application';
    interruptedTools?: ReadonlyArray<{
      readonly name: string;
      readonly id: string;
    }>;
  });
}
/**
 * A durable submission exhausted its recovery attempt budget after its input
 * was applied: repeated attempts (interruption, restart, or transient
 * failure) consumed `maxAttempts` without a completed response.
 */
declare class SubmissionRetryExhaustedError extends FlueError {
  constructor({
    attemptCount,
    maxAttempts
  }: {
    attemptCount: number;
    maxAttempts: number;
  });
}
/** A durable submission exceeded its configured processing timeout. */
declare class SubmissionTimeoutError extends FlueError {
  constructor();
}
/**
 * A durable submission was aborted. Abort is requested per agent instance
 * (`abort(name, id)`), stops all in-flight and queued work for that instance,
 * and is a distinct terminal outcome — not a failure. A submission that has
 * already settled (or committed its terminal record) is never aborted; an abort
 * that loses the race to a completed response settles as completed instead.
 *
 * Delivered to a waiting `wait()`/observer and recorded as the durable terminal
 * outcome: a `submission_aborted` conversation advisory (both kinds) plus, for
 * direct submissions, a `submission_settled` record with `outcome: 'aborted'`.
 */
declare class SubmissionAbortedError extends FlueError {
  constructor();
}
/**
 * Render any thrown value into a `Response` with the canonical Flue error
 * envelope. Unknown / non-Flue errors are logged in full and rendered as a
 * generic 500 with no message leaked.
 */
declare function toHttpResponse(err: unknown): Response;
//#endregion
export { ToolOutputSerializationError as A, toHttpResponse as B, SubmissionAbortedError as C, ToolInputValidationError as D, SubmissionTimeoutError as E, WorkflowAdmissionUnavailableError as F, WorkflowInputSerializationError as I, WorkflowInputUnexpectedError as L, ToolValidationIssue as M, ValidationIssue as N, ToolLegacyDefinitionError as O, WorkflowAdmissionError as P, WorkflowInvocationNotConfiguredError as R, SubagentNotDeclaredError as S, SubmissionRetryExhaustedError as T, SessionAlreadyExistsError as _, AttachmentIntegrityError as a, SkillDefinitionValidationError as b, DelegationDepthExceededError as c, OperationFailedError as d, PersistedSchemaVersionError as f, SandboxOperationUnsupportedError as g, RuntimeUnavailableError as h, AttachmentConflictError as i, ToolOutputValidationError as j, ToolNameConflictError as k, FlueError as l, ProviderRegistrationError as m, ActionOutputSerializationError as n, AttachmentNotAvailableError as o, ProductEventVersionError as p, ActionOutputValidationError as r, ConversationStreamStoreError as s, ActionInputValidationError as t, InstrumentationAlreadyInstalledError as u, SessionBusyError as v, SubmissionInterruptedError as w, SkillNotRegisteredError as x, SessionNotFoundError as y, WorkflowNotDiscoveredError as z };