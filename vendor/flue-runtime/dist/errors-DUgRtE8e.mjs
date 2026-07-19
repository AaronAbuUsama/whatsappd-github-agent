//#region src/errors.ts
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
/**
* Format a list of items for inclusion in error details. Empty lists render
* as the supplied fallback (default `(none)`), so messages read naturally
* regardless of whether anything is registered.
*
* Module-private: only used by the concrete error subclasses below. Promote
* to `export` if/when a real cross-file caller appears.
*/
function formatList(items, fallback = "(none)") {
	if (items.length === 0) return fallback;
	return items.map((item) => `"${String(item)}"`).join(", ");
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
var FlueError = class extends Error {
	type;
	details;
	dev;
	meta;
	cause;
	constructor(options) {
		super(options.message);
		this.name = "FlueError";
		this.type = options.type;
		this.details = options.details;
		this.dev = options.dev;
		this.meta = options.meta;
		this.cause = options.cause;
	}
};
/**
* Base class for HTTP-layer errors. Adds `status` and optional `headers`.
* Subclasses set these in the `super({...})` call so the call site doesn't
* have to think about HTTP semantics.
*/
var FlueHttpError = class extends FlueError {
	status;
	headers;
	constructor(options) {
		super(options);
		this.name = "FlueHttpError";
		this.status = options.status;
		this.headers = options.headers;
	}
};
var RuntimeUnavailableError = class extends FlueHttpError {
	constructor({ state }) {
		super({
			type: "runtime_unavailable",
			message: "The local runtime is temporarily unavailable.",
			details: "Retry after the runtime finishes reloading.",
			dev: "",
			status: 503,
			headers: { "Retry-After": "1" },
			meta: { state }
		});
	}
};
var MethodNotAllowedError = class extends FlueHttpError {
	constructor({ method, allowed }) {
		super({
			type: "method_not_allowed",
			message: `HTTP method ${method} is not allowed on this endpoint.`,
			details: `This endpoint accepts ${formatList(allowed)} only.`,
			dev: "",
			status: 405,
			headers: { Allow: allowed.join(", ") }
		});
	}
};
var UnsupportedMediaTypeError = class extends FlueHttpError {
	constructor({ received }) {
		const detailLines = [];
		if (received) detailLines.push(`Received Content-Type: "${received}".`);
		else detailLines.push(`No Content-Type header was sent.`);
		detailLines.push("Send the request body as JSON with the header \"Content-Type: application/json\", or omit the body entirely (and the Content-Type header) if the request doesn't have a payload.");
		super({
			type: "unsupported_media_type",
			message: `Request body must be sent as application/json.`,
			details: detailLines.join("\n"),
			dev: "",
			status: 415
		});
	}
};
var InvalidJsonError = class extends FlueHttpError {
	constructor({ parseError }) {
		super({
			type: "invalid_json",
			message: `Request body is not valid JSON.`,
			details: `The JSON parser reported: ${parseError}\nVerify the body is well-formed JSON, or omit the body entirely if the request doesn't have a payload.`,
			dev: "",
			status: 400
		});
	}
};
var AgentNotFoundError = class extends FlueHttpError {
	constructor({ name, available }) {
		super({
			type: "agent_not_found",
			message: `Agent "${name}" is not registered.`,
			details: `Verify the agent name is correct.`,
			dev: `Available agents: ${formatList(available)}.\nAgents are loaded from the project root's "agents/" directory at build time. Verify the agent file is present in the project root being served.`,
			status: 404
		});
	}
};
var WorkflowNotFoundError = class extends FlueHttpError {
	constructor({ name, available, notHttp = false }) {
		super({
			type: "workflow_not_found",
			message: `Workflow "${name}" is not registered.`,
			details: `Verify the workflow name is correct.`,
			dev: notHttp ? `Workflow "${name}" is built but not exposed over HTTP. To expose it, export route middleware and call await next() to enter the workflow handler.` : `Available workflows: ${formatList(available)}.\nWorkflows are loaded from the project root's "workflows/" directory at build time.`,
			status: 404
		});
	}
};
var RouteNotFoundError = class extends FlueHttpError {
	constructor({ method, path }) {
		super({
			type: "route_not_found",
			message: `No route matches ${method} ${path}.`,
			details: `Verify the request method and path are correct.`,
			dev: "",
			status: 404
		});
	}
};
var RunNotFoundError = class extends FlueHttpError {
	constructor({ runId }) {
		super({
			type: "run_not_found",
			message: `Run "${runId}" was not found.`,
			details: "Verify the run id is correct and its history is still available.",
			dev: "",
			status: 404
		});
	}
};
var StreamNotFoundError = class extends FlueHttpError {
	constructor({ path }) {
		super({
			type: "stream_not_found",
			message: `Event stream "${path}" was not found.`,
			details: "Streams are created when their agent instance receives its first prompt or their workflow run starts.",
			dev: "",
			status: 404
		});
	}
};
/**
* The attachments endpoint exists but the agent module did not export an
* `attachments` middleware, so byte downloads are not exposed. Rendered as a
* plain 404 in production (indistinguishable from any other unmatched route);
* in dev the `dev` field explains how to opt in.
*/
var AttachmentsNotExposedError = class extends FlueHttpError {
	constructor({ method, path, agentName }) {
		super({
			type: "route_not_found",
			message: `No route matches ${method} ${path}.`,
			details: "Verify the request method and path are correct.",
			dev: `Attachment downloads are opt-in. Export an \`attachments\` Hono middleware from agents/${agentName}.ts to expose GET /agents/${agentName}/:id/attachments/:attachmentId; use it to authorize and scope access. Without it this endpoint returns 404.`,
			status: 404
		});
	}
};
var AttachmentNotFoundError = class extends FlueHttpError {
	constructor({ attachmentId }) {
		super({
			type: "attachment_not_found",
			message: `Attachment "${attachmentId}" was not found.`,
			details: "The attachment id may be incorrect, or it belongs to a conversation other than the default one.",
			dev: "",
			status: 404
		});
	}
};
var RunStoreUnavailableError = class extends FlueHttpError {
	constructor() {
		super({
			type: "run_store_unavailable",
			message: "Run history is not available in this runtime.",
			details: "This endpoint requires the generated runtime to be configured with a run store.",
			dev: "",
			status: 501
		});
	}
};
var InvalidRequestError = class extends FlueHttpError {
	constructor({ reason }) {
		super({
			type: "invalid_request",
			message: `Request is malformed.`,
			details: reason,
			dev: "",
			status: 400
		});
	}
};
/**
* A persisted store records a schema/format version this runtime does not
* support. Thrown when opening a database stamped by a newer Flue version
* (e.g. after a rollback) or carrying an unrecognized version marker.
*
* Not an HTTP error — this fires when a store is opened (startup, adapter
* `migrate()`, Durable Object initialization), before any request is served.
*/
var ProductEventVersionError = class extends FlueError {
	constructor({ storedVersion }) {
		super({
			type: "product_event_version_unsupported",
			message: `Persisted product event version ${String(storedVersion)} is unsupported.`,
			details: "The persisted event cannot be read or replayed safely by this runtime.",
			dev: "Clear historical event and terminal-outbox data created by an earlier Flue beta.",
			meta: {
				storedVersion,
				supportedVersion: 3
			}
		});
	}
};
var ConversationRecordInvariantError = class extends FlueError {
	constructor({ recordId, recordType, reason }) {
		super({
			type: "conversation_record_invariant",
			message: "A canonical conversation record violates the conversation stream contract.",
			details: "The persisted conversation cannot be reduced safely.",
			dev: reason,
			meta: {
				recordId,
				recordType,
				reason
			}
		});
		this.name = "ConversationRecordInvariantError";
	}
};
var ConversationStreamStoreError = class extends FlueError {
	constructor({ operation, path, reason }) {
		super({
			type: "conversation_stream_store_failure",
			message: "The canonical conversation stream operation could not be completed.",
			details: "The conversation stream remains unchanged when the operation was rejected.",
			dev: reason,
			meta: {
				operation,
				path,
				reason
			}
		});
		this.name = "ConversationStreamStoreError";
	}
};
var AttachmentConflictError = class extends FlueError {
	constructor({ path, attachmentId }) {
		super({
			type: "attachment_conflict",
			message: "The attachment identity conflicts with persisted attachment data.",
			details: "Use a new attachment identity or retry with the exact original attachment.",
			dev: `Attachment "${attachmentId}" in canonical stream "${path}" was reused with different content, metadata, or ownership.`,
			meta: {
				path,
				attachmentId
			}
		});
		this.name = "AttachmentConflictError";
	}
};
var AttachmentIntegrityError = class extends FlueError {
	constructor({ attachmentId, reason }) {
		super({
			type: "attachment_integrity",
			message: "The attachment bytes failed integrity verification.",
			details: "The attachment cannot be used safely.",
			dev: `Attachment "${attachmentId}" has a ${reason} mismatch.`,
			meta: {
				attachmentId,
				reason
			}
		});
		this.name = "AttachmentIntegrityError";
	}
};
var PersistedSchemaVersionError = class extends FlueError {
	constructor({ storedVersion, supportedVersion }) {
		const numeric = /^[0-9]+$/.test(storedVersion) ? Number(storedVersion) : void 0;
		const newer = numeric !== void 0 && numeric > supportedVersion;
		super({
			type: "persisted_schema_version_unsupported",
			message: newer ? `This database was created by a newer Flue version (schema version ${storedVersion}; this runtime supports version ${supportedVersion}).` : `This database records an unrecognized schema version ("${storedVersion}"; this runtime supports version ${supportedVersion}).`,
			details: "The persisted data cannot be read safely by this runtime.",
			dev: newer ? `Upgrade Flue to a version that supports schema version ${storedVersion}, or point the runtime at a different database.` : "The \"schema_version\" row in the flue_meta table is not a version this runtime recognizes. Restore the database, or point the runtime at a different one.",
			meta: {
				storedVersion,
				supportedVersion
			}
		});
	}
};
var InstrumentationAlreadyInstalledError = class extends FlueError {
	constructor() {
		super({
			type: "instrumentation_already_installed",
			message: "An instrumentation owner of this kind is already installed.",
			details: "Dispose the active instrumentation before installing its replacement.",
			dev: ""
		});
		this.name = "InstrumentationAlreadyInstalledError";
	}
};
var SandboxOperationUnsupportedError = class extends FlueError {
	constructor({ operation, provider, options }) {
		super({
			type: "sandbox_operation_unsupported",
			message: `${provider} does not support ${operation} with ${formatList(options)}.`,
			details: "The requested operation was rejected before the filesystem was modified.",
			dev: "Use an adapter that implements these options exactly, or issue an operation supported by this provider.",
			meta: {
				operation,
				provider,
				options: [...options]
			}
		});
	}
};
var SessionNotFoundError = class extends FlueError {
	constructor({ session, harness }) {
		super({
			type: "session_not_found",
			message: `Session "${session}" does not exist in harness "${harness}".`,
			details: "Verify the session name is correct, or create the session first.",
			dev: "`sessions.get()` never creates sessions. Use `harness.session(name)` to get-or-create, or `sessions.create(name)` to create explicitly."
		});
	}
};
var SessionAlreadyExistsError = class extends FlueError {
	constructor({ session, harness }) {
		super({
			type: "session_already_exists",
			message: `Session "${session}" already exists in harness "${harness}".`,
			details: "Choose a different session name, or open the existing session instead.",
			dev: "`sessions.create()` requires an unused name. Use `harness.session(name)` to get-or-create."
		});
	}
};
var SessionBusyError = class extends FlueError {
	constructor({ session, activeOperation }) {
		super({
			type: "session_busy",
			message: `Session "${session}" is busy running ${activeOperation}.`,
			details: "Wait for the active operation to finish before starting another operation.",
			dev: "Sessions run one operation at a time. Start another session for parallel conversation branches."
		});
	}
};
var SkillDefinitionValidationError = class extends FlueError {
	constructor({ issues }) {
		super({
			type: "skill_definition_validation",
			message: "Skill definition is invalid.",
			details: "Correct the invalid skill fields and try again.",
			dev: "Pass a valid Agent Skills definition to defineSkill().",
			meta: { issues }
		});
		this.name = "SkillDefinitionValidationError";
	}
};
var SkillNotRegisteredError = class extends FlueError {
	constructor({ skill, available, skillsDir }) {
		super({
			type: "skill_not_registered",
			message: `Skill "${skill}" is not registered.`,
			details: "Verify the skill name is correct.",
			dev: `Available skills: ${formatList(available)}.\nSkills are discovered at init() time from ${skillsDir}/<name>/SKILL.md inside the session's sandbox. If you expected "${skill}" to be there, make sure the SKILL.md file exists at that path before calling init() — the default empty sandbox starts with no files, so it has no skills unless you put them there.\nPackaged skills can be imported from SKILL.md with { type: 'skill' } and passed directly to session.skill(skillReference).`
		});
	}
};
var ProviderRegistrationError = class extends FlueError {
	constructor({ providerId }) {
		super({
			type: "invalid_provider_registration",
			message: `Provider "${providerId}" cannot be registered without \`api\` and \`baseUrl\`.`,
			details: `"${providerId}" is not a catalog provider, so its registration must say which wire protocol and endpoint to use.`,
			dev: "Pass `api` and `baseUrl` in the registerProvider() options. They are only optional when the provider id is a built-in catalog provider, in which case the registration hydrates from the catalog.",
			meta: { providerId }
		});
	}
};
var CloudflareAIBindingError = class extends FlueError {
	constructor({ message, status, statusText, body }) {
		const statusLabel = status === void 0 ? void 0 : `${status}${statusText ? ` ${statusText}` : ""}`;
		super({
			type: "cloudflare_ai_binding_error",
			message: message ?? `Cloudflare AI binding request failed${statusLabel ? ` with ${statusLabel}` : ""}.`,
			details: body ? `Provider response: ${body}` : "",
			dev: "",
			meta: {
				...status !== void 0 ? { status } : {},
				...statusText ? { statusText } : {}
			}
		});
	}
};
var DelegationDepthExceededError = class extends FlueError {
	constructor({ maxDepth }) {
		super({
			type: "delegation_depth_exceeded",
			message: `Maximum delegation depth (${maxDepth}) exceeded.`,
			details: "The chain of delegated Tasks and Actions is too deep.",
			dev: "Each nested task() or Action delegation adds one level. Restructure the agents to delegate less deeply."
		});
	}
};
var SubagentNotDeclaredError = class extends FlueError {
	constructor({ subagent, available }) {
		super({
			type: "subagent_not_declared",
			message: `Subagent "${subagent}" is not declared.`,
			details: "Verify the subagent name is correct.",
			dev: `Available subagents: ${formatList(available)}.\nDeclare subagents in the agent definition's \`subagents\` array.`
		});
	}
};
var AttachmentNotAvailableError = class extends FlueError {
	constructor({ attachmentId }) {
		super({
			type: "attachment_not_available",
			message: `Attachment "${attachmentId}" is not available in this session.`,
			details: "The delegated task can only receive attachments visible in its calling session.",
			dev: "Pass an attachment ID from the current conversation attachment manifest.",
			meta: { attachmentId }
		});
	}
};
var ToolNameConflictError = class extends FlueError {
	constructor({ name, conflict, source, reserved }) {
		const dev = source === "adapter" ? conflict === "reserved" ? `The sandbox adapter's tools() returned "${name}", which the framework appends automatically when appropriate; remove it from the adapter.` : `The sandbox adapter's tools() returned the name "${name}" more than once; sandbox adapter tool names must be unique.` : conflict === "reserved" ? `Framework-reserved tool names: ${formatList(reserved ?? [])}. Rename the custom tool.` : "Rename one of the conflicting custom tools.";
		super({
			type: "tool_name_conflict",
			message: conflict === "reserved" ? `Tool name "${name}" is reserved by the framework.` : `Duplicate tool name "${name}".`,
			details: "Tool names must be unique and must not use framework-reserved names.",
			dev
		});
	}
};
var ActionValidationError = class extends FlueError {
	constructor({ action, boundary, issues }) {
		super({
			type: `action_${boundary}_validation`,
			message: `Action "${action}" ${boundary} does not match the required schema.`,
			details: "",
			dev: "",
			meta: {
				action,
				issues
			}
		});
	}
};
var ActionInputValidationError = class extends ActionValidationError {
	constructor({ action, issues }) {
		super({
			action,
			boundary: "input",
			issues
		});
		this.name = "ActionInputValidationError";
	}
};
var ActionOutputValidationError = class extends ActionValidationError {
	constructor({ action, issues }) {
		super({
			action,
			boundary: "output",
			issues
		});
		this.name = "ActionOutputValidationError";
	}
};
var ActionOutputSerializationError = class extends FlueError {
	constructor({ action, cause }) {
		super({
			type: "action_output_serialization",
			message: `Action "${action}" output is not JSON-serializable.`,
			details: "",
			dev: "Return a JSON-serializable value, or undefined when the Action has no output schema.",
			meta: { action },
			cause
		});
		this.name = "ActionOutputSerializationError";
	}
};
var WorkflowInvocationNotConfiguredError = class extends FlueError {
	constructor() {
		super({
			type: "workflow_invocation_not_configured",
			message: "Workflow invocation is not configured in this runtime.",
			details: "",
			dev: "Call invoke() from a Flue-built server entry."
		});
		this.name = "WorkflowInvocationNotConfiguredError";
	}
};
var WorkflowNotDiscoveredError = class extends FlueError {
	constructor() {
		super({
			type: "workflow_not_discovered",
			message: "The workflow is not registered in this application.",
			details: "",
			dev: "invoke() accepts the exact Workflow Definition value default-exported by one discovered workflow module."
		});
		this.name = "WorkflowNotDiscoveredError";
	}
};
var WorkflowInputUnexpectedError = class extends FlueError {
	constructor() {
		super({
			type: "workflow_input_unexpected",
			message: "This workflow does not accept input.",
			details: "",
			dev: "Remove the input value from invoke() for a workflow whose Action has no input schema."
		});
		this.name = "WorkflowInputUnexpectedError";
	}
};
var WorkflowInputSerializationError = class extends FlueError {
	constructor({ cause }) {
		super({
			type: "workflow_input_serialization",
			message: "Workflow input is not JSON-serializable.",
			details: "",
			dev: "Pass a plain JSON value as invoke().input.",
			cause
		});
		this.name = "WorkflowInputSerializationError";
	}
};
var WorkflowAdmissionUnavailableError = class extends FlueError {
	constructor() {
		super({
			type: "workflow_admission_unavailable",
			message: "Workflow admission is not available in this runtime.",
			details: "",
			dev: "The generated runtime did not configure a workflow admission hook."
		});
		this.name = "WorkflowAdmissionUnavailableError";
	}
};
var WorkflowAdmissionError = class extends FlueError {
	constructor({ workflow, cause }) {
		super({
			type: "workflow_admission_failed",
			message: "Workflow admission failed.",
			details: "",
			dev: `The generated runtime could not admit workflow "${workflow}".`,
			meta: { workflow },
			cause
		});
		this.name = "WorkflowAdmissionError";
	}
};
/**
* Model-supplied tool arguments failed the tool's valibot `parameters`
* schema. Thrown from the tool's wrapped `execute`; the agent loop converts
* the throw into an error tool-result built from `message`, so the model sees
* the issues and can retry with corrected arguments. `meta.issues` carries
* the structured issues in Standard Schema's shape.
*/
var ToolLegacyDefinitionError = class extends FlueError {
	constructor({ fields }) {
		super({
			type: "tool_legacy_definition",
			message: "This tool uses the unsupported legacy definition format.",
			details: "The tool definition contains legacy fields.",
			dev: "defineTool() no longer supports { parameters, execute }. Rename parameters to input, rename execute to run, and return structured data directly. Flue validates output and JSON-serializes it for the model.",
			meta: { fields: [...fields] }
		});
		this.name = "ToolLegacyDefinitionError";
	}
};
var ToolInputValidationError = class extends FlueError {
	constructor({ tool, issues }) {
		const summary = issues.map((issue) => issue.path && issue.path.length > 0 ? `${issue.message} (at ${issue.path.map(String).join(".")})` : issue.message).join("; ");
		super({
			type: "tool_input_validation",
			message: `Arguments for tool "${tool}" do not match the required schema: ${summary}. Call the tool again with corrected arguments.`,
			details: "",
			dev: "",
			meta: {
				tool,
				issues
			}
		});
		this.name = "ToolInputValidationError";
	}
};
var ToolOutputValidationError = class extends FlueError {
	constructor({ tool, issues }) {
		super({
			type: "tool_output_validation",
			message: `Tool "${tool}" output does not match the required schema.`,
			details: "",
			dev: "",
			meta: {
				tool,
				issues
			}
		});
		this.name = "ToolOutputValidationError";
	}
};
var ToolOutputSerializationError = class extends FlueError {
	constructor({ tool, cause }) {
		super({
			type: "tool_output_serialization",
			message: `Tool "${tool}" output is not JSON-serializable.`,
			details: "",
			dev: "Return a JSON-serializable value, or undefined when the Tool has no output schema.",
			meta: { tool },
			cause
		});
		this.name = "ToolOutputSerializationError";
	}
};
/**
* A session operation ran but did not complete successfully — the underlying
* model call errored, or a durable input could not be persisted or recovered.
* `reason` carries the underlying failure text; it is part of the message so
* logs and serialized events stay informative, but it is prose, not API.
*/
var OperationFailedError = class extends FlueError {
	constructor({ operation, reason }) {
		super({
			type: "operation_failed",
			message: `${operation} failed: ${reason}`,
			details: "",
			dev: ""
		});
	}
};
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
var SubmissionInterruptedError = class extends FlueError {
	constructor(input) {
		if (input.phase === "retry_exhausted_before_input") super({
			type: "submission_interrupted",
			message: "Submission was repeatedly interrupted before input application and exhausted its retry budget.",
			details: "Every processing attempt was interrupted before the submission input was applied to the session. The input was never processed and no model call was started.",
			dev: "Repeated pre-input interruptions usually mean the process kept restarting or crashing while the submission waited to start. Each claim consumes one attempt from the agent definition's `durability.maxAttempts` budget.",
			meta: {
				phase: input.phase,
				attemptCount: input.attemptCount,
				maxAttempts: input.maxAttempts
			}
		});
		else if (input.phase === "before_input_marker") super({
			type: "submission_interrupted",
			message: "Submission was interrupted before input application could be safely recovered.",
			details: "The canonical conversation and operational marker did not provide a safe recoverable input state. The input was not replayed.",
			dev: "",
			meta: { phase: input.phase }
		});
		else {
			const toolNames = input.interruptedTools?.map((tool) => tool.name) ?? [];
			super({
				type: "submission_interrupted",
				message: toolNames.length > 0 ? `Submission was interrupted with pending tool call(s): ${toolNames.join(", ")}. The tool outcome could not be confirmed and the tool was not automatically retried.` : "Submission was interrupted after input application without a completed response. The work was not automatically replayed.",
				details: "Recovery settles interrupted work as failed when it cannot prove that resuming or replaying is safe: a repeated model or tool call could duplicate external effects.",
				dev: "",
				meta: {
					phase: input.phase,
					...input.interruptedTools ? { interruptedTools: input.interruptedTools } : {}
				}
			});
		}
	}
};
/**
* A durable submission exhausted its recovery attempt budget after its input
* was applied: repeated attempts (interruption, restart, or transient
* failure) consumed `maxAttempts` without a completed response.
*/
var SubmissionRetryExhaustedError = class extends FlueError {
	constructor({ attemptCount, maxAttempts }) {
		super({
			type: "submission_retry_exhausted",
			message: `Submission exceeded maximum recovery attempts (${attemptCount}/${maxAttempts}).`,
			details: "Recovery re-attempted the interrupted submission until its attempt budget ran out without a completed response.",
			dev: "The budget is configured via the agent definition's `durability.maxAttempts`.",
			meta: {
				attemptCount,
				maxAttempts
			}
		});
	}
};
/** A durable submission exceeded its configured processing timeout. */
var SubmissionTimeoutError = class extends FlueError {
	constructor() {
		super({
			type: "submission_timeout",
			message: "Submission exceeded the configured timeout.",
			details: "The operation ran longer than the configured durability timeout.",
			dev: "The timeout is configured in milliseconds via the agent definition's `durability.timeoutMs`."
		});
	}
};
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
var SubmissionAbortedError = class extends FlueError {
	constructor() {
		super({
			type: "submission_aborted",
			message: "Submission was aborted.",
			details: "The operation was stopped before it produced a completed response.",
			dev: ""
		});
	}
};
/**
* Error framework utilities: renderers, type guards, request parsing helpers.
*
* Wire envelope (HTTP body + SSE `data:` payload for error events):
*
*     {
*       "error": {
*         "type":    "...",
*         "message": "...",
*         "details": "...",
*         "dev":     "..."   // present only in local/dev mode AND when non-empty
*       }
*     }
*
* Field rules:
*   - `type`, `message`, `details` are always present on the wire.
*   - `dev` is gated by explicit generated-runtime configuration. Even in
*     local development, `dev` is omitted when the error class set it to
*     `''` — so its presence is not a reliable signal of mode by itself;
*     clients should not depend on it that way.
*     See the error classes above for the two-audience rationale.
*   - `meta` is included on the wire only when an error subclass sets it
*     (rare).
*   - `cause` is never included on the wire (it's logged server-side only).
*/
function isFlueError(value) {
	return value instanceof FlueError;
}
/**
* Module-private for now: when an external call site appears we can promote
* to `export` and decide the right shape for `warn`/`info` (FlueError
* subclasses with severity? plain strings? structured data?) — rather than
* committing to a shape now without any usage to validate it.
*/
function formatForLog(prefix, err) {
	if (isFlueError(err)) {
		const lines = [`${prefix} [${err.type}] ${err.message}`];
		if (err.details) for (const line of err.details.split("\n")) lines.push(`  ${line}`);
		if (err.dev) for (const line of err.dev.split("\n")) lines.push(`  ${line}`);
		if (err.cause !== void 0) lines.push(`  cause: ${err.cause instanceof Error ? err.cause.stack ?? err.cause.message : String(err.cause)}`);
		return lines.join("\n");
	}
	if (err instanceof Error) return `${prefix} ${err.stack ?? err.message}`;
	return `${prefix} ${String(err)}`;
}
const flueLog = { error(err) {
	console.error(formatForLog("[flue]", err));
} };
let devMode = false;
function configureErrorRendering(options) {
	devMode = options.devMode;
}
function envelope(err) {
	const out = { error: {
		type: err.type,
		message: err.message,
		details: err.details
	} };
	if (devMode && err.dev) out.error.dev = err.dev;
	if (err.meta) out.error.meta = err.meta;
	return out;
}
const GENERIC_INTERNAL = { error: {
	type: "internal_error",
	message: "An internal error occurred.",
	details: "The server encountered an unexpected error while handling this request."
} };
/**
* Render any thrown value into a `Response` with the canonical Flue error
* envelope. Unknown / non-Flue errors are logged in full and rendered as a
* generic 500 with no message leaked.
*/
function toHttpResponse(err) {
	const baseHeaders = {
		"content-type": "application/json",
		"x-content-type-options": "nosniff",
		"cross-origin-resource-policy": "cross-origin"
	};
	if (isFlueError(err)) {
		const isHttp = err instanceof FlueHttpError;
		const status = isHttp ? err.status : 500;
		const headers = { ...baseHeaders };
		if (isHttp && err.headers) Object.assign(headers, err.headers);
		if (!isHttp) flueLog.error(err);
		return new Response(JSON.stringify(envelope(err)), {
			status,
			headers
		});
	}
	flueLog.error(err);
	return new Response(JSON.stringify(GENERIC_INTERNAL), {
		status: 500,
		headers: baseHeaders
	});
}
/**
* Parse a request body as JSON. Returns `undefined` when the body is omitted.
*
* Throws `UnsupportedMediaTypeError` if a body is present without
* `application/json` content-type, and `InvalidJsonError` if the body is
* present but unparseable.
*/
async function parseJsonBody(request) {
	const contentLengthHeader = request.headers.get("content-length");
	const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
	const contentType = request.headers.get("content-type");
	if (contentLength === 0 || contentLengthHeader === null && contentType === null) return void 0;
	if (!contentType?.toLowerCase().includes("application/json")) throw new UnsupportedMediaTypeError({ received: contentType });
	let text;
	try {
		text = await request.clone().text();
	} catch (err) {
		throw new InvalidJsonError({ parseError: err instanceof Error ? err.message : String(err) });
	}
	if (text.trim() === "") return void 0;
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new InvalidJsonError({ parseError: err instanceof Error ? err.message : String(err) });
	}
}
function validateWorkflowRequest(opts) {
	if (opts.method !== "POST") throw new MethodNotAllowedError({
		method: opts.method,
		allowed: ["POST"]
	});
	if (opts.name.trim() === "") throw new InvalidRequestError({ reason: "Workflow URLs must have the shape /workflows/<name> with a non-empty segment." });
	if (!opts.registeredWorkflows.includes(opts.name)) throw new WorkflowNotFoundError({
		name: opts.name,
		available: opts.registeredWorkflows
	});
	if (!opts.httpWorkflows.includes(opts.name)) throw new WorkflowNotFoundError({
		name: opts.name,
		available: opts.registeredWorkflows,
		notHttp: true
	});
}
function validateAgentRequest(opts) {
	if (opts.method !== "POST" && opts.method !== "GET" && opts.method !== "HEAD") throw new MethodNotAllowedError({
		method: opts.method,
		allowed: [
			"GET",
			"HEAD",
			"POST"
		]
	});
	if (opts.name.trim() === "" || opts.id.trim() === "") throw new InvalidRequestError({ reason: "Agent URLs must have the shape /agents/<name>/<id> with non-empty segments." });
	if (!opts.registeredAgents.includes(opts.name)) throw new AgentNotFoundError({
		name: opts.name,
		available: opts.registeredAgents
	});
}
//#endregion
export { SkillNotRegisteredError as A, ToolOutputSerializationError as B, RunStoreUnavailableError as C, SessionBusyError as D, SessionAlreadyExistsError as E, SubmissionRetryExhaustedError as F, WorkflowInputUnexpectedError as G, WorkflowAdmissionError as H, SubmissionTimeoutError as I, configureErrorRendering as J, WorkflowInvocationNotConfiguredError as K, ToolInputValidationError as L, SubagentNotDeclaredError as M, SubmissionAbortedError as N, SessionNotFoundError as O, SubmissionInterruptedError as P, validateWorkflowRequest as Q, ToolLegacyDefinitionError as R, RunNotFoundError as S, SandboxOperationUnsupportedError as T, WorkflowAdmissionUnavailableError as U, ToolOutputValidationError as V, WorkflowInputSerializationError as W, toHttpResponse as X, parseJsonBody as Y, validateAgentRequest as Z, OperationFailedError as _, AttachmentIntegrityError as a, ProviderRegistrationError as b, AttachmentsNotExposedError as c, ConversationStreamStoreError as d, DelegationDepthExceededError as f, MethodNotAllowedError as g, InvalidRequestError as h, AttachmentConflictError as i, StreamNotFoundError as j, SkillDefinitionValidationError as k, CloudflareAIBindingError as l, InstrumentationAlreadyInstalledError as m, ActionOutputSerializationError as n, AttachmentNotAvailableError as o, FlueError as p, WorkflowNotDiscoveredError as q, ActionOutputValidationError as r, AttachmentNotFoundError as s, ActionInputValidationError as t, ConversationRecordInvariantError as u, PersistedSchemaVersionError as v, RuntimeUnavailableError as w, RouteNotFoundError as x, ProductEventVersionError as y, ToolNameConflictError as z };
