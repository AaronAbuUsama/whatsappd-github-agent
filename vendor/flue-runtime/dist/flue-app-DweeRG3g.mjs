import { C as RunStoreUnavailableError, G as WorkflowInputUnexpectedError, H as WorkflowAdmissionError, J as configureErrorRendering, K as WorkflowInvocationNotConfiguredError, Q as validateWorkflowRequest, S as RunNotFoundError, W as WorkflowInputSerializationError, X as toHttpResponse, Z as validateAgentRequest, c as AttachmentsNotExposedError, g as MethodNotAllowedError, h as InvalidRequestError, j as StreamNotFoundError, q as WorkflowNotDiscoveredError, s as AttachmentNotFoundError, x as RouteNotFoundError } from "./errors-DUgRtE8e.mjs";
import { a as cloneJsonSerializable } from "./tool-C2CuUqYC.mjs";
import { F as handleWorkflowRequest, H as generateWorkflowRunId, J as agentStreamPath, O as toolResultOutput, P as handleAgentRequest, S as createReducedInstanceState, W as assertProductEventV3, X as parseOffset, Y as formatOffset, Z as runStreamPath, k as toolResultText, l as projectConversationUi, w as reduceConversationRecords } from "./conversation-projections-XMug3C6A.mjs";
import { E as WorkflowRouteParamSchema, S as AgentRouteParamSchema, w as InvocationQuerySchema } from "./run-store-CYeXjR-d.mjs";
import { Hono } from "hono";
import { validator } from "hono-openapi";
//#region src/runtime/dispatch.ts
async function enqueueDispatch(options) {
	const agent = options.request.agent;
	const input = validateAndCloneDispatchRequest(options.request, agent, options.rt);
	return options.dispatchQueue.enqueue({
		dispatchId: crypto.randomUUID(),
		agent,
		id: options.request.id,
		input,
		acceptedAt: (/* @__PURE__ */ new Date()).toISOString()
	});
}
function validateAndCloneDispatchRequest(request, agent, rt) {
	if (typeof agent !== "string" || agent.trim() === "") throw new Error("[flue] dispatch() requires a non-empty target agent.");
	if (typeof request.id !== "string" || request.id.trim() === "") throw new Error("[flue] dispatch() requires a non-empty \"id\" target agent instance id.");
	if (request.input === void 0) throw new Error("[flue] dispatch() requires an \"input\" payload. Use null for an intentional empty payload.");
	if (!agentExists(rt, agent)) throw new Error(`[flue] dispatch() target agent "${agent}" is not registered.`);
	return cloneJsonSerializable(request.input, "dispatch().input");
}
function agentExists(rt, agentName) {
	return rt.agents.some((agent) => agent.name === agentName);
}
//#endregion
//#region src/conversation-public.ts
const DEFAULT_HARNESS = "default";
const DEFAULT_SESSION = "default";
function selectRootConversation(state) {
	const roots = [...state.conversations.values()].filter((conversation) => conversation.kind === "root");
	return roots.find((conversation) => conversation.harness === DEFAULT_HARNESS && conversation.session === DEFAULT_SESSION) ?? roots[0];
}
function projectAgentConversationSnapshot(state) {
	const conversation = selectRootConversation(state);
	if (!conversation) return void 0;
	const ui = projectConversationUi(conversation, state.recordsThroughOffset);
	return {
		v: 1,
		conversationId: conversation.conversationId,
		offset: ui.streamOffset,
		messages: ui.messages,
		settlements: projectSettlements(state, conversation.conversationId)
	};
}
function projectAgentConversationBatch(options) {
	const conversation = selectRootConversation(options.state) ?? (options.previousState ? selectRootConversation(options.previousState) : void 0);
	if (!conversation) return [];
	const conversationId = conversation.conversationId;
	const relevant = options.records.filter((record) => record.conversationId === conversationId);
	if (relevant.length === 0) return [];
	if (relevant.some(requiresSnapshotReset)) {
		const snapshot = projectAgentConversationSnapshot(options.state);
		return snapshot ? withPositions([{
			type: "conversation-reset",
			conversationId,
			snapshot
		}], options.batchOrdinal) : [];
	}
	return withPositions(relevant.flatMap((record) => encodeRecord(record, conversationId, options.state)), options.batchOrdinal);
}
/**
* Stamp each chunk with its position within the batch. Index is the chunk's
* order in the batch's projection (a single record may fan out to several
* chunks), so `{ batch, index }` is globally unique and monotonic across the
* conversation. This is the identity consumers dedupe on under redelivery.
*/
function withPositions(bodies, batch) {
	return bodies.map((body, index) => ({
		...body,
		position: {
			batch,
			index
		}
	}));
}
function requiresSnapshotReset(record) {
	return record.type === "conversation_created" || record.type === "compaction";
}
function encodeRecord(record, conversationId, state) {
	switch (record.type) {
		case "user_message": return [{
			type: "message-appended",
			conversationId,
			message: {
				id: record.messageId,
				role: "user",
				...record.submissionId ? { submissionId: record.submissionId } : {},
				metadata: { timestamp: record.timestamp },
				parts: record.content.map((content) => content.type === "text" ? {
					type: "text",
					text: content.text,
					state: "done"
				} : {
					type: "file",
					mediaType: content.attachment.mimeType,
					id: content.attachment.id,
					size: content.attachment.size,
					...content.attachment.filename ? { filename: content.attachment.filename } : {}
				})
			}
		}];
		case "signal": return [{
			type: "message-appended",
			conversationId,
			message: {
				id: record.messageId,
				role: "user",
				metadata: { timestamp: record.timestamp },
				parts: [{
					type: "text",
					text: record.content,
					state: "done"
				}]
			}
		}];
		case "assistant_message_started": return [{
			type: "message-started",
			conversationId,
			messageId: record.messageId,
			timestamp: record.timestamp,
			...record.submissionId ? { submissionId: record.submissionId } : {},
			...typeof record.modelInfo.provider === "string" && typeof record.modelInfo.model === "string" ? { model: {
				provider: record.modelInfo.provider,
				id: record.modelInfo.model
			} } : {}
		}];
		case "assistant_text_delta": return [{
			type: "message-delta",
			conversationId,
			messageId: record.messageId,
			kind: "text",
			delta: record.delta
		}];
		case "assistant_reasoning_delta": return [{
			type: "message-delta",
			conversationId,
			messageId: record.messageId,
			kind: "reasoning",
			delta: record.delta
		}];
		case "assistant_tool_call": return [{
			type: "tool-input",
			conversationId,
			messageId: record.messageId,
			toolCallId: record.toolCallId,
			toolName: record.name,
			input: record.arguments
		}];
		case "assistant_message_completed": return [{
			type: "message-completed",
			conversationId,
			messageId: record.messageId,
			...record.usage ? { usage: record.usage } : {}
		}];
		case "tool_results_committed": return record.outcomeIds.flatMap((outcomeId) => encodeToolOutcome(outcomeId, conversationId, record, state));
		case "submission_settled": return record.submissionId ? [{
			type: "submission-settled",
			conversationId,
			submissionId: record.submissionId,
			outcome: record.outcome,
			...record.result === void 0 ? {} : { result: record.result },
			...record.error === void 0 ? {} : { error: record.error }
		}] : [];
		default: return [];
	}
}
function encodeToolOutcome(outcomeId, conversationId, commit, state) {
	const outcome = state.recordsById.get(outcomeId);
	if (outcome?.type !== "tool_outcome" || outcome.conversationId !== commit.conversationId || outcome.harness !== commit.harness || outcome.session !== commit.session) return [];
	return outcome.isError ? [{
		type: "tool-output-error",
		conversationId,
		toolCallId: outcome.toolCallId,
		errorText: toolResultText(outcome.content)
	}] : [{
		type: "tool-output",
		conversationId,
		toolCallId: outcome.toolCallId,
		output: outcome.output !== void 0 ? outcome.output : toolResultOutput(outcome.content)
	}];
}
function projectSettlements(state, conversationId) {
	return [...state.recordsById.values()].filter((record) => record.conversationId === conversationId && record.type === "submission_settled" && typeof record.submissionId === "string").map((record) => ({
		submissionId: record.submissionId,
		outcome: record.outcome,
		...record.result === void 0 ? {} : { result: record.result },
		...record.error === void 0 ? {} : { error: record.error }
	}));
}
//#endregion
//#region src/conversation-reader.ts
async function loadReducedConversationState(options) {
	let state = createReducedInstanceState();
	let offset = "-1";
	while (true) {
		const read = await options.store.read(options.path, {
			offset,
			limit: 1e3
		});
		for (const batch of read.batches) {
			state = reduceConversationRecords(state, batch.records, batch.offset);
			offset = batch.offset;
		}
		if (read.upToDate) return state;
	}
}
async function loadReducedConversationPrefix(options) {
	let state = createReducedInstanceState();
	if (options.offset === "-1") return state;
	let offset = "-1";
	while (true) {
		const read = await options.store.read(options.path, {
			offset,
			limit: 1e3
		});
		for (const batch of read.batches) {
			state = reduceConversationRecords(state, batch.records, batch.offset);
			offset = batch.offset;
			if (offset === options.offset) return state;
		}
		if (read.upToDate) {
			await options.store.read(options.path, {
				offset: options.offset,
				limit: 1
			});
			throw new Error("[flue] Canonical conversation offset is not a batch boundary.");
		}
	}
}
//#endregion
//#region src/runtime/handle-conversation-routes.ts
const SECURITY_HEADERS$1 = {
	"X-Content-Type-Options": "nosniff",
	"Cross-Origin-Resource-Policy": "cross-origin"
};
const LONG_POLL_TIMEOUT_MS$1 = 3e4;
const DURABLE_POLL_INTERVAL_MS = 250;
const SSE_HEARTBEAT_MS$1 = 15e3;
async function handleAgentConversationRead(options) {
	const view = new URL(options.request.url).searchParams.get("view") ?? "history";
	if (view === "history") return historyResponse(options);
	if (view === "updates") return updatesResponse(options);
	return errorResponse(new InvalidRequestError({ reason: "Invalid agent conversation view. Use history or updates." }));
}
/**
* Serves the bytes of one attachment referenced by the default conversation.
*
* Resolves the agent instance's default conversation id and scopes the lookup to
* it, so attachments belonging to task/action child conversations are never
* served through the public route. The byte content is immutable (digest-keyed),
* hence the long-lived private cache. Reached only after the route's opt-in
* `attachments` middleware has run.
*/
async function handleAgentAttachmentRead(options) {
	if (!await options.conversationStore.getMeta(options.path)) return errorResponse(new StreamNotFoundError({ path: options.path }));
	const snapshot = projectAgentConversationSnapshot(await loadReducedConversationState({
		store: options.conversationStore,
		path: options.path
	}));
	if (!snapshot) return errorResponse(new StreamNotFoundError({ path: options.path }));
	const stored = await options.attachmentStore.get({
		streamPath: options.path,
		conversationId: snapshot.conversationId,
		attachmentId: options.attachmentId
	});
	if (!stored) return errorResponse(new AttachmentNotFoundError({ attachmentId: options.attachmentId }));
	return new Response(stored.bytes, { headers: {
		"content-type": stored.attachment.mimeType,
		"content-length": String(stored.attachment.size),
		"content-disposition": "inline",
		"cache-control": "private, max-age=31536000, immutable",
		"content-security-policy": "sandbox",
		...SECURITY_HEADERS$1
	} });
}
async function handleAgentConversationHead(store, path) {
	const meta = await store.getMeta(path);
	if (!meta) return headError(new StreamNotFoundError({ path }));
	return new Response(null, { headers: {
		"content-type": "application/json",
		"cache-control": "no-store",
		"Stream-Next-Offset": meta.nextOffset,
		"Stream-Up-To-Date": "true",
		...SECURITY_HEADERS$1
	} });
}
async function historyResponse(options) {
	const url = new URL(options.request.url);
	if (url.searchParams.has("offset") || url.searchParams.has("tail") || url.searchParams.has("live")) return errorResponse(new InvalidRequestError({ reason: "History reads do not accept offset, tail, or live parameters." }));
	if (!await options.store.getMeta(options.path)) return errorResponse(new StreamNotFoundError({ path: options.path }));
	const snapshot = projectAgentConversationSnapshot(await loadReducedConversationState({
		store: options.store,
		path: options.path
	}));
	if (!snapshot) return errorResponse(new StreamNotFoundError({ path: options.path }));
	return Response.json(snapshot, { headers: {
		"cache-control": "no-store",
		"Stream-Next-Offset": snapshot.offset,
		"Stream-Up-To-Date": "true",
		...SECURITY_HEADERS$1
	} });
}
async function updatesResponse(options) {
	const url = new URL(options.request.url);
	if (url.searchParams.has("tail")) return errorResponse(new InvalidRequestError({ reason: "Update streams do not accept tail." }));
	const offset = singleOffset(url);
	if (offset instanceof Response) return offset;
	const live = liveMode(url);
	if (live instanceof Response) return live;
	if (!await options.store.getMeta(options.path)) return errorResponse(new StreamNotFoundError({ path: options.path }));
	if (live === "sse") return sseResponse(options.store, options.path, offset, options.request.signal);
	let state = await loadReducedConversationPrefix({
		store: options.store,
		path: options.path,
		offset
	});
	let read = await options.store.read(options.path, { offset });
	if (live === "long-poll" && read.batches.length === 0) {
		const waited = await waitForData(options.store, options.path, offset, options.request.signal);
		if (waited === "aborted") return new Response(null, {
			status: 499,
			headers: SECURITY_HEADERS$1
		});
		read = waited;
	}
	const projected = projectRead(state, read);
	state = projected.state;
	return dsJsonResponse(projected.items, read, projected.offset);
}
function projectRead(initialState, read) {
	let state = initialState;
	const items = [];
	let offset = initialState.recordsThroughOffset;
	for (const batch of read.batches) {
		const previousState = state;
		state = reduceConversationRecords(state, batch.records, batch.offset);
		items.push(...projectAgentConversationBatch({
			state,
			previousState,
			records: batch.records,
			batchOrdinal: parseOffset(batch.offset)
		}));
		offset = batch.offset;
	}
	return {
		state,
		items,
		offset
	};
}
function dsJsonResponse(items, read, offset) {
	return Response.json(items, { headers: {
		"cache-control": "no-store",
		"Stream-Next-Offset": offset,
		...read.upToDate ? { "Stream-Up-To-Date": "true" } : {},
		...SECURITY_HEADERS$1
	} });
}
function sseResponse(store, path, offset, signal) {
	const encoder = new TextEncoder();
	let active = true;
	let unsubscribe = () => {};
	let heartbeat;
	const body = new ReadableStream({
		async start(controller) {
			let state = await loadReducedConversationPrefix({
				store,
				path,
				offset
			});
			let currentOffset = offset;
			let wake;
			unsubscribe = store.subscribe(path, () => wake?.());
			heartbeat = setInterval(() => {
				if (active) controller.enqueue(encoder.encode(": heartbeat\n\n"));
			}, SSE_HEARTBEAT_MS$1);
			const onAbort = () => {
				active = false;
				wake?.();
			};
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				while (active) {
					const read = await store.read(path, { offset: currentOffset });
					const projected = projectRead(state, read);
					state = projected.state;
					if (projected.items.length > 0) controller.enqueue(encoder.encode(`event: data\ndata:${JSON.stringify(projected.items)}\n\n`));
					currentOffset = read.nextOffset;
					const control = {
						streamNextOffset: currentOffset,
						...read.upToDate ? { upToDate: true } : {}
					};
					controller.enqueue(encoder.encode(`event: control\ndata:${JSON.stringify(control)}\n\n`));
					if (!read.upToDate) continue;
					await new Promise((resolve) => {
						wake = resolve;
						setTimeout(resolve, LONG_POLL_TIMEOUT_MS$1);
					});
					wake = void 0;
				}
			} finally {
				active = false;
				unsubscribe();
				if (heartbeat) clearInterval(heartbeat);
				signal.removeEventListener("abort", onAbort);
				controller.close();
			}
		},
		cancel() {
			active = false;
			unsubscribe();
			if (heartbeat) clearInterval(heartbeat);
		}
	});
	return new Response(body, { headers: {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		...SECURITY_HEADERS$1
	} });
}
function singleOffset(url) {
	const offsets = url.searchParams.getAll("offset");
	if (offsets.length !== 1) return errorResponse(new InvalidRequestError({ reason: "Exactly one offset is required." }));
	const offset = offsets[0];
	if (offset !== "-1" && !/^\d+_\d+$/.test(offset)) return errorResponse(new InvalidRequestError({ reason: "Invalid offset format." }));
	return offset;
}
function liveMode(url) {
	const live = url.searchParams.get("live");
	if (live === null) return null;
	if (live === "long-poll" || live === "sse") return live;
	return errorResponse(new InvalidRequestError({ reason: "Invalid live mode. Use long-poll or sse." }));
}
async function waitForData(store, path, offset, signal) {
	if (signal.aborted) return "aborted";
	const deadline = Date.now() + LONG_POLL_TIMEOUT_MS$1;
	let pending = false;
	let wake;
	const unsubscribe = store.subscribe(path, () => {
		pending = true;
		wake?.();
	});
	const onAbort = () => wake?.();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			pending = false;
			const read = await store.read(path, { offset });
			if (signal.aborted) return "aborted";
			if (read.batches.length > 0 || Date.now() >= deadline) return read;
			if (pending) continue;
			await new Promise((resolve) => {
				let timer;
				const finish = () => {
					clearTimeout(timer);
					resolve();
				};
				wake = finish;
				timer = setTimeout(finish, Math.min(DURABLE_POLL_INTERVAL_MS, deadline - Date.now()));
				if (pending || signal.aborted) finish();
			});
			wake = void 0;
		}
	} finally {
		unsubscribe();
		signal.removeEventListener("abort", onAbort);
	}
}
function errorResponse(error) {
	return toHttpResponse(error);
}
function headError(error) {
	const response = toHttpResponse(error);
	return new Response(null, {
		status: response.status,
		headers: response.headers
	});
}
//#endregion
//#region src/runtime/handle-stream-routes.ts
/**
* Durable Streams protocol read endpoints.
*
* Implements DS-compliant GET (catch-up, long-poll, SSE) and HEAD on any
* {@link EventStreamStore} path. These are read-only — writes are internal
* side-effects of agent execution and workflow lifecycle.
*
* @see https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md
*/
const LONG_POLL_TIMEOUT_MS = 3e4;
const SSE_HEARTBEAT_MS = 15e3;
const STREAM_NEXT_OFFSET = "Stream-Next-Offset";
const STREAM_UP_TO_DATE = "Stream-Up-To-Date";
const STREAM_CLOSED = "Stream-Closed";
const STREAM_CURSOR = "Stream-Cursor";
const SECURITY_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Cross-Origin-Resource-Policy": "cross-origin"
};
const SSE_OFFSET_FIELD = "streamNextOffset";
const SSE_CURSOR_FIELD = "streamCursor";
const SSE_CLOSED_FIELD = "streamClosed";
const SSE_UP_TO_DATE_FIELD = "upToDate";
const CURSOR_EPOCH_MS = 1728432e6;
const CURSOR_INTERVAL_MS = 2e4;
function maxBigInt(left, right) {
	return left > right ? left : right;
}
function generateCursor(clientCursor) {
	const currentInterval = Math.floor((Date.now() - CURSOR_EPOCH_MS) / CURSOR_INTERVAL_MS);
	if (!clientCursor) return String(currentInterval);
	const clientInterval = parseInt(clientCursor, 10);
	if (!Number.isFinite(clientInterval) || clientInterval < currentInterval) return String(currentInterval);
	const jitter = Math.floor(Math.random() * 180) + 1;
	return String(clientInterval + jitter);
}
function generateETag(path, startOffset, endOffset, closed) {
	return `"${typeof Buffer !== "undefined" ? Buffer.from(path).toString("base64") : btoa(String.fromCharCode(...new TextEncoder().encode(path)))}:${startOffset}:${endOffset}${closed ? ":c" : ""}"`;
}
function encodeSseData(payload) {
	return `${payload.split(/\r\n|\r|\n/).map((line) => `data:${line}`).join("\n")}\n\n`;
}
/**
* DS-compliant HEAD: returns stream metadata without a body.
* 404 if the stream does not exist.
*/
async function handleStreamHead(store, path) {
	const meta = await store.getStreamMeta(path);
	if (!meta) {
		const error = streamErrorResponse(streamNotFoundError(path));
		return new Response(null, {
			status: error.status,
			headers: error.headers
		});
	}
	const headers = {
		"content-type": "application/json",
		...SECURITY_HEADERS,
		[STREAM_NEXT_OFFSET]: meta.nextOffset,
		[STREAM_UP_TO_DATE]: "true",
		"cache-control": "no-store"
	};
	if (meta.closed) headers[STREAM_CLOSED] = "true";
	headers.etag = generateETag(path, "-1", meta.nextOffset, meta.closed);
	return new Response(null, {
		status: 200,
		headers
	});
}
/**
* DS-compliant GET: catch-up, long-poll, or SSE mode based on `?live=` param.
* 404 if the stream does not exist.
*/
async function handleStreamRead(opts) {
	const { store, path, request } = opts;
	const url = new URL(request.url);
	const offsetValues = url.searchParams.getAll("offset");
	const offsetParam = offsetValues[0] ?? "-1";
	const tailValues = url.searchParams.getAll("tail");
	const liveRaw = url.searchParams.get("live");
	const cursor = url.searchParams.get("cursor") ?? void 0;
	if (offsetValues.length > 1) return streamErrorResponse(new InvalidRequestError({ reason: "Duplicate offset parameters are not allowed." }));
	if (tailValues.length > 1) return streamErrorResponse(new InvalidRequestError({ reason: "Duplicate tail parameters are not allowed." }));
	const tailParam = tailValues[0];
	if (tailParam !== void 0 && !/^[1-9]\d*$/.test(tailParam)) return streamErrorResponse(new InvalidRequestError({ reason: "Tail must be an integer greater than or equal to 1." }));
	if (liveRaw !== null && offsetValues.length === 0) return streamErrorResponse(new InvalidRequestError({ reason: "Offset is required for live mode." }));
	if (liveRaw !== null && liveRaw !== "long-poll" && liveRaw !== "sse") return streamErrorResponse(new InvalidRequestError({ reason: "Invalid live mode. Use \"long-poll\" or \"sse\"." }));
	const live = liveRaw;
	if (offsetParam !== "-1" && offsetParam !== "now" && !/^\d+_\d+$/.test(offsetParam)) return streamErrorResponse(new InvalidRequestError({ reason: "Invalid offset format." }));
	const meta = await store.getStreamMeta(path);
	if (!meta) return streamErrorResponse(streamNotFoundError(path));
	const readOffset = offsetParam === "now" && live !== null ? meta.nextOffset : offsetParam === "-1" && tailParam !== void 0 ? formatOffset(Number(maxBigInt(-1n, BigInt(parseOffset(meta.nextOffset)) - BigInt(tailParam)))) : offsetParam;
	if (live === "sse") return handleSseMode(store, path, readOffset, request.signal);
	const result = await store.readEvents(path, { offset: readOffset });
	if (live === "long-poll") return handleLongPollMode(store, path, readOffset, readOffset, cursor, result, request.signal);
	return handleCatchUpMode(request, path, readOffset, result);
}
function publicEventData(_path, result) {
	return result.events.map((event) => {
		assertProductEventV3(event.data);
		return event.data;
	});
}
function streamErrorResponse(error) {
	return toHttpResponse(error);
}
/** Run streams 404 as "run not found"; agent streams get the accurate label. */
function streamNotFoundError(path) {
	return path.startsWith("runs/") ? new RunNotFoundError({ runId: path.slice(5) }) : new StreamNotFoundError({ path });
}
function handleCatchUpMode(request, path, offsetParam, result) {
	const isClosed = result.closed && result.upToDate;
	const etag = offsetParam === "now" ? void 0 : generateETag(path, offsetParam, result.nextOffset, isClosed);
	const conditional = etag ? checkConditional(request, etag) : null;
	if (conditional) return conditional;
	const body = JSON.stringify(publicEventData(path, result));
	const headers = {
		"content-type": "application/json",
		[STREAM_NEXT_OFFSET]: result.nextOffset,
		"cache-control": "no-store",
		...SECURITY_HEADERS
	};
	if (etag) headers.etag = etag;
	if (result.upToDate) headers[STREAM_UP_TO_DATE] = "true";
	if (isClosed) headers[STREAM_CLOSED] = "true";
	return new Response(body, {
		status: 200,
		headers
	});
}
async function handleLongPollMode(store, path, readOffset, requestOffset, clientCursor, result, signal) {
	if (result.events.length > 0) return longPollDataResponse(result, path, requestOffset, clientCursor);
	if (result.closed && result.upToDate) return longPollEmptyResponse(result.nextOffset, clientCursor, true);
	const waitResult = await waitForStreamData(store, path, signal, async () => {
		const reread = await store.readEvents(path, { offset: readOffset });
		return reread.events.length > 0 || reread.closed && reread.upToDate;
	});
	if (waitResult === "aborted") return new Response(null, {
		status: 499,
		headers: SECURITY_HEADERS
	});
	if (waitResult === "timeout") {
		const closed = (await store.getStreamMeta(path))?.closed ?? false;
		return longPollEmptyResponse(result.nextOffset, clientCursor, closed);
	}
	const freshResult = await store.readEvents(path, { offset: readOffset });
	if (freshResult.events.length > 0) return longPollDataResponse(freshResult, path, requestOffset, clientCursor);
	const closed = (await store.getStreamMeta(path))?.closed ?? false;
	return longPollEmptyResponse(result.nextOffset, clientCursor, closed);
}
/** Build a 200 long-poll response with event data. */
function longPollDataResponse(result, path, offsetParam, clientCursor) {
	const isClosed = result.closed && result.upToDate;
	const headers = {
		"content-type": "application/json",
		"cache-control": "no-store",
		...SECURITY_HEADERS,
		[STREAM_NEXT_OFFSET]: result.nextOffset,
		[STREAM_CURSOR]: generateCursor(clientCursor)
	};
	if (result.upToDate) headers[STREAM_UP_TO_DATE] = "true";
	if (isClosed) headers[STREAM_CLOSED] = "true";
	if (offsetParam !== "now") headers.etag = generateETag(path, offsetParam, result.nextOffset, isClosed);
	return new Response(JSON.stringify(publicEventData(path, result)), {
		status: 200,
		headers
	});
}
/** Build a 204 long-poll response (no new data). */
function longPollEmptyResponse(nextOffset, clientCursor, closed) {
	const headers = {
		...SECURITY_HEADERS,
		[STREAM_NEXT_OFFSET]: nextOffset,
		[STREAM_UP_TO_DATE]: "true",
		[STREAM_CURSOR]: generateCursor(clientCursor)
	};
	if (closed) headers[STREAM_CLOSED] = "true";
	return new Response(null, {
		status: 204,
		headers
	});
}
function waitForStreamData(store, path, signal, recheck) {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve("aborted");
			return;
		}
		let settled = false;
		const settle = (result) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};
		const unsub = store.subscribe(path, () => settle("data"));
		const timer = setTimeout(() => settle("timeout"), LONG_POLL_TIMEOUT_MS);
		if (recheck) recheck().then((hasData) => {
			if (hasData) settle("data");
		}).catch(() => {});
		const onAbort = () => settle("aborted");
		signal.addEventListener("abort", onAbort, { once: true });
		function cleanup() {
			unsub();
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		}
	});
}
function handleSseMode(store, path, offsetParam, signal) {
	const encoder = new TextEncoder();
	let isConnected = true;
	let heartbeatTimer;
	let resolveCapacity;
	const stream = new ReadableStream({
		start(controller) {
			signal.addEventListener("abort", () => {
				isConnected = false;
				resolveCapacity?.();
				resolveCapacity = void 0;
				cleanup();
				try {
					controller.close();
				} catch {}
			}, { once: true });
			heartbeatTimer = setInterval(() => {
				if (!isConnected) return;
				try {
					controller.enqueue(encoder.encode(": heartbeat\n\n"));
				} catch {
					isConnected = false;
					cleanup();
				}
			}, SSE_HEARTBEAT_MS);
			runSseLoop(store, path, offsetParam, controller, encoder, signal, () => isConnected, () => {
				if (controller.desiredSize === null || controller.desiredSize > 0) return Promise.resolve();
				return new Promise((resolve) => {
					resolveCapacity = resolve;
				});
			}).then(() => {
				cleanup();
				try {
					controller.close();
				} catch {}
			}, (error) => {
				console.error(`[flue] SSE stream read failed for ${path}:`, error);
				cleanup();
				try {
					controller.error(error);
				} catch {}
			});
		},
		pull() {
			resolveCapacity?.();
			resolveCapacity = void 0;
		},
		cancel() {
			isConnected = false;
			resolveCapacity?.();
			resolveCapacity = void 0;
			cleanup();
		}
	});
	function cleanup() {
		if (heartbeatTimer !== void 0) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = void 0;
		}
	}
	return new Response(stream, {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			...SECURITY_HEADERS
		}
	});
}
async function runSseLoop(store, path, offsetParam, controller, encoder, signal, isConnected, waitForCapacity) {
	let currentOffset = offsetParam;
	while (isConnected()) {
		await waitForCapacity();
		if (!isConnected()) return;
		const result = await store.readEvents(path, { offset: currentOffset });
		if (result.events.length > 0) {
			const sseData = `event: data\n${encodeSseData(JSON.stringify(publicEventData(path, result)))}`;
			try {
				controller.enqueue(encoder.encode(sseData));
			} catch {
				return;
			}
		}
		const clientAtTail = result.upToDate;
		const streamClosed = result.closed && clientAtTail;
		const controlData = { [SSE_OFFSET_FIELD]: result.nextOffset };
		if (streamClosed) controlData[SSE_CLOSED_FIELD] = true;
		else {
			controlData[SSE_CURSOR_FIELD] = generateCursor();
			if (clientAtTail) controlData[SSE_UP_TO_DATE_FIELD] = true;
		}
		const controlSse = `event: control\n${encodeSseData(JSON.stringify(controlData))}`;
		try {
			controller.enqueue(encoder.encode(controlSse));
		} catch {
			return;
		}
		currentOffset = result.nextOffset;
		if (streamClosed) return;
		if (!clientAtTail) continue;
		const waitResult = await waitForStreamData(store, path, signal, async () => {
			const reread = await store.readEvents(path, { offset: currentOffset });
			return reread.events.length > 0 || reread.closed && reread.upToDate;
		});
		if (waitResult === "aborted") return;
		if (waitResult === "timeout") {
			const keepAlive = {
				[SSE_OFFSET_FIELD]: currentOffset,
				[SSE_CURSOR_FIELD]: generateCursor(),
				[SSE_UP_TO_DATE_FIELD]: true
			};
			try {
				controller.enqueue(encoder.encode(`event: control\n${encodeSseData(JSON.stringify(keepAlive))}`));
			} catch {
				return;
			}
		}
	}
}
/**
* Check the request's If-None-Match header and return a 304 if the
* ETag matches. Returns null if the request should proceed normally.
*/
function checkConditional(request, etag) {
	const ifNoneMatch = request.headers.get("if-none-match");
	if (ifNoneMatch && ifNoneMatch === etag) return new Response(null, {
		status: 304,
		headers: {
			etag,
			...SECURITY_HEADERS
		}
	});
	return null;
}
//#endregion
//#region src/runtime/invoke.ts
async function invokeWorkflow(workflow, request, runtime) {
	if (!runtime) throw new WorkflowInvocationNotConfiguredError();
	const workflowName = runtime.workflows.find((record) => record.definition === workflow)?.name;
	if (!workflowName) throw new WorkflowNotDiscoveredError();
	if (!workflow.action.input && request.input !== void 0) throw new WorkflowInputUnexpectedError();
	let input;
	try {
		input = request.input === void 0 ? void 0 : cloneJsonSerializable(request.input, "invoke().input");
	} catch (cause) {
		throw new WorkflowInputSerializationError({ cause });
	}
	try {
		return await runtime.admitWorkflow({
			workflowName,
			input
		});
	} catch (cause) {
		if (cause instanceof WorkflowAdmissionError) throw cause;
		throw new WorkflowAdmissionError({
			workflow: workflowName,
			cause
		});
	}
}
//#endregion
//#region src/runtime/flue-app.ts
async function dispatch(agentOrRequest, maybeRequest) {
	const rt = runtimeConfig;
	if (!rt) throw new Error("[flue] dispatch() called before runtime was configured. This usually means it was used outside a Flue-built server entry.");
	return enqueueDispatch({
		request: isAgentDefinitionValue(agentOrRequest) ? resolveAgentDefinitionDispatchRequest(agentOrRequest, maybeRequest, rt) : agentOrRequest,
		dispatchQueue: rt.dispatchQueue,
		rt
	});
}
function invoke(workflow, request) {
	return invokeWorkflow(workflow, request, runtimeConfig);
}
function isAgentDefinitionValue(value) {
	return "__flueAgentDefinition" in value && value.__flueAgentDefinition === true && typeof value.initialize === "function";
}
function resolveAgentDefinitionDispatchRequest(agent, request, rt) {
	if (!request) throw new Error("[flue] dispatch(agent, request) requires a dispatch request.");
	const name = rt.agents.find((record) => record.definition === agent)?.name;
	if (!name) throw new Error("[flue] dispatch() target agent definition is not a discovered default-exported agent in this built application.");
	return {
		agent: name,
		id: request.id,
		input: request.input
	};
}
let runtimeConfig;
/**
* Not part of the public API — exposed via `@flue/runtime/internal` only
* because the generated entry imports it from a stable bare specifier.
*/
function configureFlueRuntime(cfg) {
	runtimeConfig = cfg;
	configureErrorRendering({ devMode: cfg.devMode ?? false });
}
function getFlueRuntime() {
	return runtimeConfig;
}
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
function flue() {
	const app = new Hono();
	app.post("/workflows/:name", validated("param", WorkflowRouteParamSchema), validated("query", InvocationQuerySchema), workflowRouteHandler);
	app.all("/workflows/:name", workflowRouteHandler);
	app.post("/agents/:name/:id", validated("param", AgentRouteParamSchema), validated("query", InvocationQuerySchema), agentRouteHandler);
	app.all("/agents/:name/:id/abort", abortRouteHandler);
	app.all("/agents/:name/:id/attachments/:attachmentId", attachmentsRouteHandler);
	app.all("/agents/:name/:id", agentRouteHandler);
	app.all("/channels/:name", channelRouteHandler);
	app.all("/channels/:name/:suffix{.+}", channelRouteHandler);
	app.all("/runs/:runId", runStreamReadHandler);
	app.onError((err) => toHttpResponse(err));
	return app;
}
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
function createDefaultFlueApp() {
	const app = new Hono();
	app.route("/", flue());
	app.notFound((c) => {
		throw new RouteNotFoundError({
			method: c.req.method,
			path: new URL(c.req.url).pathname
		});
	});
	app.onError((err) => toHttpResponse(err));
	return app;
}
function validated(target, schema) {
	return validator(target, schema, (result) => {
		if (result.success) return;
		throw new InvalidRequestError({ reason: `Invalid ${target} parameters: ${describeValidationIssues(result.error)}` });
	});
}
/**
* Flatten standard-schema validation issues into a caller-safe sentence.
* The raw issue objects are a validation-library-internal shape and must not
* reach the wire — clients would freeze that shape into their error handling.
*/
function describeValidationIssues(issues) {
	if (!Array.isArray(issues) || issues.length === 0) return "request validation failed.";
	return issues.map((issue) => {
		const message = typeof issue.message === "string" ? issue.message : "Invalid value.";
		const path = Array.isArray(issue.path) ? issue.path.map((segment) => typeof segment === "object" && segment !== null && "key" in segment ? String(segment.key) : String(segment)).join(".") : "";
		return path ? `${path}: ${message}` : message;
	}).join(" ");
}
const workflowRouteHandler = async (c) => {
	const rt = runtimeConfig;
	if (!rt) throw new Error("[flue] flue() route invoked before runtime was configured. This usually means flue() was used outside a Flue-built server entry.");
	const name = c.req.param("name") ?? "";
	validateWorkflowRequest({
		method: c.req.method,
		name,
		registeredWorkflows: rt.workflows.map((workflow) => workflow.name),
		httpWorkflows: registeredWorkflowsForTransport(rt)
	});
	const request = c.req.raw.clone();
	const record = rt.workflows.find((workflow) => workflow.name === name);
	return runAttachedMiddleware(c, record?.route, async () => {
		if (rt.target === "node") {
			if (!record) throw new Error("[flue] Node runtime is missing workflow configuration.");
			return handleWorkflowRequest({
				request,
				workflowName: name,
				workflow: record.definition,
				createContext: rt.createWorkflowContext,
				runStore: rt.runStore,
				eventStreamStore: rt.eventStreamStore,
				activityGate: rt.activityGate
			});
		}
		const response = await rt.routeWorkflowRequest(request, c.env, {
			workflowName: name,
			instanceId: generateWorkflowRunId()
		});
		if (response) return response;
		throw new RouteNotFoundError({
			method: c.req.method,
			path: new URL(c.req.url).pathname
		});
	});
};
const agentRouteHandler = async (c) => {
	const rt = runtimeConfig;
	if (!rt) throw new Error("[flue] flue() route invoked before runtime was configured. This usually means flue() was used outside a Flue-built server entry.");
	const name = c.req.param("name") ?? "";
	const id = c.req.param("id") ?? "";
	validateAgentRequest({
		method: c.req.method,
		name,
		id,
		registeredAgents: registeredAgentsForTransport(rt)
	});
	const request = c.req.raw.clone();
	return runAttachedMiddleware(c, rt.agents.find((agent) => agent.name === name)?.route, async () => {
		if (c.req.method === "GET" || c.req.method === "HEAD") {
			const streamPath = agentStreamPath(name, id);
			if (rt.target === "node") {
				if (c.req.method === "HEAD") return handleAgentConversationHead(rt.conversationStreamStore, streamPath);
				return handleAgentConversationRead({
					store: rt.conversationStreamStore,
					path: agentStreamPath(name, id),
					request: c.req.raw
				});
			}
			const response = await rt.routeAgentRequest(request, c.env, {
				agentName: name,
				instanceId: id
			});
			if (response) return response;
			throw new RouteNotFoundError({
				method: c.req.method,
				path: new URL(c.req.url).pathname
			});
		}
		if (rt.target === "node") {
			const admitAttachedSubmission = rt.createAgentAdmission(name, id);
			if (!admitAttachedSubmission) throw new Error("[flue] Node runtime is missing agent admission configuration.");
			return handleAgentRequest({
				request,
				id,
				agentName: name,
				conversationStreamStore: rt.conversationStreamStore,
				admitAttachedSubmission
			});
		}
		const response = await rt.routeAgentRequest(request, c.env, {
			agentName: name,
			instanceId: id
		});
		if (response) return response;
		throw new RouteNotFoundError({
			method: c.req.method,
			path: new URL(c.req.url).pathname
		});
	});
};
const abortRouteHandler = async (c) => {
	const rt = runtimeConfig;
	if (!rt) throw new Error("[flue] flue() route invoked before runtime was configured. This usually means flue() was used outside a Flue-built server entry.");
	if (c.req.method !== "POST") throw new MethodNotAllowedError({
		method: c.req.method,
		allowed: ["POST"]
	});
	const name = c.req.param("name") ?? "";
	const id = c.req.param("id") ?? "";
	validateAgentRequest({
		method: c.req.method,
		name,
		id,
		registeredAgents: registeredAgentsForTransport(rt)
	});
	const request = c.req.raw.clone();
	return runAttachedMiddleware(c, rt.agents.find((agent) => agent.name === name)?.route, async () => {
		if (rt.target === "node") {
			const aborted = await rt.abortAgentInstance(name, id);
			return Response.json({ aborted });
		}
		const response = await rt.routeAgentRequest(request, c.env, {
			agentName: name,
			instanceId: id
		});
		if (response) return response;
		throw new RouteNotFoundError({
			method: c.req.method,
			path: new URL(c.req.url).pathname
		});
	});
};
const attachmentsRouteHandler = async (c) => {
	const rt = requiredRuntime();
	const name = c.req.param("name") ?? "";
	const id = c.req.param("id") ?? "";
	const attachmentId = c.req.param("attachmentId") ?? "";
	const record = rt.agents.find((agent) => agent.name === name);
	if (!record?.attachments) throw new AttachmentsNotExposedError({
		method: c.req.method,
		path: new URL(c.req.url).pathname,
		agentName: name
	});
	if (c.req.method !== "GET") throw new MethodNotAllowedError({
		method: c.req.method,
		allowed: ["GET"]
	});
	const request = c.req.raw.clone();
	return runAttachedMiddleware(c, record.attachments, async () => {
		if (rt.target === "node") return handleAgentAttachmentRead({
			conversationStore: rt.conversationStreamStore,
			attachmentStore: rt.attachmentStore,
			path: agentStreamPath(name, id),
			attachmentId
		});
		const response = await rt.routeAgentRequest(request, c.env, {
			agentName: name,
			instanceId: id
		});
		if (response) return response;
		throw new RouteNotFoundError({
			method: c.req.method,
			path: new URL(c.req.url).pathname
		});
	});
};
const channelRouteHandler = async (c) => {
	const rt = runtimeConfig;
	if (!rt) throw new Error("[flue] flue() route invoked before runtime was configured. This usually means flue() was used outside a Flue-built server entry.");
	const name = c.req.param("name") ?? "";
	const remainder = c.req.param("suffix") ?? "";
	const suffix = remainder.length > 0 ? `/${remainder}` : "";
	const routes = rt.channelHandlers?.[name];
	if (!routes || suffix.length === 0) throw new RouteNotFoundError({
		method: c.req.method,
		path: new URL(c.req.url).pathname
	});
	const handler = routes[`${c.req.method} ${suffix}`];
	if (!handler) {
		const allowed = Object.keys(routes).filter((key) => key.endsWith(` ${suffix}`)).map((key) => key.slice(0, key.indexOf(" ")));
		if (allowed.length > 0) throw new MethodNotAllowedError({
			method: c.req.method,
			allowed
		});
		throw new RouteNotFoundError({
			method: c.req.method,
			path: new URL(c.req.url).pathname
		});
	}
	const lease = rt.activityGate?.enter();
	let response;
	try {
		response = normalizeFetchResponse(await handler(c));
		if (response?.body && lease) response = retainActivityLease(response, lease);
		else lease?.release();
	} catch (error) {
		lease?.release();
		throw error;
	}
	if (!response) throw new TypeError(`[flue] Channel "${name}" handler for ${c.req.method} ${suffix} must return a Response.`);
	return response;
};
function retainActivityLease(response, lease) {
	const body = response.body;
	if (!body) {
		lease.release();
		return response;
	}
	const reader = body.getReader();
	return new Response(new ReadableStream({
		async pull(controller) {
			try {
				const result = await reader.read();
				if (result.done) {
					lease.release();
					controller.close();
					return;
				}
				controller.enqueue(result.value);
			} catch (error) {
				lease.release();
				controller.error(error);
			}
		},
		async cancel(reason) {
			try {
				await reader.cancel(reason);
			} finally {
				lease.release();
			}
		}
	}), {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers
	});
}
function normalizeFetchResponse(value) {
	if (value instanceof globalThis.Response) return value;
	if (Object.prototype.toString.call(value) !== "[object Response]") return void 0;
	if (typeof value !== "object" || value === null) return void 0;
	try {
		const response = value;
		if (!Number.isInteger(response.status) || response.status < 200 || response.status > 599 || typeof response.statusText !== "string" || typeof response.headers?.entries !== "function" || response.body !== null && typeof response.body !== "object") return;
		return new globalThis.Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: new Headers(response.headers)
		});
	} catch {
		return;
	}
}
const runStreamReadHandler = async (c) => {
	const rt = requiredRuntime();
	const method = c.req.method;
	const runId = c.req.param("runId") ?? "";
	const pointer = await findRunPointer(rt, c.env, runId);
	const workflow = pointer ? rt.workflows.find((record) => record.name === pointer.workflowName) : void 0;
	if (!workflow || !workflow.runs && !rt.temporaryLocalExposure) throw new RunNotFoundError({ runId });
	return runAttachedMiddleware(c, workflow.runs, async () => {
		if (method !== "GET" && method !== "HEAD") throw new MethodNotAllowedError({
			method,
			allowed: ["GET", "HEAD"]
		});
		const wantsMeta = method === "GET" && new URL(c.req.url).searchParams.has("meta");
		if (rt.target === "node") {
			if (wantsMeta) return handleRunRouteRequest({
				runStore: rt.runStore,
				workflowName: workflow.name,
				runId
			});
			return nodeStreamReadResponse(rt, method, runStreamPath(runId), c.req.raw);
		}
		const response = await rt.routeRunRequest(c.req.raw, c.env, {
			workflowName: workflow.name,
			runId
		});
		if (response) return response;
		throw new RunNotFoundError({ runId });
	});
};
/** Serve run metadata (`RunRecord`) for a workflow-scoped run lookup. */
async function handleRunRouteRequest(opts) {
	if (!opts.runStore) throw new RunStoreUnavailableError();
	const run = await opts.runStore.getRun(opts.runId);
	if (!run || run.workflowName !== opts.workflowName) throw new RunNotFoundError({ runId: opts.runId });
	return new Response(JSON.stringify(run), { headers: { "content-type": "application/json" } });
}
/** Serve a DS stream HEAD/GET from the Node runtime's store. */
function nodeStreamReadResponse(rt, method, streamPath, request) {
	const store = rt.eventStreamStore;
	if (method === "HEAD") return handleStreamHead(store, streamPath);
	return handleStreamRead({
		store,
		path: streamPath,
		request
	});
}
/**
* Resolve a run pointer from the configured store/index, or `null` when no
* run with this id is recorded. Throws {@link RunStoreUnavailableError} when
* the runtime has no run store configured (a wiring problem, not a
* resource-existence outcome).
*/
async function findRunPointer(rt, env, runId) {
	if (rt.target === "cloudflare") {
		const index = rt.createRunIndexForRequest(env);
		if (!index) throw new RunStoreUnavailableError();
		return index.lookupRun(runId);
	}
	return rt.runStore.lookupRun(runId);
}
function requiredRuntime() {
	if (!runtimeConfig) throw new Error("[flue] flue() route invoked before runtime was configured. This usually means flue() was used outside a Flue-built server entry.");
	return runtimeConfig;
}
async function runAttachedMiddleware(c, middleware, handle) {
	if (!middleware) return handle();
	const finalizedBefore = c.finalized;
	const responseBefore = finalizedBefore ? c.res : void 0;
	let continued = false;
	const response = await middleware(c, async () => {
		if (continued) throw new Error("next() called multiple times");
		continued = true;
		const handled = await handle();
		if (handled) c.res = handled;
	});
	if (response) return response;
	if (continued || c.finalized && (!finalizedBefore || c.res !== responseBefore)) return c.res;
	throw new Error("Context is not finalized. Did you forget to return a Response object or await next()?");
}
function registeredAgentsForTransport(rt) {
	return rt.agents.filter((agent) => rt.temporaryLocalExposure || agent.route !== void 0).map((agent) => agent.name);
}
function registeredWorkflowsForTransport(rt) {
	return rt.workflows.filter((workflow) => rt.temporaryLocalExposure || workflow.route !== void 0).map((workflow) => workflow.name);
}
//#endregion
export { getFlueRuntime as a, handleStreamHead as c, handleAgentConversationHead as d, handleAgentConversationRead as f, flue as i, handleStreamRead as l, createDefaultFlueApp as n, handleRunRouteRequest as o, loadReducedConversationState as p, dispatch as r, invoke as s, configureFlueRuntime as t, handleAgentAttachmentRead as u };
