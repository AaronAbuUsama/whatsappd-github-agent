import { l as CloudflareAIBindingError } from "../errors-DUgRtE8e.mjs";
import { f as clampLimit, i as encodeRunCursor, l as migrateFlueSqlSchema, n as MAX_LIST_LIMIT, r as decodeRunCursor } from "../run-store-CYeXjR-d.mjs";
import { d as CLOUDFLARE_AI_BINDING_API, n as getModelGateway, t as getModelBinding } from "../providers-CsCcTxMU.mjs";
import { a as runWithCloudflareContext, n as resolveCloudflareExtension, o as cfSandboxToSessionEnv } from "../extension-mG94bmnO.mjs";
import { createAssistantMessageEventStream, parseStreamingJson } from "@earendil-works/pi-ai/compat";
import { DurableObject } from "cloudflare:workers";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { convertMessages } from "@earendil-works/pi-ai/api/openai-completions";
//#region src/cloudflare/registry-ops.ts
/**
* Internal run-pointer index for the Cloudflare target.
*
* Cloudflare stores run records in per-workflow Durable Objects, so a
* singleton `FlueRegistry` DO keeps a pointer index for cross-deployment
* lookup and listing. This topology is internal plumbing behind the
* composite Cloudflare `RunStore` (see `cloudflare/run-store.ts`); it is
* not part of the public adapter contract — single-database adapters back
* pointers from their run records directly.
*
* Does not import `cloudflare:workers`; the `FlueRegistry` DO class wraps
* these synchronous ops in `cloudflare/registry-do.ts`.
*/
function createRegistryOps(sql) {
	ensureRegistryTables(sql);
	return new SqlRegistryOps(sql);
}
var SqlRegistryOps = class {
	sql;
	constructor(sql) {
		this.sql = sql;
	}
	recordRunStart(input) {
		this.sql.exec(`INSERT OR IGNORE INTO flue_registry_runs
			 (run_id, workflow_name, status, started_at, ended_at, duration_ms, is_error)
			 VALUES (?, ?, 'active', ?, NULL, NULL, NULL)`, input.runId, input.workflowName, input.startedAt);
	}
	recordRunEnd(input) {
		this.sql.exec(`INSERT INTO flue_registry_runs
			 (run_id, workflow_name, status, started_at, ended_at, duration_ms, is_error)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(run_id) DO UPDATE SET
			   status = excluded.status,
			   ended_at = excluded.ended_at,
			   duration_ms = excluded.duration_ms,
			   is_error = excluded.is_error`, input.runId, input.workflowName, input.isError ? "errored" : "completed", input.startedAt, input.endedAt, input.durationMs, input.isError ? 1 : 0);
	}
	lookupRun(runId) {
		const row = this.sql.exec("SELECT run_id, workflow_name FROM flue_registry_runs WHERE run_id = ?", runId).toArray()[0];
		return row ? {
			runId: String(row.run_id),
			workflowName: String(row.workflow_name)
		} : null;
	}
	listRuns(opts) {
		const limit = clampLimit(opts.limit, 100, MAX_LIST_LIMIT);
		const cursor = decodeRunCursor(opts.cursor);
		const wheres = [];
		const bindings = [];
		if (opts.status) {
			wheres.push("status = ?");
			bindings.push(opts.status);
		}
		if (opts.workflowName) {
			wheres.push("workflow_name = ?");
			bindings.push(opts.workflowName);
		}
		if (cursor) {
			wheres.push("(started_at < ? OR (started_at = ? AND run_id < ?))");
			bindings.push(cursor.startedAt, cursor.startedAt, cursor.runId);
		}
		const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
		const rows = this.sql.exec(`SELECT * FROM flue_registry_runs ${where}
			 ORDER BY started_at DESC, run_id DESC LIMIT ?`, ...bindings, limit + 1).toArray();
		const hasMore = rows.length > limit;
		const page = (hasMore ? rows.slice(0, limit) : rows).map(rowToRunPointer);
		const last = page.at(-1);
		return {
			runs: page,
			nextCursor: hasMore && last ? encodeRunCursor(last) : void 0
		};
	}
};
function ensureRegistryTables(sql) {
	migrateFlueSqlSchema(sql, () => {
		sql.exec(`CREATE TABLE IF NOT EXISTS flue_registry_runs (
			 run_id TEXT PRIMARY KEY,
			 workflow_name TEXT,
			 status TEXT NOT NULL,
			 started_at TEXT NOT NULL,
			 ended_at TEXT,
			 duration_ms INTEGER,
			 is_error INTEGER
			)`);
		sql.exec("CREATE INDEX IF NOT EXISTS flue_registry_status_started_idx ON flue_registry_runs (status, started_at DESC)");
		sql.exec("CREATE INDEX IF NOT EXISTS flue_registry_workflow_started_idx ON flue_registry_runs (workflow_name, started_at DESC)");
	});
}
function rowToRunPointer(row) {
	return {
		runId: String(row.run_id),
		workflowName: String(row.workflow_name),
		status: String(row.status),
		startedAt: String(row.started_at),
		endedAt: typeof row.ended_at === "string" ? row.ended_at : void 0,
		durationMs: typeof row.duration_ms === "number" ? row.duration_ms : void 0,
		isError: row.is_error === null || row.is_error === void 0 ? void 0 : Boolean(row.is_error)
	};
}
//#endregion
//#region src/cloudflare/registry-router.ts
async function handleRegistryRequest(ops, request) {
	const url = new URL(request.url);
	const segments = url.pathname.split("/").filter(Boolean);
	try {
		if (request.method === "GET" && segments[0] === "pointers" && segments.length === 2) {
			const runId = decodeURIComponent(segments[1] ?? "");
			if (!runId) return new Response("Missing runId.", { status: 404 });
			const pointer = ops.lookupRun(runId);
			if (!pointer) return new Response(null, { status: 404 });
			return jsonResponse(pointer);
		}
		if (request.method === "POST" && segments[0] === "pointers" && segments[2] === "start" && segments.length === 3) {
			const runId = decodeURIComponent(segments[1] ?? "");
			if (!runId) return new Response("Missing runId.", { status: 404 });
			const body = await request.json();
			ops.recordRunStart({
				...body,
				runId
			});
			return new Response(null, { status: 204 });
		}
		if (request.method === "POST" && segments[0] === "pointers" && segments[2] === "end" && segments.length === 3) {
			const runId = decodeURIComponent(segments[1] ?? "");
			if (!runId) return new Response("Missing runId.", { status: 404 });
			const body = await request.json();
			ops.recordRunEnd({
				...body,
				runId
			});
			return new Response(null, { status: 204 });
		}
		if (request.method === "GET" && segments[0] === "pointers" && segments.length === 1) return jsonResponse(ops.listRuns(parseListRunsOpts(url.searchParams)));
		return new Response(`Unknown registry endpoint: ${request.method} ${url.pathname}`, { status: 404 });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return new Response(JSON.stringify({ error: message }), {
			status: 500,
			headers: jsonHeaders()
		});
	}
}
function parseListRunsOpts(params) {
	const opts = {};
	const status = params.get("status");
	if (status === "active" || status === "completed" || status === "errored") opts.status = status;
	const workflow = params.get("workflow");
	if (workflow) opts.workflowName = workflow;
	const limit = params.get("limit");
	if (limit !== null) opts.limit = Number.parseInt(limit, 10);
	const cursor = params.get("cursor");
	if (cursor) opts.cursor = cursor;
	return opts;
}
function jsonHeaders() {
	return { "content-type": "application/json" };
}
function jsonResponse(body) {
	return new Response(JSON.stringify(body), { headers: jsonHeaders() });
}
//#endregion
//#region src/cloudflare/registry-do.ts
/** Singleton run-pointer index for the Cloudflare target. */
var FlueRegistry = class extends DurableObject {
	ops;
	constructor(state, env) {
		super(state, env);
		this.ops = createRegistryOps(state.storage.sql);
	}
	async fetch(request) {
		return handleRegistryRequest(this.ops, request);
	}
};
//#endregion
//#region src/cloudflare/run-store.ts
/**
* Request-scoped client for the `FlueRegistry` index DO, used by the outer
* worker for `/runs/:runId` lookups and `listRuns()`.
*/
function createCloudflareRunIndex(namespace) {
	if (!namespace) return void 0;
	return new FlueRegistryClient(namespace);
}
/**
* Compose the per-workflow-DO record store with the `FlueRegistry` index DO.
* Without a registry binding the record store is used as-is (no
* cross-deployment index).
*/
function createCloudflareRunStore(records, namespace) {
	if (!namespace) return records;
	return new CloudflareCompositeRunStore(records, new FlueRegistryClient(namespace));
}
var CloudflareCompositeRunStore = class {
	records;
	index;
	constructor(records, index) {
		this.records = records;
		this.index = index;
	}
	async createRun(input) {
		await this.records.createRun(input);
		await safeIndexWrite("recordRunStart", () => this.index.recordRunStart({
			runId: input.runId,
			workflowName: input.workflowName,
			startedAt: input.startedAt
		}));
	}
	async endRun(input) {
		await this.records.endRun(input);
		const record = await this.records.getRun(input.runId);
		if (!record) return;
		await safeIndexWrite("recordRunEnd", () => this.index.recordRunEnd({
			runId: input.runId,
			workflowName: record.workflowName,
			startedAt: record.startedAt,
			endedAt: input.endedAt,
			durationMs: input.durationMs,
			isError: input.isError
		}));
	}
	async getRun(runId) {
		return this.records.getRun(runId);
	}
	async lookupRun(runId) {
		return this.index.lookupRun(runId);
	}
	async listRuns(opts = {}) {
		return this.index.listRuns(opts);
	}
};
/**
* The index is a mirror of authoritative per-DO records: a faulted pointer
* write must not fail run admission or finalization.
*/
async function safeIndexWrite(label, fn) {
	try {
		await fn();
	} catch (error) {
		console.error(`[flue:run-index] ${label} failed:`, error);
	}
}
const FLUE_REGISTRY_INSTANCE_NAME = "default";
const SYNTHETIC_BASE = "https://flue-registry.local";
var FlueRegistryClient = class {
	namespace;
	constructor(namespace) {
		this.namespace = namespace;
	}
	async recordRunStart(input) {
		const { runId, ...body } = input;
		await this.callExpectingNoContent(`/pointers/${encodeURIComponent(runId)}/start`, "POST", body);
	}
	async recordRunEnd(input) {
		const { runId, ...body } = input;
		await this.callExpectingNoContent(`/pointers/${encodeURIComponent(runId)}/end`, "POST", body);
	}
	async lookupRun(runId) {
		const response = await this.fetch(new Request(`${SYNTHETIC_BASE}/pointers/${encodeURIComponent(runId)}`, { method: "GET" }));
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`[flue] FlueRegistry lookupRun(${runId}) failed: ${response.status} ${await response.text()}`);
		return await response.json();
	}
	async listRuns(opts = {}) {
		const params = new URLSearchParams();
		if (opts.status) params.set("status", opts.status);
		if (opts.workflowName) params.set("workflow", opts.workflowName);
		if (opts.limit !== void 0) params.set("limit", String(opts.limit));
		if (opts.cursor) params.set("cursor", opts.cursor);
		const qs = params.toString();
		const response = await this.fetch(new Request(`${SYNTHETIC_BASE}/pointers${qs ? `?${qs}` : ""}`, { method: "GET" }));
		if (!response.ok) throw new Error(`[flue] FlueRegistry listRuns failed: ${response.status} ${await response.text()}`);
		return await response.json();
	}
	fetch(request) {
		return this.namespace.get(this.namespace.idFromName(FLUE_REGISTRY_INSTANCE_NAME)).fetch(request);
	}
	async callExpectingNoContent(path, method, body) {
		const response = await this.fetch(new Request(`${SYNTHETIC_BASE}${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body)
		}));
		if (!response.ok) throw new Error(`[flue] FlueRegistry ${method} ${path} failed: ${response.status} ${await response.text()}`);
	}
};
//#endregion
//#region src/cloudflare/workers-ai-provider.ts
/**
* Mirrors pi-ai's effective compat for Workers AI models: `getCompat()`, i.e.
* `detectCompat('cloudflare-workers-ai')` plus the per-model `compat`
* overrides in pi-ai's model registry (which set `sendSessionAffinityHeaders:
* true`; `detectCompat` alone returns `false`). Hardcoded here because
* `convertMessages` requires a fully-resolved compat object and the binding's
* wire format matches `cloudflare-workers-ai` exactly. Re-mirror if pi-ai's
* detection logic or registry overrides change upstream. Note
* `sendSessionAffinityHeaders` is inert in this provider — it applies the
* `x-session-affinity` header itself in `streamCloudflareWorkersAi`.
*/
const WORKERS_AI_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	chatTemplateKwargs: {},
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: void 0,
	sendSessionAffinityHeaders: true,
	supportsLongCacheRetention: false
};
function convertTools(tools) {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			strict: false
		}
	}));
}
function emptyUsage() {
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
function parseChunkUsage(raw) {
	const cacheRead = raw.prompt_tokens_details?.cached_tokens ?? 0;
	const promptTokens = raw.prompt_tokens ?? 0;
	const completionTokens = raw.completion_tokens ?? 0;
	return {
		input: Math.max(0, promptTokens - cacheRead),
		output: completionTokens,
		cacheRead,
		cacheWrite: 0,
		totalTokens: raw.total_tokens ?? promptTokens + completionTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
function mapStopReason(reason) {
	switch (reason) {
		case "stop":
		case "eos": return { stopReason: "stop" };
		case "length": return { stopReason: "length" };
		case "tool_calls":
		case "function_call": return { stopReason: "toolUse" };
		case "content_filter": return {
			stopReason: "error",
			errorMessage: "Provider stopped generation: content filter"
		};
		default: return {
			stopReason: "error",
			errorMessage: `Provider finish_reason: ${reason}`
		};
	}
}
async function* iterateSseChunks(body) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let finished = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				finished = true;
				buffer += decoder.decode();
				if (buffer.trim().length > 0) yield* parseSseEvents(buffer);
				return;
			}
			buffer += decoder.decode(value, { stream: true });
			let boundary = findSseBoundary(buffer);
			while (boundary) {
				const block = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary.width);
				yield* parseSseEvents(block);
				boundary = findSseBoundary(buffer);
			}
		}
	} finally {
		if (!finished) try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}
function findSseBoundary(buffer) {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	if (lf === -1 && crlf === -1) return null;
	if (lf === -1) return {
		index: crlf,
		width: 4
	};
	if (crlf === -1) return {
		index: lf,
		width: 2
	};
	return lf < crlf ? {
		index: lf,
		width: 2
	} : {
		index: crlf,
		width: 4
	};
}
function* parseSseEvents(block) {
	const dataLines = [];
	let start = 0;
	while (start <= block.length) {
		const newline = block.indexOf("\n", start);
		const end = newline === -1 ? block.length : newline;
		const lineEnd = end > start && block.charCodeAt(end - 1) === 13 ? end - 1 : end;
		const line = block.slice(start, lineEnd);
		if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
		if (newline === -1) break;
		start = newline + 1;
	}
	if (dataLines.length === 0) return;
	const data = dataLines.join("\n");
	if (data === "" || data === "[DONE]") return;
	try {
		yield JSON.parse(data);
	} catch {
		console.error(`Workers AI: dropping unparseable SSE data payload: ${data.slice(0, 200)}`);
	}
}
function isAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError";
}
const streamCloudflareWorkersAi = (model, context, options) => {
	if (isAnthropicGatewayModel(model)) return streamCloudflareAnthropicAi(model, context, options);
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now()
		};
		let response;
		try {
			const ai = resolveBinding(model);
			const payload = {
				messages: convertMessages(model, context, WORKERS_AI_COMPAT),
				stream: true,
				stream_options: { include_usage: true }
			};
			if (context.tools && context.tools.length > 0) payload.tools = convertTools(context.tools);
			if (options?.maxTokens) payload.max_completion_tokens = options.maxTokens;
			if (options?.temperature !== void 0) payload.temperature = options.temperature;
			applyReasoningEffort(payload, model, options?.reasoning);
			const overridden = await options?.onPayload?.(payload, model);
			const finalPayload = overridden === void 0 ? payload : overridden;
			const extraHeaders = buildExtraHeaders(options);
			const gateway = getModelGateway(model);
			response = await ai.run(model.id, finalPayload, {
				returnRawResponse: true,
				...options?.signal ? { signal: options.signal } : {},
				...Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {},
				...gateway ? { gateway } : {}
			});
			await options?.onResponse?.({
				status: response.status,
				headers: headersToRecord(response.headers)
			}, model);
			await assertSuccessfulBindingResponse(response);
			if (!response.body) throw new CloudflareAIBindingError({ message: "Cloudflare AI binding returned empty response body." });
			stream.push({
				type: "start",
				partial: output
			});
			let textBlock = null;
			let thinkingBlock = null;
			let hasFinishReason = false;
			const toolCallBlocksByIndex = /* @__PURE__ */ new Map();
			const toolCallBlocksById = /* @__PURE__ */ new Map();
			const blocks = output.content;
			const indexOf = (block) => block ? blocks.indexOf(block) : -1;
			const finishBlock = (block) => {
				const contentIndex = indexOf(block);
				if (contentIndex === -1) return;
				if (block.type === "text") stream.push({
					type: "text_end",
					contentIndex,
					content: block.text,
					partial: output
				});
				else if (block.type === "thinking") stream.push({
					type: "thinking_end",
					contentIndex,
					content: block.thinking,
					partial: output
				});
				else if (block.type === "toolCall") {
					block.arguments = parseStreamingJson(block.partialArgs ?? "");
					delete block.partialArgs;
					delete block.streamIndex;
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall: block,
						partial: output
					});
				}
			};
			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = {
						type: "text",
						text: ""
					};
					blocks.push(textBlock);
					stream.push({
						type: "text_start",
						contentIndex: indexOf(textBlock),
						partial: output
					});
				}
				return textBlock;
			};
			const ensureThinkingBlock = (thinkingSignature) => {
				if (!thinkingBlock) {
					thinkingBlock = {
						type: "thinking",
						thinking: "",
						thinkingSignature
					};
					blocks.push(thinkingBlock);
					stream.push({
						type: "thinking_start",
						contentIndex: indexOf(thinkingBlock),
						partial: output
					});
				}
				return thinkingBlock;
			};
			const ensureToolCallBlock = (toolCall) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : void 0;
				let block = streamIndex !== void 0 ? toolCallBlocksByIndex.get(streamIndex) : void 0;
				if (!block && toolCall.id) block = toolCallBlocksById.get(toolCall.id);
				if (!block) {
					block = {
						type: "toolCall",
						id: toolCall.id ?? "",
						name: toolCall.function?.name ?? "",
						arguments: {},
						partialArgs: "",
						streamIndex
					};
					if (streamIndex !== void 0) toolCallBlocksByIndex.set(streamIndex, block);
					if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
					blocks.push(block);
					stream.push({
						type: "toolcall_start",
						contentIndex: indexOf(block),
						partial: output
					});
				}
				if (streamIndex !== void 0 && block.streamIndex === void 0) {
					block.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
				return block;
			};
			for await (const rawChunk of iterateSseChunks(response.body)) {
				const chunk = rawChunk;
				if (!chunk || typeof chunk !== "object") continue;
				output.responseId ||= chunk.id;
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) output.responseModel ||= chunk.model;
				if (chunk.usage) output.usage = parseChunkUsage(chunk.usage);
				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : void 0;
				if (!choice) continue;
				if (!chunk.usage && choice.usage) output.usage = parseChunkUsage(choice.usage);
				if (choice.finish_reason) {
					const mapped = mapStopReason(choice.finish_reason);
					output.stopReason = mapped.stopReason;
					if (mapped.errorMessage) output.errorMessage = mapped.errorMessage;
					hasFinishReason = true;
				}
				const delta = choice.delta;
				if (!delta) continue;
				if (delta.content !== null && delta.content !== void 0 && delta.content.length > 0) {
					const block = ensureTextBlock();
					block.text += delta.content;
					stream.push({
						type: "text_delta",
						contentIndex: indexOf(block),
						delta: delta.content,
						partial: output
					});
				}
				const reasoningDelta = pickReasoning(delta);
				if (reasoningDelta) {
					const block = ensureThinkingBlock(reasoningDelta.field);
					block.thinking += reasoningDelta.text;
					stream.push({
						type: "thinking_delta",
						contentIndex: indexOf(block),
						delta: reasoningDelta.text,
						partial: output
					});
				}
				if (delta.tool_calls) for (const toolCall of delta.tool_calls) {
					const block = ensureToolCallBlock(toolCall);
					if (!block.id && toolCall.id) {
						block.id = toolCall.id;
						toolCallBlocksById.set(toolCall.id, block);
					}
					if (!block.name && toolCall.function?.name) block.name = toolCall.function.name;
					let toolDelta = "";
					if (toolCall.function?.arguments) {
						toolDelta = toolCall.function.arguments;
						block.partialArgs = (block.partialArgs ?? "") + toolDelta;
						block.arguments = parseStreamingJson(block.partialArgs);
					}
					stream.push({
						type: "toolcall_delta",
						contentIndex: indexOf(block),
						delta: toolDelta,
						partial: output
					});
				}
			}
			for (const block of blocks) finishBlock(block);
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "error") throw new Error(output.errorMessage ?? "Provider returned an error stop reason");
			if (!hasFinishReason) throw new Error("Stream ended without finish_reason");
			stream.push({
				type: "done",
				reason: output.stopReason,
				message: output
			});
			stream.end();
		} catch (error) {
			if (response?.body && !response.body.locked) response.body.cancel().catch(() => {});
			for (const block of output.content) if (block.type === "toolCall") {
				delete block.partialArgs;
				delete block.streamIndex;
			}
			output.stopReason = options?.signal?.aborted || isAbortError(error) ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({
				type: "error",
				reason: output.stopReason,
				error: output
			});
			stream.end();
		}
	})();
	return stream;
};
function streamCloudflareAnthropicAi(model, context, options) {
	const ai = resolveBinding(model);
	const gateway = getModelGateway(model);
	const anthropicModel = toAnthropicGatewayModel(model);
	const client = createAnthropicBindingClient(ai, model, options, gateway);
	return stream(anthropicModel, context, {
		...options,
		client,
		cacheRetention: "none",
		thinkingEnabled: Boolean(options?.reasoning),
		onPayload: async (payload, payloadModel) => {
			const normalized = normalizeAnthropicGatewayPayload(payload);
			const overridden = await options?.onPayload?.(normalized, payloadModel);
			return overridden === void 0 ? normalized : normalizeAnthropicGatewayPayload(overridden);
		}
	});
}
function isAnthropicGatewayModel(model) {
	return model.id.startsWith("anthropic/");
}
function toAnthropicGatewayModel(model) {
	return {
		...model,
		api: "anthropic-messages",
		baseUrl: "",
		compat: {
			supportsCacheControlOnTools: false,
			supportsEagerToolInputStreaming: false,
			supportsLongCacheRetention: false,
			sendSessionAffinityHeaders: false
		}
	};
}
function createAnthropicBindingClient(ai, model, options, gateway) {
	return { messages: { create(params, requestOptions) {
		return { async asResponse() {
			const extraHeaders = buildExtraHeaders(options);
			const response = await ai.run(model.id, params, {
				returnRawResponse: true,
				...requestOptions?.signal ? { signal: requestOptions.signal } : {},
				...Object.keys(extraHeaders).length > 0 ? { extraHeaders } : {},
				...gateway ? { gateway } : {}
			});
			await assertSuccessfulBindingResponse(response);
			return response;
		} };
	} } };
}
function buildExtraHeaders(options) {
	const extraHeaders = {};
	if (options?.sessionId) extraHeaders["x-session-affinity"] = options.sessionId;
	if (options?.headers) Object.assign(extraHeaders, options.headers);
	return extraHeaders;
}
function normalizeAnthropicGatewayPayload(payload) {
	const system = payload.system;
	if (Array.isArray(system)) {
		const text = system.map((block) => {
			if (typeof block === "string") return block;
			if (block && typeof block === "object" && "text" in block) {
				const value = block.text;
				return typeof value === "string" ? value : "";
			}
			return "";
		}).filter((text) => text.length > 0).join("\n\n");
		if (text.length > 0) return {
			...payload,
			system: text
		};
		const { system: _system, ...rest } = payload;
		return rest;
	}
	return payload;
}
async function assertSuccessfulBindingResponse(response) {
	if (response.ok) return;
	const body = await safeReadText(response);
	throw new CloudflareAIBindingError({
		status: response.status,
		statusText: response.statusText,
		body
	});
}
/**
* Read the binding extension carried on the resolved Model.
*/
function resolveBinding(model) {
	const ai = getModelBinding(model);
	if (!ai) throw new CloudflareAIBindingError({ message: "Cloudflare AI binding not available. Models prefixed with \"cloudflare/\" require a configured AI binding." });
	return ai;
}
function pickReasoning(delta) {
	for (const field of ["reasoning_content", "reasoning"]) {
		const value = delta[field];
		if (typeof value === "string" && value.length > 0) return {
			field,
			text: value
		};
	}
	return null;
}
function applyReasoningEffort(payload, model, level) {
	if (!model.reasoning || level === void 0) return;
	payload.reasoning_effort = mapReasoningEffort(level);
}
function mapReasoningEffort(level) {
	switch (level) {
		case "minimal":
		case "low": return "low";
		case "medium": return "medium";
		case "high":
		case "xhigh": return "high";
	}
}
function headersToRecord(headers) {
	const out = {};
	headers.forEach((value, key) => {
		out[key] = value;
	});
	return out;
}
async function safeReadText(response) {
	try {
		return await response.text();
	} catch {
		return;
	}
}
/**
* Return the pi-ai `ApiProvider` definition for the Cloudflare AI binding.
*/
function getCloudflareAIBindingApiProvider() {
	return {
		api: CLOUDFLARE_AI_BINDING_API,
		stream: streamCloudflareWorkersAi,
		streamSimple: streamCloudflareWorkersAi
	};
}
//#endregion
export { FlueRegistry, cfSandboxToSessionEnv, createCloudflareRunIndex, createCloudflareRunStore, getCloudflareAIBindingApiProvider, resolveCloudflareExtension, runWithCloudflareContext };
