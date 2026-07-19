import { A as SkillNotRegisteredError, D as SessionBusyError, F as SubmissionRetryExhaustedError, I as SubmissionTimeoutError, M as SubagentNotDeclaredError, N as SubmissionAbortedError, P as SubmissionInterruptedError, _ as OperationFailedError, d as ConversationStreamStoreError, f as DelegationDepthExceededError, o as AttachmentNotAvailableError, p as FlueError, u as ConversationRecordInvariantError, z as ToolNameConflictError } from "./errors-DUgRtE8e.mjs";
import { i as validateToolOutput, l as valibotToJsonSchema, r as parseToolInput, t as assertToolDefinition } from "./tool-C2CuUqYC.mjs";
import { C as getActiveConversationPath, D as renderSignalMessage, E as toolResultEntryId, J as agentStreamPath, Q as interceptExecution, T as toolOutcomeKey, V as generateTurnId, X as parseOffset, Y as formatOffset, _ as isContextOverflow, a as getLatestCompletedAssistantEntry, b as emptyUsage, c as projectConversationModelContextEntries, ct as runActionWithParsedInput, d as findTrailingPartialToolBatch, f as isRetryableModelError, g as deriveCompactionDefaults, h as compact, i as getAssistantText, j as assertAgentDispatchAdmissionInput, m as calculateContextTokens, n as classifyConversationSubmission, o as getLatestConversationCompaction, p as DEFAULT_COMPACTION_SETTINGS, r as getActiveConversationPathSince, s as projectConversationModelContext, st as parseActionInput, t as aggregateConversationUsageSince, u as countConsecutiveRetryableModelErrors, v as prepareCompaction, x as fromProviderUsage, y as shouldCompact, z as generateOperationId } from "./conversation-projections-XMug3C6A.mjs";
import { C as IMAGE_DATA_OMITTED, T as redactObservationDetailImages, _ as createPackagedSkillReadTool, a as GIVE_UP_TOOL_NAME, b as formatBashResult, c as buildPromptText, d as buildWorkspaceSkillPrompt, f as createResultTools, g as createActivateSkillTool, h as READ_SKILL_RESOURCE_TOOL_NAME, i as FINISH_TOOL_NAME, l as buildResultFollowUpPrompt, m as parseSkillMarkdown, o as ResultUnavailableError, p as prepareResultTool, r as getSkillReferenceDirectory, s as buildPackagedSkillPrompt, u as buildSkillByPathlessNamePrompt, v as createTaskTool, w as redactEventImages, x as getPreparedToolAdapter, y as createTools } from "./skill-package-B-Co0HMC.mjs";
import { i as createFlueFs, l as createCallHandle, s as abortErrorFor } from "./sandbox-tx-XM70E.mjs";
import { T as MAX_IMAGE_DATA_LENGTH, d as SUBMISSION_SESSION_NAME, f as clampLimit, l as migrateFlueSqlSchema, x as parseSessionStorageKey } from "./run-store-CYeXjR-d.mjs";
import { a as getRegisteredStoreResponses, i as getRegisteredApiKey, r as getProviderTelemetry } from "./providers-CsCcTxMU.mjs";
import { i as createAttachmentRef } from "./attachment-store-C1jHXs6y.mjs";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { Agent } from "@earendil-works/pi-agent-core";
//#region src/agent-execution-store.ts
/** Default maximum total attempts before terminalization. */
const DURABILITY_DEFAULT_MAX_ATTEMPTS = 10;
/** Default submission timeout in milliseconds (one hour). */
const DURABILITY_DEFAULT_TIMEOUT_MS = 36e5;
/** Default lease duration for submission ownership in milliseconds (30 seconds). */
const LEASE_DURATION_MS = 3e4;
//#endregion
//#region src/context.ts
/**
* Context discovery: reads AGENTS.md and .agents/skills/ from a session's
* working directory. Used at runtime by the session initialisation path.
*/
function isWorkspaceSkill(skill) {
	const candidate = skill;
	return candidate.__flueWorkspaceSkill === true && typeof candidate.directory === "string" && typeof candidate.skillMdPath === "string";
}
/** Read AGENTS.md (and CLAUDE.md if present) from a directory. Returns concatenated contents. */
async function readAgentsMd(env, basePath) {
	const parts = [];
	for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
		const filePath = basePath.endsWith("/") ? basePath + filename : `${basePath}/${filename}`;
		if (await env.exists(filePath)) {
			const content = await env.readFile(filePath);
			parts.push(content.trim());
		}
	}
	return parts.join("\n\n");
}
/** Path to the skills directory under a given base path. */
function skillsDirIn(basePath) {
	return basePath.endsWith("/") ? `${basePath}.agents/skills` : `${basePath}/.agents/skills`;
}
/**
* Discover skills from `.agents/skills/<name>/SKILL.md` under basePath.
*
* Skill bodies are intentionally not retained. Autonomous activation
* rereads SKILL.md before injecting its instructions, while direct name
* invocation lets the model read workspace files itself. This keeps
* relative references resolvable and picks up mid-session edits without
* re-initialising the agent. We parse the frontmatter here only to
* populate the system-prompt's "Available Skills" registry.
*
* Discovered skills the user didn't opt into must not be able to brick
* the session: a malformed SKILL.md is skipped with a warning instead of
* failing init(). Explicitly imported/packaged skills stay strict — they
* are validated at build time where a hard error is actionable.
*/
async function discoverLocalSkills(env, basePath) {
	const skillsDir = skillsDirIn(basePath);
	if (!await env.exists(skillsDir)) return {};
	const skills = Object.create(null);
	const entries = await env.readdir(skillsDir);
	for (const entry of entries) {
		const skillDir = `${skillsDir}/${entry}`;
		try {
			if (!(await env.stat(skillDir)).isDirectory) continue;
		} catch {
			continue;
		}
		const skillMdPath = `${skillDir}/SKILL.md`;
		if (!await env.exists(skillMdPath)) continue;
		const content = await env.readFile(skillMdPath);
		let parsed;
		try {
			parsed = parseSkillMarkdown(content, {
				directoryName: entry,
				path: skillMdPath
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[flue] Skipping invalid workspace skill "${entry}": ${detail}`);
			continue;
		}
		const workspaceSkill = {
			__flueWorkspaceSkill: true,
			name: parsed.name,
			description: parsed.description,
			directory: skillDir,
			skillMdPath
		};
		skills[parsed.name] = workspaceSkill;
	}
	return skills;
}
function mergeSkillCatalog(definitionSkills, discoveredSkills) {
	const merged = Object.create(null);
	for (const skill of definitionSkills) merged[skill.name] = skill;
	for (const [name, skill] of Object.entries(discoveredSkills)) {
		if (Object.hasOwn(merged, name)) throw new Error(`[flue] Skill name "${name}" appears in both agent definition and workspace discovery.`);
		merged[name] = skill;
	}
	return merged;
}
/**
* Headless-mode preamble. Included once at the top of every session's
* system prompt so the model knows it's running without a human operator
* before the first turn — and doesn't get reminded of it on every
* `prompt()` / `skill()` call. Previously this lived in
* `result.ts:buildPromptText` / `buildSkillPrompt` and was inlined into
* each per-call user message; that was redundant noise once the harness
* gained tool-call shape (it can't ask questions or wait for input
* regardless of what the user message says).
*/
const HEADLESS_PREAMBLE = "You are running in headless mode with no human operator. Work autonomously — never ask questions, never wait for user input. Make your best judgment and proceed independently.";
function composeSystemPrompt(agentsMd, skills, env, instructions) {
	const parts = [HEADLESS_PREAMBLE];
	if (instructions) parts.push("", instructions);
	if (agentsMd) parts.push("", agentsMd);
	const skillEntries = Object.values(skills);
	if (skillEntries.length > 0) {
		parts.push("", "## Available Skills", "", "The following skills provide specialized instructions for specific tasks. When a task matches a skill description, call the `activate_skill` tool with that skill name before proceeding so its full instructions are loaded. Skill instructions and supporting resources stay lazy until activation or explicit file reads.", "");
		for (const skill of skillEntries) {
			const desc = skill.description ? ` — ${skill.description}` : "";
			parts.push(`- **${skill.name}**${desc}`);
		}
	}
	if (env) {
		const date = (/* @__PURE__ */ new Date()).toLocaleDateString("en-US", {
			weekday: "short",
			year: "numeric",
			month: "short",
			day: "numeric"
		});
		parts.push("", `Date: ${date}`);
		parts.push(`Working directory: ${env.cwd}`);
		if (env.directoryListing && env.directoryListing.length > 0) parts.push("", "Directory structure:", env.directoryListing.join("\n"));
	}
	return parts.join("\n");
}
/** Discover AGENTS.md, local skills, and directory listing from the session's cwd. */
async function discoverSessionContext(env, instructions, definitionSkills = []) {
	const cwd = env.cwd;
	const agentsMd = await readAgentsMd(env, cwd);
	const skills = mergeSkillCatalog(definitionSkills, await discoverLocalSkills(env, cwd));
	let directoryListing;
	try {
		directoryListing = await env.readdir(cwd);
	} catch {}
	return {
		systemPrompt: composeSystemPrompt(agentsMd, skills, {
			cwd,
			directoryListing
		}, instructions),
		skills
	};
}
//#endregion
//#region src/conversation-records.ts
function generateConversationRecordId() {
	return `record_${crypto.randomUUID()}`;
}
function generateConversationEntryId() {
	return `entry_${crypto.randomUUID()}`;
}
//#endregion
//#region src/persisted-images.ts
const IMAGE_DATA_CHUNK_LENGTH = 256 * 1024;
const markerPrefix = "__flue_image_chunks__:";
/**
* Operation entry points (prompt/skill/task) call this before any history
* mutation so oversized images are rejected identically across session store
* adapters, instead of failing later inside SQL persistence and leaving an
* unsaveable entry in in-memory history. The check inside
* `extractImageBlocks` remains as a persistence-layer invariant.
*/
function assertImagesWithinLimit(images) {
	for (const image of images ?? []) if (image.data.length > 14680064) throw new Error(`[flue] Image data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`);
}
function extractDirectSubmissionImages(input) {
	const extracted = extractImageArray(input.payload.images);
	return {
		value: {
			...input,
			payload: {
				...input.payload,
				...extracted.value === void 0 ? {} : { images: extracted.value }
			}
		},
		chunks: extracted.chunks
	};
}
function hydrateDirectSubmissionImages(input, imageData) {
	if (input.payload.images === void 0) {
		assertExactImageGroups([], imageData);
		return input;
	}
	assertExactImageGroups(markerIds(input.payload.images), imageData);
	return {
		...input,
		payload: {
			...input.payload,
			images: hydrateImageArray(input.payload.images, imageData)
		}
	};
}
function extractImageArray(images) {
	if (images === void 0) return {
		value: void 0,
		chunks: []
	};
	return extractImageBlocks(images);
}
function extractImageBlocks(blocks) {
	const chunks = [];
	let imageIndex = 0;
	return {
		value: blocks.map((block) => {
			if (!isImageBlock(block)) return block;
			if (block.data.length > 14680064) throw new Error(`[flue] Image data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`);
			const imageId = String(imageIndex++);
			const count = Math.max(1, Math.ceil(block.data.length / IMAGE_DATA_CHUNK_LENGTH));
			for (let index = 0; index < count; index++) chunks.push({
				imageId,
				index,
				count,
				data: block.data.slice(index * IMAGE_DATA_CHUNK_LENGTH, (index + 1) * IMAGE_DATA_CHUNK_LENGTH)
			});
			return {
				...block,
				data: `${markerPrefix}${imageId}`
			};
		}),
		chunks
	};
}
function markerIds(content) {
	if (!Array.isArray(content)) return [];
	return content.flatMap((block) => {
		if (!isImageBlock(block) || !block.data.startsWith(markerPrefix)) return [];
		return [block.data.slice(22)];
	});
}
function assertExactImageGroups(markerImageIds, imageData) {
	const markers = new Set(markerImageIds);
	if (markers.size !== markerImageIds.length || markers.size !== imageData.size) throw new Error("[flue] Persisted image chunks do not match persisted image markers.");
	for (const imageId of imageData.keys()) if (!markers.has(imageId)) throw new Error("[flue] Persisted image chunks do not match persisted image markers.");
}
function hydrateImageArray(blocks, imageData) {
	return blocks.map((block) => {
		if (!isImageBlock(block) || !block.data.startsWith(markerPrefix)) return block;
		const data = imageData.get(block.data.slice(22));
		if (data === void 0) throw new Error("[flue] Persisted image chunks are missing.");
		return {
			...block,
			data
		};
	});
}
function isImageBlock(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const block = value;
	return block.type === "image" && typeof block.data === "string";
}
//#endregion
//#region src/shell.ts
/**
* Run `command` through `env.exec` wrapped in the bash tool-event envelope:
* a `tool_start` emit up front, then a terminal `tool` emit carrying either
* the formatted bash result or the `details: { command, exitCode: -1 }`
* error-result shape. The optional `record` hook runs before each terminal
* emit so `session.shell()` can append its transcript triple at the same
* point in the sequence on both branches.
*/
async function execShellWithEvents(env, emit, command, options, signal, executionContext, record) {
	const toolCallId = crypto.randomUUID();
	const startedAt = Date.now();
	const args = { command };
	if (options?.cwd !== void 0) args.cwd = options.cwd;
	if (options?.env !== void 0) args.env = redactEnvValues(options.env);
	emit({
		type: "tool_start",
		toolName: "bash",
		toolCallId
	}, {
		origin: "caller",
		toolType: "function",
		args
	});
	try {
		const result = await interceptExecution({
			type: "tool",
			toolCallId,
			toolName: "bash"
		}, executionContext, () => env.exec(command, {
			env: options?.env,
			cwd: options?.cwd,
			timeoutMs: options?.timeoutMs,
			signal
		}));
		const shellResult = {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode
		};
		const toolResult = formatBashResult(shellResult, command);
		await record?.(toolCallId, args, toolResult, false);
		emit({
			type: "tool",
			toolName: "bash",
			toolCallId,
			isError: false,
			result: toolResult,
			durationMs: Date.now() - startedAt
		}, {
			origin: "caller",
			toolType: "function"
		});
		return shellResult;
	} catch (error) {
		const errResult = {
			content: [{
				type: "text",
				text: getErrorMessage(error)
			}],
			details: {
				command,
				exitCode: -1
			}
		};
		await record?.(toolCallId, args, errResult, true);
		emit({
			type: "tool",
			toolName: "bash",
			toolCallId,
			isError: true,
			result: errResult,
			durationMs: Date.now() - startedAt
		}, {
			origin: "caller",
			toolType: "function",
			errorInfo: classifyShellError(error)
		});
		throw error;
	}
}
function classifyShellError(error) {
	if (error instanceof DOMException && error.name === "AbortError") return {
		type: "AbortError",
		name: error.name,
		message: error.message
	};
	if (error instanceof Error) return {
		type: error.name || "_OTHER",
		name: error.name,
		message: error.message
	};
	return {
		type: "_OTHER",
		...typeof error === "string" ? { message: error } : {}
	};
}
function getErrorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function redactEnvValues(env) {
	return Object.fromEntries(Object.keys(env).map((key) => [key, "<redacted>"]));
}
//#endregion
//#region src/session.ts
const MAX_DELEGATION_DEPTH = 4;
const MAX_TRANSIENT_MODEL_RETRIES = 3;
const TRANSIENT_MODEL_RETRY_BASE_DELAY_MS = 2e3;
function toolResultText(value) {
	const content = value.content;
	if (content.length === 1 && content[0]?.type === "text") return content[0].text;
	return content;
}
function toTurnMessage(message) {
	if (message.role === "signal") return {
		role: "user",
		content: renderSignalMessage(message)
	};
	if (message.role === "user") return {
		role: "user",
		content: typeof message.content === "string" ? message.content : message.content.map(toTurnContent)
	};
	if (message.role === "assistant") return {
		role: "assistant",
		content: message.content.map(toTurnContent)
	};
	if (message.role === "toolResult") return {
		role: "toolResult",
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		content: message.content.map(toTurnContent),
		isError: message.isError
	};
	throw new Error(`[flue] Unsupported message role in turn context: ${message.role}`);
}
function toTurnContent(block) {
	if (block.type === "text") return {
		type: "text",
		text: block.text,
		textSignature: block.textSignature
	};
	if (block.type === "image") return {
		type: "image",
		data: IMAGE_DATA_OMITTED,
		mimeType: block.mimeType
	};
	if (block.type === "thinking") return {
		type: "thinking",
		thinking: block.thinking,
		thinkingSignature: block.thinkingSignature,
		redacted: block.redacted
	};
	return {
		type: "toolCall",
		id: block.id,
		name: block.name,
		arguments: block.arguments,
		thoughtSignature: block.thoughtSignature
	};
}
function getRegisteredPackagedSkills(skills) {
	const registered = {};
	for (const skill of Object.values(skills)) {
		if (!("__flueSkillReference" in skill)) continue;
		const packaged = getSkillReferenceDirectory(skill);
		if (packaged) registered[skill.id] = packaged;
	}
	return registered;
}
function createDispatchInputSignal(input) {
	return {
		role: "signal",
		type: "dispatch_input",
		tagName: "dispatch",
		content: stableStringify(input.input),
		attributes: {
			agent: input.agent,
			id: input.id,
			session: "default",
			dispatchId: input.dispatchId,
			acceptedAt: input.acceptedAt
		},
		timestamp: Date.now()
	};
}
function stableStringify(value) {
	return JSON.stringify(sortJsonLike(value), null, 2);
}
function sortJsonLike(value) {
	if (Array.isArray(value)) return value.map(sortJsonLike);
	if (!value || typeof value !== "object") return value;
	const sorted = {};
	for (const key of Object.keys(value).sort()) sorted[key] = sortJsonLike(value[key]);
	return sorted;
}
function wrapProviderStream(stream, operation, executionContext) {
	return {
		[Symbol.asyncIterator]() {
			const iterator = stream[Symbol.asyncIterator]();
			const returnIterator = iterator.return?.bind(iterator);
			const throwIterator = iterator.throw?.bind(iterator);
			return {
				next: () => interceptExecution(operation, executionContext, () => iterator.next()),
				return: returnIterator ? () => interceptExecution(operation, executionContext, returnIterator) : void 0,
				throw: throwIterator ? (error) => interceptExecution(operation, executionContext, () => throwIterator(error)) : void 0
			};
		},
		result() {
			return interceptExecution(operation, executionContext, () => stream.result());
		}
	};
}
function parseProviderEndpoint(value) {
	if (!value) return void 0;
	try {
		const url = new URL(value);
		return {
			address: url.hostname,
			...url.port ? { port: Number(url.port) } : {}
		};
	} catch {
		return;
	}
}
function classifyError(error) {
	if (error instanceof DOMException && error.name === "AbortError") return {
		type: "AbortError",
		name: error.name,
		message: error.message
	};
	if (error && typeof error === "object") {
		const value = error;
		const name = typeof value.name === "string" ? value.name : void 0;
		const code = typeof value.code === "string" ? value.code : void 0;
		return {
			type: typeof value.type === "string" ? value.type : code ?? name ?? "_OTHER",
			...name === void 0 ? {} : { name },
			...code === void 0 ? {} : { code },
			...typeof value.message === "string" ? { message: value.message } : {}
		};
	}
	if (typeof error === "string") return {
		type: "_OTHER",
		message: error
	};
	return { type: "_OTHER" };
}
function modelRetryDelayMs(attempt) {
	const baseDelay = TRANSIENT_MODEL_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
	return Math.round(baseDelay * (.75 + Math.random() * .25));
}
function sleepUntilRetry(delayMs, signal) {
	if (signal.aborted) return Promise.reject(abortErrorFor(signal));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(abortErrorFor(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
var Session = class {
	name;
	conversationId;
	fs;
	agentLoop;
	affinityKey;
	config;
	env;
	compactionAbortController;
	modelRetryAbortController;
	eventCallback;
	agentTools;
	toolFactory;
	closed = false;
	activeOperation;
	activeOperationId;
	activeAgentInput;
	activeOperationSettlement = Promise.resolve();
	resolveActiveOperationSettlement;
	closePromise;
	activeToolCalls = /* @__PURE__ */ new Map();
	modelToolTelemetry = /* @__PURE__ */ new WeakMap();
	activeTurnId;
	modelRequests = /* @__PURE__ */ new Map();
	modelRequestStartTimes = /* @__PURE__ */ new Map();
	activeTasks = /* @__PURE__ */ new Set();
	activeActionHarnesses = /* @__PURE__ */ new Set();
	delegationDepth;
	createTaskSession;
	actions;
	createActionHarness;
	scopeSignal;
	onClose;
	activeTimeoutAt;
	activeSubmissionId;
	activeSubmissionAttemptId;
	conversationWriter;
	attachmentStore;
	canonicalAssistant;
	canonicalToolRequestMessageId;
	canonicalToolResultParentId;
	pendingCanonicalWrites = /* @__PURE__ */ new Set();
	pendingToolPublications = /* @__PURE__ */ new Map();
	executionIdentity;
	emitTurnRequestAndStream = async (model, context, options) => {
		if (this.activeTurnId === void 0) this.activeTurnId = generateTurnId();
		const turnId = this.activeTurnId;
		const operationId = this.activeOperationId ?? generateOperationId();
		this.emitTurnRequest(turnId, "agent", model, context, options);
		const operation = {
			type: "model",
			turnId
		};
		const executionContext = this.executionContext({
			operationId,
			turnId
		});
		return interceptExecution(operation, executionContext, async () => wrapProviderStream(streamSimple(model, context, options), operation, executionContext));
	};
	canonicalEnvelope(type, id = generateConversationRecordId()) {
		return {
			v: 1,
			id,
			type,
			conversationId: this.conversationId,
			harness: this.executionIdentity.harness ?? "default",
			session: this.name,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			...this.activeSubmissionId ? { submissionId: this.activeSubmissionId } : {},
			...this.activeSubmissionAttemptId ? { attemptId: this.activeSubmissionAttemptId } : {},
			...this.activeOperationId ? { operationId: this.activeOperationId } : {},
			...this.activeTurnId ? { turnId: this.activeTurnId } : {}
		};
	}
	canonicalAppendOptions() {
		const submission = this.activeSubmissionId && this.activeSubmissionAttemptId ? {
			submissionId: this.activeSubmissionId,
			attemptId: this.activeSubmissionAttemptId
		} : void 0;
		return submission ? { submission } : {};
	}
	appendCanonical(records) {
		return this.conversationWriter.append(records, this.canonicalAppendOptions());
	}
	enqueueCanonical(records, publish) {
		const pending = this.conversationWriter.enqueue(records, this.canonicalAppendOptions()).then(() => publish());
		let tracked;
		tracked = pending.finally(() => this.pendingCanonicalWrites.delete(tracked));
		this.pendingCanonicalWrites.add(tracked);
	}
	async flushCanonical() {
		await this.conversationWriter.flush();
		await Promise.all(this.pendingCanonicalWrites);
	}
	modelRequestInfo(model, options) {
		if (!model) throw new Error("[flue] Missing configured model for turn telemetry.");
		const providerTelemetry = getProviderTelemetry(model.provider);
		const parsedEndpoint = parseProviderEndpoint(model.baseUrl);
		return {
			providerId: model.provider,
			providerName: providerTelemetry?.providerName ?? model.provider,
			requestedModel: model.id,
			api: model.api,
			serverAddress: providerTelemetry?.serverAddress ?? parsedEndpoint?.address,
			serverPort: providerTelemetry?.serverPort ?? parsedEndpoint?.port,
			reasoningLevel: options?.reasoning,
			maxTokens: options?.maxTokens,
			temperature: options?.temperature
		};
	}
	emitTurnRequest(turnId, purpose, model, context, options) {
		const tools = context.tools?.map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}));
		const request = this.modelRequestInfo(model, options);
		this.modelRequests.set(turnId, request);
		this.modelRequestStartTimes.set(turnId, Date.now());
		this.emit({
			type: "turn_request",
			turnId,
			purpose,
			request: {
				...request,
				input: {
					systemPrompt: context.systemPrompt,
					messages: context.messages.map(toTurnMessage),
					tools
				}
			}
		});
	}
	emitTurn(turnId, purpose, response, request, error) {
		const output = response ? toTurnMessage(response) : void 0;
		this.emit({
			type: "turn",
			turnId,
			purpose,
			durationMs: durationSince(this.modelRequestStartTimes.get(turnId)),
			request,
			response: {
				responseId: response?.responseId,
				responseModel: response?.responseModel,
				output,
				usage: fromProviderUsage(response?.usage),
				finishReason: response?.stopReason,
				...error !== void 0 || response?.errorMessage ? { error: classifyError(error ?? response?.errorMessage) } : {}
			},
			isError: error !== void 0 || response?.stopReason === "error" || response?.stopReason === "aborted"
		});
	}
	constructor(options) {
		this.name = options.name;
		this.conversationId = options.conversation.conversationId;
		this.affinityKey = options.conversation.affinityKey;
		this.config = options.config;
		this.env = options.env;
		this.fs = createFlueFs(options.env);
		this.agentTools = options.agentTools ?? [];
		this.toolFactory = options.toolFactory;
		this.delegationDepth = options.delegationDepth ?? 0;
		this.createTaskSession = options.createTaskSession;
		this.actions = options.actions ?? [];
		this.createActionHarness = options.createActionHarness;
		this.scopeSignal = options.scopeSignal;
		this.onClose = options.onClose;
		this.conversationWriter = options.conversationWriter;
		this.attachmentStore = options.attachmentStore;
		this.executionIdentity = options.executionContext ?? {};
		const systemPrompt = this.config.systemPrompt;
		const tools = this.assembleModelTools(this.createBuiltinToolGroups(this.env, []), this.agentTools, []);
		const previousMessages = [];
		this.agentLoop = new Agent({
			initialState: {
				systemPrompt,
				model: this.config.model,
				tools,
				messages: previousMessages,
				thinkingLevel: this.config.thinkingLevel ?? "medium"
			},
			getApiKey: (provider) => this.getProviderApiKey(provider),
			onPayload: (payload, model) => this.applyProviderPayloadOverrides(payload, model),
			streamFn: this.emitTurnRequestAndStream,
			toolExecution: "parallel",
			sessionId: this.affinityKey
		});
		this.eventCallback = options.onAgentEvent;
		this.agentLoop.subscribe(async (event) => {
			switch (event.type) {
				case "agent_start":
					this.emit({ type: "agent_start" });
					break;
				case "turn_start":
					this.activeTurnId ??= generateTurnId();
					this.emit({
						type: "turn_start",
						turnId: this.activeTurnId,
						purpose: "agent"
					});
					break;
				case "message_start": {
					const turnId = this.activeTurnId ?? generateTurnId();
					this.activeTurnId = turnId;
					if (event.message.role === "assistant") {
						const messageId = generateConversationEntryId();
						const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId) ?? null;
						this.canonicalAssistant = {
							messageId,
							parentId,
							blocks: /* @__PURE__ */ new Map()
						};
						this.canonicalToolRequestMessageId = void 0;
						this.canonicalToolResultParentId = void 0;
						const { role: _role, content: _content, stopReason: _stopReason, errorMessage: _errorMessage, timestamp: _timestamp, usage: _usage, ...modelInfo } = event.message;
						await this.appendCanonical([{
							...this.canonicalEnvelope("assistant_message_started"),
							type: "assistant_message_started",
							messageId,
							parentId,
							modelInfo
						}]);
					}
					this.emit({
						type: "message_start",
						message: event.message,
						turnId
					});
					break;
				}
				case "message_update": {
					const aEvent = event.assistantMessageEvent;
					const assistant = this.canonicalAssistant;
					if (assistant && aEvent.type === "text_start") {
						const blockId = `block_${crypto.randomUUID()}`;
						assistant.blocks.set(aEvent.contentIndex, {
							id: blockId,
							type: "text",
							deltaCount: 0,
							completed: false
						});
						await this.appendCanonical([{
							...this.canonicalEnvelope("assistant_text_started"),
							type: "assistant_text_started",
							messageId: assistant.messageId,
							blockId,
							blockIndex: aEvent.contentIndex
						}]);
					} else if (assistant && aEvent.type === "text_delta") {
						const block = assistant.blocks.get(aEvent.contentIndex);
						if (!block || block.type !== "text") throw new Error("[flue] Canonical text delta has no started block.");
						this.enqueueCanonical([{
							...this.canonicalEnvelope("assistant_text_delta"),
							type: "assistant_text_delta",
							messageId: assistant.messageId,
							blockId: block.id,
							sequence: block.deltaCount++,
							delta: aEvent.delta
						}], () => this.emit({
							type: "text_delta",
							text: aEvent.delta
						}));
					} else if (assistant && aEvent.type === "text_end") {
						const block = assistant.blocks.get(aEvent.contentIndex);
						if (!block || block.type !== "text") throw new Error("[flue] Canonical text completion has no started block.");
						const content = aEvent.partial.content[aEvent.contentIndex];
						await this.flushCanonical();
						await this.appendCanonical([{
							...this.canonicalEnvelope("assistant_text_completed"),
							type: "assistant_text_completed",
							messageId: assistant.messageId,
							blockId: block.id,
							deltaCount: block.deltaCount,
							...content?.type === "text" && content.textSignature ? { textSignature: content.textSignature } : {}
						}]);
						block.completed = true;
					} else if (assistant && aEvent.type === "thinking_start") {
						const blockId = `block_${crypto.randomUUID()}`;
						assistant.blocks.set(aEvent.contentIndex, {
							id: blockId,
							type: "reasoning",
							deltaCount: 0,
							completed: false
						});
						await this.appendCanonical([{
							...this.canonicalEnvelope("assistant_reasoning_started"),
							type: "assistant_reasoning_started",
							messageId: assistant.messageId,
							blockId,
							blockIndex: aEvent.contentIndex
						}]);
						this.emit({
							type: "thinking_start",
							contentIndex: aEvent.contentIndex
						});
					} else if (assistant && aEvent.type === "thinking_delta") {
						const block = assistant.blocks.get(aEvent.contentIndex);
						if (!block || block.type !== "reasoning") throw new Error("[flue] Canonical reasoning delta has no started block.");
						this.enqueueCanonical([{
							...this.canonicalEnvelope("assistant_reasoning_delta"),
							type: "assistant_reasoning_delta",
							messageId: assistant.messageId,
							blockId: block.id,
							sequence: block.deltaCount++,
							delta: aEvent.delta
						}], () => this.emit({
							type: "thinking_delta",
							contentIndex: aEvent.contentIndex,
							delta: aEvent.delta
						}));
					} else if (assistant && aEvent.type === "thinking_end") {
						const block = assistant.blocks.get(aEvent.contentIndex);
						if (!block || block.type !== "reasoning") throw new Error("[flue] Canonical reasoning completion has no started block.");
						const content = aEvent.partial.content[aEvent.contentIndex];
						await this.flushCanonical();
						await this.appendCanonical([{
							...this.canonicalEnvelope("assistant_reasoning_completed"),
							type: "assistant_reasoning_completed",
							messageId: assistant.messageId,
							blockId: block.id,
							deltaCount: block.deltaCount,
							...content?.type === "thinking" && content.thinkingSignature ? { encrypted: content.thinkingSignature } : {},
							...content?.type === "thinking" && content.redacted ? { redacted: true } : {}
						}]);
						block.completed = true;
						this.emit({
							type: "thinking_end",
							contentIndex: aEvent.contentIndex,
							content: aEvent.content
						});
					} else if (assistant && aEvent.type === "toolcall_end") await this.appendCanonical([{
						...this.canonicalEnvelope("assistant_tool_call"),
						type: "assistant_tool_call",
						messageId: assistant.messageId,
						blockId: `block_${crypto.randomUUID()}`,
						blockIndex: aEvent.contentIndex,
						toolCallId: aEvent.toolCall.id,
						name: aEvent.toolCall.name,
						arguments: aEvent.toolCall.arguments,
						...aEvent.toolCall.thoughtSignature ? { thoughtSignature: aEvent.toolCall.thoughtSignature } : {}
					}]);
					else if (aEvent.type === "text_delta") this.emit({
						type: "text_delta",
						text: aEvent.delta
					});
					else if (aEvent.type === "thinking_start") this.emit({
						type: "thinking_start",
						contentIndex: aEvent.contentIndex
					});
					else if (aEvent.type === "thinking_delta") this.emit({
						type: "thinking_delta",
						contentIndex: aEvent.contentIndex,
						delta: aEvent.delta
					});
					else if (aEvent.type === "thinking_end") this.emit({
						type: "thinking_end",
						contentIndex: aEvent.contentIndex,
						content: aEvent.content
					});
					break;
				}
				case "message_end": {
					const turnId = this.activeTurnId ?? generateTurnId();
					this.activeTurnId = turnId;
					if (event.message.role === "assistant") {
						const canonical = this.canonicalAssistant;
						if (canonical) {
							await this.flushCanonical();
							for (const block of canonical.blocks.values()) {
								if (block.completed) continue;
								await this.appendCanonical([block.type === "text" ? {
									...this.canonicalEnvelope("assistant_text_completed"),
									type: "assistant_text_completed",
									messageId: canonical.messageId,
									blockId: block.id,
									deltaCount: block.deltaCount
								} : {
									...this.canonicalEnvelope("assistant_reasoning_completed"),
									type: "assistant_reasoning_completed",
									messageId: canonical.messageId,
									blockId: block.id,
									deltaCount: block.deltaCount
								}]);
								block.completed = true;
							}
							await this.appendCanonical([{
								...this.canonicalEnvelope("assistant_message_completed"),
								type: "assistant_message_completed",
								messageId: canonical.messageId,
								stopReason: event.message.stopReason,
								usage: event.message.usage,
								...event.message.errorMessage ? { error: event.message.errorMessage } : {}
							}]);
							this.canonicalToolRequestMessageId = event.message.content.some((content) => content.type === "toolCall") ? canonical.messageId : void 0;
							this.canonicalAssistant = void 0;
						}
						const request = this.modelRequests.get(turnId) ?? this.modelRequestInfo(this.agentLoop.state.model);
						this.emitTurn(turnId, "agent", event.message, request);
						this.modelRequests.delete(turnId);
						this.modelRequestStartTimes.delete(turnId);
					}
					this.emit({
						type: "message_end",
						message: event.message,
						turnId
					});
					break;
				}
				case "tool_execution_start": {
					const tool = this.agentLoop.state.tools.find((candidate) => candidate.name === event.toolName);
					this.activeToolCalls.set(event.toolCallId, {
						startedAt: Date.now(),
						toolName: event.toolName,
						telemetry: tool ? this.modelToolTelemetry.get(tool) ?? {
							origin: "model",
							toolType: "function"
						} : {
							origin: "model",
							toolType: "function"
						},
						startEmitted: false
					});
					break;
				}
				case "tool_execution_update": break;
				case "tool_execution_end": {
					const call = this.activeToolCalls.get(event.toolCallId) ?? {
						startedAt: Date.now(),
						toolName: event.toolName,
						telemetry: {
							origin: "model",
							toolType: "function"
						},
						startEmitted: false
					};
					const assistantMessageId = this.canonicalToolRequestMessageId;
					if (!assistantMessageId) throw new Error("[flue] Canonical tool outcome has no assistant request.");
					const outcomeKey = `${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(event.toolCallId)}`;
					const messageId = `entry_tool_outcome_${outcomeKey}`;
					const result = event.result;
					const images = result.content.flatMap((content, index) => content.type === "image" ? [{
						id: `att_${messageId}_${index}`,
						mimeType: content.mimeType,
						data: content.data
					}] : []);
					const refs = await this.persistCanonicalAttachments(images);
					let imageIndex = 0;
					const details = result.details;
					const hasStructuredOutput = !event.isError && typeof details === "object" && details !== null && "output" in details;
					await this.appendCanonical([{
						...this.canonicalEnvelope("tool_outcome", `record_tool_outcome_${outcomeKey}`),
						type: "tool_outcome",
						assistantMessageId,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						isError: event.isError,
						content: result.content.map((content) => {
							if (content.type === "text") return {
								type: "text",
								text: content.text
							};
							const attachment = refs[imageIndex++];
							if (!attachment) throw new Error("[flue] Canonical tool outcome attachment is missing.");
							return {
								type: "attachment",
								attachment
							};
						}),
						...hasStructuredOutput ? { output: details?.output } : {}
					}]);
					if (!call.startEmitted) this.emit({
						type: "tool_start",
						toolName: call.toolName,
						toolCallId: event.toolCallId
					}, call.telemetry);
					const publishTool = () => this.emit({
						type: "tool",
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						isError: event.isError,
						result: event.result,
						durationMs: durationSince(call.startedAt)
					}, {
						...call.telemetry,
						...call.effectiveResultCaptured ? { effectiveResult: call.effectiveResult } : {},
						...event.isError ? { errorInfo: classifyError(call.error ?? event.result) } : {}
					});
					this.pendingToolPublications.set(event.toolCallId, publishTool);
					this.activeToolCalls.delete(event.toolCallId);
					break;
				}
				case "turn_end": {
					const turnId = this.activeTurnId ?? generateTurnId();
					if (event.toolResults.length > 0) {
						const parentId = this.canonicalToolResultParentId ?? await this.conversationWriter.getConversationLeaf(this.conversationId);
						if (!parentId) throw new Error("[flue] Canonical tool results have no assistant parent.");
						const assistantMessageId = this.canonicalToolRequestMessageId;
						if (!assistantMessageId) throw new Error("[flue] Canonical tool results have no assistant request.");
						const conversation = await this.requireConversation();
						const outcomeIds = event.toolResults.map((toolResult) => {
							const outcome = conversation.toolOutcomes.get(toolOutcomeKey(assistantMessageId, toolResult.toolCallId));
							if (!outcome) throw new Error("[flue] Canonical tool result has no durable outcome.");
							return outcome.recordId;
						});
						await this.appendCanonical([{
							...this.canonicalEnvelope("tool_results_committed", `record_tool_results_committed_${encodeCanonicalId(assistantMessageId)}`),
							type: "tool_results_committed",
							assistantMessageId,
							parentId,
							outcomeIds
						}]);
						for (const toolResult of event.toolResults) {
							this.pendingToolPublications.get(toolResult.toolCallId)?.();
							this.pendingToolPublications.delete(toolResult.toolCallId);
						}
						const finalToolResult = event.toolResults.at(-1);
						if (!finalToolResult) throw new ConversationRecordInvariantError({
							recordId: `record_tool_results_committed_${encodeCanonicalId(assistantMessageId)}`,
							recordType: "tool_results_committed",
							reason: "A committed canonical tool-result batch must contain at least one result."
						});
						this.canonicalToolResultParentId = toolResultEntryId(assistantMessageId, finalToolResult.toolCallId);
						this.canonicalToolRequestMessageId = void 0;
					}
					this.emit({
						type: "turn_messages",
						turnId,
						purpose: "agent",
						message: event.message,
						toolResults: event.toolResults
					});
					this.activeTurnId = void 0;
					break;
				}
				case "agent_end":
					this.emit({
						type: "agent_end",
						messages: event.messages
					});
					this.activeTurnId = void 0;
					break;
			}
		});
	}
	resolveCompactionSettings(model) {
		const cc = this.config.compaction;
		const defaults = model ? deriveCompactionDefaults({
			contextWindow: model.contextWindow ?? 0,
			maxTokens: model.maxTokens ?? 0
		}) : DEFAULT_COMPACTION_SETTINGS;
		if (cc === false) return {
			...defaults,
			enabled: false
		};
		if (!cc) return defaults;
		return {
			enabled: true,
			reserveTokens: cc.reserveTokens ?? defaults.reserveTokens,
			keepRecentTokens: cc.keepRecentTokens ?? defaults.keepRecentTokens
		};
	}
	async initializeCanonicalContext() {
		await this.rebuildCanonicalContext();
	}
	prompt(text, options) {
		return createCallHandle(options?.signal, (signal) => this.runOperation("prompt", signal, async () => {
			const schema = options?.result;
			return this.runPromptCall({
				promptText: buildPromptText(text, schema),
				schema,
				tools: options?.tools,
				frameworkTools: options?.frameworkTools,
				model: options?.model,
				thinkingLevel: options?.thinkingLevel,
				images: options?.images,
				errorLabel: "prompt",
				signal
			});
		}));
	}
	async inspectSubmissionInput(input) {
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation?.entries.has(this.canonicalInputEntryId(input))) return "absent";
		return this.inspectCanonicalState(classifyConversationSubmission(conversation, this.canonicalInputEntryId(input), { contextWindow: this.agentLoop.state.model?.contextWindow ?? 0 }));
	}
	/**
	* Reconstruct the submission result from persisted history for a
	* submission whose canonical response completed but whose settlement was
	* interrupted. Mirrors the response shape of `processSubmissionInput`
	* (text/usage/model) without replaying any provider work, so
	* reconciliation can resolve a waiting observer with the real result.
	* Returns undefined when the input or a completed response is absent.
	*/
	async reconstructSubmissionResult(input) {
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation) return void 0;
		const following = getActiveConversationPathSince(conversation, this.canonicalInputEntryId(input));
		if (!following) return void 0;
		const assistantEntry = getLatestCompletedAssistantEntry(following);
		if (!assistantEntry || assistantEntry.message.role !== "assistant") return void 0;
		const assistant = assistantEntry.message;
		const usage = aggregateConversationUsageSince(conversation, this.canonicalInputEntryId(input));
		if (!usage) return void 0;
		return {
			text: getAssistantText(assistant),
			usage,
			model: {
				provider: assistant.provider,
				id: assistant.model
			}
		};
	}
	processSubmissionInput(input, options) {
		return createCallHandle(void 0, (signal) => this.runOperation("prompt", signal, () => input.kind === "dispatch" ? this.runPersistedDispatchInput(agentSubmissionDispatchInput(input), signal, options) : this.runPersistedDirectSubmissionInput(input, signal, options)));
	}
	/**
	* Complete the trailing partial tool-result batch left by a turn that was
	* interrupted mid-batch, so resumption continues from the repaired batch
	* instead of replaying — and re-executing — tool calls whose results were
	* already recorded. Conservative by construction: every recorded result is
	* preserved (first-write-wins) and unresolved calls get explicit
	* unknown-outcome error results — never a re-execution. The batch is
	* derived from persisted canonical history. No-op when no trailing partial
	* batch exists.
	*/
	async repairTrailingPartialToolBatch(inputEntryId, signal) {
		const conversation = await this.requireConversation();
		const following = getActiveConversationPathSince(conversation, inputEntryId);
		if (!following) return;
		const partial = findTrailingPartialToolBatch(following.flatMap((entry) => entry.type === "message" ? [entry] : []));
		if (!partial) return;
		const resolvedTaskOutcomes = await this.resumeUnresolvedTaskCalls(conversation, partial, signal);
		await this.appendRepairedToolResultBatch(partial.entryId, partial.toolCalls, conversation, resolvedTaskOutcomes);
	}
	/**
	* Resume each unresolved model-invoked `task` call in a trailing partial
	* batch from its durable child conversation, returning a real `tool_outcome`
	* record per resolved call (keyed by tool call id). Calls without a
	* `child_session_retained` link (e.g. programmatic `session.task()`) are left
	* for the interrupted-marker path. Failure policy (D-B): a provably-permanent
	* config failure (`SubagentNotDeclaredError`) yields an error outcome so the
	* parent continues degraded; every other failure propagates so the parent's
	* retry budget re-attempts (never silently abandon possibly-recoverable work).
	*/
	async resumeUnresolvedTaskCalls(conversation, partial, signal) {
		const resolved = /* @__PURE__ */ new Map();
		for (const toolCall of partial.toolCalls) {
			if (toolCall.name !== "task") continue;
			if (conversation.toolOutcomes.get(toolOutcomeKey(partial.entryId, toolCall.id))) continue;
			const ref = [...conversation.childConversations.values()].find((child) => child.type === "task" && child.parentToolCallId === toolCall.id);
			if (!ref) continue;
			resolved.set(toolCall.id, await this.resumeChildTaskCall(partial.entryId, partial.assistant, toolCall.id, ref, signal));
		}
		return resolved;
	}
	/** Reattach to one in-flight child, resume it to completion, and build the
	*  parent's real `tool_outcome` for the originating `task` call. */
	async resumeChildTaskCall(assistantEntryId, assistant, toolCallId, ref, signal) {
		if (!this.createTaskSession) throw new Error("[flue] This session cannot resume task sessions.");
		const args = assistant.content.find((block) => block.type === "toolCall" && block.id === toolCallId)?.arguments ?? {};
		let taskAgent;
		try {
			taskAgent = args.agent ? this.resolveDeclaredSubagent(args.agent) : void 0;
		} catch (error) {
			if (error instanceof SubagentNotDeclaredError) return this.taskResumeFailureOutcomeRecord(assistantEntryId, toolCallId, error);
			throw error;
		}
		const taskStartMs = Date.now();
		let child;
		try {
			child = await this.createTaskSession({
				parentSession: this.name,
				parentConversationId: this.conversationId,
				taskId: ref.taskId,
				parentEnv: this.env,
				cwd: args.cwd,
				agent: taskAgent,
				depth: this.delegationDepth + 1,
				existing: { conversationId: ref.conversationId },
				...ref.parentToolCallId ? { parentToolCallId: ref.parentToolCallId } : {},
				...ref.parentAssistantEntryId ? { parentAssistantEntryId: ref.parentAssistantEntryId } : {}
			});
			this.activeTasks.add(child);
			const text = await child.resumeReattachedChild({
				timeoutAt: this.activeTimeoutAt,
				signal
			});
			this.emit({
				type: "task",
				taskId: ref.taskId,
				agent: taskAgent?.name,
				isError: false,
				result: text,
				durationMs: durationSince(taskStartMs),
				parentSession: this.name,
				session: child.name,
				conversationId: child.conversationId
			});
			return this.taskResumeOutcomeRecord(assistantEntryId, toolCallId, text);
		} finally {
			if (child) {
				await child.close();
				this.activeTasks.delete(child);
			}
		}
	}
	taskResumeOutcomeRecord(assistantEntryId, toolCallId, text) {
		const key = `${encodeCanonicalId(assistantEntryId)}_${encodeCanonicalId(toolCallId)}`;
		return {
			...this.canonicalEnvelope("tool_outcome", `record_tool_outcome_${key}`),
			type: "tool_outcome",
			assistantMessageId: assistantEntryId,
			toolCallId,
			toolName: "task",
			isError: false,
			content: [{
				type: "text",
				text: text || "(task completed with no text)"
			}]
		};
	}
	taskResumeFailureOutcomeRecord(assistantEntryId, toolCallId, error) {
		const key = `${encodeCanonicalId(assistantEntryId)}_${encodeCanonicalId(toolCallId)}`;
		return {
			...this.canonicalEnvelope("tool_outcome", `record_tool_resume_failed_${key}`),
			type: "tool_outcome",
			assistantMessageId: assistantEntryId,
			toolCallId,
			toolName: "task",
			isError: true,
			content: [{
				type: "text",
				text: JSON.stringify({
					type: "subagent_unavailable",
					message: error.message
				})
			}]
		};
	}
	/**
	* Shared repair core: build a complete ordered result batch for
	* `toolCalls`, preserving already-settled results (first-write-wins), using a
	* pre-resolved outcome where one was produced (resumed subagent task), and
	* synthesizing interrupted-marker error results for the remaining unresolved
	* calls — never a fabricated or assumed outcome.
	*/
	async appendRepairedToolResultBatch(assistantEntryId, toolCalls, conversation, resolved) {
		if (conversation.activeLeafId !== assistantEntryId) return;
		if (!toolCalls.at(-1)) throw new ConversationRecordInvariantError({
			recordId: `record_tool_repair_commit_${encodeCanonicalId(assistantEntryId)}`,
			recordType: "tool_results_committed",
			reason: "A repaired canonical tool-result batch must contain at least one tool call."
		});
		const outcomeRecords = [];
		const outcomeIds = [];
		for (const toolCall of toolCalls) {
			const outcome = conversation.toolOutcomes.get(toolOutcomeKey(assistantEntryId, toolCall.id));
			if (outcome) {
				outcomeIds.push(outcome.recordId);
				continue;
			}
			const resolvedRecord = resolved.get(toolCall.id);
			if (resolvedRecord) {
				outcomeRecords.push(resolvedRecord);
				outcomeIds.push(resolvedRecord.id);
				continue;
			}
			const recordId = `record_tool_repair_outcome_${`${encodeCanonicalId(assistantEntryId)}_${encodeCanonicalId(toolCall.id)}`}`;
			outcomeRecords.push({
				...this.canonicalEnvelope("tool_outcome", recordId),
				type: "tool_outcome",
				assistantMessageId: assistantEntryId,
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				isError: true,
				content: [{
					type: "text",
					text: JSON.stringify({
						type: "interrupted",
						message: "Tool execution was interrupted before completion. The outcome is unknown."
					})
				}]
			});
			outcomeIds.push(recordId);
		}
		if (outcomeRecords.length > 0) await this.appendCanonical(outcomeRecords);
		await this.appendCanonical([{
			...this.canonicalEnvelope("tool_results_committed", `record_tool_repair_commit_${encodeCanonicalId(assistantEntryId)}`),
			type: "tool_results_committed",
			assistantMessageId: assistantEntryId,
			parentId: assistantEntryId,
			outcomeIds
		}]);
		await this.rebuildCanonicalContext();
	}
	async recoverInterruptedStream(attempt, turnId) {
		{
			this.activeSubmissionId = attempt?.submissionId;
			this.activeSubmissionAttemptId = attempt?.attemptId;
			this.activeTurnId = turnId;
			const inProgress = await this.conversationWriter.findInProgressAssistant(this.conversationId, attempt?.submissionId);
			if (!inProgress) {
				const conversation = await this.conversationWriter.getConversation(this.conversationId);
				const partial = conversation ? getActiveConversationPath(conversation).findLast((entry) => entry.type === "message" && entry.submissionId === attempt?.submissionId && entry.message.role === "assistant" && entry.message.stopReason === "aborted" && entry.message.content.some((block) => block.type === "text" && block.text.length > 0)) : void 0;
				if (!partial) return false;
				const continuedEntryId = `entry_recovery_${partial.id}_stream_continued`;
				if (conversation?.activeLeafId === continuedEntryId && conversation.entries.has(`entry_recovery_${partial.id}_stream_interrupted`) && conversation.entries.has(continuedEntryId)) {
					await this.rebuildCanonicalContext();
					return true;
				}
				let parentId = partial.id;
				const records = [];
				for (const signalType of ["stream_interrupted", "stream_continued"]) {
					const messageId = `entry_recovery_${partial.id}_${signalType}`;
					records.push({
						...this.canonicalEnvelope("signal", `record_recovery_${partial.id}_${signalType}`),
						type: "signal",
						messageId,
						parentId,
						signalType,
						content: signalType === "stream_interrupted" ? "The previous assistant stream was interrupted." : "Continue from the durable partial assistant response."
					});
					parentId = messageId;
				}
				await this.appendCanonical(records);
				await this.rebuildCanonicalContext();
				return true;
			}
			const blocks = [...inProgress.blocks.values()];
			const continuable = !blocks.some((block) => block.type === "tool_call") && blocks.some((block) => (block.type === "text" || block.type === "reasoning") && block.deltas.join("").length > 0);
			const records = [];
			for (const block of blocks) if ((block.type === "text" || block.type === "reasoning") && !block.completed) records.push(block.type === "text" ? {
				...this.canonicalEnvelope("assistant_text_completed", `record_recovery_${inProgress.messageId}_${block.blockId}_completed`),
				type: "assistant_text_completed",
				messageId: inProgress.messageId,
				blockId: block.blockId,
				deltaCount: block.deltas.length
			} : {
				...this.canonicalEnvelope("assistant_reasoning_completed", `record_recovery_${inProgress.messageId}_${block.blockId}_completed`),
				type: "assistant_reasoning_completed",
				messageId: inProgress.messageId,
				blockId: block.blockId,
				deltaCount: block.deltas.length
			});
			records.push({
				...this.canonicalEnvelope("assistant_message_completed", `record_recovery_${inProgress.messageId}_aborted`),
				type: "assistant_message_completed",
				messageId: inProgress.messageId,
				stopReason: "aborted",
				usage: zeroProviderUsage(),
				error: "Stream interrupted before completion."
			});
			if (!continuable) {
				await this.appendCanonical(records);
				await this.rebuildCanonicalContext();
				return false;
			}
			let parentId = inProgress.messageId;
			for (const signalType of ["stream_interrupted", "stream_continued"]) {
				const messageId = `entry_recovery_${inProgress.messageId}_${signalType}`;
				records.push({
					...this.canonicalEnvelope("signal", `record_recovery_${inProgress.messageId}_${signalType}`),
					type: "signal",
					messageId,
					parentId,
					signalType,
					content: signalType === "stream_interrupted" ? "The previous assistant stream was interrupted." : "Continue from the durable partial assistant response."
				});
				parentId = messageId;
			}
			await this.appendCanonical(records);
			await this.rebuildCanonicalContext();
			return true;
		}
	}
	async recordSubmissionTerminal(input) {
		let body = input.message;
		if (input.interruptedTools && input.interruptedTools.length > 0) {
			const toolList = input.interruptedTools.map((t) => `  - ${t.name} (${t.id})`).join("\n");
			body += `\n\nInterrupted tool call(s):\n${toolList}`;
		}
		{
			const aborted = input.reason === "aborted";
			const signalType = aborted ? "submission_aborted" : "submission_interrupted";
			const slug = aborted ? "submission_aborted" : "submission_interrupted";
			const recordId = `record_${slug}_${input.submissionId}`;
			if (await this.conversationWriter.hasRecord(recordId)) return;
			const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
			await this.appendCanonical([{
				...this.canonicalEnvelope("signal", recordId),
				type: "signal",
				messageId: `entry_${slug}_${input.submissionId}`,
				parentId,
				signalType,
				content: body,
				attributes: {
					submissionId: input.submissionId,
					kind: input.kind,
					reason: input.reason
				}
			}]);
			await this.rebuildCanonicalContext();
		}
	}
	skill(skill, options) {
		return createCallHandle(options?.signal, (signal) => this.runOperation("skill", signal, async () => {
			const schema = options?.result;
			let promptText;
			let skillName;
			let activePackagedSkills;
			if (typeof skill === "string") {
				const registered = this.config.skills[skill];
				if (registered && "__flueSkillReference" in registered) {
					const packaged = this.resolvePackagedSkill(registered);
					promptText = buildPackagedSkillPrompt(registered, packaged, options?.args, schema);
					activePackagedSkills = { [registered.id]: packaged };
				} else if (registered) promptText = buildSkillByPathlessNamePrompt(skill, options?.args, schema);
				else this.throwMissingSkill(skill);
				skillName = skill;
			} else {
				const packaged = this.resolvePackagedSkill(skill);
				promptText = buildPackagedSkillPrompt(skill, packaged, options?.args, schema);
				activePackagedSkills = { [skill.id]: packaged };
				skillName = skill.name;
			}
			return this.runPromptCall({
				promptText,
				schema,
				tools: options?.tools,
				frameworkTools: options?.frameworkTools,
				model: options?.model,
				thinkingLevel: options?.thinkingLevel,
				images: options?.images,
				errorLabel: `skill("${skillName}")`,
				activePackagedSkills,
				signal
			});
		}));
	}
	task(text, options) {
		return createCallHandle(options?.signal, (signal) => this.runOperation("task", signal, async () => (await this.executeTask(text, options, signal)).output));
	}
	shell(command, options) {
		return createCallHandle(options?.signal, (signal) => this.runOperation("shell", signal, () => execShellWithEvents(this.env, (event, detail) => this.emit(event, detail), command, options, this.scopeSignal ? AbortSignal.any([signal, this.scopeSignal]) : signal, this.executionContext({ operationId: this.activeOperationId }), (toolCallId, args, result, isError) => this.appendShellTriple(toolCallId, args, result, isError))));
	}
	async compact() {
		await this.runOperation("compact", void 0, async () => {
			await this.runCompaction("manual");
		});
	}
	abort() {
		this.agentLoop.abort();
		this.compactionAbortController?.abort();
		this.modelRetryAbortController?.abort();
		for (const task of this.activeTasks) task.abort();
		for (const harness of this.activeActionHarnesses) harness.close();
	}
	async settle() {
		this.abort();
		await this.activeOperationSettlement;
		await Promise.allSettled([
			this.flushCanonical(),
			...[...this.activeTasks].map((task) => task.settle()),
			...[...this.activeActionHarnesses].map((harness) => harness.close())
		]);
	}
	close() {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.abort();
		this.closePromise = this.settle().finally(() => {
			this.onClose?.();
		});
		return this.closePromise;
	}
	/**
	* Precedence: call-level > agent-level default. A call-level specifier
	* resolves via `resolveModel` (which throws on an invalid specifier and never
	* returns undefined for a defined one); the agent default is always present.
	*/
	resolveModelForCall(modelSpecifier) {
		if (!modelSpecifier) return this.config.model;
		const model = this.config.resolveModel(modelSpecifier);
		if (!model) throw new Error(`[flue] Model "${modelSpecifier}" could not be resolved.`);
		return model;
	}
	/** Precedence: call-level > agent-level default > 'medium'. */
	resolveThinkingLevelForCall(callValue) {
		return callValue ?? this.config.thinkingLevel ?? "medium";
	}
	getProviderApiKey(providerId) {
		return getRegisteredApiKey(providerId);
	}
	/**
	* Provider-specific payload overrides. Returning undefined keeps the
	* upstream-built payload as-is.
	*/
	applyProviderPayloadOverrides(payload, model) {
		if (model.api !== "openai-responses" && model.api !== "azure-openai-responses") return;
		if (!getRegisteredStoreResponses(model.provider)) return;
		return {
			...payload,
			store: true
		};
	}
	resolvePackagedSkill(reference) {
		const packaged = getSkillReferenceDirectory(reference);
		if (!packaged) throw new Error(`[flue] Packaged skill "${reference.name}" is unavailable for this application build.`);
		return packaged;
	}
	async activateSkillForTool(name) {
		const registered = this.config.skills[name];
		if (!registered) this.throwMissingSkill(name);
		if ("__flueSkillReference" in registered) return buildPackagedSkillPrompt(registered, this.resolvePackagedSkill(registered));
		if (isWorkspaceSkill(registered)) return buildWorkspaceSkillPrompt(registered.name, registered.directory, registered.skillMdPath, await this.env.readFile(registered.skillMdPath));
		return buildSkillByPathlessNamePrompt(name);
	}
	throwMissingSkill(skill) {
		throw new SkillNotRegisteredError({
			skill,
			available: Object.keys(this.config.skills),
			skillsDir: skillsDirIn(this.env.cwd)
		});
	}
	toolTelemetry(source, tool) {
		return {
			origin: source === "adapter" ? "adapter" : source === "framework" || source === "result" ? "framework" : "model",
			toolType: source === "action" ? "extension" : "function",
			description: tool.description
		};
	}
	wrapModelTool(tool, source, prepare = (toolCallId, params, signal) => ({
		args: params,
		run: () => tool.execute(toolCallId, params, signal),
		result: toolResultText
	})) {
		const telemetry = this.toolTelemetry(source, tool);
		const wrapped = {
			...tool,
			execute: async (toolCallId, params, signal) => {
				let prepared;
				try {
					if (signal?.aborted) throw abortErrorFor(signal);
					prepared = prepare(toolCallId, params, signal);
				} catch (error) {
					const call = this.activeToolCalls.get(toolCallId) ?? {
						startedAt: Date.now(),
						toolName: tool.name,
						telemetry,
						startEmitted: false
					};
					call.error = error;
					if (!call.startEmitted) {
						this.emit({
							type: "tool_start",
							toolName: tool.name,
							toolCallId
						}, telemetry);
						call.startEmitted = true;
					}
					this.activeToolCalls.set(toolCallId, call);
					throw error;
				}
				const call = this.activeToolCalls.get(toolCallId) ?? {
					startedAt: Date.now(),
					toolName: tool.name,
					telemetry,
					startEmitted: false
				};
				call.telemetry = telemetry;
				this.activeToolCalls.set(toolCallId, call);
				if (!call.startEmitted) {
					this.emit({
						type: "tool_start",
						toolName: tool.name,
						toolCallId
					}, {
						...telemetry,
						args: prepared.args
					});
					call.startEmitted = true;
				}
				try {
					const result = await interceptExecution({
						type: "tool",
						toolCallId,
						toolName: tool.name
					}, this.executionContext(), prepared.run);
					call.effectiveResult = prepared.result ? prepared.result(result) : result;
					call.effectiveResultCaptured = true;
					return result;
				} catch (error) {
					call.error = error;
					throw error;
				}
			}
		};
		this.modelToolTelemetry.set(wrapped, telemetry);
		return wrapped;
	}
	createCustomTools(tools) {
		return tools.map((toolDef) => {
			const preparedToolAdapter = getPreparedToolAdapter(toolDef);
			if (!preparedToolAdapter) assertToolDefinition(toolDef, `Tool "${toolDef.name}"`);
			const tool = {
				name: toolDef.name,
				label: toolDef.name,
				description: toolDef.description,
				parameters: preparedToolAdapter?.parameters ?? (toolDef.input ? valibotToJsonSchema(toolDef.input) : {
					type: "object",
					properties: {},
					additionalProperties: false
				}),
				execute: async () => {
					throw new Error("unreachable");
				}
			};
			return this.wrapModelTool(tool, "custom", (_toolCallId, params, signal) => {
				if (preparedToolAdapter) return {
					args: params,
					run: async () => ({
						content: [{
							type: "text",
							text: await preparedToolAdapter.execute(params, signal)
						}],
						details: { customTool: toolDef.name }
					}),
					result: toolResultText
				};
				const parsed = parseToolInput(toolDef, params, signal);
				return {
					args: parsed.input,
					run: async () => {
						const output = validateToolOutput(toolDef, await toolDef.run(parsed.context));
						return {
							content: [{
								type: "text",
								text: output === void 0 ? "null" : JSON.stringify(output)
							}],
							details: {
								customTool: toolDef.name,
								output
							}
						};
					},
					result: (value) => value.details.output
				};
			});
		});
	}
	createActionTools() {
		return this.actions.map((action) => {
			const tool = {
				name: action.name,
				label: action.name,
				description: action.description,
				parameters: action.input ? valibotToJsonSchema(action.input) : {
					type: "object",
					properties: {},
					additionalProperties: false
				},
				execute: async () => {
					throw new Error("unreachable");
				}
			};
			return this.wrapModelTool(tool, "action", (toolCallId, input, signal) => {
				const parsedInput = parseActionInput(action, action.input ? input : void 0);
				return {
					args: parsedInput.declared ? parsedInput.value : void 0,
					run: () => this.executeActionTool(action, toolCallId, parsedInput, signal),
					result: (value) => value.details.output
				};
			});
		});
	}
	async executeActionTool(action, toolCallId, parsedInput, signal) {
		if (!this.createActionHarness) throw new Error("[flue] This session cannot execute Actions.");
		if (this.delegationDepth >= MAX_DELEGATION_DEPTH) throw new DelegationDepthExceededError({ maxDepth: MAX_DELEGATION_DEPTH });
		const invocationId = crypto.randomUUID();
		const harness = this.createActionHarness({
			invocationId,
			parentConversationId: this.conversationId,
			depth: this.delegationDepth + 1,
			signal,
			executionContext: this.executionIdentity,
			eventCallback: this.eventCallback,
			config: this.config,
			env: this.env,
			tools: this.agentTools,
			actions: this.actions,
			retainSession: async (session, conversation, harness) => {
				await this.conversationWriter.ensureChildConversation({
					parent: {
						conversationId: this.conversationId,
						harness: this.executionIdentity.harness ?? "default",
						session: this.name
					},
					child: {
						kind: "action",
						conversationId: conversation.conversationId,
						harness,
						session,
						affinityKey: conversation.affinityKey,
						createdAt: conversation.createdAt,
						parentConversationId: this.conversationId,
						actionInvocationId: invocationId
					},
					ref: {
						conversationId: conversation.conversationId,
						harness,
						session,
						type: "action",
						invocationId
					}
				});
			}
		});
		this.activeActionHarnesses.add(harness);
		try {
			const output = await runActionWithParsedInput(action, {
				harness,
				log: this.createActionLogger(action.name, toolCallId)
			}, parsedInput);
			return {
				content: [{
					type: "text",
					text: output === void 0 ? "null" : JSON.stringify(output)
				}],
				details: {
					action: action.name,
					invocationId,
					toolCallId,
					output
				}
			};
		} finally {
			this.activeActionHarnesses.delete(harness);
			await harness.close();
		}
	}
	createActionLogger(action, toolCallId) {
		const emit = (level, message, attributes) => this.emit({
			type: "log",
			level,
			message,
			attributes: {
				...attributes,
				action,
				toolCallId
			}
		});
		return {
			info: (message, attributes) => emit("info", message, attributes),
			warn: (message, attributes) => emit("warn", message, attributes),
			error: (message, attributes) => emit("error", message, attributes)
		};
	}
	assembleModelTools(baseGroups, customDefinitions, extraTools) {
		const groups = [
			...baseGroups,
			{
				source: "custom",
				tools: this.createCustomTools(customDefinitions)
			},
			{
				source: "action",
				tools: this.createActionTools()
			},
			{
				source: "result",
				tools: extraTools
			}
		];
		const seen = /* @__PURE__ */ new Map();
		const frameworkReserved = new Set([
			"task",
			"activate_skill",
			READ_SKILL_RESOURCE_TOOL_NAME,
			FINISH_TOOL_NAME,
			GIVE_UP_TOOL_NAME
		]);
		for (const group of groups) for (const tool of group.tools) {
			if (frameworkReserved.has(tool.name) && group.source !== "framework" && !(group.source === "result" && (tool.name === "finish" || tool.name === "give_up"))) throw new ToolNameConflictError({
				name: tool.name,
				conflict: "reserved",
				source: group.source,
				reserved: [...frameworkReserved]
			});
			if (seen.has(tool.name)) throw new ToolNameConflictError({
				name: tool.name,
				conflict: "duplicate",
				source: group.source
			});
			seen.set(tool.name, group.source);
		}
		return groups.flatMap((group) => group.source === "custom" || group.source === "action" ? group.tools : group.tools.map((tool) => group.source === "result" ? this.wrapModelTool(tool, group.source, (toolCallId, params, signal) => {
			if (signal?.aborted) throw abortErrorFor(signal);
			return prepareResultTool(tool, params) ?? {
				args: params,
				run: () => tool.execute(toolCallId, params, signal),
				result: toolResultText
			};
		}) : this.wrapModelTool(tool, group.source)));
	}
	/** Build built-in tools from the sandbox adapter or the framework defaults. */
	createBuiltinToolGroups(env, tools, model, thinkingLevel, activePackagedSkills, frameworkToolOptions) {
		const runTask = (params, signal, toolCallId) => this.runTaskForTool(params, tools, model, thinkingLevel, signal, toolCallId);
		const packagedSkills = {
			...getRegisteredPackagedSkills(this.config.skills),
			...activePackagedSkills
		};
		const skillNames = Object.keys(this.config.skills);
		const activateSkillTool = skillNames.length > 0 ? createActivateSkillTool(skillNames, (name) => this.activateSkillForTool(name)) : void 0;
		const packagedRead = Object.values(packagedSkills).some((skill) => Object.keys(skill.files).some((path) => path !== "SKILL.md")) ? createPackagedSkillReadTool(packagedSkills) : void 0;
		const frameworkTools = (taskTool) => [
			...frameworkToolOptions?.task === false ? [] : [taskTool],
			...activateSkillTool ? [activateSkillTool] : [],
			...packagedRead ? [packagedRead] : []
		];
		if (this.toolFactory) {
			let adapterTools = this.toolFactory(env, { subagents: this.config.subagents ?? {} });
			if (packagedRead) {
				const adapterRead = adapterTools.find((tool) => tool.name === "read");
				if (adapterRead) adapterTools = adapterTools.map((tool) => tool !== adapterRead ? tool : {
					...tool,
					execute: (id, params, signal) => {
						const resourcePath = typeof params === "object" && params !== null && "path" in params ? params.path : void 0;
						return typeof resourcePath === "string" && resourcePath.startsWith("/.flue/packaged-skills/") ? packagedRead.execute(id, params, signal) : adapterRead.execute(id, params, signal);
					}
				});
			}
			return [{
				source: "adapter",
				tools: adapterTools
			}, {
				source: "framework",
				tools: frameworkTools(createTaskTool(runTask, this.config.subagents ?? {}))
			}];
		}
		return [{
			source: "builtin",
			tools: createTools(env, {
				subagents: this.config.subagents ?? {},
				packagedSkills
			})
		}, {
			source: "framework",
			tools: frameworkTools(createTaskTool(runTask, this.config.subagents ?? {}))
		}];
	}
	async withCallOverrides(options, fn) {
		const previousTools = this.agentLoop.state.tools;
		const previousModel = this.agentLoop.state.model;
		const previousThinkingLevel = this.agentLoop.state.thinkingLevel;
		const resolvedModel = this.resolveModelForCall(options.model);
		this.agentLoop.state.model = resolvedModel;
		this.agentLoop.state.thinkingLevel = this.resolveThinkingLevelForCall(options.thinkingLevel);
		const builtinToolGroups = this.createBuiltinToolGroups(this.env, options.tools, options.model, options.thinkingLevel, options.activePackagedSkills, options.frameworkTools);
		this.agentLoop.state.tools = this.assembleModelTools(builtinToolGroups, [...this.agentTools, ...options.tools], options.extraTools ?? []);
		try {
			return await fn({ resolvedModel });
		} finally {
			this.agentLoop.state.tools = previousTools;
			this.agentLoop.state.model = previousModel;
			this.agentLoop.state.thinkingLevel = previousThinkingLevel;
		}
	}
	resolveDeclaredSubagent(name) {
		const subagents = this.config.subagents ?? {};
		const subagent = subagents[name];
		if (subagent) return subagent;
		throw new SubagentNotDeclaredError({
			subagent: name,
			available: Object.keys(subagents)
		});
	}
	async runTaskForTool(params, tools, inheritedModel, inheritedThinkingLevel, signal, toolCallId) {
		const attachmentIds = [...new Set((params.attachments ?? []).map((attachment) => attachment.id))];
		const images = await this.resolveCanonicalImages(attachmentIds);
		const result = await this.executeTask(params.prompt, {
			agent: params.agent,
			inheritedModel,
			inheritedThinkingLevel,
			cwd: params.cwd,
			images,
			tools: params.agent ? void 0 : tools,
			toolCallId
		}, signal);
		return {
			content: [{
				type: "text",
				text: result.text || "(task completed with no text)"
			}],
			details: {
				taskId: result.taskId,
				session: result.session,
				messageId: result.messageId,
				agent: result.agent,
				cwd: result.cwd
			}
		};
	}
	async executeTask(text, options, signal) {
		this.assertActive();
		if (!this.createTaskSession) throw new Error("[flue] This session cannot create task sessions.");
		if (this.delegationDepth >= MAX_DELEGATION_DEPTH) throw new DelegationDepthExceededError({ maxDepth: MAX_DELEGATION_DEPTH });
		assertImagesWithinLimit(options?.images);
		if (signal?.aborted) throw abortErrorFor(signal);
		const taskId = crypto.randomUUID();
		const taskAgent = options?.agent ? this.resolveDeclaredSubagent(options.agent) : void 0;
		let child;
		let abortListener;
		const taskStartMs = Date.now();
		try {
			child = await this.createTaskSession({
				parentSession: this.name,
				parentConversationId: this.conversationId,
				taskId,
				parentEnv: this.env,
				cwd: options?.cwd,
				agent: taskAgent,
				depth: this.delegationDepth + 1,
				...options?.toolCallId ? { parentToolCallId: options.toolCallId } : {},
				...options?.toolCallId && this.canonicalToolRequestMessageId ? { parentAssistantEntryId: this.canonicalToolRequestMessageId } : {}
			});
			this.activeTasks.add(child);
			this.emit({
				type: "task_start",
				taskId,
				prompt: text,
				agent: taskAgent?.name,
				cwd: options?.cwd,
				parentSession: this.name,
				session: child.name,
				conversationId: child.conversationId
			}, {
				agentInput: {
					text: buildPromptText(text, options?.result),
					...options?.images?.length ? { images: options.images.map((image) => ({ mimeType: image.mimeType })) } : {}
				},
				...options?.toolCallId ? { toolCallId: options.toolCallId } : {}
			});
			if (signal) {
				abortListener = () => child?.abort();
				signal.addEventListener("abort", abortListener, { once: true });
			}
			const schema = options?.result;
			const childOptions = {
				model: options?.model ?? (taskAgent?.model !== void 0 ? void 0 : options?.inheritedModel),
				thinkingLevel: options?.thinkingLevel ?? (taskAgent?.thinkingLevel !== void 0 ? void 0 : options?.inheritedThinkingLevel),
				tools: options?.tools,
				frameworkTools: options?.frameworkTools,
				images: options?.images,
				signal
			};
			if (schema) childOptions.result = schema;
			const taskChild = child;
			const output = await interceptExecution({
				type: "task",
				taskId
			}, this.executionContext({
				conversationId: taskChild.conversationId,
				session: taskChild.name,
				taskId
			}), async () => taskChild.prompt(text, childOptions));
			const taskResult = {
				output,
				text: typeof output?.text === "string" ? output.text : child.getAssistantText(),
				taskId,
				session: child.name,
				messageId: await child.getLatestAssistantMessageId(),
				agent: taskAgent?.name,
				cwd: options?.cwd
			};
			this.emit({
				type: "task",
				taskId,
				agent: taskAgent?.name,
				isError: false,
				result: taskResult.text,
				durationMs: durationSince(taskStartMs),
				parentSession: this.name,
				session: child.name,
				conversationId: child.conversationId
			}, { agentOutput: child.agentInvocationOutput(output) });
			return taskResult;
		} catch (error) {
			this.emit({
				type: "task",
				taskId,
				agent: taskAgent?.name,
				isError: true,
				result: getErrorMessage(error),
				durationMs: durationSince(taskStartMs),
				parentSession: this.name,
				...child ? {
					session: child.name,
					conversationId: child.conversationId
				} : {}
			}, { errorInfo: classifyError(error) });
			throw error;
		} finally {
			if (signal && abortListener) signal.removeEventListener("abort", abortListener);
			if (child) {
				await child.close();
				this.activeTasks.delete(child);
			}
		}
	}
	async runOperation(operation, signal, fn) {
		const operationSignal = signal && this.scopeSignal ? AbortSignal.any([signal, this.scopeSignal]) : signal ?? this.scopeSignal;
		return this.runExclusive(operation, async () => {
			if (operationSignal?.aborted) throw abortErrorFor(operationSignal);
			this.activeOperationId = generateOperationId();
			const operationId = this.activeOperationId;
			const startedAt = Date.now();
			this.emit({
				type: "operation_start",
				operationId,
				operationKind: operation
			});
			const onAbort = () => {
				this.agentLoop.abort();
				this.compactionAbortController?.abort(operationSignal?.reason);
				this.modelRetryAbortController?.abort(operationSignal?.reason);
				for (const task of this.activeTasks) task.abort();
				for (const harness of this.activeActionHarnesses) harness.close();
			};
			operationSignal?.addEventListener("abort", onAbort, { once: true });
			try {
				const execute = () => fn();
				const result = operation === "prompt" || operation === "skill" ? await interceptExecution({
					type: "agent",
					operationId,
					operationKind: operation
				}, this.executionContext({ operationId }), execute) : await execute();
				this.emit({
					type: "operation",
					operationId,
					operationKind: operation,
					durationMs: durationSince(startedAt),
					isError: false,
					result,
					usage: usageFromResult(result)
				}, operation === "prompt" || operation === "skill" ? {
					agentInput: this.activeAgentInput,
					agentOutput: this.agentInvocationOutput(result)
				} : void 0);
				return result;
			} catch (error) {
				const surfaced = operationSignal?.aborted ? abortErrorFor(operationSignal) : error;
				this.emit({
					type: "operation",
					operationId,
					operationKind: operation,
					durationMs: durationSince(startedAt),
					isError: true,
					error: serializeError(surfaced)
				}, operation === "prompt" || operation === "skill" ? {
					agentInput: this.activeAgentInput,
					errorInfo: classifyError(surfaced)
				} : void 0);
				throw surfaced;
			} finally {
				operationSignal?.removeEventListener("abort", onAbort);
				this.emit({ type: "idle" });
				this.activeOperationId = void 0;
				this.activeAgentInput = void 0;
			}
		});
	}
	async runExclusive(operation, fn) {
		this.assertActive();
		if (this.activeOperation) throw new SessionBusyError({
			session: this.name,
			activeOperation: this.activeOperation
		});
		this.activeOperation = operation;
		this.activeOperationSettlement = new Promise((resolve) => {
			this.resolveActiveOperationSettlement = resolve;
		});
		try {
			return await fn();
		} finally {
			this.activeOperation = void 0;
			this.resolveActiveOperationSettlement?.();
			this.resolveActiveOperationSettlement = void 0;
		}
	}
	executionContext(overrides = {}) {
		return {
			...this.executionIdentity,
			conversationId: this.conversationId,
			session: this.name,
			...this.activeOperationId ? { operationId: this.activeOperationId } : {},
			...this.activeTurnId ? { turnId: this.activeTurnId } : {},
			...overrides
		};
	}
	emit(event, observation) {
		const decorated = {
			...redactEventImages(event),
			conversationId: event.conversationId ?? this.conversationId,
			session: event.session ?? this.name
		};
		const operationId = event.operationId ?? this.activeOperationId;
		if (operationId !== void 0) decorated.operationId = operationId;
		const turnId = event.turnId ?? this.activeTurnId;
		if (turnId !== void 0) decorated.turnId = turnId;
		this.eventCallback?.(decorated, redactObservationDetailImages(observation));
	}
	assertActive() {
		if (this.closed) throw abortErrorFor(AbortSignal.abort());
	}
	/** Append a `session.shell()` call as an LLM-shaped bash tool exchange. */
	async resolveCanonicalImages(ids) {
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation) throw new AttachmentNotAvailableError({ attachmentId: ids[0] ?? "" });
		const available = this.visibleCanonicalAttachments(conversation);
		const images = [];
		for (const id of ids) {
			const attachment = available.get(id);
			if (!attachment) throw new AttachmentNotAvailableError({ attachmentId: id });
			const stored = await this.attachmentStore.get({
				streamPath: this.conversationWriter.path,
				conversationId: this.conversationId,
				attachmentId: id
			});
			if (!stored) throw new AttachmentNotAvailableError({ attachmentId: id });
			images.push({
				type: "image",
				data: encodeBase64(stored.bytes),
				mimeType: attachment.mimeType
			});
		}
		return images;
	}
	visibleCanonicalAttachments(conversation) {
		const available = /* @__PURE__ */ new Map();
		for (const contextEntry of projectConversationModelContextEntries(conversation, { resolveAttachment: (attachment) => ({
			data: attachment.id,
			mimeType: attachment.mimeType
		}) })) {
			if (contextEntry.sourceEntry.type !== "message") continue;
			for (const attachment of contextEntry.sourceEntry.attachmentRefs?.values() ?? []) available.set(attachment.id, attachment);
		}
		return available;
	}
	async persistCanonicalAttachments(attachments) {
		const refs = [];
		for (const attachment of attachments) {
			const bytes = decodeBase64$1(attachment.data);
			const ref = await createAttachmentRef({
				id: attachment.id,
				mimeType: attachment.mimeType,
				bytes,
				...attachment.filename ? { filename: attachment.filename } : {}
			});
			await this.attachmentStore.put({
				streamPath: this.conversationWriter.path,
				attachment: ref,
				bytes,
				conversationId: this.conversationId
			});
			refs.push(ref);
		}
		return refs;
	}
	async appendShellTriple(toolCallId, args, toolResult, isError) {
		const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
		const userMessageId = generateConversationEntryId();
		const assistantMessageId = generateConversationEntryId();
		const resultMessageId = toolResultEntryId(assistantMessageId, toolCallId);
		const refs = await this.persistCanonicalAttachments(toolResult.content.flatMap((content, index) => content.type === "image" ? [{
			id: `att_${resultMessageId}_${index}`,
			mimeType: content.mimeType,
			data: content.data
		}] : []));
		let imageIndex = 0;
		const attachmentContent = () => {
			const attachment = refs[imageIndex++];
			if (!attachment) throw new Error("[flue] Canonical shell attachment is missing.");
			return {
				type: "attachment",
				attachment
			};
		};
		await this.appendCanonical([
			{
				...this.canonicalEnvelope("user_message"),
				type: "user_message",
				messageId: userMessageId,
				parentId,
				content: [{
					type: "text",
					text: `Run this shell command:\n\n\`\`\`bash\n${String(args.command)}\n\`\`\``
				}]
			},
			{
				...this.canonicalEnvelope("assistant_message_started"),
				type: "assistant_message_started",
				messageId: assistantMessageId,
				parentId: userMessageId,
				modelInfo: {
					api: "flue-shell",
					provider: "flue",
					model: ""
				}
			},
			{
				...this.canonicalEnvelope("assistant_tool_call"),
				type: "assistant_tool_call",
				messageId: assistantMessageId,
				blockId: `block_${crypto.randomUUID()}`,
				blockIndex: 0,
				toolCallId,
				name: "bash",
				arguments: args
			},
			{
				...this.canonicalEnvelope("assistant_message_completed"),
				type: "assistant_message_completed",
				messageId: assistantMessageId,
				stopReason: "toolUse",
				usage: zeroProviderUsage()
			},
			{
				...this.canonicalEnvelope("tool_outcome", `record_tool_outcome_${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(toolCallId)}`),
				type: "tool_outcome",
				assistantMessageId,
				toolCallId,
				toolName: "bash",
				isError,
				content: toolResult.content.map((content) => content.type === "text" ? {
					type: "text",
					text: content.text
				} : attachmentContent())
			},
			{
				...this.canonicalEnvelope("tool_results_committed"),
				type: "tool_results_committed",
				assistantMessageId,
				parentId: assistantMessageId,
				outcomeIds: [`record_tool_outcome_${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(toolCallId)}`]
			}
		]);
		await this.rebuildCanonicalContext();
	}
	async requireConversation() {
		const conversation = await this.conversationWriter.getConversation(this.conversationId);
		if (!conversation) throw new Error("[flue] Canonical conversation is missing.");
		return conversation;
	}
	async resolveCanonicalContextAttachments(conversation) {
		const resolved = /* @__PURE__ */ new Map();
		for (const attachment of this.visibleCanonicalAttachments(conversation).values()) {
			const stored = await this.attachmentStore.get({
				streamPath: this.conversationWriter.path,
				conversationId: this.conversationId,
				attachmentId: attachment.id
			});
			if (!stored) throw new AttachmentNotAvailableError({ attachmentId: attachment.id });
			resolved.set(attachment.id, {
				type: "image",
				data: encodeBase64(stored.bytes),
				mimeType: stored.attachment.mimeType
			});
		}
		return resolved;
	}
	async rebuildCanonicalContext() {
		const conversation = await this.requireConversation();
		const resolved = await this.resolveCanonicalContextAttachments(conversation);
		const messages = projectConversationModelContext(conversation, { resolveAttachment: (attachment) => {
			const image = resolved.get(attachment.id);
			if (!image) throw new AttachmentNotAvailableError({ attachmentId: attachment.id });
			return image;
		} });
		this.agentLoop.state.messages = messages;
	}
	/**
	* Drive the agent loop with recovery: each iteration first evaluates the
	* trailing assistant (overflow → compact, transient error → back off) and
	* then starts the next turn, so one loop body serves both live turns and
	* resumption of persisted state.
	*
	* Live callers pass only `start`; their first iteration has nothing to
	* evaluate and recovery applies to the turns the loop itself produces.
	* The persisted-input resume path additionally passes `resume` with the
	* trailing assistant the classifier found after the input (if any), so
	* the persisted state gets the same recovery evaluation before the first
	* `continue()`. When recovery is already exhausted at resume entry, the
	* loop throws `OperationFailedError` for `resume.errorLabel`: no live
	* turn has run, so `agentLoop.state.errorMessage` is unset and the
	* caller's `throwIfError` could not surface the failure.
	*/
	async runModelTurnWithRecovery(options) {
		let start = options.start;
		let assistant = options.resume?.assistant;
		let turnCompleted = false;
		let overflowRecoveryAttempted = false;
		const throwIfHalted = () => {
			if (options.signal.aborted) throw abortErrorFor(options.signal);
			if (this.activeTimeoutAt !== void 0 && Date.now() >= this.activeTimeoutAt) throw new SubmissionTimeoutError();
		};
		while (true) {
			const overflow = assistant !== void 0 && isContextOverflow(assistant, this.agentLoop.state.model.contextWindow ?? 0);
			const retryable = !overflow && assistant !== void 0 && isRetryableModelError(assistant);
			if (turnCompleted && !overflow && !retryable) {
				if (assistant !== void 0) {
					await this.checkCompaction(assistant);
					if (assistant.stopReason === "error" || assistant.stopReason === "aborted") await this.rebuildCanonicalContext();
				}
				return;
			}
			if (overflow && overflowRecoveryAttempted) {
				await this.rebuildCanonicalContext();
				return;
			}
			throwIfHalted();
			if (overflow && assistant !== void 0) {
				overflowRecoveryAttempted = true;
				this.internalLog("info", "[flue:compaction] Overflow detected, compacting and retrying...");
				await this.rebuildCanonicalContext();
				if (!await this.runCompaction("overflow")) {
					if (!turnCompleted && options.resume) throw new OperationFailedError({
						operation: options.resume.errorLabel,
						reason: assistant.errorMessage ?? assistant.stopReason
					});
					return;
				}
				this.internalLog("info", "[flue:compaction] Retrying after overflow recovery...");
				start = () => this.agentLoop.continue();
			} else if (retryable && assistant !== void 0) {
				const transientRetries = countConsecutiveRetryableModelErrors(getActiveConversationPath(await this.requireConversation()).flatMap((entry) => entry.type === "message" ? [entry] : []));
				if (!await this.waitForTransientModelRetry(assistant, transientRetries)) {
					if (!turnCompleted && options.resume) throw new OperationFailedError({
						operation: options.resume.errorLabel,
						reason: assistant.errorMessage ?? assistant.stopReason
					});
					return;
				}
				start = () => this.agentLoop.continue();
			}
			if (overflow || retryable) throwIfHalted();
			try {
				await start();
				await this.agentLoop.waitForIdle();
			} catch (error) {
				await this.rebuildCanonicalContext();
				throw error;
			}
			turnCompleted = true;
			const messages = this.agentLoop.state.messages;
			const latest = messages[messages.length - 1];
			assistant = latest?.role === "assistant" ? latest : void 0;
		}
	}
	async waitForTransientModelRetry(assistant, attempt) {
		if (attempt > MAX_TRANSIENT_MODEL_RETRIES) {
			this.internalLog("warn", "[flue:model-retry] Transient model error retries exhausted", {
				attempts: attempt - 1,
				error: assistant.errorMessage
			});
			await this.rebuildCanonicalContext();
			return false;
		}
		const delayMs = modelRetryDelayMs(attempt);
		await this.rebuildCanonicalContext();
		this.modelRetryAbortController = new AbortController();
		this.internalLog("warn", "[flue:model-retry] Retrying transient model error", {
			attempt,
			maxRetries: MAX_TRANSIENT_MODEL_RETRIES,
			delayMs,
			error: assistant.errorMessage
		});
		try {
			await sleepUntilRetry(delayMs, this.modelRetryAbortController.signal);
		} finally {
			this.modelRetryAbortController = void 0;
		}
		return true;
	}
	async checkCompaction(assistantMessage) {
		if (assistantMessage.stopReason === "aborted" || assistantMessage.stopReason === "error") return;
		const model = this.agentLoop.state.model;
		const settings = this.resolveCompactionSettings(model);
		if (!settings.enabled) return;
		const contextWindow = model.contextWindow ?? 0;
		const contextTokens = calculateContextTokens(assistantMessage.usage);
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			this.internalLog("info", `[flue:compaction] Threshold reached — ${contextTokens} tokens used, window ${contextWindow}, reserve ${settings.reserveTokens}, triggering compaction`);
			await this.runCompaction("threshold");
		}
	}
	/**
	* Runs a compaction pass. The summarization cost (1–2 internal LLM
	* calls) is persisted on the resulting canonical compaction usage, which
	* `aggregateUsageSince` later folds into the surrounding call's
	* `response.usage` — so users see the true cost of the call that
	* triggered compaction.
	*/
	async runCompaction(reason) {
		this.compactionAbortController = new AbortController();
		const messagesBefore = this.agentLoop.state.messages.length;
		const compactionStartMs = Date.now();
		let terminalPending = false;
		try {
			const sessionModel = this.agentLoop.state.model;
			const settings = this.resolveCompactionSettings(sessionModel);
			const compactionConfig = this.config.compaction === false ? void 0 : this.config.compaction;
			const summarizationModel = compactionConfig?.model ? this.resolveModelForCall(compactionConfig.model) : sessionModel;
			const canonicalConversation = await this.requireConversation();
			const resolvedAttachments = await this.resolveCanonicalContextAttachments(canonicalConversation);
			const contextEntries = projectConversationModelContextEntries(canonicalConversation, { resolveAttachment: (attachment) => {
				const image = resolvedAttachments.get(attachment.id);
				if (!image) throw new AttachmentNotAvailableError({ attachmentId: attachment.id });
				return image;
			} });
			const messages = contextEntries.map((entry) => entry.message);
			const latestCompaction = getLatestConversationCompaction(canonicalConversation);
			const preparation = prepareCompaction(messages, settings, latestCompaction ? {
				summary: latestCompaction.summary,
				firstKeptIndex: 1,
				details: latestCompaction.details
			} : void 0);
			if (!preparation) {
				this.internalLog("info", "[flue:compaction] Nothing to compact (no valid cut point found)");
				return false;
			}
			const firstKeptEntry = contextEntries[preparation.firstKeptIndex]?.sourceEntry;
			if (!firstKeptEntry || firstKeptEntry.type !== "message") {
				this.internalLog("info", "[flue:compaction] Nothing to compact (first kept message has no entry)");
				return false;
			}
			this.internalLog("info", `[flue:compaction] Summarizing ${preparation.messagesToSummarize.length} messages` + (preparation.isSplitTurn ? ` (split turn: ${preparation.turnPrefixMessages.length} prefix messages)` : "") + `, keeping messages from index ${preparation.firstKeptIndex}`);
			const estimatedTokens = preparation.tokensBefore;
			this.emit({
				type: "compaction_start",
				reason,
				estimatedTokens
			});
			terminalPending = true;
			const result = await compact(preparation, summarizationModel, this.getProviderApiKey(summarizationModel.provider), this.compactionAbortController.signal, {
				start: (purpose, model, context, options) => {
					const handle = { turnId: generateTurnId() };
					this.emitTurnRequest(handle.turnId, purpose, model, context, options);
					return handle;
				},
				run: (handle, execute) => interceptExecution({
					type: "model",
					turnId: handle.turnId
				}, this.executionContext({
					operationId: this.activeOperationId,
					turnId: handle.turnId
				}), execute),
				end: (purpose, handle, _model, response, error) => {
					const request = this.modelRequests.get(handle.turnId);
					if (!request) throw new Error(`[flue] Missing model request telemetry for turn "${handle.turnId}".`);
					this.emitTurn(handle.turnId, purpose, response, request, error);
					this.modelRequests.delete(handle.turnId);
					this.modelRequestStartTimes.delete(handle.turnId);
				}
			});
			if (this.compactionAbortController.signal.aborted) {
				const abortError = abortErrorFor(this.compactionAbortController.signal);
				this.emit({
					type: "compaction",
					messagesBefore,
					messagesAfter: this.agentLoop.state.messages.length,
					durationMs: durationSince(compactionStartMs),
					isError: true,
					error: serializeError(abortError)
				});
				terminalPending = false;
				if (reason === "manual") throw abortError;
				return false;
			}
			{
				const sourceLeafId = (await this.requireConversation()).activeLeafId;
				if (!sourceLeafId) throw new Error("[flue] Canonical compaction has no source leaf.");
				await this.appendCanonical([{
					...this.canonicalEnvelope("compaction"),
					type: "compaction",
					entryId: generateConversationEntryId(),
					parentId: sourceLeafId,
					summary: result.summary,
					firstKeptEntryId: firstKeptEntry.id,
					sourceLeafId,
					tokensBefore: result.tokensBefore,
					details: result.details,
					usage: result.usage
				}]);
			}
			await this.rebuildCanonicalContext();
			const messagesAfter = this.agentLoop.state.messages.length;
			this.internalLog("info", `[flue:compaction] Complete — messages: ${messagesBefore} → ${messagesAfter}, tokens before: ${result.tokensBefore}`);
			this.emit({
				type: "compaction",
				messagesBefore,
				messagesAfter,
				durationMs: durationSince(compactionStartMs),
				isError: false,
				usage: result.usage
			});
			terminalPending = false;
			return true;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.internalLog("error", `[flue:compaction] Failed: ${errorMessage}`, { error });
			if (terminalPending) this.emit({
				type: "compaction",
				messagesBefore,
				messagesAfter: this.agentLoop.state.messages.length,
				durationMs: durationSince(compactionStartMs),
				isError: true,
				error: serializeError(error)
			});
			if (reason === "manual") throw error;
			return false;
		} finally {
			this.compactionAbortController = void 0;
		}
	}
	internalLog(level, message, attributes) {
		if (level === "error") console.error(message);
		this.emit({
			type: "log",
			level,
			message,
			attributes: normalizeLogAttributes(attributes)
		});
	}
	throwIfError(context) {
		const errorMsg = this.agentLoop.state.errorMessage;
		if (errorMsg) throw new OperationFailedError({
			operation: context,
			reason: errorMsg
		});
	}
	/**
	* Sum the usage of every entry the call appended to the active path
	* after `beforeLeafId`: assistant messages contribute their per-turn
	* `usage` (provider-reported, normalized through `fromProviderUsage`),
	* and compaction entries contribute the aggregated cost of the
	* summarization call(s) they dispatched. Returns zeros when nothing
	* was appended (defensive — `throwIfError` normally fires first).
	*
	* Walks the durable, parent-linked active path rather than the volatile
	* flat `agentLoop.state.messages` array, so the result is robust to
	* mid-call mutations (e.g. overflow recovery removing a failed
	* assistant turn before retry).
	*/
	async aggregateCanonicalUsageSince(beforeLeafId) {
		return aggregateConversationUsageSince(await this.requireConversation(), beforeLeafId) ?? emptyUsage();
	}
	agentInvocationOutput(result) {
		if (typeof result !== "object" || result === null) return void 0;
		if ("data" in result) return {
			type: "data",
			data: result.data
		};
		if ("text" in result && typeof result.text === "string") {
			const messages = this.agentLoop.state.messages;
			for (let i = messages.length - 1; i >= 0; i--) {
				const message = messages[i];
				if (message?.role === "assistant") return {
					type: "text",
					text: result.text,
					finishReason: message.stopReason
				};
			}
		}
	}
	getAssistantText() {
		const messages = this.agentLoop.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg?.role !== "assistant") continue;
			const content = msg.content;
			if (!Array.isArray(content)) continue;
			const textParts = [];
			for (const block of content) if (block.type === "text") textParts.push(block.text);
			return textParts.join("\n");
		}
		return "";
	}
	async getLatestAssistantMessageId() {
		return getActiveConversationPath(await this.requireConversation()).findLast((entry) => entry.type === "message" && entry.message.role === "assistant")?.id;
	}
	canonicalInputEntryId(input) {
		return input.kind === "dispatch" ? submissionEntryId("dispatch", input.dispatchId) : submissionEntryId("direct", input.submissionId);
	}
	inspectCanonicalState(state) {
		switch (state.kind) {
			case "absent": return "absent";
			case "completed": return "completed";
			case "interrupted_partial": return "continuable";
			case "resume": return state.mode === "overflow" || state.mode === "input_only" ? "uncertain" : "continuable";
			default: return "uncertain";
		}
	}
	async runPersistedDispatchInput(input, signal, options) {
		this.activeAgentInput = { text: renderSignalMessage(createDispatchInputSignal(input)) };
		return this.runPersistedContextInput({
			inputEntryId: submissionEntryId("dispatch", input.dispatchId),
			createCanonicalInput: (parentId) => {
				const signal = createDispatchInputSignal(input);
				return {
					...this.canonicalEnvelope("signal", `record_dispatch_input_${input.dispatchId}`),
					type: "signal",
					messageId: submissionEntryId("dispatch", input.dispatchId),
					parentId,
					dispatchId: input.dispatchId,
					signalType: signal.type,
					tagName: signal.tagName,
					content: signal.content,
					attributes: signal.attributes
				};
			},
			errorLabel: `dispatch(${input.dispatchId})`,
			onInputApplied: options?.onInputApplied,
			submissionAttempt: options?.submissionAttempt,
			startedAt: options?.startedAt,
			timeoutAt: options?.timeoutAt,
			signal
		});
	}
	/**
	* Resume the conversation from a persisted input entry to completion:
	* classify the canonical state after the input, repair an interrupted
	* trailing tool batch if needed, then drive the model turn(s). Conversation-
	* level and submission-agnostic — used both by the top-level submission resume
	* (`runPersistedContextInput`) and by an in-process subagent reattach
	* (`resumeReattachedChild`). Assumes any interrupted partial stream has
	* already been materialized (the coordinator does this for submissions via
	* `recoverInterruptedStream`; the child reattach calls it directly), so the
	* classified state is never `interrupted_partial` here.
	*/
	async resumeConversationToCompletion(options) {
		const state = classifyConversationSubmission(await this.requireConversation(), options.inputEntryId, { contextWindow: this.agentLoop.state.model.contextWindow ?? 0 });
		switch (state.kind) {
			case "absent": throw new OperationFailedError({
				operation: options.errorLabel,
				reason: "the input could not be persisted"
			});
			case "advanced_past_input": throw new OperationFailedError({
				operation: options.errorLabel,
				reason: "the session advanced past this input before it completed"
			});
			case "terminal_error": throw new OperationFailedError({
				operation: options.errorLabel,
				reason: state.reason
			});
			case "completed":
			case "resume":
				if (state.kind === "completed" && !state.overflow) break;
				if (state.kind === "resume" && state.mode === "tool_results_partial") await this.repairTrailingPartialToolBatch(options.inputEntryId, options.signal);
				await this.runModelTurnWithRecovery({
					start: () => this.agentLoop.continue(),
					signal: options.signal,
					resume: {
						assistant: state.assistant,
						errorLabel: options.errorLabel
					}
				});
				this.throwIfError(options.errorLabel);
				break;
			case "tool_use_unresolved":
				await this.repairTrailingPartialToolBatch(options.inputEntryId, options.signal);
				await this.runModelTurnWithRecovery({
					start: () => this.agentLoop.continue(),
					signal: options.signal,
					resume: {
						assistant: state.assistant,
						errorLabel: options.errorLabel
					}
				});
				this.throwIfError(options.errorLabel);
				break;
		}
	}
	/**
	* Resume a reattached subagent (recovery only) to completion, returning its
	* final assistant text for the parent's `task` outcome. Runs in the child's
	* own operation so child-internal events stay on the child context; inherits
	* the parent's deadline; materializes any interrupted partial stream (D-A,
	* identical to top-level recovery) before classifying and continuing from the
	* child's durable input. Idempotent: an already-completed child resumes as a
	* no-op and returns its recorded text.
	*/
	resumeReattachedChild(options) {
		return createCallHandle(options.signal, (signal) => this.runOperation("prompt", signal, async () => {
			const previousTimeout = this.activeTimeoutAt;
			this.activeTimeoutAt = options.timeoutAt;
			try {
				return await this.withCallOverrides({
					tools: [],
					model: void 0,
					thinkingLevel: void 0
				}, async () => {
					await this.recoverInterruptedStream();
					const inputEntry = getActiveConversationPath(await this.requireConversation()).find((entry) => entry.type === "message" && entry.message.role === "user");
					if (!inputEntry) throw new Error("[flue] Resumed task conversation has no durable input.");
					await this.resumeConversationToCompletion({
						inputEntryId: inputEntry.id,
						errorLabel: "task",
						signal
					});
					return this.getAssistantText();
				});
			} finally {
				this.activeTimeoutAt = previousTimeout;
			}
		}));
	}
	async runPersistedDirectSubmissionInput(input, signal, options) {
		this.activeAgentInput = {
			text: input.payload.message,
			...input.payload.images?.length ? { images: input.payload.images.map((image) => ({ mimeType: image.mimeType })) } : {}
		};
		return this.runPersistedContextInput({
			inputEntryId: submissionEntryId("direct", input.submissionId),
			createCanonicalInput: async (parentId) => {
				const refs = await this.persistCanonicalAttachments((input.payload.images ?? []).map((image, index) => ({
					id: `att_direct_${input.submissionId}_${index}`,
					mimeType: image.mimeType,
					data: image.data,
					...image.filename ? { filename: image.filename } : {}
				})));
				return {
					...this.canonicalEnvelope("user_message", `record_direct_input_${input.submissionId}`),
					type: "user_message",
					messageId: submissionEntryId("direct", input.submissionId),
					parentId,
					content: [{
						type: "text",
						text: input.payload.message
					}, ...refs.map((attachment) => ({
						type: "attachment",
						attachment
					}))]
				};
			},
			errorLabel: `direct(${input.submissionId})`,
			onInputApplied: options?.onInputApplied,
			submissionAttempt: options?.submissionAttempt,
			startedAt: options?.startedAt,
			timeoutAt: options?.timeoutAt,
			signal
		});
	}
	resolveSubmissionDurability(startedAt, timeoutAt) {
		return {
			maxRetry: this.config.durability?.maxAttempts ?? 10,
			timeoutAt: timeoutAt ?? (startedAt ?? Date.now()) + (this.config.durability?.timeoutMs ?? 36e5)
		};
	}
	async runPersistedContextInput(options) {
		return this.withCallOverrides({
			tools: [],
			model: void 0,
			thinkingLevel: void 0
		}, async ({ resolvedModel }) => {
			this.activeSubmissionId = options.submissionAttempt?.submissionId;
			this.activeSubmissionAttemptId = options.submissionAttempt?.attemptId;
			const durability = this.resolveSubmissionDurability(options.startedAt, options.timeoutAt);
			this.activeTimeoutAt = durability.timeoutAt;
			try {
				if (!await this.conversationWriter.hasConversationEntry(this.conversationId, options.inputEntryId)) {
					const parentId = await this.conversationWriter.getConversationLeaf(this.conversationId);
					await this.appendCanonical([await options.createCanonicalInput(parentId)]);
				}
				await this.rebuildCanonicalContext();
				await options.onInputApplied?.(durability);
				await this.resumeConversationToCompletion({
					inputEntryId: options.inputEntryId,
					errorLabel: options.errorLabel,
					signal: options.signal
				});
				return {
					text: this.getAssistantText(),
					usage: await this.aggregateCanonicalUsageSince(options.inputEntryId),
					model: {
						provider: resolvedModel.provider,
						id: resolvedModel.id
					}
				};
			} finally {
				this.activeSubmissionId = void 0;
				this.activeSubmissionAttemptId = void 0;
				this.activeTimeoutAt = void 0;
			}
		});
	}
	/**
	* Shared body of `prompt()` and `skill()`: scope the runtime, optionally
	* inject the result-tool pair, drive the agent loop, and aggregate usage.
	*
	* Returns `PromptResultResponse<T>` when a result schema is set, else `PromptResponse`.
	*/
	async runPromptCall(args) {
		assertImagesWithinLimit(args.images);
		this.activeAgentInput = {
			text: args.promptText,
			...args.images?.length ? { images: args.images.map((image) => ({ mimeType: image.mimeType })) } : {}
		};
		const resultBundle = args.schema ? createResultTools(args.schema) : void 0;
		return this.withCallOverrides({
			tools: args.tools ?? [],
			frameworkTools: args.frameworkTools,
			model: args.model,
			thinkingLevel: args.thinkingLevel,
			extraTools: resultBundle?.tools,
			activePackagedSkills: args.activePackagedSkills
		}, async ({ resolvedModel }) => {
			const beforeLeafId = await this.conversationWriter.getConversationLeaf(this.conversationId);
			const messageId = generateConversationEntryId();
			const refs = await this.persistCanonicalAttachments((args.images ?? []).map((image, index) => ({
				id: `att_prompt_${messageId}_${index}`,
				mimeType: image.mimeType,
				data: image.data
			})));
			await this.appendCanonical([{
				...this.canonicalEnvelope("user_message"),
				type: "user_message",
				messageId,
				parentId: beforeLeafId,
				content: [{
					type: "text",
					text: args.promptText
				}, ...refs.map((attachment) => ({
					type: "attachment",
					attachment
				}))]
			}]);
			await this.rebuildCanonicalContext();
			const projectedPrompt = this.agentLoop.state.messages.pop();
			if (projectedPrompt?.role !== "user") throw new Error("[flue] Canonical prompt projection is missing its user message.");
			const projectedContent = Array.isArray(projectedPrompt.content) ? projectedPrompt.content : [{
				type: "text",
				text: projectedPrompt.content
			}];
			const projectedText = projectedContent.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			const projectedImages = projectedContent.filter((block) => block.type === "image");
			const model = {
				provider: resolvedModel.provider,
				id: resolvedModel.id
			};
			if (resultBundle) return {
				data: await this.runWithResultTools(projectedText, projectedImages, resultBundle, args.errorLabel, args.signal),
				usage: await this.aggregateCanonicalUsageSince(beforeLeafId),
				model
			};
			await this.runModelTurnWithRecovery({
				start: () => this.agentLoop.prompt(projectedText, projectedImages),
				signal: args.signal
			});
			this.throwIfError(args.errorLabel);
			return {
				text: this.getAssistantText(),
				usage: await this.aggregateCanonicalUsageSince(beforeLeafId),
				model
			};
		});
	}
	/**
	* Drive the agent loop through one or more turns until the LLM either calls
	* the `finish` tool (success) or the `give_up` tool (typed error).
	*
	* If a turn ends with neither tool called, we send a brief reminder and
	* loop. There is no retry cap from the framework's perspective: the model has a
	* clear escape hatch via `give_up`, the user has cancellation via `signal`,
	* and pi-agent-core has its own iteration limits as the final ceiling.
	* `MAX_FOLLOWUPS` is a defense-in-depth ceiling against pathological loops.
	*
	*/
	async runWithResultTools(initialPrompt, initialImages, bundle, errorLabel, signal) {
		const MAX_FOLLOWUPS = 32;
		for (let attempt = 0; attempt <= MAX_FOLLOWUPS; attempt++) {
			if (signal.aborted) throw abortErrorFor(signal);
			await this.runModelTurnWithRecovery({
				start: () => this.agentLoop.prompt(attempt === 0 ? initialPrompt : buildResultFollowUpPrompt(), attempt === 0 ? initialImages : void 0),
				signal
			});
			this.throwIfError(errorLabel);
			const outcome = bundle.getOutcome();
			if (outcome.type === "finished") return outcome.value;
			if (outcome.type === "gave_up") throw new ResultUnavailableError(outcome.reason, this.getAssistantText());
		}
		throw new ResultUnavailableError(`Agent did not call \`finish\` or \`give_up\` after 33 attempts.`, this.getAssistantText());
	}
};
const publicSessionsBySession = /* @__PURE__ */ new WeakMap();
const internalSessionsByFacade = /* @__PURE__ */ new WeakMap();
/**
* Wrap an internal Session in a facade exposing exactly the {@link FlueSession}
* contract. Session instances carry internal runtime surface (the durable
* submission executor, `abort()`/`close()`, load-bearing `metadata`) that must
* not leak to user code at runtime. Repeated calls for the same Session return
* the same facade.
*/
function createPublicSession(session) {
	const existing = publicSessionsBySession.get(session);
	if (existing) return existing;
	const facade = {
		name: session.name,
		conversationId: session.conversationId,
		fs: session.fs,
		prompt: session.prompt.bind(session),
		shell: session.shell.bind(session),
		skill: session.skill.bind(session),
		task: session.task.bind(session),
		compact: session.compact.bind(session)
	};
	publicSessionsBySession.set(session, facade);
	internalSessionsByFacade.set(facade, session);
	return facade;
}
/**
* Recover the internal Session behind a facade produced by
* {@link createPublicSession}, or `undefined` when the object is not a
* registered facade (e.g. a test fake injected through a harness seam).
* Runtime-internal use only (durable submission processing).
*/
function getInternalSession(session) {
	return internalSessionsByFacade.get(session);
}
function serializeError(error) {
	if (error instanceof Error) return {
		name: error.name,
		message: error.message
	};
	return error;
}
function normalizeLogAttributes(attributes) {
	if (!attributes) return void 0;
	if (!(attributes.error instanceof Error)) return attributes;
	return {
		...attributes,
		error: serializeError(attributes.error)
	};
}
function zeroProviderUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
function encodeBase64(bytes) {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
	return btoa(binary);
}
function decodeBase64$1(value) {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function encodeCanonicalId(id) {
	const bytes = new TextEncoder().encode(id);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function submissionEntryId(kind, id) {
	return `entry_${kind}_${encodeCanonicalId(id)}`;
}
function durationSince(start) {
	return start === void 0 ? 0 : Date.now() - start;
}
function usageFromResult(result) {
	if (typeof result !== "object" || result === null) return void 0;
	const usage = result.usage;
	return isPromptUsage(usage) ? usage : void 0;
}
function isPromptUsage(value) {
	return typeof value === "object" && value !== null && typeof value.input === "number" && typeof value.output === "number" && typeof value.totalTokens === "number";
}
//#endregion
//#region src/runtime/agent-submissions.ts
function createDispatchAgentSubmissionInput(input) {
	return {
		...input,
		kind: "dispatch",
		submissionId: input.dispatchId
	};
}
function createDirectAgentSubmissionInput(options) {
	return {
		kind: "direct",
		submissionId: crypto.randomUUID(),
		agent: options.agent,
		id: options.id,
		payload: options.payload,
		acceptedAt: (/* @__PURE__ */ new Date()).toISOString(),
		...options.traceCarrier ? { traceCarrier: options.traceCarrier } : {}
	};
}
async function materializeAgentSubmissionSession(ctx, agent, input, attachmentStore) {
	if (input.kind === "direct") ctx.setSubmissionId?.(input.submissionId);
	const session = await openAgentSubmissionSession(ctx, agent, input);
	if (input.kind === "direct" && attachmentStore) for (const [index, image] of (input.payload.images ?? []).entries()) {
		const bytes = decodeBase64(image.data);
		const attachment = await createAttachmentRef({
			id: `att_direct_${input.submissionId}_${index}`,
			mimeType: image.mimeType,
			bytes,
			...image.filename ? { filename: image.filename } : {}
		});
		const streamPath = agentStreamPath(input.agent, input.id);
		await attachmentStore.put({
			streamPath,
			attachment,
			bytes,
			conversationId: session.conversationId
		});
	}
}
function createAgentSubmissionSessionHandler(agent, input, execute) {
	return async (ctx) => {
		return execute(await openAgentSubmissionSession(ctx, agent, input));
	};
}
function agentSubmissionDispatchId(input) {
	return input.kind === "dispatch" ? input.dispatchId : void 0;
}
function agentSubmissionDispatchInput(input) {
	const { kind: _kind, submissionId: _submissionId, ...dispatch } = input;
	return dispatch;
}
function createAgentSubmissionObserverRegistry() {
	const observers = /* @__PURE__ */ new Map();
	return {
		attach(submissionId, observer) {
			if (observers.has(submissionId)) throw new Error("[flue] Internal agent submission observer is already attached.");
			let resolve;
			let reject;
			const completion = new Promise((resolve_, reject_) => {
				resolve = resolve_;
				reject = reject_;
			});
			completion.catch(() => {});
			const attached = {
				...observer,
				resolve,
				reject
			};
			observers.set(submissionId, attached);
			return {
				completion,
				detach() {
					if (observers.get(submissionId) === attached) observers.delete(submissionId);
				}
			};
		},
		async publish(submissionId, event) {
			try {
				await observers.get(submissionId)?.onEvent?.(event);
			} catch (error) {
				console.warn("[flue:submission-observer] onEvent callback failed:", error);
			}
		},
		complete(submissionId, result) {
			observers.get(submissionId)?.resolve(result);
			observers.delete(submissionId);
		},
		fail(submissionId, error) {
			observers.get(submissionId)?.reject(error);
			observers.delete(submissionId);
		}
	};
}
/**
* Shared reconciliation decision tree for an interrupted running submission.
* Used by both the Cloudflare and Node agent coordinators.
*
* The `createContext` callback builds a `FlueContextInternal` for handler
* execution. Submission input is delivered through the session handler rather
* than context construction.
*/
async function reconcileInterruptedSubmission(submissions, submission, agent, createContext, lease, conversationWriter) {
	const { input } = submission;
	const attempt = submissionAttemptRef(submission);
	if (!attempt) return { disposition: "stale" };
	const dispatchId = agentSubmissionDispatchId(input);
	const ctx = createContext(dispatchId);
	if (submission.kind === "direct") ctx.setSubmissionId?.(submission.submissionId);
	const inspected = await createAgentSubmissionSessionHandler(agent, input, async (s) => {
		const state = await s.inspectSubmissionInput(input);
		return {
			state,
			result: state === "completed" ? await s.reconstructSubmissionResult(input) : void 0
		};
	})(ctx);
	const state = inspected.state;
	if (state === "completed") {
		if (submission.kind === "direct") await settleDirectSubmission(submissions, attempt, ctx, "completed", inspected.result, void 0, conversationWriter);
		else await submissions.completeSubmission(attempt);
		return {
			disposition: "completed",
			result: inspected.result
		};
	}
	if (submission.abortRequestedAt !== void 0) {
		const abortCtx = createContext(dispatchId);
		if (submission.kind === "direct") abortCtx.setSubmissionId?.(submission.submissionId);
		if (!await settleAbortedWithContext(submissions, submission, attempt, agent, abortCtx, conversationWriter)) return { disposition: "stale" };
		return {
			disposition: "failed",
			error: new SubmissionAbortedError()
		};
	}
	if (submission.attemptCount >= submission.maxRetry) return failInterruptedSubmission(submissions, submission, attempt, agent, "exhausted_retry_budget", submission.inputAppliedAt === void 0 ? new SubmissionInterruptedError({
		phase: "retry_exhausted_before_input",
		attemptCount: submission.attemptCount,
		maxAttempts: submission.maxRetry
	}) : new SubmissionRetryExhaustedError({
		attemptCount: submission.attemptCount,
		maxAttempts: submission.maxRetry
	}), createContext, void 0, conversationWriter);
	if (submission.timeoutAt > 0 && Date.now() >= submission.timeoutAt) return failInterruptedSubmission(submissions, submission, attempt, agent, "exceeded_timeout", new SubmissionTimeoutError(), createContext, void 0, conversationWriter);
	if (submission.inputAppliedAt === void 0 && state !== "absent") {
		const replacement = await submissions.replaceSubmissionAttempt(attempt, crypto.randomUUID(), lease);
		if (replacement?.attemptId) {
			const replacementAttempt = {
				submissionId: replacement.submissionId,
				attemptId: replacement.attemptId
			};
			if (!await submissions.markSubmissionInputApplied(replacementAttempt, {
				maxRetry: replacement.maxRetry,
				timeoutAt: replacement.timeoutAt
			})) return { disposition: "stale" };
			return {
				disposition: "replacement",
				submission: replacement
			};
		}
		return { disposition: "stale" };
	}
	if (state === "continuable" || state === "uncertain") {
		const replacement = await submissions.replaceSubmissionAttempt(attempt, crypto.randomUUID(), lease);
		if (!replacement?.attemptId) return { disposition: "stale" };
		if (state === "continuable") {
			const recoveryCtx = createContext(dispatchId);
			if (submission.kind === "direct") recoveryCtx.setSubmissionId?.(submission.submissionId);
			await createAgentSubmissionSessionHandler(agent, input, (s) => s.recoverInterruptedStream({
				submissionId: replacement.submissionId,
				attemptId: replacement.attemptId
			}))(recoveryCtx);
		}
		return {
			disposition: "replacement",
			submission: replacement
		};
	}
	if (submission.inputAppliedAt === void 0) {
		await submissions.requeueSubmissionBeforeInputApplied(attempt);
		return { disposition: "requeued" };
	}
	return failInterruptedSubmission(submissions, submission, attempt, agent, "interrupted_after_input_application", new SubmissionInterruptedError({ phase: "after_input_application" }), createContext, void 0, conversationWriter);
}
/**
* Create the event callback that forwards submission events to attached
* observers. Filters `run_start`/`run_end`, strips `runId`, and sets
* `instanceId`. Used by both Node and Cloudflare coordinators for direct
* submissions.
*/
function createSubmissionEventCallback(submissionId, instanceId, publish) {
	return (event) => {
		if (event.type === "run_start" || event.type === "run_end") return;
		const attachedEvent = {
			...event,
			instanceId,
			submissionId
		};
		delete attachedEvent.runId;
		return publish(submissionId, attachedEvent);
	};
}
/** Synthetic request for the submission's kind: an agent route for direct prompts, the dispatch path for dispatches. */
function submissionSyntheticRequest(input) {
	if (input.kind === "direct") return new Request(`https://flue.invalid/agents/${encodeURIComponent(input.agent)}/${encodeURIComponent(input.id)}`, { method: "POST" });
	return new Request("https://flue.invalid/_dispatch", { method: "POST" });
}
/**
* Shared submission processing logic used by both Node and Cloudflare
* coordinators. Validates the submission, creates a context, wires event
* forwarding for direct submissions, runs the agent handler, and settles
* the submission on success or failure.
*/
async function processSubmission(opts) {
	const { submissions, submission, observers } = opts;
	const { input } = submission;
	if (!submission.attemptId) return;
	if (input.kind === "dispatch") assertAgentDispatchAdmissionInput(input);
	const attempt = {
		submissionId: submission.submissionId,
		attemptId: submission.attemptId
	};
	const persisted = await submissions.getSubmission(submission.submissionId);
	if (persisted?.status !== "running" || persisted.attemptId !== attempt.attemptId) return;
	if (submission.attemptCount === 1 && opts.onInteractionStart) try {
		opts.onInteractionStart({
			agentName: input.agent,
			instanceId: input.id,
			kind: submission.kind,
			submissionId: submission.submissionId,
			dispatchId: agentSubmissionDispatchId(input)
		});
	} catch (error) {
		console.error("[flue:submission-observer] interaction start callback failed:", error);
	}
	const agent = opts.resolveAgent(input.agent);
	const ctx = opts.createContext(agentSubmissionDispatchId(input));
	if (submission.kind === "direct") {
		ctx.setSubmissionId?.(submission.submissionId);
		ctx.setEventCallback(createSubmissionEventCallback(submission.submissionId, input.id, (sid, event) => observers.publish(sid, event)));
	}
	const execute = () => createAgentSubmissionSessionHandler(agent, input, (session) => {
		const handle = session.processSubmissionInput(input, {
			onInputApplied: async (durability) => {
				if (!await submissions.markSubmissionInputApplied(attempt, durability)) throw new Error("[flue] Agent submission attempt lost ownership before input application.");
				if (submission.kind === "direct") try {
					await ctx.flushEventCallbacks();
				} catch (callbackError) {
					console.error("[flue:event-stream] Direct user event persistence failed before provider execution:", callbackError);
				}
			},
			startedAt: submission.startedAt,
			timeoutAt: submission.inputAppliedAt !== void 0 && submission.timeoutAt > 0 ? submission.timeoutAt : void 0,
			submissionAttempt: attempt
		});
		if (opts.signal && !opts.signal.aborted) {
			const signal = opts.signal;
			const onAbort = () => handle.abort(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			handle.then(() => signal.removeEventListener("abort", onAbort), () => signal.removeEventListener("abort", onAbort));
		} else if (opts.signal?.aborted) handle.abort(opts.signal.reason);
		return handle;
	})(ctx);
	try {
		if (persisted.abortRequestedAt !== void 0) {
			const settled = await settleAbortedWithContext(submissions, submission, attempt, agent, ctx, opts.conversationWriter);
			if (submission.kind === "direct" && settled) observers.fail(submission.submissionId, new SubmissionAbortedError());
			return;
		}
		let result;
		try {
			const run = () => interceptExecution({
				type: "agent",
				operationId: submission.submissionId,
				operationKind: "prompt"
			}, {
				instanceId: input.id,
				submissionId: submission.submissionId,
				dispatchId: agentSubmissionDispatchId(input),
				agentName: input.agent,
				traceCarrier: input.traceCarrier
			}, execute);
			result = await run();
		} catch (error) {
			if (opts.isShutdownAbort?.(error)) {
				if (submission.kind === "direct") observers.fail(submission.submissionId, error);
				throw error;
			}
			if (opts.signal?.reason instanceof SubmissionAbortedError) {
				const settled = await settleAbortedWithContext(submissions, submission, attempt, agent, ctx, opts.conversationWriter);
				if (submission.kind === "direct" && settled) observers.fail(submission.submissionId, new SubmissionAbortedError());
				return;
			}
			const settled = submission.kind === "direct" ? await settleDirectSubmission(submissions, attempt, ctx, "failed", void 0, error, opts.conversationWriter) : await submissions.failSubmission(attempt, error);
			if (submission.kind === "direct" && settled) observers.fail(submission.submissionId, error);
			throw error;
		}
		const settled = submission.kind === "direct" ? await settleDirectSubmission(submissions, attempt, ctx, "completed", result, void 0, opts.conversationWriter) : await submissions.completeSubmission(attempt);
		if (submission.kind === "direct" && settled) observers.complete(submission.submissionId, result);
	} finally {
		if (submission.kind === "direct") ctx.setEventCallback(void 0);
		opts.onSettled?.();
	}
}
async function failInterruptedSubmission(submissions, submission, attempt, agent, reason, error, createContext, interruptedTools, conversationWriter) {
	const { input } = submission;
	const ctx = createContext(agentSubmissionDispatchId(input));
	if (submission.kind === "direct") ctx.setSubmissionId?.(submission.submissionId);
	try {
		await createAgentSubmissionSessionHandler(agent, input, (s) => s.recordSubmissionTerminal({
			submissionId: submission.submissionId,
			kind: submission.kind,
			reason,
			message: error.message,
			interruptedTools
		}))(ctx);
	} catch (terminalError) {
		console.error("[flue:submission-reconciliation] Failed to record terminal message for submission", submission.submissionId, terminalError);
	}
	if (!(submission.kind === "direct" ? await settleDirectSubmission(submissions, attempt, ctx, "failed", void 0, error, conversationWriter) : await submissions.failSubmission(attempt, error))) return { disposition: "stale" };
	return {
		disposition: "failed",
		error
	};
}
/**
* Settle a submission as the distinct `aborted` terminal outcome. Shared by the
* pre-execution abort check, the in-flight abort catch, and the recovery abort
* branch.
*
* Both kinds record a `submission_aborted` conversation advisory (best-effort —
* a persistent save failure must not wedge settlement in a reconciliation loop)
* so the abort is always visible in the message timeline. Direct submissions
* additionally settle through the two-phase outbox with `outcome: 'aborted'`,
* the durable terminal record a reconnecting waiter observes; dispatch
* submissions settle the operational row with `failSubmission`.
*
* Returns whether the terminal settle CAS won. Callers that lost the CAS must
* not proceed as if they settled it (the first terminal state wins).
*/
async function settleAbortedWithContext(submissions, submission, attempt, agent, ctx, conversationWriter) {
	const error = new SubmissionAbortedError();
	try {
		await createAgentSubmissionSessionHandler(agent, submission.input, (s) => s.recordSubmissionTerminal({
			submissionId: submission.submissionId,
			kind: submission.kind,
			reason: "aborted",
			message: error.message
		}))(ctx);
	} catch (advisoryError) {
		console.error("[flue:submission-abort] Failed to record abort advisory for submission", submission.submissionId, advisoryError);
	}
	if (submission.kind === "direct") return settleDirectSubmission(submissions, attempt, ctx, "aborted", void 0, error, conversationWriter);
	return submissions.failSubmission(attempt, error);
}
async function settleDirectSubmission(submissions, attempt, ctx, outcome, result, error, conversationWriter) {
	const event = ctx.createEvent({
		type: "submission_settled",
		submissionId: attempt.submissionId,
		outcome,
		...outcome === "completed" ? { result } : { error: serializeSubmissionError(error) }
	});
	if (!conversationWriter) return false;
	const eventKey = `record_direct-submission:${attempt.submissionId}:settled`;
	const reduced = await conversationWriter.loadReducedState();
	const conversation = [...reduced.conversations.values()].find((candidate) => [...candidate.entries.values()].some((entry) => entry.submissionId === attempt.submissionId)) ?? [...reduced.conversations.values()].find((candidate) => candidate.harness === "default" && candidate.session === "default");
	if (!conversation) return false;
	const pending = (await submissions.listPendingSubmissionSettlements()).find((candidate) => candidate.submissionId === attempt.submissionId);
	const settlement = pending?.record ?? {
		v: 1,
		id: eventKey,
		type: "submission_settled",
		conversationId: conversation.conversationId,
		harness: conversation.harness,
		session: conversation.session,
		timestamp: (/* @__PURE__ */ new Date()).toISOString(),
		submissionId: attempt.submissionId,
		attemptId: attempt.attemptId,
		outcome,
		...outcome === "completed" ? { result } : { error: serializeSubmissionError(error) }
	};
	const obligation = pending ?? await submissions.reserveSubmissionSettlement(attempt, {
		recordId: eventKey,
		record: settlement
	});
	if (!obligation) return false;
	const existing = await conversationWriter.getRecord(eventKey);
	if (!existing) await conversationWriter.append([obligation.record], { submission: attempt });
	else if (JSON.stringify(existing) !== JSON.stringify(obligation.record)) console.error("[flue:submission-settlement] Canonical settlement conflict; the existing durable record is authoritative.", {
		submissionId: attempt.submissionId,
		recordId: eventKey
	});
	ctx.publishEvent(event);
	try {
		await ctx.flushEventCallbacks();
	} catch (callbackError) {
		console.error("[flue:subscriber] Terminal event subscriber failed:", callbackError);
	}
	return submissions.finalizeSubmissionSettlement(attempt, eventKey);
}
function decodeBase64(value) {
	const binary = atob(value);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function serializeSubmissionError(error) {
	if (error instanceof FlueError) return {
		name: error.name,
		message: error.message,
		type: error.type,
		details: error.details,
		...error.meta ? { meta: error.meta } : {}
	};
	return {
		name: "Error",
		message: "The agent submission failed because of an internal error.",
		type: "internal_error",
		details: "The server encountered an unexpected error while processing the agent submission."
	};
}
function submissionAttemptRef(submission) {
	if (!submission.attemptId) return null;
	return {
		submissionId: submission.submissionId,
		attemptId: submission.attemptId
	};
}
async function openAgentSubmissionSession(ctx, agent, _input) {
	const session = await (await ctx.initializeRootHarness(agent)).session(SUBMISSION_SESSION_NAME);
	return getInternalSession(session) ?? session;
}
//#endregion
//#region src/persisted-image-placement.ts
function submissionChunkOwner(submissionId) {
	return {
		kind: "submission",
		id: submissionId,
		part: ""
	};
}
function prepareDirectSubmission(input) {
	return extractDirectSubmissionImages(input);
}
function hydratePersistedDirectSubmission(input, rows) {
	return hydrateDirectSubmissionImages(input, reassemblePersistedChunks(rows));
}
function matchesPersistedDirectSubmission(input, persistedInput, rows) {
	try {
		return JSON.stringify(hydratePersistedDirectSubmission(persistedInput, rows)) === JSON.stringify(input);
	} catch {
		return false;
	}
}
function reassemblePersistedChunks(rows) {
	const grouped = /* @__PURE__ */ new Map();
	for (const row of rows) {
		const imageRows = grouped.get(row.imageId) ?? [];
		imageRows.push(row);
		grouped.set(row.imageId, imageRows);
	}
	const data = /* @__PURE__ */ new Map();
	for (const [imageId, imageRows] of grouped) {
		const ordered = imageRows.toSorted((left, right) => left.index - right.index);
		const expectedCount = ordered[0]?.count;
		if (expectedCount === void 0 || expectedCount < 1 || ordered.length !== expectedCount || ordered.some((row, index) => row.count !== expectedCount || row.index !== index)) throw new Error("[flue] Persisted image chunks are missing or malformed.");
		data.set(imageId, ordered.map((row) => row.data).join(""));
	}
	return data;
}
function samePersistedChunks(left, right) {
	if (left.length !== right.length) return false;
	const rightByKey = new Map(right.map((chunk) => [chunkKey(chunk), chunk]));
	return left.every((chunk) => {
		const other = rightByKey.get(chunkKey(chunk));
		return other !== void 0 && chunk.count === other.count && chunk.data === other.data;
	});
}
function chunkKey(chunk) {
	return `${chunk.imageId}\u0000${chunk.index}`;
}
//#endregion
//#region src/runtime/conversation-stream-store.ts
const CREATE_STREAMS_TABLE = `
CREATE TABLE IF NOT EXISTS flue_conversation_streams (
  path TEXT PRIMARY KEY,
  identity_json TEXT NOT NULL,
  next_offset INTEGER NOT NULL DEFAULT 0,
  producer_id TEXT,
  producer_epoch INTEGER NOT NULL DEFAULT 0,
  next_producer_sequence INTEGER NOT NULL DEFAULT 0,
  incarnation TEXT NOT NULL
)`;
const CREATE_BATCHES_TABLE = `
CREATE TABLE IF NOT EXISTS flue_conversation_stream_batches (
  path TEXT NOT NULL,
  seq INTEGER NOT NULL,
  producer_id TEXT NOT NULL,
  producer_epoch INTEGER NOT NULL,
  producer_sequence INTEGER NOT NULL,
  data TEXT NOT NULL,
  submission_id TEXT,
  attempt_id TEXT,
  PRIMARY KEY (path, seq),
  UNIQUE (path, producer_id, producer_epoch, producer_sequence)
)`;
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 1e3;
/**
* Shared in-memory listener registry for conversation-stream `subscribe` /
* `notify`. Every conversation store keeps a process-local fan-out of change
* listeners keyed by stream path; this class encapsulates the registration,
* unsubscribe-and-prune, and error-swallowing notify behavior so the stores do
* not each re-implement the same `Map<string, Set<() => void>>`.
*/
var StreamListenerRegistry = class {
	listeners = /* @__PURE__ */ new Map();
	subscribe(path, listener) {
		let listeners = this.listeners.get(path);
		if (!listeners) {
			listeners = /* @__PURE__ */ new Set();
			this.listeners.set(path, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners?.delete(listener);
			if (listeners?.size === 0) this.listeners.delete(path);
		};
	}
	notify(path) {
		for (const listener of this.listeners.get(path) ?? []) try {
			listener();
		} catch {}
	}
};
function ensureSqlConversationStreamTables(sql) {
	migrateFlueSqlSchema(sql, () => {
		sql.exec(CREATE_STREAMS_TABLE);
		sql.exec(CREATE_BATCHES_TABLE);
	});
}
var InMemoryConversationStreamStore = class {
	streams = /* @__PURE__ */ new Map();
	listeners = new StreamListenerRegistry();
	async createStream(path, identity) {
		const existing = this.streams.get(path);
		if (existing) {
			if (existing.identity.agentName !== identity.agentName || existing.identity.instanceId !== identity.instanceId) this.fail("create", path, "Stream identity conflicts.");
			return;
		}
		this.streams.set(path, {
			identity: { ...identity },
			incarnation: crypto.randomUUID(),
			producerId: null,
			producerEpoch: 0,
			nextProducerSequence: 0,
			batches: []
		});
	}
	async acquireProducer(path, producerId) {
		const stream = this.streams.get(path);
		if (!stream) this.fail("acquire_producer", path, "Stream does not exist.");
		stream.producerId = producerId;
		stream.producerEpoch += 1;
		stream.nextProducerSequence = 0;
		return {
			producerId,
			producerEpoch: stream.producerEpoch,
			incarnation: stream.incarnation,
			nextProducerSequence: 0,
			offset: formatOffset(stream.batches.length - 1)
		};
	}
	async append(input) {
		if (input.records.length === 0) this.fail("append", input.path, "A canonical batch cannot be empty.");
		const data = JSON.stringify(input.records);
		const stream = this.streams.get(input.path);
		if (!stream) this.fail("append", input.path, "Stream does not exist.");
		if (stream.producerId !== input.producerId || stream.producerEpoch !== input.producerEpoch || stream.incarnation !== input.incarnation) this.fail("append", input.path, "Producer ownership is stale.");
		const retry = stream.batches.find((batch) => batch.producerId === input.producerId && batch.producerEpoch === input.producerEpoch && batch.producerSequence === input.producerSequence);
		if (retry) {
			if (retry.data !== data || retry.submissionId !== (input.submission?.submissionId ?? null) || retry.attemptId !== (input.submission?.attemptId ?? null)) this.fail("append", input.path, "Producer sequence has conflicting content.");
			return { offset: retry.offset };
		}
		if (stream.nextProducerSequence !== input.producerSequence) this.fail("append", input.path, "Producer sequence is not the next expected value.");
		this.assertSubmissionOwnership(input.path, input.submission, input.records);
		const offset = formatOffset(stream.batches.length);
		stream.batches.push({
			offset,
			records: JSON.parse(data),
			producerId: input.producerId,
			producerEpoch: input.producerEpoch,
			producerSequence: input.producerSequence,
			data,
			submissionId: input.submission?.submissionId ?? null,
			attemptId: input.submission?.attemptId ?? null
		});
		stream.nextProducerSequence += 1;
		this.listeners.notify(input.path);
		return { offset };
	}
	async read(path, options) {
		const stream = this.streams.get(path);
		if (!stream) return {
			batches: [],
			nextOffset: "-1",
			upToDate: true
		};
		const head = stream.batches.length - 1;
		const rawOffset = options?.offset ?? "-1";
		if (rawOffset === "now") return {
			batches: [],
			nextOffset: formatOffset(head),
			upToDate: true
		};
		const startAfter = parseOffset(rawOffset);
		if (!Number.isSafeInteger(startAfter) || startAfter > head) this.fail("read", path, "Read offset is beyond the canonical stream head.");
		const limit = clampLimit(options?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
		const page = stream.batches.slice(startAfter + 1, startAfter + 1 + limit);
		return {
			batches: page.map((batch) => ({
				offset: batch.offset,
				records: JSON.parse(batch.data)
			})),
			nextOffset: page.at(-1)?.offset ?? formatOffset(startAfter),
			upToDate: startAfter + page.length >= head
		};
	}
	async getMeta(path) {
		const stream = this.streams.get(path);
		if (!stream) return null;
		return {
			identity: { ...stream.identity },
			incarnation: stream.incarnation,
			nextOffset: formatOffset(stream.batches.length - 1),
			producerId: stream.producerId,
			producerEpoch: stream.producerEpoch,
			nextProducerSequence: stream.nextProducerSequence
		};
	}
	async delete(path) {
		this.streams.delete(path);
		this.listeners.notify(path);
	}
	subscribe(path, listener) {
		return this.listeners.subscribe(path, listener);
	}
	assertSubmissionOwnership(path, submission, records) {
		const owned = records.filter((record) => record.submissionId !== void 0 || record.attemptId !== void 0);
		if (!submission) {
			if (owned.length > 0) this.fail("append", path, "Submission-owned records require an attempt authorization.");
			return;
		}
		if (owned.some((record) => record.submissionId !== submission.submissionId || record.attemptId !== submission.attemptId)) this.fail("append", path, "Record ownership does not match the authorized submission attempt.");
	}
	fail(operation, path, reason) {
		throw new ConversationStreamStoreError({
			operation,
			path,
			reason
		});
	}
};
var SqliteConversationStreamStore = class {
	sql;
	runTransaction;
	listeners = new StreamListenerRegistry();
	constructor(sql, runTransaction) {
		this.sql = sql;
		this.runTransaction = runTransaction;
		ensureSqlConversationStreamTables(sql);
	}
	async createStream(path, identity) {
		const data = JSON.stringify(identity);
		this.runTransaction(() => {
			const existing = this.sql.exec("SELECT identity_json FROM flue_conversation_streams WHERE path = ?", path).toArray()[0];
			if (existing) {
				if (existing.identity_json !== data) this.fail("create", path, "Stream identity conflicts.");
				return;
			}
			this.sql.exec("INSERT INTO flue_conversation_streams (path, identity_json, incarnation) VALUES (?, ?, ?)", path, data, crypto.randomUUID());
		});
	}
	async acquireProducer(path, producerId) {
		return this.runTransaction(() => {
			const row = this.sql.exec(`UPDATE flue_conversation_streams
					 SET producer_id = ?, producer_epoch = producer_epoch + 1, next_producer_sequence = 0
					 WHERE path = ?
					 RETURNING producer_epoch, next_offset, incarnation`, producerId, path).toArray()[0];
			if (!row) this.fail("acquire_producer", path, "Stream does not exist.");
			return {
				producerId,
				producerEpoch: row.producer_epoch,
				incarnation: row.incarnation,
				nextProducerSequence: 0,
				offset: formatOffset(row.next_offset - 1)
			};
		});
	}
	async append(input) {
		if (input.records.length === 0) this.fail("append", input.path, "A canonical batch cannot be empty.");
		const data = JSON.stringify(input.records);
		const result = this.runTransaction(() => {
			const meta = this.sql.exec(`SELECT next_offset, producer_id, producer_epoch, next_producer_sequence, incarnation
					 FROM flue_conversation_streams WHERE path = ?`, input.path).toArray()[0];
			if (!meta) this.fail("append", input.path, "Stream does not exist.");
			if (meta.producer_id !== input.producerId || meta.producer_epoch !== input.producerEpoch || meta.incarnation !== input.incarnation) this.fail("append", input.path, "Producer ownership is stale.");
			const retry = this.sql.exec(`SELECT seq, data, submission_id, attempt_id FROM flue_conversation_stream_batches
					 WHERE path = ? AND producer_id = ? AND producer_epoch = ? AND producer_sequence = ?`, input.path, input.producerId, input.producerEpoch, input.producerSequence).toArray()[0];
			if (retry) {
				if (retry.data !== data || retry.submission_id !== (input.submission?.submissionId ?? null) || retry.attempt_id !== (input.submission?.attemptId ?? null)) this.fail("append", input.path, "Producer sequence has conflicting content.");
				return {
					offset: formatOffset(retry.seq),
					appended: false
				};
			}
			if (meta.next_producer_sequence !== input.producerSequence) this.fail("append", input.path, "Producer sequence is not the next expected value.");
			this.assertSubmissionAuthorization(input.path, input.submission, input.records);
			const seq = meta.next_offset;
			this.sql.exec(`INSERT INTO flue_conversation_stream_batches
				 (path, seq, producer_id, producer_epoch, producer_sequence, data, submission_id, attempt_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, input.path, seq, input.producerId, input.producerEpoch, input.producerSequence, data, input.submission?.submissionId ?? null, input.submission?.attemptId ?? null);
			this.sql.exec(`UPDATE flue_conversation_streams
				 SET next_offset = next_offset + 1, next_producer_sequence = next_producer_sequence + 1
				 WHERE path = ?`, input.path);
			return {
				offset: formatOffset(seq),
				appended: true
			};
		});
		if (result.appended) this.listeners.notify(input.path);
		return { offset: result.offset };
	}
	async read(path, options) {
		const meta = await this.getMeta(path);
		if (!meta) return {
			batches: [],
			nextOffset: "-1",
			upToDate: true
		};
		const rawOffset = options?.offset ?? "-1";
		if (rawOffset === "now") return {
			batches: [],
			nextOffset: meta.nextOffset,
			upToDate: true
		};
		const startAfter = parseOffset(rawOffset);
		const head = parseOffset(meta.nextOffset);
		if (!Number.isSafeInteger(startAfter) || startAfter > head) this.fail("read", path, "Read offset is beyond the canonical stream head.");
		const limit = clampLimit(options?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
		const rows = this.sql.exec(`SELECT seq, data FROM flue_conversation_stream_batches
				 WHERE path = ? AND seq > ? ORDER BY seq ASC LIMIT ?`, path, startAfter, limit + 1).toArray();
		const batches = rows.slice(0, limit).map((row) => ({
			offset: formatOffset(row.seq),
			records: JSON.parse(row.data)
		}));
		return {
			batches,
			nextOffset: batches.at(-1)?.offset ?? formatOffset(startAfter),
			upToDate: rows.length <= limit
		};
	}
	async getMeta(path) {
		const row = this.sql.exec(`SELECT identity_json, next_offset, producer_id, producer_epoch, next_producer_sequence, incarnation
				 FROM flue_conversation_streams WHERE path = ?`, path).toArray()[0];
		if (!row) return null;
		return {
			identity: JSON.parse(row.identity_json),
			incarnation: row.incarnation,
			nextOffset: formatOffset(row.next_offset - 1),
			producerId: row.producer_id ?? null,
			producerEpoch: row.producer_epoch,
			nextProducerSequence: row.next_producer_sequence
		};
	}
	async delete(path) {
		this.runTransaction(() => {
			this.sql.exec("DELETE FROM flue_conversation_stream_batches WHERE path = ?", path);
			this.sql.exec("DELETE FROM flue_conversation_streams WHERE path = ?", path);
		});
		this.listeners.notify(path);
	}
	subscribe(path, listener) {
		return this.listeners.subscribe(path, listener);
	}
	assertSubmissionAuthorization(path, submission, records) {
		const submissionRecords = records.filter((record) => record.submissionId !== void 0 || record.attemptId !== void 0);
		if (!submission) {
			if (submissionRecords.length > 0) this.fail("append", path, "Submission-owned records require an attempt authorization.");
			return;
		}
		if (submissionRecords.some((record) => record.submissionId !== submission.submissionId || record.attemptId !== submission.attemptId)) this.fail("append", path, "Record ownership does not match the authorized submission attempt.");
		const row = this.sql.exec(`SELECT status, attempt_id, session_key, settlement_record_id, settlement_record_json
				 FROM flue_agent_submissions WHERE submission_id = ?`, submission.submissionId).toArray()[0];
		const sessionIdentity = typeof row?.session_key === "string" ? parseSessionStorageKey(row.session_key) : void 0;
		const streamIdentity = this.sql.exec("SELECT identity_json FROM flue_conversation_streams WHERE path = ?", path).toArray()[0];
		const instanceId = streamIdentity ? JSON.parse(streamIdentity.identity_json).instanceId : void 0;
		const terminalizingSettlement = row?.status === "terminalizing" && records.length === 1 && submissionRecords.length === 1 && submissionRecords[0]?.type === "submission_settled" && row.settlement_record_id === submissionRecords[0].id && row.settlement_record_json === JSON.stringify(submissionRecords[0]);
		if (!row || row.status !== "running" && !terminalizingSettlement || row.attempt_id !== submission.attemptId || !sessionIdentity || sessionIdentity.instanceId !== instanceId) this.fail("append", path, "Submission attempt no longer owns work for this agent instance.");
	}
	fail(operation, path, reason) {
		throw new ConversationStreamStoreError({
			operation,
			path,
			reason
		});
	}
};
//#endregion
export { LEASE_DURATION_MS as C, DURABILITY_DEFAULT_TIMEOUT_MS as S, Session as _, hydratePersistedDirectSubmission as a, discoverSessionContext as b, samePersistedChunks as c, createDirectAgentSubmissionInput as d, createDispatchAgentSubmissionInput as f, submissionSyntheticRequest as g, reconcileInterruptedSubmission as h, ensureSqlConversationStreamTables as i, submissionChunkOwner as l, processSubmission as m, SqliteConversationStreamStore as n, matchesPersistedDirectSubmission as o, materializeAgentSubmissionSession as p, StreamListenerRegistry as r, prepareDirectSubmission as s, InMemoryConversationStreamStore as t, createAgentSubmissionObserverRegistry as u, createPublicSession as v, DURABILITY_DEFAULT_MAX_ATTEMPTS as x, execShellWithEvents as y };
