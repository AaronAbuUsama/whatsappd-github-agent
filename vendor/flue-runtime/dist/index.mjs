import { A as SkillNotRegisteredError, B as ToolOutputSerializationError, C as RunStoreUnavailableError, D as SessionBusyError, E as SessionAlreadyExistsError, F as SubmissionRetryExhaustedError, G as WorkflowInputUnexpectedError, H as WorkflowAdmissionError, I as SubmissionTimeoutError, K as WorkflowInvocationNotConfiguredError, L as ToolInputValidationError, M as SubagentNotDeclaredError, N as SubmissionAbortedError, O as SessionNotFoundError, P as SubmissionInterruptedError, R as ToolLegacyDefinitionError, T as SandboxOperationUnsupportedError, U as WorkflowAdmissionUnavailableError, V as ToolOutputValidationError, W as WorkflowInputSerializationError, _ as OperationFailedError, b as ProviderRegistrationError, f as DelegationDepthExceededError, k as SkillDefinitionValidationError, m as InstrumentationAlreadyInstalledError, n as ActionOutputSerializationError, o as AttachmentNotAvailableError, p as FlueError, q as WorkflowNotDiscoveredError, r as ActionOutputValidationError, t as ActionInputValidationError, y as ProductEventVersionError, z as ToolNameConflictError } from "./errors-DUgRtE8e.mjs";
import { n as defineTool } from "./tool-C2CuUqYC.mjs";
import { U as defineWorkflow, nt as defineAgent, ot as defineAction, rt as defineAgentProfile, tt as createAgent } from "./conversation-projections-XMug3C6A.mjs";
import { C as IMAGE_DATA_OMITTED, S as registerPreparedToolAdapter, n as createSkillReference, o as ResultUnavailableError, t as buildPackagedSkill } from "./skill-package-B-Co0HMC.mjs";
import { a as observe, n as instrument } from "./instrumentation-DMZ8Niqr.mjs";
import { a as createSandboxSessionEnv, t as bash } from "./sandbox-tx-XM70E.mjs";
import { a as getFlueRuntime, r as dispatch, s as invoke } from "./flue-app-DweeRG3g.mjs";
import { c as registerProvider, s as registerApiProvider } from "./providers-CsCcTxMU.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
//#region package.json
var version = "1.0.0-beta.9";
const FRAMEWORK_TOOL_EXCLUSION_SUPPORTED = true;
//#endregion
//#region src/mcp.ts
/**
* Connects to a remote MCP server and adapts its listed tools into ordinary
* Flue tool definitions.
*
* Adapted tool names use `mcp__<server>__<tool>`. Unsupported characters are
* replaced with underscores, and duplicate adapted names are rejected. Close
* the returned connection when its tools are no longer needed.
*/
async function connectMcpServer(name, options) {
	const url = options.url instanceof URL ? options.url : new URL(options.url);
	const requestInit = mergeRequestInit(options.requestInit, options.headers);
	const transport = await createTransport(url, options.transport ?? "streamable-http", requestInit, options.fetch);
	return connectMcpServerWithClient(name, new Client({
		name: "flue",
		version
	}), transport, {
		timeout: options.timeoutMs,
		resetTimeoutOnProgress: options.resetTimeoutOnProgress
	});
}
async function connectMcpServerWithClient(name, client, transport, requestOptions = {}) {
	try {
		await client.connect(transport);
		let page = await client.listTools(void 0, requestOptions);
		const tools = [...page.tools];
		const seenCursors = /* @__PURE__ */ new Set();
		while (page.nextCursor !== void 0) {
			if (seenCursors.has(page.nextCursor)) throw new Error(`[flue] MCP server "${name}" repeated tools/list cursor ${JSON.stringify(page.nextCursor)} during tool discovery.`);
			seenCursors.add(page.nextCursor);
			page = await client.listTools({ cursor: page.nextCursor }, requestOptions);
			tools.push(...page.tools);
		}
		return {
			name,
			tools: createMcpTools(name, client, tools, requestOptions),
			close: () => client.close()
		};
	} catch (error) {
		await client.close().catch(() => void 0);
		throw error;
	}
}
async function createTransport(url, transport, requestInit, fetchImpl) {
	if (transport === "sse") {
		const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
		return new SSEClientTransport(url, {
			requestInit,
			fetch: fetchImpl
		});
	}
	return new StreamableHTTPClientTransport(url, {
		requestInit,
		fetch: fetchImpl
	});
}
function createMcpTools(serverName, client, tools, requestOptions) {
	const names = /* @__PURE__ */ new Set();
	const validator = new AjvJsonSchemaValidator();
	return tools.filter((tool) => {
		if (tool.execution?.taskSupport !== "required") return true;
		console.warn(`[flue] Skipping MCP tool "${tool.name}" from server "${serverName}": it requires task-based execution, which is not supported.`);
		return false;
	}).map((tool) => {
		const toolName = createToolName(serverName, tool.name);
		const outputValidator = tool.outputSchema ? validator.getValidator(tool.outputSchema) : void 0;
		if (names.has(toolName)) throw new Error(`[flue] MCP tools from server "${serverName}" produced duplicate tool name "${toolName}".`);
		names.add(toolName);
		const definition = {
			name: toolName,
			description: createToolDescription(serverName, tool),
			input: void 0,
			output: void 0,
			run() {
				throw new Error("[flue] MCP tools execute through the internal adapter.");
			}
		};
		registerPreparedToolAdapter(definition, {
			parameters: normalizeInputSchema(tool.inputSchema),
			async execute(args, signal) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const result = await client.callTool({
					name: tool.name,
					arguments: args
				}, void 0, {
					...requestOptions,
					signal
				});
				validateMcpResult(tool.name, result, outputValidator);
				const text = formatMcpResult(result);
				if (result.isError) throw new Error(text);
				return text;
			}
		});
		return Object.freeze(definition);
	});
}
function validateMcpResult(toolName, result, validator) {
	if (!validator) return;
	if (result.structuredContent === void 0 && !result.isError) throw new McpError(ErrorCode.InvalidRequest, `Tool ${toolName} has an output schema but did not return structured content`);
	if (result.structuredContent === void 0) return;
	const validation = validator(result.structuredContent);
	if (!validation.valid) throw new McpError(ErrorCode.InvalidParams, `Structured content does not match the tool's output schema: ${validation.errorMessage}`);
}
function mergeRequestInit(requestInit, headers) {
	if (!headers) return requestInit ?? {};
	const mergedHeaders = new Headers(requestInit?.headers);
	for (const [key, value] of new Headers(headers)) mergedHeaders.set(key, value);
	return {
		...requestInit,
		headers: mergedHeaders
	};
}
function createToolName(serverName, toolName) {
	return `mcp__${sanitizeToolNamePart(serverName)}__${sanitizeToolNamePart(toolName)}`;
}
function sanitizeToolNamePart(value) {
	return value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "") || "unnamed";
}
function createToolDescription(serverName, tool) {
	const originalName = tool.name;
	const title = tool.title ?? tool.annotations?.title;
	const parts = [`MCP tool "${originalName}" from server "${serverName}".`];
	if (title && title !== originalName) parts.push(`Title: ${title}.`);
	if (tool.description) parts.push(tool.description);
	return parts.join(" ");
}
function normalizeInputSchema(schema) {
	return {
		...schema,
		type: schema.type ?? "object",
		properties: schema.properties ?? {},
		required: schema.required
	};
}
function formatMcpResult(result) {
	const parts = [];
	if (result.structuredContent !== void 0) parts.push(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
	for (const item of result.content ?? []) {
		if (item.type === "text") {
			parts.push(item.text);
			continue;
		}
		if (item.type === "image") {
			parts.push(`[Image: ${item.mimeType}, ${item.data.length} base64 chars]`);
			continue;
		}
		if (item.type === "audio") {
			parts.push(`[Audio: ${item.mimeType}, ${item.data.length} base64 chars]`);
			continue;
		}
		if (item.type === "resource") {
			const resource = item.resource;
			if ("text" in resource) parts.push(`[Resource: ${resource.uri}]\n${resource.text}`);
			else parts.push(`[Resource: ${resource.uri}, ${resource.blob.length} base64 chars]`);
			continue;
		}
		if (item.type === "resource_link") {
			const description = item.description ? ` - ${item.description}` : "";
			parts.push(`[Resource link: ${item.name} (${item.uri})${description}]`);
			continue;
		}
		parts.push(JSON.stringify(item));
	}
	return parts.filter(Boolean).join("\n\n") || "(MCP tool returned no content)";
}
//#endregion
//#region src/runtime/inspect.ts
/**
* Server-side deployment-inspection primitives.
*
* These free functions read the ambient generated runtime (the same pattern
* as `dispatch()`) and are the building blocks for application-owned
* inspection endpoints: mount your own route, apply your own authorization,
* and serve whatever shape your operators need. Flue does not ship an
* inspection HTTP surface of its own.
*/
/**
* Lists workflow-run summaries (`RunPointer`s) newest-first, filtered by
* `status`/`workflowName` and paginated via the opaque `cursor` returned in
* {@link ListRunsResponse.nextCursor}.
*/
async function listRuns(options) {
	return requireRunListing(requireInspectRuntime("listRuns")).listRuns(options);
}
/**
* Retrieves one workflow-run record, or `null` when no run with this id is
* recorded.
*/
async function getRun(runId) {
	const rt = requireInspectRuntime("getRun");
	if (rt.target === "node") return rt.runStore.getRun(runId);
	const pointer = await requireRunListing(rt).lookupRun(runId);
	if (!pointer) return null;
	const response = await rt.routeRunRequest(new Request(`https://flue.invalid/runs/${encodeURIComponent(runId)}?meta`), void 0, {
		workflowName: pointer.workflowName,
		runId
	});
	if (!response || response.status === 404) return null;
	if (!response.ok) throw new Error(`[flue] getRun("${runId}") failed with status ${response.status}.`);
	return await response.json();
}
/** Lists the agents built into this deployment. */
async function listAgents() {
	return requireInspectRuntime("listAgents").agents.map((agent) => ({
		name: agent.name,
		...agent.description === void 0 ? {} : { description: agent.description },
		transports: agent.route === void 0 ? {} : { http: true },
		defined: true
	}));
}
function requireInspectRuntime(label) {
	const rt = getFlueRuntime();
	if (!rt) throw new Error(`[flue] ${label}() called before runtime was configured. This usually means it was used outside a Flue-built server entry.`);
	return rt;
}
function requireRunListing(rt) {
	if (rt.target === "cloudflare") {
		const index = rt.createRunIndexForRequest(void 0);
		if (!index) throw new RunStoreUnavailableError();
		return index;
	}
	return rt.runStore;
}
//#endregion
//#region src/skill-definition.ts
const encoder = new TextEncoder();
function defineSkill(options) {
	const normalized = validateOptions(options);
	const files = [{
		path: "SKILL.md",
		content: encoder.encode(serializeSkillMarkdown(normalized))
	}, ...Object.entries(normalized.files).map(([path, value]) => ({
		path,
		content: typeof value === "string" ? encoder.encode(value) : value
	}))];
	return createSkillReference(buildPackagedSkill({
		name: normalized.name,
		description: normalized.description,
		files
	}));
}
function validateOptions(options) {
	const issues = [];
	if (!isRecord(options)) throw new SkillDefinitionValidationError({ issues: [{
		path: [],
		message: "Expected a skill definition object."
	}] });
	const name = requiredString(options.name, "name", issues);
	if (name.length > 64) issues.push({
		path: ["name"],
		message: "Must be at most 64 characters."
	});
	if (name && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) issues.push({
		path: ["name"],
		message: "Must contain only lowercase ASCII letters, numbers, and single hyphens."
	});
	const description = requiredString(options.description, "description", issues);
	if ([...description].length > 1024) issues.push({
		path: ["description"],
		message: "Must be at most 1024 characters."
	});
	const instructions = optionalString(options.instructions, "instructions", issues) ?? "";
	const license = optionalString(options.license, "license", issues);
	const compatibility = optionalString(options.compatibility, "compatibility", issues);
	if (compatibility !== void 0 && [...compatibility].length > 500) issues.push({
		path: ["compatibility"],
		message: "Must be at most 500 characters."
	});
	const allowedTools = optionalString(options.allowedTools, "allowedTools", issues);
	const metadata = options.metadata === void 0 ? void 0 : Object.create(null);
	if (options.metadata !== void 0) {
		if (!isRecord(options.metadata)) issues.push({
			path: ["metadata"],
			message: "Must be a string-to-string mapping."
		});
		else for (const [key, value] of Object.entries(options.metadata)) if (typeof value !== "string") issues.push({
			path: ["metadata", key],
			message: "Must be a string."
		});
		else if (metadata) metadata[key] = value;
	}
	const files = Object.create(null);
	if (options.files !== void 0) if (!isRecord(options.files)) issues.push({
		path: ["files"],
		message: "Must be a file-path mapping."
	});
	else for (const [path, content] of Object.entries(options.files)) {
		validateFilePath(path, issues);
		if (typeof content !== "string" && !(content instanceof Uint8Array)) issues.push({
			path: ["files", path],
			message: "Must be a string or Uint8Array."
		});
		else files[path] = typeof content === "string" ? content : new Uint8Array(content);
	}
	if (issues.length > 0) throw new SkillDefinitionValidationError({ issues });
	return {
		name,
		description,
		instructions,
		license,
		compatibility,
		metadata,
		allowedTools,
		files
	};
}
function requiredString(value, field, issues) {
	if (typeof value !== "string" || value.trim().length === 0) {
		issues.push({
			path: [field],
			message: "Must be a non-empty string."
		});
		return "";
	}
	return value.trim();
}
function optionalString(value, field, issues) {
	if (value === void 0) return void 0;
	if (typeof value !== "string") {
		issues.push({
			path: [field],
			message: "Must be a string when provided."
		});
		return;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function validateFilePath(path, issues) {
	const segments = path.split("/");
	if (path.length === 0 || path === "SKILL.md" || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("\0") || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) issues.push({
		path: ["files", path],
		message: "Must be a safe relative path and must not be SKILL.md."
	});
}
function serializeSkillMarkdown(options) {
	const lines = [
		"---",
		`name: ${JSON.stringify(options.name)}`,
		`description: ${JSON.stringify(options.description)}`
	];
	if (options.license !== void 0) lines.push(`license: ${JSON.stringify(options.license)}`);
	if (options.compatibility !== void 0) lines.push(`compatibility: ${JSON.stringify(options.compatibility)}`);
	if (options.metadata !== void 0) {
		lines.push("metadata:");
		for (const key of Object.keys(options.metadata).sort()) lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(options.metadata[key])}`);
	}
	if (options.allowedTools !== void 0) lines.push(`allowed-tools: ${JSON.stringify(options.allowedTools)}`);
	lines.push("---", "");
	if (options.instructions.length > 0) lines.push(options.instructions);
	return `${lines.join("\n")}\n`;
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
//#endregion
//#region src/types.ts
const FLUE_EVENT_SCHEMA_REVISION = 3;
//#endregion
export { ActionInputValidationError, ActionOutputSerializationError, ActionOutputValidationError, AttachmentNotAvailableError, DelegationDepthExceededError, FLUE_EVENT_SCHEMA_REVISION, FlueError, IMAGE_DATA_OMITTED, InstrumentationAlreadyInstalledError, OperationFailedError, ProductEventVersionError, ProviderRegistrationError, ResultUnavailableError, SandboxOperationUnsupportedError, SessionAlreadyExistsError, SessionBusyError, SessionNotFoundError, SkillDefinitionValidationError, SkillNotRegisteredError, SubagentNotDeclaredError, SubmissionAbortedError, SubmissionInterruptedError, SubmissionRetryExhaustedError, SubmissionTimeoutError, ToolInputValidationError, ToolLegacyDefinitionError, ToolNameConflictError, ToolOutputSerializationError, ToolOutputValidationError, WorkflowAdmissionError, WorkflowAdmissionUnavailableError, WorkflowInputSerializationError, WorkflowInputUnexpectedError, WorkflowInvocationNotConfiguredError, WorkflowNotDiscoveredError, bash, connectMcpServer, createAgent, createSandboxSessionEnv, defineAction, defineAgent, defineAgentProfile, defineSkill, defineTool, defineWorkflow, dispatch, getRun, instrument, invoke, listAgents, listRuns, observe, registerApiProvider, registerProvider };
export { FRAMEWORK_TOOL_EXCLUSION_SUPPORTED };
