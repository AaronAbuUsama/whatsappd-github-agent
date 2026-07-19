import { C as RunStoreUnavailableError, G as WorkflowInputUnexpectedError, X as toHttpResponse, Y as parseJsonBody, h as InvalidRequestError, n as ActionOutputSerializationError, o as AttachmentNotAvailableError, r as ActionOutputValidationError, t as ActionInputValidationError, u as ConversationRecordInvariantError, y as ProductEventVersionError } from "./errors-DUgRtE8e.mjs";
import { a as cloneJsonSerializable, c as parseValibot, o as isTopLevelObjectSchema, s as isValibotSchema, t as assertToolDefinition } from "./tool-C2CuUqYC.mjs";
import { C as DirectAgentPayloadSchema, a as isBufferedRunEvent, b as isUuid, f as clampLimit, g as createActionScopeName, l as migrateFlueSqlSchema, o as isStreamExcludedEvent, v as createTaskSessionName, y as isPublicSessionName } from "./run-store-CYeXjR-d.mjs";
import * as v from "valibot";
import { ulid } from "ulidx";
import { completeSimple, isContextOverflow } from "@earendil-works/pi-ai/compat";
//#region src/action.ts
const definedActions = /* @__PURE__ */ new WeakSet();
function defineAction(options) {
	if (!options || typeof options !== "object") throw new Error("[flue] defineAction() requires an action definition object.");
	assertNonEmptyString$1(options.name, "defineAction({ name })");
	assertNonEmptyString$1(options.description, "defineAction({ description })");
	if (options.input !== void 0) {
		if (!isValibotSchema(options.input)) throw new Error("[flue] defineAction({ input }) must be a Valibot schema.");
		if (!isTopLevelObjectSchema(options.input)) throw new Error("[flue] defineAction({ input }) must be a top-level object schema.");
	}
	if (options.output !== void 0 && !isValibotSchema(options.output)) throw new Error("[flue] defineAction({ output }) must be a Valibot schema.");
	if (typeof options.run !== "function") throw new Error("[flue] defineAction({ run }) must be a function.");
	const action = Object.freeze({
		__flueAction: true,
		name: options.name,
		description: options.description,
		input: options.input,
		output: options.output,
		run: options.run
	});
	definedActions.add(action);
	return action;
}
function isActionDefinition(value) {
	return Boolean(value && typeof value === "object" && definedActions.has(value));
}
function parseActionInput(action, input) {
	if (!action.input) {
		if (input !== void 0) throw new WorkflowInputUnexpectedError();
		return {
			declared: false,
			value: void 0
		};
	}
	const parsed = parseValibot(action.input, input === void 0 ? {} : input);
	if (!parsed.success) throw new ActionInputValidationError({
		action: action.name,
		issues: parsed.issues
	});
	return {
		declared: true,
		value: parsed.output
	};
}
async function runActionWithParsedInput(action, context, input) {
	const runContext = input.declared ? {
		...context,
		input: input.value
	} : context;
	const result = await action.run(runContext);
	let output = result;
	if (action.output) {
		const parsed = parseValibot(action.output, result);
		if (!parsed.success) throw new ActionOutputValidationError({
			action: action.name,
			issues: parsed.issues
		});
		output = parsed.output;
	}
	if (output === void 0 && !action.output) return void 0;
	if (output === void 0) throw new ActionOutputSerializationError({ action: action.name });
	try {
		return cloneJsonSerializable(output, `Action "${action.name}" output`);
	} catch (cause) {
		throw new ActionOutputSerializationError({
			action: action.name,
			cause
		});
	}
}
function assertNonEmptyString$1(value, label) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`[flue] ${label} must be a non-empty string.`);
}
//#endregion
//#region src/agent-definition.ts
const agentDefinitions = /* @__PURE__ */ new WeakSet();
const VALID_THINKING_LEVELS = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true
};
const AgentProfileSchema = v.strictObject({
	name: v.optional(v.string()),
	description: v.optional(v.string()),
	model: v.optional(v.string()),
	instructions: v.optional(v.string()),
	skills: v.optional(v.array(v.unknown())),
	tools: v.optional(v.array(v.unknown())),
	actions: v.optional(v.array(v.unknown())),
	subagents: v.optional(v.array(v.unknown())),
	thinkingLevel: v.optional(v.string()),
	compaction: v.optional(v.union([v.literal(false), v.looseObject({})])),
	durability: v.optional(v.looseObject({}))
}, (issue) => issue.expected === "never" ? `received unknown agent profile field ${issue.received}` : issue.message);
const AGENT_RUNTIME_FIELDS = new Set([
	...Object.keys(AgentProfileSchema.entries),
	"profile",
	"cwd",
	"sandbox"
].filter((field) => field !== "name"));
/**
* Validates and returns a reusable agent profile. Use profiles as the baseline
* for an agent definition or as named subagents available to `session.task()`.
*
* Throws when the profile contains unknown fields, invalid capabilities,
* duplicate capability names, or circular subagents.
*/
function defineAgentProfile(profile) {
	assertAgentProfile(profile, "defineAgentProfile()", /* @__PURE__ */ new WeakSet());
	return profile;
}
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
function defineAgent(initialize) {
	if (typeof initialize !== "function") throw new Error("[flue] defineAgent() requires an initializer function.");
	const agent = Object.freeze({
		__flueAgentDefinition: true,
		initialize
	});
	agentDefinitions.add(agent);
	return agent;
}
/** @deprecated Renamed to {@link defineAgent}. */
function createAgent(initialize) {
	return defineAgent(initialize);
}
function isAgentDefinition(value) {
	return Boolean(value && typeof value === "object" && agentDefinitions.has(value));
}
function assertResolvedAgentProfile(profile, label) {
	assertAgentProfile(profile, label, /* @__PURE__ */ new WeakSet());
	return profile;
}
function resolveAgentProfile(options) {
	assertAgentRuntimeConfig(options);
	const profile = options?.profile;
	return {
		name: profile?.name,
		description: hasOwn(options, "description") ? options?.description : profile?.description,
		model: hasOwn(options, "model") ? options?.model : profile?.model,
		instructions: hasOwn(options, "instructions") ? options?.instructions : profile?.instructions,
		skills: mergeArrays(profile?.skills, options?.skills),
		tools: mergeArrays(profile?.tools, options?.tools),
		actions: mergeArrays(profile?.actions, options?.actions),
		subagents: mergeArrays(profile?.subagents, options?.subagents),
		thinkingLevel: hasOwn(options, "thinkingLevel") ? options?.thinkingLevel : profile?.thinkingLevel,
		compaction: hasOwn(options, "compaction") ? options?.compaction : profile?.compaction,
		durability: hasOwn(options, "durability") ? options?.durability : profile?.durability
	};
}
function extendAgentProfile(profile, extensions) {
	return {
		...profile,
		skills: mergeArrays(profile.skills, extensions.skills),
		tools: mergeArrays(profile.tools, extensions.tools),
		actions: mergeArrays(profile.actions, extensions.actions),
		subagents: mergeArrays(profile.subagents, extensions.subagents)
	};
}
function hasOwn(value, key) {
	return Boolean(value && Object.hasOwn(value, key));
}
function mergeArrays(base, additions) {
	if (base === void 0 && additions === void 0) return void 0;
	return [...base ?? [], ...additions ?? []];
}
function assertAgentRuntimeConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("[flue] defineAgent() initializer must return an agent runtime config object.");
	for (const key of Object.keys(value)) if (!AGENT_RUNTIME_FIELDS.has(key)) throw new Error(`[flue] defineAgent() initializer returned unknown runtime config field "${key}".`);
	if (value.profile !== void 0) assertAgentProfile(value.profile, "defineAgent() profile", /* @__PURE__ */ new WeakSet());
}
function assertAgentProfile(value, label, activeDefinitions) {
	const parsed = v.safeParse(AgentProfileSchema, value);
	if (!parsed.success) throw new Error(`[flue] ${label} requires a valid agent profile: ${formatIssues(parsed.issues)}.`);
	const definition = parsed.output;
	const source = value;
	if (activeDefinitions.has(source)) throw new Error(`[flue] ${label} must not contain circular subagents.`);
	activeDefinitions.add(source);
	if (definition.name !== void 0) assertAgentName(definition.name, `${label} name`);
	if (definition.description !== void 0) assertNonEmptyString(definition.description, `${label} description`);
	assertThinkingLevel(definition.thinkingLevel, label);
	assertCompaction(definition.compaction, label);
	assertDurability(definition.durability, label);
	assertTools(definition.tools, label);
	assertActions(definition.actions, label);
	assertSkills(definition.skills, label);
	assertSubagents(definition.subagents, label, activeDefinitions);
	assertUniqueNames(definition.tools, `${label} tools`, "tool");
	assertUniqueNames(definition.actions, `${label} actions`, "action");
	assertUniqueNames(definition.skills, `${label} skills`, "skill");
	assertUniqueNames(definition.subagents, `${label} subagents`, "subagent");
	activeDefinitions.delete(source);
}
function assertThinkingLevel(value, label) {
	if (value !== void 0 && !(value in VALID_THINKING_LEVELS)) throw new Error(`[flue] ${label} thinkingLevel must be one of: ${Object.keys(VALID_THINKING_LEVELS).join(", ")}.`);
}
function assertCompaction(definition, label) {
	if (definition === void 0 || definition === false) return;
	for (const key of Object.keys(definition)) if (key !== "reserveTokens" && key !== "keepRecentTokens" && key !== "model") throw new Error(`[flue] ${label} compaction received unknown field "${key}".`);
	assertTokenCount(definition.reserveTokens, `${label} compaction.reserveTokens`);
	assertTokenCount(definition.keepRecentTokens, `${label} compaction.keepRecentTokens`);
	if (definition.model !== void 0 && typeof definition.model !== "string") throw new Error(`[flue] ${label} compaction.model must be a string.`);
}
function assertDurability(definition, label) {
	if (definition === void 0) return;
	for (const key of Object.keys(definition)) if (key !== "maxAttempts" && key !== "timeoutMs") throw new Error(`[flue] ${label} durability received unknown field "${key}".`);
	assertPositiveInteger(definition.maxAttempts, `${label} durability.maxAttempts`);
	assertPositiveInteger(definition.timeoutMs, `${label} durability.timeoutMs`);
}
function assertPositiveInteger(value, label) {
	if (value === void 0) return;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) throw new Error(`[flue] ${label} must be a positive integer.`);
}
function assertTokenCount(value, label) {
	if (value === void 0) return;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) throw new Error(`[flue] ${label} must be a non-negative integer.`);
}
function assertTools(values, label) {
	for (const [index, value] of values?.entries() ?? []) assertToolDefinition(value, `${label} tools[${index}]`);
}
function assertActions(values, label) {
	for (const [index, value] of values?.entries() ?? []) if (!isActionDefinition(value)) throw new Error(`[flue] ${label} actions[${index}] must be created with defineAction().`);
}
function assertSkills(values, label) {
	for (const [index, value] of values?.entries() ?? []) {
		if (!value || typeof value !== "object") throw new Error(`[flue] ${label} skills[${index}] must be a skill definition object.`);
		const skill = value;
		assertNonEmptyString(skill.name, `${label} skills[${index}].name`);
		assertNonEmptyString(skill.description, `${label} skills[${index}].description`);
	}
}
function assertSubagents(values, label, activeDefinitions) {
	for (const [index, value] of values?.entries() ?? []) {
		if (!value || typeof value !== "object") throw new Error(`[flue] ${label} subagents[${index}] must be an agent definition object.`);
		const subagent = value;
		assertAgentName(subagent.name, `${label} subagents[${index}].name`);
		if (subagent.durability !== void 0) throw new Error(`[flue] ${label} subagents[${index}] must not declare durability. Delegated task sessions run inside the parent operation; configure durability on the agent definition instead.`);
		assertAgentProfile(value, `${label} subagents[${index}]`, activeDefinitions);
	}
}
function assertAgentName(value, label) {
	assertNonEmptyString(value, label);
	if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value)) throw new Error(`[flue] ${label} must start with a letter and contain only letters, numbers, "_", or "-".`);
}
function assertNonEmptyString(value, label) {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`[flue] ${label} must be a non-empty string.`);
}
function assertUniqueNames(values, label, kind) {
	if (!values) return;
	const seen = /* @__PURE__ */ new Set();
	for (const value of values) {
		const name = value.name;
		if (!name) continue;
		if (seen.has(name)) throw new Error(`[flue] ${label} must not contain duplicate ${kind} name "${name}".`);
		seen.add(name);
	}
}
function formatIssues(issues) {
	return issues.map((issue) => issue.message).join("; ");
}
//#endregion
//#region src/execution-interceptor.ts
const interceptors = [];
function extractTraceCarrier(headers) {
	const traceparent = headers.get("traceparent");
	if (!traceparent || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/.test(traceparent)) return void 0;
	const [, traceId, spanId] = traceparent.split("-");
	if (/^0+$/.test(traceId ?? "") || /^0+$/.test(spanId ?? "")) return void 0;
	const tracestate = headers.get("tracestate");
	if (tracestate && (tracestate.length > 512 || !tracestate.split(",").every((entry) => entry.includes("=")))) return { traceparent };
	return {
		traceparent,
		...tracestate ? { tracestate } : {}
	};
}
function registerExecutionInterceptor(interceptor) {
	interceptors.push(interceptor);
	return () => {
		const index = interceptors.indexOf(interceptor);
		if (index !== -1) interceptors.splice(index, 1);
	};
}
function interceptExecution(operation, ctx, next) {
	return Promise.resolve().then(() => dispatchExecution(operation, ctx, next));
}
function dispatchExecution(operation, ctx, next) {
	const registered = [...interceptors];
	let index = -1;
	const dispatch = (nextIndex) => {
		if (nextIndex <= index) return Promise.reject(/* @__PURE__ */ new Error("Flue execution next() called more than once."));
		index = nextIndex;
		const interceptor = registered[nextIndex];
		if (!interceptor) return next();
		let called = false;
		return interceptor(operation, ctx, () => {
			if (called) return Promise.reject(/* @__PURE__ */ new Error("Flue execution next() called more than once."));
			called = true;
			return dispatch(nextIndex + 1);
		});
	};
	return dispatch(0);
}
//#endregion
//#region src/runtime/event-stream-store.ts
/**
* Durable event stream store — async interface and SQLite implementation.
*
* Stores append-only JSON event streams. Each stream is identified by a path
* (e.g. `agents/my-agent/instance-1` or `runs/run_01JX...`). Events get
* monotonically increasing integer offsets formatted as `<readSeq>_<seq>` —
* two 16-digit zero-padded integers separated by an underscore, matching the
* DS reference server's offset format. The first component is always `0`
* (Flue has no file segments); the second is the sequence number.
*
* The interface is fully async (returns Promises) so that adapters backed by
* async databases (Postgres, MongoDB, etc.) can implement it naturally. The
* only exception is {@link EventStreamStore.subscribe}, which is an in-memory
* listener registration and stays synchronous.
*/
const COMPONENT_PAD = 16;
const ZERO_COMPONENT = "0".repeat(COMPONENT_PAD);
/**
* Format an integer sequence number as a DS-compatible offset string.
*
* Produces `<readSeq>_<seq>` with both components zero-padded to 16 digits,
* matching the DS reference server's offset format. The first component is
* always `0` (Flue uses integer sequences, not segmented files).
*/
function formatOffset(seq) {
	if (seq === -1) return "-1";
	return `${ZERO_COMPONENT}_${String(seq).padStart(COMPONENT_PAD, "0")}`;
}
/**
* Parse a DS offset string back to an integer sequence number.
* Accepts the `<readSeq>_<seq>` format and extracts the second component.
* Returns -1 for the sentinel `"-1"`. Throws on any other format.
*/
function parseOffset(offset) {
	if (offset === "-1") return -1;
	const sequence = /^\d+_(\d+)$/.exec(offset)?.[1];
	if (!sequence) throw new Error(`[flue] Invalid stream offset: "${offset}".`);
	return parseInt(sequence, 10);
}
function agentStreamPath(agentName, instanceId) {
	return `agents/${agentName}/${instanceId}`;
}
function runStreamPath(runId) {
	return `runs/${runId}`;
}
const CREATE_STREAMS_TABLE = `
CREATE TABLE IF NOT EXISTS flue_event_streams (
  path         TEXT PRIMARY KEY,
  next_offset  INTEGER NOT NULL DEFAULT 0,
  closed       INTEGER NOT NULL DEFAULT 0
)`;
const CREATE_ENTRIES_TABLE = `
CREATE TABLE IF NOT EXISTS flue_event_stream_entries (
  path    TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (path, seq)
)`;
const CREATE_EVENT_KEYS_TABLE = `
CREATE TABLE IF NOT EXISTS flue_event_stream_keys (
  path    TEXT NOT NULL,
  key     TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (path, key),
  UNIQUE (path, seq)
)`;
const CREATE_EVENT_KEY_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS flue_event_stream_key_append
AFTER INSERT ON flue_event_stream_keys
BEGIN
  INSERT INTO flue_event_stream_entries (path, seq, data)
  VALUES (NEW.path, NEW.seq, NEW.data);
  UPDATE flue_event_streams SET next_offset = next_offset + 1
  WHERE path = NEW.path;
END`;
const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 1e3;
/**
* SQLite-backed {@link EventStreamStore}.
*
* Works with both `node:sqlite` (via the {@link SqlStorage} adapter) and
* Cloudflare DO SQLite. Tables are created in the constructor — no separate
* migration step required. The constructor stamps a fresh database with the
* current schema version and throws when the database records an unknown or
* newer version.
*
* All methods are `async` to satisfy the interface contract but resolve
* synchronously since SQLite operations are synchronous.
*/
var SqliteEventStreamStore = class {
	sql;
	listeners = /* @__PURE__ */ new Map();
	constructor(sql) {
		this.sql = sql;
		migrateFlueSqlSchema(sql, () => {
			sql.exec(CREATE_STREAMS_TABLE);
			sql.exec(CREATE_ENTRIES_TABLE);
			sql.exec(CREATE_EVENT_KEYS_TABLE);
			sql.exec(CREATE_EVENT_KEY_TRIGGER);
		});
	}
	async createStream(path) {
		this.sql.exec(`INSERT OR IGNORE INTO flue_event_streams (path) VALUES (?)`, path);
	}
	async appendEvent(path, event) {
		const data = JSON.stringify(event);
		const updated = this.sql.exec(`UPDATE flue_event_streams
				 SET next_offset = next_offset + 1
				 WHERE path = ? AND closed = 0
				 RETURNING next_offset`, path).toArray();
		if (updated.length === 0) {
			if (!await this.getStreamMeta(path)) throw new Error(`[flue] Event stream "${path}" does not exist.`);
			throw new Error(`[flue] Event stream "${path}" is closed.`);
		}
		const [updatedRow] = updated;
		if (!updatedRow) throw new Error(`[flue] Event stream "${path}" could not be updated.`);
		const offset = updatedRow.next_offset - 1;
		this.sql.exec(`INSERT INTO flue_event_stream_entries (path, seq, data) VALUES (?, ?, ?)`, path, offset, data);
		this.notifyListeners(path);
		return formatOffset(offset);
	}
	async appendEventOnce(path, key, event) {
		const data = JSON.stringify(event);
		const inserted = this.sql.exec(`INSERT OR IGNORE INTO flue_event_stream_keys (path, key, seq, data)
				 SELECT path, ?, next_offset, ? FROM flue_event_streams
				 WHERE path = ? AND closed = 0
				 RETURNING seq`, key, data, path).toArray()[0];
		if (inserted) {
			this.notifyListeners(path);
			return formatOffset(inserted.seq);
		}
		const existing = this.sql.exec("SELECT seq, data FROM flue_event_stream_keys WHERE path = ? AND key = ?", path, key).toArray()[0];
		if (existing) {
			if (existing.data !== data) throw new Error(`[flue] Event key "${key}" already has a conflicting payload.`);
			return formatOffset(existing.seq);
		}
		if (!await this.getStreamMeta(path)) throw new Error(`[flue] Event stream "${path}" does not exist.`);
		throw new Error(`[flue] Event stream "${path}" is closed.`);
	}
	async readEvents(path, opts) {
		const meta = await this.getStreamMeta(path);
		if (!meta) return {
			events: [],
			nextOffset: formatOffset(-1),
			upToDate: true,
			closed: false
		};
		const rawOffset = opts?.offset ?? "-1";
		const limit = clampLimit(opts?.limit, 100, MAX_READ_LIMIT);
		let startAfter;
		if (rawOffset === "-1") startAfter = -1;
		else if (rawOffset === "now") return {
			events: [],
			nextOffset: meta.nextOffset,
			upToDate: true,
			closed: meta.closed
		};
		else startAfter = parseOffset(rawOffset);
		const rows = this.sql.exec(`SELECT seq, data FROM flue_event_stream_entries
					 WHERE path = ? AND seq > ?
					 ORDER BY seq ASC
					 LIMIT ?`, path, startAfter, limit + 1).toArray();
		const page = rows.slice(0, limit);
		const events = page.map((row) => ({
			data: JSON.parse(row.data),
			offset: formatOffset(row.seq)
		}));
		const lastRow = page.at(-1);
		const lastSeq = lastRow ? lastRow.seq : -1;
		const upToDate = rows.length <= limit;
		return {
			events,
			nextOffset: events.length > 0 ? formatOffset(lastSeq) : formatOffset(startAfter),
			upToDate,
			closed: meta.closed
		};
	}
	async closeStream(path) {
		this.sql.exec(`UPDATE flue_event_streams SET closed = 1 WHERE path = ?`, path);
		this.notifyListeners(path);
	}
	async getStreamMeta(path) {
		const [row] = this.sql.exec(`SELECT next_offset, closed FROM flue_event_streams WHERE path = ?`, path).toArray();
		if (!row) return null;
		const writeHead = row.next_offset;
		return {
			nextOffset: formatOffset(writeHead - 1),
			closed: row.closed === 1
		};
	}
	subscribe(path, listener) {
		let bucket = this.listeners.get(path);
		if (!bucket) {
			bucket = /* @__PURE__ */ new Set();
			this.listeners.set(path, bucket);
		}
		bucket.add(listener);
		const subscribedBucket = bucket;
		return () => {
			subscribedBucket.delete(listener);
			if (subscribedBucket.size === 0) this.listeners.delete(path);
		};
	}
	notifyListeners(path) {
		const bucket = this.listeners.get(path);
		if (bucket) for (const listener of [...bucket]) try {
			listener();
		} catch {}
	}
};
//#endregion
//#region src/product-event.ts
function assertProductEventV3(value) {
	const version = value && typeof value === "object" ? value.v : void 0;
	if (version !== 3) throw new ProductEventVersionError({ storedVersion: version });
}
//#endregion
//#region src/workflow-definition.ts
const WORKFLOW_DEFINITIONS_KEY = Symbol.for("@flue/runtime/workflow-definitions");
const runtimeGlobal = globalThis;
if (!runtimeGlobal[WORKFLOW_DEFINITIONS_KEY]) runtimeGlobal[WORKFLOW_DEFINITIONS_KEY] = /* @__PURE__ */ new WeakSet();
const workflowDefinitions = runtimeGlobal[WORKFLOW_DEFINITIONS_KEY];
function defineWorkflow(options) {
	if (!options || typeof options !== "object") throw new Error("[flue] defineWorkflow() requires a workflow definition object.");
	if (!isAgentDefinition(options.agent)) throw new Error("[flue] defineWorkflow({ agent }) requires an AgentDefinition.");
	const hasAction = Object.hasOwn(options, "action") && options.action !== void 0;
	if (hasAction === (Object.hasOwn(options, "run") && options.run !== void 0)) throw new Error("[flue] defineWorkflow() requires exactly one of action or run.");
	if (hasAction) {
		if (!isActionDefinition(options.action)) throw new Error("[flue] defineWorkflow({ action }) requires an Action.");
		if (Object.hasOwn(options, "input") || Object.hasOwn(options, "output")) throw new Error("[flue] defineWorkflow({ action }) does not accept input or output.");
		return makeWorkflowDefinition(options.agent, options.action);
	}
	const action = defineAction({
		name: "workflow",
		description: "Workflow-private action.",
		input: options.input,
		output: options.output,
		run: options.run
	});
	return makeWorkflowDefinition(options.agent, action);
}
function makeWorkflowDefinition(agent, action) {
	const workflow = Object.freeze({
		__flueWorkflowDefinition: true,
		agent,
		action
	});
	workflowDefinitions.add(workflow);
	return workflow;
}
function isWorkflowDefinition(value) {
	return Boolean(value && typeof value === "object" && workflowDefinitions.has(value));
}
//#endregion
//#region src/runtime/ids.ts
/**
* Workflow run ids are opaque: nothing may parse structure out of them. The
* owning workflow is resolved through the run registry (`runId` →
* `workflowName`).
*/
function generateWorkflowRunId() {
	return `run_${ulid()}`;
}
function generateSessionAffinityKey() {
	return `aff_${ulid()}`;
}
function generateConversationId() {
	return `conv_${ulid()}`;
}
function generateOperationId() {
	return `op_${ulid()}`;
}
function generateTurnId() {
	return `turn_${ulid()}`;
}
//#endregion
//#region src/runtime/handle-agent.ts
/** Shared per-agent HTTP dispatcher for the Node and Cloudflare targets. */
function assertWorkflowDefinition(value, name) {
	if (!isWorkflowDefinition(value)) throw new Error(`[flue] Workflow "${name}" must default-export defineWorkflow(...).`);
}
function assertAgentDispatchAdmissionInput(input) {
	if (!isDispatchInput(input)) throw new Error("[flue] Internal dispatch admission received an invalid payload.");
}
function isDispatchInput(value) {
	if (!value || typeof value !== "object") return false;
	const input = value;
	return typeof input.dispatchId === "string" && input.dispatchId.trim() !== "" && typeof input.agent === "string" && input.agent.trim() !== "" && typeof input.id === "string" && input.id.trim() !== "" && input.input !== void 0 && typeof input.acceptedAt === "string" && input.acceptedAt.trim() !== "";
}
function parseDirectAgentPayload(payload) {
	const parsed = v.safeParse(DirectAgentPayloadSchema, payload);
	if (parsed.success) return parsed.output;
	throw new InvalidRequestError({ reason: parsed.issues.find((issue) => issue.type === "max_length")?.message ?? "Direct agent requests must use JSON object body { \"message\": string, \"images\"?: image[] }." });
}
/**
* Derive the absolute DS stream URL advertised in invocation responses from
* the incoming request URL (query stripped). Agent prompts stream at the
* request URL itself; workflow runs stream at the sibling `/runs/:runId`
* route under the same mount prefix as the admitting `/workflows/:name`
* route.
*/
function invocationStreamUrl(request, runId) {
	const url = new URL(request.url);
	url.search = "";
	if (runId !== void 0) {
		const index = url.pathname.lastIndexOf("/workflows/");
		url.pathname = `${index > 0 ? url.pathname.slice(0, index) : ""}/runs/${encodeURIComponent(runId)}`;
	}
	return url.toString();
}
/**
* Build the 202 admission response shared by agent and workflow invocation.
* The stream coordinates are mirrored as `Location` and `Stream-Next-Offset`
* headers, matching the Durable Streams stream-creation convention.
*/
function admissionResponse(body, streamUrl, offset) {
	return new Response(JSON.stringify(body), {
		status: 202,
		headers: {
			"content-type": "application/json",
			Location: streamUrl,
			"Stream-Next-Offset": offset
		}
	});
}
/**
* Handle one attached `/agents/:name/:id` prompt interaction.
*
* Returns accepted stream coordinates by default, or a synchronous JSON
* result when `?wait=result` is requested. Events are available via the DS
* stream read endpoint (GET on the same URL).
*/
async function handleAgentRequest(opts) {
	const { request, id } = opts;
	try {
		const payload = parseDirectAgentPayload(await parseJsonBody(request));
		const traceCarrier = extractTraceCarrier(request.headers);
		const directOptions = {
			payload,
			admitAttachedSubmission: opts.admitAttachedSubmission,
			traceCarrier
		};
		const streamUrl = invocationStreamUrl(request);
		if (new URL(request.url).searchParams.get("wait") === "result") {
			const streamPath = agentStreamPath(opts.agentName, id);
			return runDirectSyncMode(directOptions, streamUrl, (await opts.conversationStreamStore.getMeta(streamPath))?.nextOffset ?? "-1");
		}
		const receipt = await opts.admitAttachedSubmission(payload, void 0, false, traceCarrier);
		const offset = receipt.offset ?? "-1";
		return admissionResponse({
			streamUrl,
			offset,
			submissionId: receipt.submissionId
		}, streamUrl, offset);
	} catch (err) {
		return toHttpResponse(err);
	}
}
async function handleWorkflowRequest(opts) {
	const { request, workflowName, workflow, createContext, runStore, eventStreamStore } = opts;
	const startWorkflowAdmission = opts.startWorkflowAdmission ?? defaultStartWorkflowAdmission;
	const runId = opts.runId ?? generateWorkflowRunId();
	try {
		const input = await parseJsonBody(request);
		parseActionInput(workflow.action, input);
		const wait = new URL(request.url).searchParams.get("wait");
		const execution = await prepareWorkflowExecution({
			workflowName,
			runId,
			workflow,
			input,
			request,
			createContext,
			startWorkflowAdmission,
			runStore,
			eventStreamStore,
			activityGate: opts.activityGate
		});
		if (wait === "result") return await runSyncMode(execution);
		return await runWorkflowAdmissionMode(execution);
	} catch (err) {
		return toHttpResponse(err);
	}
}
async function prepareWorkflowExecution(opts) {
	const { workflowName, runId, workflow, input, request, traceCarrier = extractTraceCarrier(request.headers), createContext, startWorkflowAdmission, runStore, eventStreamStore, activityGate } = opts;
	if (!runStore) throw new RunStoreUnavailableError();
	const activityLease = activityGate?.enter();
	let lifecycle;
	try {
		lifecycle = await createWorkflowRunLifecycle({
			workflowName,
			runId,
			input,
			request,
			traceCarrier,
			createContext,
			runStore,
			eventStreamStore,
			requirePersistedAdmission: true
		});
	} catch (error) {
		activityLease?.release();
		throw error;
	}
	return {
		runId,
		runStore,
		lifecycle,
		startWorkflowAdmission,
		workflow,
		activityLease
	};
}
function startWorkflowExecution(execution) {
	if (execution.scheduling) return execution.scheduling;
	const { runId, lifecycle, workflow, startWorkflowAdmission } = execution;
	const run = () => withWorkflowRunLifecycle(lifecycle, () => executeWorkflowDefinition(workflow, lifecycle.ctx, lifecycle.input));
	try {
		const scheduling = startWorkflowAdmission(runId, run);
		const completion = Promise.resolve(scheduling.completion).finally(() => {
			execution.activityLease?.release();
			execution.activityLease = void 0;
		});
		completion.catch(() => void 0);
		execution.scheduling = {
			admitted: Promise.resolve(scheduling.admitted).catch(async (error) => {
				await emitRunEnd(lifecycle, {
					isError: true,
					error
				});
				throw error;
			}),
			completion
		};
	} catch (error) {
		execution.activityLease?.release();
		execution.activityLease = void 0;
		const completion = Promise.reject(error);
		completion.catch(() => void 0);
		execution.scheduling = {
			admitted: emitRunEnd(lifecycle, {
				isError: true,
				error
			}).then(() => {
				throw error;
			}),
			completion
		};
	}
	return execution.scheduling;
}
async function detachWorkflowExecution(execution) {
	const scheduling = startWorkflowExecution(execution);
	scheduling.completion.catch((error) => {
		console.error("[flue] Workflow run failed:", execution.runId, error);
	});
	await scheduling.admitted;
}
async function admitDetachedWorkflow(opts) {
	const runId = opts.runId ?? generateWorkflowRunId();
	await detachWorkflowExecution(await prepareWorkflowExecution({
		workflowName: opts.workflowName,
		runId,
		workflow: opts.workflow,
		input: opts.input,
		request: opts.request,
		createContext: opts.createContext,
		startWorkflowAdmission: opts.startWorkflowAdmission ?? defaultStartWorkflowAdmission,
		runStore: opts.runStore,
		eventStreamStore: opts.eventStreamStore,
		activityGate: opts.activityGate
	}));
	return { runId };
}
async function runWorkflowAdmissionMode(execution) {
	await detachWorkflowExecution(execution);
	return new Response(JSON.stringify({ runId: execution.runId }), {
		status: 202,
		headers: { "content-type": "application/json" }
	});
}
async function failRecoveredRun(opts) {
	const events = await readRecoveryEvents(opts);
	const terminalEvent = findTerminalRunEvent(events);
	const run = await opts.runStore?.getRun(opts.runId);
	if (terminalEvent || run && run.status !== "active") {
		await reconcileTerminalRun(opts, run, terminalEvent);
		return;
	}
	const initialEventIndex = events.reduce((nextIndex, event) => Number.isSafeInteger(event.eventIndex) && event.eventIndex >= nextIndex ? event.eventIndex + 1 : nextIndex, 0);
	const startedAt = run?.startedAt ?? (/* @__PURE__ */ new Date()).toISOString();
	const startedAtMs = Date.parse(startedAt);
	const startEvent = events.find((event) => event.type === "run_start");
	const input = run?.input !== void 0 ? run.input : startEvent?.input;
	if (!run) await safeRunStore("createRun(recovery)", () => opts.runStore?.createRun({
		runId: opts.runId,
		workflowName: opts.workflowName,
		startedAt,
		input
	}));
	await opts.eventStreamStore.createStream(runStreamPath(opts.runId));
	const lifecycle = {
		...opts,
		traceCarrier: run?.traceCarrier,
		input,
		ctx: opts.createContext({
			runId: opts.runId,
			request: opts.request,
			initialEventIndex
		}),
		startedAt,
		startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now()
	};
	await interceptExecution({
		type: "workflow",
		runId: opts.runId,
		workflowName: opts.workflowName,
		phase: "resume",
		startedAt: lifecycle.startedAt
	}, {
		eventContext: lifecycle.ctx,
		runId: opts.runId,
		traceCarrier: run?.traceCarrier
	}, async () => {
		const flushFanout = subscribeRunFanout(lifecycle);
		emitRunResume(lifecycle);
		await flushFanout();
		await emitRunEnd(lifecycle, {
			isError: true,
			error: opts.error
		});
	});
}
async function readRecoveryEvents(opts) {
	const streamPath = runStreamPath(opts.runId);
	const events = [];
	let offset = "-1";
	while (true) {
		const result = await opts.eventStreamStore.readEvents(streamPath, { offset });
		for (const event of result.events) {
			assertProductEventV3(event.data);
			events.push(event.data);
		}
		if (result.upToDate || result.events.length === 0) break;
		offset = result.nextOffset;
	}
	return events;
}
async function reconcileTerminalRun(opts, run, terminalEvent) {
	const isError = terminalEvent?.isError ?? run?.isError ?? false;
	const result = terminalEvent?.result !== void 0 ? terminalEvent.result : run?.result;
	const error = terminalEvent?.error !== void 0 ? terminalEvent.error : run?.error;
	const endedAt = terminalEvent?.timestamp ?? run?.endedAt ?? (/* @__PURE__ */ new Date()).toISOString();
	const durationMs = terminalEvent?.durationMs ?? run?.durationMs ?? 0;
	if (terminalEvent && !run) await safeRunStore("createRun(recovery)", () => opts.runStore?.createRun({
		runId: opts.runId,
		workflowName: opts.workflowName,
		startedAt: endedAt,
		input: void 0
	}));
	if (terminalEvent && (!run || run.status === "active")) await opts.runStore?.endRun({
		runId: opts.runId,
		endedAt,
		isError,
		durationMs,
		result,
		error
	});
	await opts.eventStreamStore.closeStream(runStreamPath(opts.runId));
}
function findTerminalRunEvent(events) {
	return [...events].reverse().find((event) => event.type === "run_end");
}
async function runDirectSyncMode(opts, streamUrl, offset) {
	const receipt = await invokeDirectAttached(opts);
	return new Response(JSON.stringify({
		result: receipt.result === void 0 ? null : receipt.result,
		streamUrl,
		offset,
		submissionId: receipt.submissionId
	}), { headers: { "content-type": "application/json" } });
}
async function invokeDirectAttached(opts) {
	return opts.admitAttachedSubmission(opts.payload, opts.onEvent, true, opts.traceCarrier);
}
async function runSyncMode(execution) {
	const scheduling = startWorkflowExecution(execution);
	await scheduling.admitted;
	const result = await scheduling.completion;
	return new Response(JSON.stringify({
		result: result === void 0 ? null : result,
		runId: execution.runId
	}), { headers: { "content-type": "application/json" } });
}
async function invokeWorkflowAttached(opts) {
	parseActionInput(opts.workflow.action, opts.input);
	const lifecycle = await createWorkflowRunLifecycle({
		workflowName: opts.workflowName,
		runId: opts.runId,
		input: opts.input,
		request: opts.request,
		traceCarrier: extractTraceCarrier(opts.request.headers),
		createContext: opts.createContext,
		runStore: opts.runStore,
		eventStreamStore: opts.eventStreamStore
	});
	const { ctx } = lifecycle;
	if (opts.onEvent) ctx.setEventCallback(opts.onEvent);
	try {
		const result = await withWorkflowRunLifecycle(lifecycle, () => executeWorkflowDefinition(opts.workflow, ctx, opts.input));
		return {
			runId: opts.runId,
			result
		};
	} finally {
		ctx.setEventCallback(void 0);
	}
}
async function executeWorkflowDefinition(workflow, ctx, input) {
	const parsedInput = parseActionInput(workflow.action, input);
	const harness = await ctx.initializeRootHarness(workflow.agent);
	try {
		return await runActionWithParsedInput(workflow.action, {
			harness,
			log: ctx.log
		}, parsedInput);
	} finally {
		await harness.close();
	}
}
async function createWorkflowRunLifecycle(options) {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const ctx = options.createContext({
		runId: options.runId,
		request: options.request
	});
	const runStore = options.runStore;
	const workflowName = options.workflowName;
	try {
		if (runStore) await persistRunAdmission("createRun", options.requirePersistedAdmission === true, () => runStore.createRun({
			runId: options.runId,
			workflowName,
			startedAt,
			input: options.input,
			traceCarrier: options.traceCarrier
		}));
	} catch (error) {
		console.error("[flue] Workflow admission error:", {
			workflowName,
			runId: options.runId,
			operation: "createRun",
			outcome: "admission_failed"
		}, error);
		throw error;
	}
	try {
		await options.eventStreamStore.createStream(runStreamPath(options.runId));
	} catch (error) {
		if (runStore) {
			const endedAtMs = Date.now();
			await runStore.endRun({
				runId: options.runId,
				endedAt: new Date(endedAtMs).toISOString(),
				isError: true,
				durationMs: endedAtMs - startedAtMs,
				error: serializeError(error)
			});
		}
		throw error;
	}
	return {
		...options,
		ctx,
		startedAt,
		startedAtMs
	};
}
/**
* Wrap all workflow invocation modes with the same run-start/run-end envelope.
*/
async function withWorkflowRunLifecycle(lifecycle, body) {
	return interceptExecution({
		type: "workflow",
		runId: lifecycle.runId,
		workflowName: lifecycle.workflowName,
		phase: "start",
		startedAt: lifecycle.startedAt
	}, {
		eventContext: lifecycle.ctx,
		runId: lifecycle.runId,
		traceCarrier: lifecycle.traceCarrier
	}, async () => {
		const flushFanout = subscribeRunFanout(lifecycle);
		emitRunStart(lifecycle);
		let didFlushFanout = false;
		let result;
		try {
			result = await body();
			await flushFanout();
			didFlushFanout = true;
		} catch (error) {
			if (!didFlushFanout) try {
				await flushFanout();
			} catch {}
			await emitRunEnd(lifecycle, {
				isError: true,
				error
			});
			throw error;
		}
		await emitRunEnd(lifecycle, {
			result,
			isError: false
		});
		return result;
	});
}
function emitRunStart(lifecycle) {
	lifecycle.ctx.emitEvent({
		type: "run_start",
		runId: lifecycle.runId,
		workflowName: lifecycle.workflowName,
		startedAt: lifecycle.startedAt,
		input: lifecycle.input
	});
}
function emitRunResume(lifecycle) {
	lifecycle.ctx.emitEvent({
		type: "run_resume",
		runId: lifecycle.runId,
		workflowName: lifecycle.workflowName,
		startedAt: lifecycle.startedAt
	});
}
/**
* Emit `run_end` and finalize the run.
*
* Terminal ordering: append `run_end` to the event stream store and close it,
* then persist the terminal record to the run store.
*/
async function emitRunEnd(lifecycle, input) {
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();
	const durationMs = endedAtMs - lifecycle.startedAtMs;
	const result = input.isError ? void 0 : input.result;
	const error = input.isError ? serializeError(input.error) : void 0;
	const normalizedResult = result === void 0 ? null : result;
	const { runStore, eventStreamStore, runId } = lifecycle;
	const decorated = lifecycle.ctx.emitEvent({
		type: "run_end",
		runId,
		result: normalizedResult,
		isError: input.isError,
		error,
		durationMs
	});
	try {
		await eventStreamStore.appendEvent(runStreamPath(runId), decorated);
	} catch (e) {
		console.error("[flue:event-stream] appendEvent(run_end) failed:", e);
	}
	try {
		await eventStreamStore.closeStream(runStreamPath(runId));
	} catch (e) {
		console.error("[flue:event-stream] closeStream failed:", e);
	}
	if (runStore) await safeRunStore("endRun", () => runStore.endRun({
		runId,
		endedAt,
		isError: input.isError,
		durationMs,
		result: input.isError ? result : normalizedResult,
		error
	}));
}
const BUFFERED_EVENT_FLUSH_INTERVAL_MS = 3e3;
/**
* Persist non-terminal events to the event stream store.
* `run_end` is handled separately by {@link emitRunEnd}.
*
* Other events are appended immediately. Per-chunk streaming events (see
* {@link isBufferedRunEvent}) are buffered and flushed at most once per
* {@link BUFFERED_EVENT_FLUSH_INTERVAL_MS} to avoid
* issuing one durable storage write per streamed chunk.
*
* Because `emitEvent` dispatches to subscribers synchronously (fire-and-forget),
* async `appendEvent` calls produce floating promises. We collect them in a
* buffer and drain at the returned flush function, which is awaited by
* {@link withWorkflowRunLifecycle} after the workflow body completes.
*/
function subscribeRunFanout(lifecycle) {
	const { ctx, eventStreamStore, runId } = lifecycle;
	const streamPath = runStreamPath(runId);
	const pending = [];
	let bufferedEvents = [];
	let bufferTimer;
	function flushBufferedEvents() {
		if (bufferedEvents.length === 0) return;
		const batch = bufferedEvents;
		bufferedEvents = [];
		for (const event of batch) pending.push(eventStreamStore.appendEvent(streamPath, event).then(() => {}, (error) => {
			console.error("[flue:event-stream] appendEvent failed:", error);
		}));
	}
	function scheduleBufferFlush() {
		if (bufferTimer !== void 0) return;
		bufferTimer = setTimeout(() => {
			bufferTimer = void 0;
			flushBufferedEvents();
		}, BUFFERED_EVENT_FLUSH_INTERVAL_MS);
	}
	const unsubscribe = ctx.subscribeEvent((event) => {
		if (event.type === "run_end") return;
		if (isStreamExcludedEvent(event)) return;
		if (isBufferedRunEvent(event)) {
			bufferedEvents.push(event);
			scheduleBufferFlush();
			return;
		}
		flushBufferedEvents();
		pending.push(eventStreamStore.appendEvent(streamPath, event).then(() => {}, (error) => {
			console.error("[flue:event-stream] appendEvent failed:", error);
		}));
	});
	return async () => {
		unsubscribe();
		if (bufferTimer !== void 0) {
			clearTimeout(bufferTimer);
			bufferTimer = void 0;
		}
		flushBufferedEvents();
		await Promise.all(pending);
	};
}
async function persistRunAdmission(label, required, fn) {
	try {
		await fn();
		return true;
	} catch (error) {
		console.error(`[flue:run-store] ${label} failed:`, error);
		if (required) throw error;
		return false;
	}
}
async function safeRunStore(label, fn) {
	return persistRunAdmission(label, false, fn);
}
function serializeError(error) {
	if (error instanceof Error) return {
		name: error.name,
		message: error.message
	};
	return error;
}
const defaultStartWorkflowAdmission = (_runId, run) => ({
	admitted: Promise.resolve(),
	completion: Promise.resolve().then(run)
});
//#endregion
//#region src/message-rendering.ts
function createUserContextMessage(text, timestamp, images = []) {
	return {
		role: "user",
		content: [{
			type: "text",
			text
		}, ...images],
		timestamp: new Date(timestamp).getTime()
	};
}
/**
* Normalize a tool-result content array to the UI `output` value: a lone text
* block unwraps to its string; anything else passes through as the array.
* Shared by the snapshot and incremental conversation projections so the two
* cannot drift.
*/
function toolResultOutput(content) {
	if (content.length === 1 && content[0]?.type === "text") return content[0].text;
	return content;
}
/** Join the text blocks of a tool-result content array (used for error text). */
function toolResultText(content) {
	return content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}
function renderSignalMessage(message) {
	const tagName = message.tagName ?? "signal";
	return `<${tagName}${[["type", message.type], ...Object.entries(message.attributes ?? {})].map(([name, value]) => ` ${escapeXmlAttribute(name ?? "")}="${escapeXmlAttribute(value ?? "")}"`).join("")}>\n${escapeXmlText(message.content)}\n</${tagName}>`;
}
function escapeXmlText(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function escapeXmlAttribute(value) {
	return escapeXmlText(value).replaceAll("\"", "&quot;");
}
//#endregion
//#region src/conversation-reducer.ts
function createReducedInstanceState() {
	return {
		recordsThroughOffset: "-1",
		conversations: /* @__PURE__ */ new Map(),
		conversationScopes: /* @__PURE__ */ new Map(),
		recordsById: /* @__PURE__ */ new Map()
	};
}
function reduceConversationRecords(state, records, offset = state.recordsThroughOffset) {
	const next = cloneReducedInstanceState(state);
	for (const record of records) applyConversationRecord(next, record);
	next.recordsThroughOffset = offset;
	return next;
}
function cloneReducedInstanceState(state) {
	return {
		recordsThroughOffset: state.recordsThroughOffset,
		conversationScopes: new Map(state.conversationScopes),
		recordsById: new Map(state.recordsById),
		conversations: new Map([...state.conversations].map(([id, conversation]) => [id, {
			...conversation,
			entries: new Map([...conversation.entries].map(([entryId, entry]) => [entryId, entry.type === "message" ? {
				...entry,
				attachmentRefs: entry.attachmentRefs ? new Map(entry.attachmentRefs) : void 0
			} : { ...entry }])),
			inProgressMessages: new Map([...conversation.inProgressMessages].map(([messageId, message]) => [messageId, {
				...message,
				blocks: new Map([...message.blocks].map(([blockId, block]) => [blockId, block.type === "text" || block.type === "reasoning" ? {
					...block,
					deltas: [...block.deltas]
				} : { ...block }])),
				blockIndexes: new Set(message.blockIndexes)
			}])),
			toolOutcomes: new Map([...conversation.toolOutcomes].map(([toolCallId, outcome]) => [toolCallId, {
				...outcome,
				content: outcome.content.map((block) => ({ ...block }))
			}])),
			childConversations: new Map(conversation.childConversations)
		}]))
	};
}
function applyConversationRecord(state, record) {
	const accepted = state.recordsById.get(record.id);
	if (accepted) {
		if (JSON.stringify(accepted) === JSON.stringify(record)) return;
		fail(record, `Record id "${record.id}" was reused with different content.`);
	}
	if (record.v !== 1) fail(record, `Record version "${String(record.v)}" is unsupported.`);
	if (record.type === "conversation_created") {
		validateConversationCreation(state, record);
		if (state.conversations.has(record.conversationId)) fail(record, `Conversation "${record.conversationId}" is already initialized.`);
		const scopeKey = conversationScopeKey(record.harness, record.session);
		const scopeOwner = state.conversationScopes.get(scopeKey);
		if (scopeOwner) fail(record, `Conversation scope is already owned by "${scopeOwner}".`);
		if (record.parentConversationId && !state.conversations.has(record.parentConversationId)) fail(record, `Parent conversation "${record.parentConversationId}" does not exist.`);
		state.conversations.set(record.conversationId, {
			...record,
			entries: /* @__PURE__ */ new Map(),
			activeLeafId: null,
			inProgressMessages: /* @__PURE__ */ new Map(),
			toolOutcomes: /* @__PURE__ */ new Map(),
			childConversations: /* @__PURE__ */ new Map()
		});
		state.conversationScopes.set(scopeKey, record.conversationId);
		state.recordsById.set(record.id, record);
		return;
	}
	const conversation = state.conversations.get(record.conversationId);
	if (!conversation) fail(record, `Conversation "${record.conversationId}" is not initialized.`);
	if (conversation.harness !== record.harness || conversation.session !== record.session) fail(record, `Conversation scope conflicts with its creation record.`);
	switch (record.type) {
		case "user_message":
			appendEntry(conversation, record, {
				type: "message",
				id: record.messageId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				message: userMessage(record.content, record.timestamp),
				attachmentRefs: attachmentRefs(record.content)
			});
			break;
		case "signal":
			appendEntry(conversation, record, {
				type: "message",
				id: record.messageId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				message: {
					role: "signal",
					type: record.signalType,
					tagName: record.tagName,
					content: record.content,
					attributes: record.attributes,
					timestamp: new Date(record.timestamp).getTime()
				}
			});
			break;
		case "assistant_message_started":
			assertParent(conversation, record, record.parentId);
			if (record.parentId !== conversation.activeLeafId) fail(record, `Assistant parent "${String(record.parentId)}" is not the conversation tail. Appends are linear.`);
			if (conversation.entries.has(record.messageId) || conversation.inProgressMessages.has(record.messageId)) fail(record, `Assistant entry "${record.messageId}" already exists.`);
			conversation.inProgressMessages.set(record.messageId, {
				messageId: record.messageId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				modelInfo: record.modelInfo,
				blocks: /* @__PURE__ */ new Map(),
				blockIndexes: /* @__PURE__ */ new Set()
			});
			break;
		case "assistant_text_started":
			startBlock(getInProgress(conversation, record, record.messageId), record, {
				type: "text",
				blockId: record.blockId,
				blockIndex: record.blockIndex,
				deltas: [],
				completed: false
			});
			break;
		case "assistant_reasoning_started":
			startBlock(getInProgress(conversation, record, record.messageId), record, {
				type: "reasoning",
				blockId: record.blockId,
				blockIndex: record.blockIndex,
				deltas: [],
				completed: false
			});
			break;
		case "assistant_text_delta":
			appendDelta(conversation, record, "text");
			break;
		case "assistant_reasoning_delta":
			appendDelta(conversation, record, "reasoning");
			break;
		case "assistant_text_completed": {
			const block = completeBlock(conversation, record, "text");
			block.textSignature = record.textSignature;
			break;
		}
		case "assistant_reasoning_completed": {
			const block = completeBlock(conversation, record, "reasoning");
			block.encrypted = record.encrypted;
			block.redacted = record.redacted;
			break;
		}
		case "assistant_tool_call":
			startBlock(getInProgress(conversation, record, record.messageId), record, {
				type: "tool_call",
				blockId: record.blockId,
				blockIndex: record.blockIndex,
				toolCallId: record.toolCallId,
				name: record.name,
				arguments: record.arguments,
				thoughtSignature: record.thoughtSignature
			});
			break;
		case "assistant_message_completed": {
			const inProgress = getInProgress(conversation, record, record.messageId);
			for (const block of inProgress.blocks.values()) if ((block.type === "text" || block.type === "reasoning") && !block.completed) fail(record, `Assistant block "${block.blockId}" is not complete.`);
			const content = [...inProgress.blocks.values()].sort((a, b) => a.blockIndex - b.blockIndex).map(materializeAssistantBlock);
			const message = {
				...inProgress.modelInfo,
				role: "assistant",
				content,
				stopReason: record.stopReason,
				usage: record.usage,
				errorMessage: record.error,
				timestamp: new Date(inProgress.timestamp).getTime()
			};
			assertAssistantCompletionAppend(conversation, record, inProgress);
			conversation.inProgressMessages.delete(record.messageId);
			commitEntry(conversation, {
				type: "message",
				id: record.messageId,
				parentId: inProgress.parentId,
				timestamp: inProgress.timestamp,
				submissionId: inProgress.submissionId,
				message
			});
			break;
		}
		case "tool_outcome": {
			const assistant = conversation.entries.get(record.assistantMessageId);
			if (assistant?.type !== "message" || assistant.message.role !== "assistant") fail(record, `Tool outcome assistant "${record.assistantMessageId}" does not exist.`);
			const call = assistant.message.content.find((block) => block.type === "toolCall" && block.id === record.toolCallId);
			if (!call || call.name !== record.toolName) fail(record, `Tool outcome does not match its assistant tool request.`);
			const outcomeKey = toolOutcomeKey(record.assistantMessageId, record.toolCallId);
			if (conversation.toolOutcomes.has(outcomeKey)) fail(record, `Tool outcome for "${record.toolCallId}" already exists.`);
			conversation.toolOutcomes.set(outcomeKey, {
				recordId: record.id,
				assistantMessageId: record.assistantMessageId,
				toolCallId: record.toolCallId,
				toolName: record.toolName,
				isError: record.isError,
				content: record.content.map((block) => ({ ...block }))
			});
			break;
		}
		case "tool_results_committed": {
			const assistant = conversation.entries.get(record.assistantMessageId);
			if (assistant?.type !== "message" || assistant.message.role !== "assistant" || assistant.message.stopReason !== "toolUse") fail(record, `Committed tool results require a completed tool-use assistant.`);
			if (record.parentId !== record.assistantMessageId || record.parentId !== conversation.activeLeafId) fail(record, `Committed tool results must extend their active assistant parent.`);
			const calls = assistant.message.content.filter((block) => block.type === "toolCall");
			if (record.outcomeIds.length !== calls.length || new Set(record.outcomeIds).size !== calls.length) fail(record, `Committed tool results must reference every assistant tool call exactly once.`);
			const outcomes = record.outcomeIds.map((outcomeId, index) => {
				const outcomeRecord = state.recordsById.get(outcomeId);
				const call = calls[index];
				if (outcomeRecord?.type !== "tool_outcome" || !call || outcomeRecord.conversationId !== record.conversationId || outcomeRecord.harness !== record.harness || outcomeRecord.session !== record.session || outcomeRecord.assistantMessageId !== record.assistantMessageId || outcomeRecord.toolCallId !== call.id || outcomeRecord.toolName !== call.name || conversation.toolOutcomes.get(toolOutcomeKey(record.assistantMessageId, call.id))?.recordId !== outcomeId) fail(record, `Committed tool outcome references do not match assistant tool-call order.`);
				return outcomeRecord;
			});
			let parentId = record.parentId;
			for (const outcome of outcomes) {
				const entryId = toolResultEntryId(record.assistantMessageId, outcome.toolCallId);
				assertEntryAppend(conversation, record, entryId, parentId);
				commitEntry(conversation, {
					type: "message",
					id: entryId,
					parentId,
					timestamp: outcome.timestamp,
					submissionId: record.submissionId,
					message: toolResultMessage(outcome),
					attachmentRefs: attachmentRefs(outcome.content),
					...outcome.output !== void 0 ? { toolOutput: { value: outcome.output } } : {}
				});
				parentId = entryId;
			}
			break;
		}
		case "compaction":
			if (!conversation.entries.has(record.firstKeptEntryId)) fail(record, `Compaction first-kept entry "${record.firstKeptEntryId}" does not exist.`);
			if (!conversation.entries.has(record.sourceLeafId)) fail(record, `Compaction source leaf "${record.sourceLeafId}" does not exist.`);
			if (record.sourceLeafId !== record.parentId || record.sourceLeafId !== conversation.activeLeafId) fail(record, `Compaction source leaf must be its active parent.`);
			if (!pathToLeaf(conversation, record.sourceLeafId).some((entry) => entry.id === record.firstKeptEntryId)) fail(record, `Compaction first-kept entry is not on the source path.`);
			appendEntry(conversation, record, {
				type: "compaction",
				id: record.entryId,
				parentId: record.parentId,
				timestamp: record.timestamp,
				submissionId: record.submissionId,
				summary: record.summary,
				firstKeptEntryId: record.firstKeptEntryId,
				sourceLeafId: record.sourceLeafId,
				tokensBefore: record.tokensBefore,
				details: record.details,
				usage: record.usage
			});
			break;
		case "child_session_retained": {
			validateChildReference(record);
			const child = state.conversations.get(record.child.conversationId);
			if (!child) fail(record, `Retained child conversation does not exist.`);
			const identityMatches = record.child.type === "task" ? child.kind === "task" && child.taskId === record.child.taskId : child.kind === "action" && child.actionInvocationId === record.child.invocationId;
			if (child.parentConversationId !== conversation.conversationId || child.harness !== record.child.harness || child.session !== record.child.session || !identityMatches) fail(record, `Retained child identity conflicts with its creation record.`);
			for (const parent of state.conversations.values()) if (parent !== conversation && parent.childConversations.has(record.child.conversationId)) fail(record, `Child conversation is already retained by another parent.`);
			const existing = conversation.childConversations.get(record.child.conversationId);
			if (existing && JSON.stringify(existing) !== JSON.stringify(record.child)) fail(record, `Child conversation topology conflicts with an existing retained child.`);
			conversation.childConversations.set(record.child.conversationId, record.child);
			break;
		}
		case "submission_settled": break;
	}
	state.recordsById.set(record.id, record);
}
function validateConversationCreation(state, record) {
	const value = record;
	if (value.kind === "root") {
		if (value.parentConversationId !== void 0 || value.taskId !== void 0 || value.actionInvocationId !== void 0 || value.agent !== void 0) fail(record, `Root conversation creation contains child identity fields.`);
		return;
	}
	if (value.kind === "task") {
		if (typeof value.parentConversationId !== "string" || typeof value.taskId !== "string" || value.actionInvocationId !== void 0 || !isUuid(value.taskId) || value.agent !== void 0 && typeof value.agent !== "string") fail(record, `Task conversation creation has invalid discriminated identity.`);
		const parent = state.conversations.get(value.parentConversationId);
		if (!parent) return;
		if (record.harness !== parent.harness || record.session !== createTaskSessionName(parent.session, value.taskId)) fail(record, `Task conversation scope does not match its derived parent identity.`);
		return;
	}
	if (value.kind !== "action" || typeof value.parentConversationId !== "string" || typeof value.actionInvocationId !== "string" || value.taskId !== void 0 || value.agent !== void 0 || !isUuid(value.actionInvocationId)) fail(record, `Action conversation creation has invalid discriminated identity.`);
	const parent = state.conversations.get(value.parentConversationId);
	if (!parent) return;
	if (record.harness !== `${parent.harness}:${createActionScopeName(value.actionInvocationId)}` || !isPublicSessionName(record.session)) fail(record, `Action conversation scope does not match its derived parent identity.`);
}
function validateChildReference(record) {
	const child = record.child;
	if (child.type === "task") {
		if (typeof child.taskId !== "string" || child.invocationId !== void 0 || !isUuid(child.taskId) || child.parentToolCallId !== void 0 && typeof child.parentToolCallId !== "string" || child.parentAssistantEntryId !== void 0 && typeof child.parentAssistantEntryId !== "string") fail(record, `Task child reference has invalid discriminated identity.`);
		return;
	}
	if (child.type !== "action" || typeof child.invocationId !== "string" || child.taskId !== void 0 || child.parentToolCallId !== void 0 || child.parentAssistantEntryId !== void 0 || !isUuid(child.invocationId)) fail(record, `Action child reference has invalid discriminated identity.`);
}
function getActiveConversationPath(conversation) {
	const path = [];
	const visited = /* @__PURE__ */ new Set();
	let current = conversation.activeLeafId ? conversation.entries.get(conversation.activeLeafId) : void 0;
	while (current) {
		if (visited.has(current.id)) throw new ConversationRecordInvariantError({
			recordId: current.id,
			recordType: current.type,
			reason: `Conversation graph contains a cycle at "${current.id}".`
		});
		visited.add(current.id);
		path.push(current);
		current = current.parentId ? conversation.entries.get(current.parentId) : void 0;
	}
	return path.reverse();
}
function buildConversationContextEntries(conversation, options = {}) {
	const path = getActiveConversationPath(conversation);
	const latestCompactionIndex = path.findLastIndex((entry) => entry.type === "compaction");
	if (latestCompactionIndex === -1) return pathToContextEntries(path, options);
	const compaction = path[latestCompactionIndex];
	const firstKeptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	const keptStart = firstKeptIndex >= 0 ? firstKeptIndex : latestCompactionIndex + 1;
	return [
		{
			message: createUserContextMessage(renderSignalMessage({
				role: "signal",
				type: "context_summary",
				tagName: "compaction",
				content: compaction.summary,
				timestamp: new Date(compaction.timestamp).getTime()
			}), compaction.timestamp),
			sourceEntry: compaction
		},
		...pathToContextEntries(path.slice(keptStart, latestCompactionIndex), options),
		...pathToContextEntries(path.slice(latestCompactionIndex + 1), options)
	];
}
function buildConversationContext(conversation, options = {}) {
	return buildConversationContextEntries(conversation, options).map((entry) => entry.message);
}
function pathToContextEntries(path, options) {
	const messages = [];
	let index = 0;
	while (index < path.length) {
		const entry = path[index];
		if (!entry || entry.type !== "message") {
			index += 1;
			continue;
		}
		const message = resolveMessageAttachments(entry, options);
		if (message.role === "signal") {
			messages.push({
				message: createUserContextMessage(renderSignalMessage(message), entry.timestamp),
				sourceEntry: entry
			});
			index += 1;
			continue;
		}
		if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				const next = path[index + 1];
				const afterNext = path[index + 2];
				if (!(message.stopReason === "aborted" && next?.type === "message" && next.message.role === "signal" && next.message.type === "stream_interrupted" && afterNext?.type === "message" && afterNext.message.role === "signal" && afterNext.message.type === "stream_continued")) {
					index += 1;
					continue;
				}
			}
			const toolCalls = message.content.filter((block) => block.type === "toolCall");
			if (toolCalls.length > 0) {
				const results = [];
				let resultIndex = index + 1;
				while (resultIndex < path.length) {
					const result = path[resultIndex];
					if (result?.type !== "message" || result.message.role !== "toolResult") break;
					results.push(resolveMessageAttachments(result, options));
					resultIndex += 1;
				}
				if (isCompleteToolBatch(toolCalls, results)) {
					messages.push({
						message,
						sourceEntry: entry
					});
					for (let resultOffset = 0; resultOffset < results.length; resultOffset++) {
						const resultEntry = path[index + 1 + resultOffset];
						const result = results[resultOffset];
						if (resultEntry && result) messages.push({
							message: result,
							sourceEntry: resultEntry
						});
					}
				}
				index = resultIndex;
				continue;
			}
			messages.push({
				message,
				sourceEntry: entry
			});
			index += 1;
			continue;
		}
		if (message.role !== "toolResult") messages.push({
			message,
			sourceEntry: entry
		});
		index += 1;
	}
	return messages;
}
function appendEntry(conversation, record, entry) {
	assertEntryAppend(conversation, record, entry.id, entry.parentId);
	commitEntry(conversation, entry);
}
function assertEntryAppend(conversation, record, entryId, parentId) {
	if (!entryId.startsWith("entry_")) fail(record, `Graph entry ids must use the "entry_" prefix.`);
	if (conversation.entries.has(entryId) || conversation.inProgressMessages.has(entryId)) fail(record, `Graph entry "${entryId}" already exists.`);
	assertParent(conversation, record, parentId);
	if (parentId !== conversation.activeLeafId) fail(record, `Entry parent "${String(parentId)}" is not the conversation tail "${String(conversation.activeLeafId)}". Appends are linear.`);
	if (conversation.inProgressMessages.size > 0) fail(record, `Cannot advance the conversation while an assistant message is in progress.`);
}
function commitEntry(conversation, entry) {
	conversation.entries.set(entry.id, entry);
	conversation.activeLeafId = entry.id;
}
function assertAssistantCompletionAppend(conversation, record, message) {
	if (!message.messageId.startsWith("entry_")) fail(record, `Graph entry ids must use the "entry_" prefix.`);
	if (conversation.entries.has(message.messageId)) fail(record, `Graph entry "${message.messageId}" already exists.`);
	assertParent(conversation, record, message.parentId);
	if (message.parentId !== conversation.activeLeafId) fail(record, `Assistant parent is no longer the conversation tail.`);
}
function assertParent(conversation, record, parentId) {
	if (parentId !== null && !conversation.entries.has(parentId)) fail(record, `Parent entry "${parentId}" does not exist in this conversation.`);
}
function pathToLeaf(conversation, leafId) {
	const path = [];
	let current = conversation.entries.get(leafId);
	while (current) {
		path.push(current);
		current = current.parentId ? conversation.entries.get(current.parentId) : void 0;
	}
	return path.reverse();
}
function getInProgress(conversation, record, messageId) {
	const message = conversation.inProgressMessages.get(messageId);
	if (!message) fail(record, `Assistant message "${messageId}" is not in progress.`);
	return message;
}
function startBlock(message, record, block) {
	if (!Number.isInteger(block.blockIndex) || block.blockIndex < 0) fail(record, `Block index must be a non-negative integer.`);
	if (message.blocks.has(block.blockId)) fail(record, `Block "${block.blockId}" already exists.`);
	if (message.blockIndexes.has(block.blockIndex)) fail(record, `Block index "${block.blockIndex}" already exists in this message.`);
	message.blocks.set(block.blockId, block);
	message.blockIndexes.add(block.blockIndex);
}
function appendDelta(conversation, record, type) {
	const block = getInProgress(conversation, record, record.messageId).blocks.get(record.blockId);
	if (!block || block.type !== type) fail(record, `Block "${record.blockId}" is not ${type}.`);
	if (block.completed) fail(record, `Block "${record.blockId}" is already complete.`);
	if (record.sequence !== block.deltas.length) fail(record, `Expected delta sequence ${block.deltas.length}, received ${record.sequence}.`);
	block.deltas.push(record.delta);
}
function completeBlock(conversation, record, type) {
	const block = getInProgress(conversation, record, record.messageId).blocks.get(record.blockId);
	if (!block || block.type !== type) fail(record, `Block "${record.blockId}" is not ${type}.`);
	if (block.completed) fail(record, `Block "${record.blockId}" is already complete.`);
	if (record.deltaCount !== block.deltas.length) fail(record, `Completion expected ${record.deltaCount} deltas but replay has ${block.deltas.length}.`);
	block.completed = true;
	return block;
}
function materializeAssistantBlock(block) {
	if (block.type === "text") return {
		type: "text",
		text: block.deltas.join(""),
		textSignature: block.textSignature
	};
	if (block.type === "reasoning") return {
		type: "thinking",
		thinking: block.deltas.join(""),
		thinkingSignature: block.encrypted,
		redacted: block.redacted
	};
	return {
		type: "toolCall",
		id: block.toolCallId,
		name: block.name,
		arguments: block.arguments,
		thoughtSignature: block.thoughtSignature
	};
}
function attachmentRefs(content) {
	const refs = content.flatMap((block) => block.type === "attachment" ? [block.attachment] : []);
	return refs.length > 0 ? new Map(refs.map((ref) => [ref.id, ref])) : void 0;
}
function userMessage(content, timestamp) {
	return {
		role: "user",
		content: content.map((block) => block.type === "text" ? block : {
			type: "image",
			data: block.attachment.id,
			mimeType: block.attachment.mimeType
		}),
		timestamp: new Date(timestamp).getTime()
	};
}
function toolResultMessage(record) {
	return {
		role: "toolResult",
		toolCallId: record.toolCallId,
		toolName: record.toolName,
		isError: record.isError,
		content: record.content.map((block) => block.type === "text" ? block : {
			type: "image",
			data: block.attachment.id,
			mimeType: block.attachment.mimeType
		}),
		timestamp: new Date(record.timestamp).getTime()
	};
}
function resolveMessageAttachments(entry, options) {
	const message = entry.message;
	if (message.role !== "user" && message.role !== "toolResult" || !Array.isArray(message.content)) return message;
	const attachments = [...entry.attachmentRefs?.values() ?? []];
	let manifestProjected = false;
	const content = message.content.map((block) => {
		if (block.type === "text" && !manifestProjected && attachments.length > 0) {
			manifestProjected = true;
			return {
				...block,
				text: attachmentManifest(block.text, attachments)
			};
		}
		if (block.type !== "image") return block;
		const ref = entry.attachmentRefs?.get(block.data);
		if (!ref) return block;
		if (!options.resolveAttachment) throw new AttachmentNotAvailableError({ attachmentId: ref.id });
		return {
			type: "image",
			...options.resolveAttachment(ref)
		};
	});
	if (!manifestProjected && attachments.length > 0) content.unshift({
		type: "text",
		text: attachmentManifest("", attachments)
	});
	return {
		...message,
		content
	};
}
function attachmentManifest(text, attachments) {
	if (attachments.length === 0) return text;
	const projection = `\n\n<attachments>\n${attachments.map((attachment) => `<image id="${attachment.id}" mimeType="${attachment.mimeType}" />`).join("\n")}\n</attachments>`;
	return text.endsWith(projection) ? text : `${text}${projection}`;
}
function isCompleteToolBatch(toolCalls, results) {
	if (toolCalls.length !== results.length) return false;
	const seen = /* @__PURE__ */ new Set();
	for (let index = 0; index < toolCalls.length; index++) {
		const call = toolCalls[index];
		const result = results[index];
		if (!call || !result || seen.has(call.id)) return false;
		seen.add(call.id);
		if (result.toolCallId !== call.id || result.toolName !== call.name) return false;
	}
	return true;
}
function toolOutcomeKey(assistantMessageId, toolCallId) {
	return JSON.stringify([assistantMessageId, toolCallId]);
}
function toolResultEntryId(assistantMessageId, toolCallId) {
	return `entry_tool_result_${encodeCanonicalId(assistantMessageId)}_${encodeCanonicalId(toolCallId)}`;
}
function encodeCanonicalId(id) {
	const bytes = new TextEncoder().encode(id);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function conversationScopeKey(harness, session) {
	return JSON.stringify([harness, session]);
}
function fail(record, reason) {
	throw new ConversationRecordInvariantError({
		recordId: record.id,
		recordType: record.type,
		reason
	});
}
//#endregion
//#region src/usage.ts
/** All-zero `PromptUsage`. Identity element for `addUsage`. */
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
/**
* Field-wise sum of two `PromptUsage` values, including the nested `cost`
* sub-object. Returns a fresh object; neither argument is mutated.
*/
function addUsage(a, b) {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total
		}
	};
}
/**
* Convert pi-ai's `Usage` into Flue's public `PromptUsage`. The shapes are
* structurally identical today, but going through this normalizer keeps
* Flue's public types decoupled from pi-ai's so future divergence in
* pi-ai (e.g. additional fields) doesn't leak into the runtime package's public
* surface. Returns `undefined` when the input is `undefined`.
*/
function fromProviderUsage(usage) {
	if (!usage) return void 0;
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total
		}
	};
}
//#endregion
//#region src/compaction.ts
/**
* Defaults applied when no user config and no model metadata are available.
* Real sessions construct settings via {@link deriveCompactionDefaults} so
* headroom tracks the active model instead of a fixed Sonnet-sized window.
*/
const DEFAULT_COMPACTION_SETTINGS = {
	enabled: true,
	reserveTokens: 2e4,
	keepRecentTokens: 8e3
};
/**
* Compute model-aware defaults. Reserve is capped at the model's max output
* because reserving more than the model can emit in one turn wastes context;
* the preserved tail stays flat because recent-context fidelity depends on
* the active work, not on the model's total window size.
*
* Caller may override either field after calling this.
*/
function deriveCompactionDefaults(input) {
	const reserveCap = input.maxTokens > 0 ? input.maxTokens : DEFAULT_COMPACTION_SETTINGS.reserveTokens;
	let reserveTokens = Math.min(DEFAULT_COMPACTION_SETTINGS.reserveTokens, reserveCap);
	if (input.contextWindow > 0 && reserveTokens * 2 >= input.contextWindow) reserveTokens = Math.max(1024, Math.floor(input.contextWindow / 3));
	return {
		enabled: true,
		reserveTokens,
		keepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens
	};
}
function calculateContextTokens(usage) {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
function getAssistantUsage(msg) {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) return assistantMsg.usage;
	}
}
function getLastAssistantUsageInfo(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		const usage = getAssistantUsage(msg);
		if (usage) return {
			usage,
			index: i
		};
	}
}
/** chars/4 heuristic. Conservative (overestimates). */
function estimateTokens(message) {
	let chars = 0;
	switch (message.role) {
		case "user": {
			const { content } = message;
			if (typeof content === "string") chars = content.length;
			else if (Array.isArray(content)) {
				for (const block of content) if (block.type === "text") chars += block.text.length;
			}
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const { content } = message;
			for (const block of content) if (block.type === "text") chars += block.text.length;
			else if (block.type === "thinking") chars += block.thinking.length;
			else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
			return Math.ceil(chars / 4);
		}
		case "toolResult": {
			const { content } = message;
			for (const block of content) if (block.type === "text") chars += block.text.length;
			else if (block.type === "image") chars += 4800;
			return Math.ceil(chars / 4);
		}
	}
	return 0;
}
function estimateContextTokens(messages) {
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) estimated += estimateTokens(message);
		return estimated;
	}
	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		const message = messages[i];
		if (message) trailingTokens += estimateTokens(message);
	}
	return usageTokens + trailingTokens;
}
function shouldCompact(contextTokens, contextWindow, settings) {
	if (!settings.enabled) return false;
	if (contextWindow <= 0) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}
function createFileOps() {
	return {
		read: /* @__PURE__ */ new Set(),
		written: /* @__PURE__ */ new Set(),
		edited: /* @__PURE__ */ new Set()
	};
}
function extractFileOpsFromMessage(message, fileOps) {
	if (message.role !== "assistant") return;
	const assistant = message;
	if (!Array.isArray(assistant.content)) return;
	for (const block of assistant.content) {
		if (block.type !== "toolCall") continue;
		const args = block.arguments;
		if (!args) continue;
		const path = typeof args.path === "string" ? args.path : void 0;
		if (!path) continue;
		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}
function computeFileLists(fileOps) {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	return {
		readFiles: [...fileOps.read].filter((f) => !modified.has(f)).sort(),
		modifiedFiles: [...modified].sort()
	};
}
function formatFileOperations(readFiles, modifiedFiles) {
	const sections = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}
const TOOL_RESULT_MAX_CHARS = 2e3;
function truncateForSummary(text, maxChars) {
	if (text.length <= maxChars) return text;
	const truncatedChars = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[... ${truncatedChars} more characters truncated]`;
}
/** Serialize messages to text so the summarization model doesn't treat it as a conversation to continue. */
function serializeConversation(messages) {
	const parts = [];
	for (const msg of messages) if (msg.role === "user") {
		const { content } = msg;
		const text = typeof content === "string" ? content : content.filter((c) => c.type === "text").map((c) => c.text).join("");
		if (text) parts.push(`[User]: ${text}`);
	} else if (msg.role === "assistant") {
		const { content } = msg;
		const textParts = [];
		const thinkingParts = [];
		const toolCalls = [];
		for (const block of content) if (block.type === "text") textParts.push(block.text);
		else if (block.type === "thinking") thinkingParts.push(block.thinking);
		else if (block.type === "toolCall") {
			const argsStr = Object.entries(block.arguments).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
			toolCalls.push(`${block.name}(${argsStr})`);
		}
		if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
		if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
		if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
	} else if (msg.role === "toolResult") {
		const { content } = msg;
		const text = content.filter((c) => c.type === "text").map((c) => c.text).join("");
		if (text) parts.push(`[Tool result]: ${truncateForSummary(text, TOOL_RESULT_MAX_CHARS)}`);
	}
	return parts.join("\n\n");
}
const SUMMARIZATION_SYSTEM_PROMPT = "You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";
const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;
const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;
/** Valid cut points: user or assistant messages. Never cut at toolResult. */
function findValidCutPoints(messages, start, end) {
	const cutPoints = [];
	for (let i = start; i < end; i++) {
		const role = messages[i]?.role;
		if (role === "user" || role === "assistant") cutPoints.push(i);
	}
	return cutPoints;
}
function findTurnStartIndex(messages, index, start) {
	for (let i = index; i >= start; i--) if (messages[i]?.role === "user") return i;
	return -1;
}
function findCutPoint(messages, start, end, keepRecentTokens) {
	const cutPoints = findValidCutPoints(messages, start, end);
	if (cutPoints.length === 0) return {
		firstKeptIndex: start,
		turnStartIndex: -1,
		isSplitTurn: false
	};
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0] ?? start;
	for (let i = end - 1; i >= start; i--) {
		const message = messages[i];
		if (!message) continue;
		const messageTokens = estimateTokens(message);
		accumulatedTokens += messageTokens;
		if (accumulatedTokens >= keepRecentTokens) {
			for (const cutPoint of cutPoints) if (cutPoint >= i) {
				cutIndex = cutPoint;
				break;
			}
			break;
		}
	}
	const isUserMessage = messages[cutIndex]?.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(messages, cutIndex, start);
	return {
		firstKeptIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1
	};
}
/** Pure function — no I/O. Finds cut point, extracts messages to summarize, tracks file ops. */
function prepareCompaction(messages, settings, previousCompaction) {
	if (messages.length === 0) return void 0;
	const boundaryStart = previousCompaction ? previousCompaction.firstKeptIndex : 0;
	const boundaryEnd = messages.length;
	const tokensBefore = estimateContextTokens(messages);
	const cutPoint = findCutPoint(messages, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	if (cutPoint.firstKeptIndex <= boundaryStart) return void 0;
	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptIndex;
	const messagesToSummarize = messages.slice(boundaryStart, historyEnd);
	const turnPrefixMessages = cutPoint.isSplitTurn ? messages.slice(cutPoint.turnStartIndex, cutPoint.firstKeptIndex) : [];
	const fileOps = createFileOps();
	if (previousCompaction?.details) {
		for (const f of previousCompaction.details.readFiles ?? []) fileOps.read.add(f);
		for (const f of previousCompaction.details.modifiedFiles ?? []) fileOps.edited.add(f);
	}
	for (const msg of messagesToSummarize) extractFileOpsFromMessage(msg, fileOps);
	for (const msg of turnPrefixMessages) extractFileOpsFromMessage(msg, fileOps);
	return {
		firstKeptIndex: cutPoint.firstKeptIndex,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary: previousCompaction?.summary,
		fileOps,
		settings
	};
}
async function generateSummary(currentMessages, model, reserveTokens, apiKey, signal, previousSummary, observer) {
	const maxTokens = Math.min(Math.floor(.8 * reserveTokens), 16e3);
	const basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	let promptText = `<conversation>\n${serializeConversation(currentMessages)}\n</conversation>\n\n`;
	if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	promptText += basePrompt;
	const summarizationMessages = [{
		role: "user",
		content: [{
			type: "text",
			text: promptText
		}],
		timestamp: Date.now()
	}];
	const completionOptions = {
		maxTokens,
		signal
	};
	if (apiKey) completionOptions.apiKey = apiKey;
	if (model.reasoning) completionOptions.reasoning = "high";
	const context = {
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: summarizationMessages
	};
	const handle = observer?.start("compaction", model, context, completionOptions);
	const observed = observer && handle ? {
		observer,
		handle
	} : void 0;
	let response;
	try {
		response = observed ? await observed.observer.run(observed.handle, () => completeSimple(model, context, completionOptions)) : await completeSimple(model, context, completionOptions);
		observed?.observer.end("compaction", observed.handle, model, response, void 0);
	} catch (error) {
		observed?.observer.end("compaction", observed.handle, model, void 0, error);
		throw error;
	}
	if (response.stopReason === "error") throw new Error(`Summarization failed: ${response.errorMessage || "Unknown error"}`);
	return {
		text: response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
		usage: response.usage
	};
}
async function generateTurnPrefixSummary(messages, model, reserveTokens, apiKey, signal, observer) {
	const maxTokens = Math.min(Math.floor(.5 * reserveTokens), 16e3);
	const summarizationMessages = [{
		role: "user",
		content: [{
			type: "text",
			text: `<conversation>\n${serializeConversation(messages)}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`
		}],
		timestamp: Date.now()
	}];
	const completionOptions = {
		maxTokens,
		signal
	};
	if (apiKey) completionOptions.apiKey = apiKey;
	if (model.reasoning) completionOptions.reasoning = "high";
	const context = {
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: summarizationMessages
	};
	const handle = observer?.start("compaction_prefix", model, context, completionOptions);
	const observed = observer && handle ? {
		observer,
		handle
	} : void 0;
	let response;
	try {
		response = observed ? await observed.observer.run(observed.handle, () => completeSimple(model, context, completionOptions)) : await completeSimple(model, context, completionOptions);
		observed?.observer.end("compaction_prefix", observed.handle, model, response, void 0);
	} catch (error) {
		observed?.observer.end("compaction_prefix", observed.handle, model, void 0, error);
		throw error;
	}
	if (response.stopReason === "error") throw new Error(`Turn prefix summarization failed: ${response.errorMessage || "Unknown error"}`);
	return {
		text: response.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"),
		usage: response.usage
	};
}
async function compact(preparation, model, apiKey, signal, observer) {
	const { messagesToSummarize, turnPrefixMessages, isSplitTurn, tokensBefore, previousSummary, fileOps, settings } = preparation;
	let summary;
	let aggregateUsage;
	const addCallUsage = (usage) => {
		const normalized = fromProviderUsage(usage);
		if (!normalized) return;
		aggregateUsage = aggregateUsage ? addUsage(aggregateUsage, normalized) : normalized;
	};
	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const [historyResult, turnPrefixResult] = await Promise.all([messagesToSummarize.length > 0 ? generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, signal, previousSummary, observer) : Promise.resolve({
			text: "No prior history.",
			usage: void 0
		}), generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, signal, observer)]);
		addCallUsage(historyResult.usage);
		addCallUsage(turnPrefixResult.usage);
		summary = `${historyResult.text}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.text}`;
	} else {
		const historyResult = await generateSummary(messagesToSummarize, model, settings.reserveTokens, apiKey, signal, previousSummary, observer);
		addCallUsage(historyResult.usage);
		summary = historyResult.text;
	}
	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary += formatFileOperations(readFiles, modifiedFiles);
	return {
		summary,
		tokensBefore,
		details: {
			readFiles,
			modifiedFiles
		},
		usage: aggregateUsage
	};
}
//#endregion
//#region src/submission-state.ts
/**
* Classify how far a persisted submission input progressed.
*
* @param following - `history.getActivePathSince(inputEntry.id)` for the
*   persisted input entry, or `undefined` when the input entry is absent
*   from history.
* @param opts.contextWindow - The active model's context window, used for
*   silent-overflow detection; pass 0 when no model is resolved (only
*   explicit overflow error messages are detected then).
*/
function classifySubmissionState(following, opts) {
	if (following === void 0) return { kind: "absent" };
	if (following.some((entry) => entry.type === "message" && entry.message.role === "user")) return { kind: "advanced_past_input" };
	const assistantEntry = following.findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
	const assistant = assistantEntry?.type === "message" ? assistantEntry.message : void 0;
	if (!assistant) return {
		kind: "resume",
		mode: "input_only",
		consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following)
	};
	const overflow = isContextOverflow(assistant, opts.contextWindow);
	if (isCompletedAssistantResponse(assistant)) return {
		kind: "completed",
		assistant,
		overflow
	};
	if (overflow) return {
		kind: "resume",
		mode: "overflow",
		assistant,
		consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following)
	};
	if (isRetryableModelError(assistant)) return {
		kind: "resume",
		mode: "transient_retry",
		assistant,
		consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following)
	};
	if (assistant.stopReason === "aborted" && following.some((entry) => entry.type === "message" && entry.message.role === "signal" && entry.message.type === "stream_continued")) return {
		kind: "resume",
		mode: "stream_continuation",
		assistant,
		consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following)
	};
	if (assistant.stopReason === "toolUse") {
		if (following.some((entry) => entry.type === "message" && entry.message.role === "toolResult")) return {
			kind: "resume",
			mode: findTrailingPartialToolBatch(following) ? "tool_results_partial" : "tool_results",
			assistant,
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following)
		};
		return {
			kind: "tool_use_unresolved",
			assistant
		};
	}
	if (assistant.stopReason === "aborted") {
		if (findTrailingPartialToolBatch(following)) return {
			kind: "resume",
			mode: "tool_results_partial",
			assistant,
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following)
		};
		return {
			kind: "resume",
			mode: "aborted_partial",
			assistant,
			consecutiveRetryableErrors: countConsecutiveRetryableModelErrors(following)
		};
	}
	return {
		kind: "terminal_error",
		reason: assistant.errorMessage ?? assistant.stopReason
	};
}
/**
* Locate the trailing toolUse turn whose persisted tool-result batch is
* incomplete — the persistence shape left behind when an abort breaks the
* tool loop mid-batch. The toolUse assistant is either the last assistant in
* `following`, or the second-to-last when the final entry is the aborted
* partial of the next turn the abort also cut short.
*
* Conservative by construction: returns undefined when the batch is
* complete (every call id has a recorded result), when a recovered stream
* continuation exists (resumption continues from the recovered partial and
* must not rewind history), or when any unexpected entry interrupts the
* trailing `assistant → toolResults → [aborted assistant]` shape.
*
* Both the classifier and the session-side repair derive the batch through
* this single function so they can never disagree about which turn is
* incomplete.
*/
function findTrailingPartialToolBatch(following) {
	if (following.some((entry) => entry.type === "message" && entry.message.role === "signal" && entry.message.type === "stream_continued")) return;
	let end = following.length;
	const lastEntry = following[end - 1];
	if (lastEntry?.type === "message" && lastEntry.message.role === "assistant" && lastEntry.message.stopReason === "aborted") end -= 1;
	let index = end - 1;
	const resultIds = /* @__PURE__ */ new Set();
	while (index >= 0) {
		const entry = following[index];
		if (entry?.type !== "message" || entry.message.role !== "toolResult") break;
		resultIds.add(entry.message.toolCallId);
		index -= 1;
	}
	const assistantEntry = following[index];
	if (index < 0 || assistantEntry?.type !== "message" || assistantEntry.message.role !== "assistant") return;
	const assistant = assistantEntry.message;
	if (assistant.stopReason !== "toolUse") return void 0;
	const toolCalls = assistant.content.flatMap((content) => content.type === "toolCall" ? [{
		type: "toolCall",
		id: content.id,
		name: content.name
	}] : []);
	if (toolCalls.length === 0) return void 0;
	if (toolCalls.every((toolCall) => resultIds.has(toolCall.id))) return void 0;
	return {
		entryId: assistantEntry.id,
		assistant,
		toolCalls
	};
}
function isRetryableModelError(message) {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	return /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|network.?error|connection.?(?:reset|refused|lost)|socket hang up|fetch failed|timed? out|timeout|terminated/i.test(message.errorMessage);
}
function isCompletedAssistantResponse(message) {
	return message.stopReason === "stop" || message.stopReason === "length";
}
function countConsecutiveRetryableModelErrors(entries) {
	let count = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "message") continue;
		if (entry.message.role === "user") return count;
		if (entry.message.role !== "assistant") continue;
		if (!isRetryableModelError(entry.message)) return count;
		count += 1;
	}
	return count;
}
//#endregion
//#region src/conversation-projections.ts
function fileFromAttachment(attachment) {
	return {
		type: "file",
		mediaType: attachment.mimeType,
		id: attachment.id,
		size: attachment.size,
		...attachment.filename ? { filename: attachment.filename } : {}
	};
}
function classifyConversationSubmission(conversation, inputEntryId, options) {
	const path = getActiveConversationPath(conversation);
	const inputIndex = path.findIndex((entry) => entry.id === inputEntryId);
	if (inputIndex === -1) return classifySubmissionState(void 0, options);
	const inProgress = [...conversation.inProgressMessages.values()].find((message) => message.parentId === conversation.activeLeafId && message.blocks.size > 0);
	if (inProgress) return {
		kind: "interrupted_partial",
		messageId: inProgress.messageId,
		assistant: materializeInterruptedAssistant(inProgress)
	};
	return classifySubmissionState(path.slice(inputIndex + 1), options);
}
function projectConversationUi(conversation, streamOffset) {
	const messages = [];
	const byId = /* @__PURE__ */ new Map();
	for (const entry of getActiveConversationPath(conversation)) {
		if (entry.type !== "message") continue;
		const projected = projectCompletedMessage(entry);
		if (projected) {
			messages.push(projected);
			byId.set(projected.id, projected);
			continue;
		}
		if (entry.message.role !== "toolResult") continue;
		const toolResult = entry.message;
		for (let index = messages.length - 1; index >= 0; index--) {
			const candidate = messages[index];
			const partIndex = candidate?.parts.findIndex((value) => value.type === "dynamic-tool" && value.toolCallId === toolResult.toolCallId) ?? -1;
			if (!candidate || partIndex < 0) continue;
			const part = candidate.parts[partIndex];
			candidate.parts[partIndex] = toolResult.isError ? {
				type: "dynamic-tool",
				toolName: part.toolName,
				toolCallId: part.toolCallId,
				state: "output-error",
				input: part.input,
				errorText: toolResultText(toolResult.content)
			} : {
				type: "dynamic-tool",
				toolName: part.toolName,
				toolCallId: part.toolCallId,
				state: "output-available",
				input: part.input,
				output: entry.toolOutput ? entry.toolOutput.value : toolResultOutput(toolResult.content)
			};
			break;
		}
	}
	for (const inProgress of conversation.inProgressMessages.values()) {
		const projected = projectInProgressMessage(inProgress);
		if (projected && !byId.has(projected.id)) messages.push(projected);
	}
	return {
		conversationId: conversation.conversationId,
		streamOffset,
		messages
	};
}
function getActiveConversationPathSince(conversation, boundaryId) {
	const path = getActiveConversationPath(conversation);
	if (boundaryId === null) return path;
	const boundaryIndex = path.findIndex((entry) => entry.id === boundaryId);
	return boundaryIndex === -1 ? void 0 : path.slice(boundaryIndex + 1);
}
function getLatestCompletedAssistantEntry(entries) {
	return entries.findLast((entry) => entry.type === "message" && entry.message.role === "assistant" && (entry.message.stopReason === "stop" || entry.message.stopReason === "length"));
}
function getAssistantText(assistant) {
	return assistant.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}
function aggregateConversationUsageSince(conversation, boundaryId) {
	const entries = getActiveConversationPathSince(conversation, boundaryId);
	if (!entries) return void 0;
	let usage = emptyUsage();
	for (const entry of entries) if (entry.type === "message" && entry.message.role === "assistant") {
		const assistantUsage = fromProviderUsage(entry.message.usage);
		if (assistantUsage) usage = addUsage(usage, assistantUsage);
	} else if (entry.type === "compaction" && entry.usage) usage = addUsage(usage, entry.usage);
	return usage;
}
function getLatestConversationCompaction(conversation) {
	return getActiveConversationPath(conversation).findLast((entry) => entry.type === "compaction");
}
function projectConversationModelContext(conversation, options) {
	return buildConversationContext(conversation, options);
}
function projectConversationModelContextEntries(conversation, options) {
	return buildConversationContextEntries(conversation, options);
}
function projectCompletedMessage(entry) {
	const message = entry.message;
	if (message.role === "user") {
		const parts = [];
		if (typeof message.content === "string") parts.push({
			type: "text",
			text: message.content,
			state: "done"
		});
		else for (const block of message.content) if (block.type === "text") parts.push({
			type: "text",
			text: block.text,
			state: "done"
		});
		else {
			const attachment = entry.attachmentRefs?.get(block.data);
			if (attachment) parts.push(fileFromAttachment(attachment));
		}
		return {
			id: entry.id,
			role: "user",
			...entry.submissionId ? { submissionId: entry.submissionId } : {},
			parts,
			metadata: { timestamp: entry.timestamp }
		};
	}
	if (message.role === "signal") return {
		id: entry.id,
		role: "user",
		parts: [{
			type: "text",
			text: message.content,
			state: "done"
		}],
		metadata: { timestamp: entry.timestamp }
	};
	if (message.role !== "assistant") return void 0;
	return {
		id: entry.id,
		role: "assistant",
		parts: message.content.map((block) => {
			if (block.type === "text") return {
				type: "text",
				text: block.text,
				state: "done"
			};
			if (block.type === "thinking") return {
				type: "reasoning",
				text: block.thinking,
				state: "done"
			};
			return {
				type: "dynamic-tool",
				toolCallId: block.id,
				toolName: block.name,
				input: block.arguments,
				state: "input-available"
			};
		}),
		metadata: {
			timestamp: entry.timestamp,
			usage: message.usage,
			model: {
				provider: message.provider,
				id: message.model
			}
		}
	};
}
function materializeInterruptedAssistant(message) {
	const content = [...message.blocks.values()].sort((a, b) => a.blockIndex - b.blockIndex).flatMap((block) => {
		if (block.type === "text") return [{
			type: "text",
			text: block.deltas.join(""),
			textSignature: block.textSignature
		}];
		if (block.type === "reasoning") return [{
			type: "thinking",
			thinking: block.deltas.join(""),
			thinkingSignature: block.encrypted,
			redacted: block.redacted
		}];
		return [];
	});
	return {
		...message.modelInfo,
		role: "assistant",
		content,
		stopReason: "aborted",
		errorMessage: "Stream interrupted before completion.",
		usage: {
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
		},
		timestamp: new Date(message.timestamp).getTime()
	};
}
function projectInProgressMessage(message) {
	const parts = [...message.blocks.values()].sort((a, b) => a.blockIndex - b.blockIndex).map((block) => {
		if (block.type === "text") return {
			type: "text",
			text: block.deltas.join(""),
			state: block.completed ? "done" : "streaming"
		};
		if (block.type === "reasoning") return {
			type: "reasoning",
			text: block.deltas.join(""),
			state: block.completed ? "done" : "streaming"
		};
		return {
			type: "dynamic-tool",
			toolCallId: block.toolCallId,
			toolName: block.name,
			input: block.arguments,
			state: "input-available"
		};
	});
	return {
		id: message.messageId,
		role: "assistant",
		parts,
		metadata: { timestamp: message.timestamp }
	};
}
//#endregion
export { registerExecutionInterceptor as $, admitDetachedWorkflow as A, generateSessionAffinityKey as B, getActiveConversationPath as C, renderSignalMessage as D, toolResultEntryId as E, handleWorkflowRequest as F, DEFAULT_READ_LIMIT as G, generateWorkflowRunId as H, invokeDirectAttached as I, agentStreamPath as J, MAX_READ_LIMIT as K, invokeWorkflowAttached as L, assertWorkflowDefinition as M, failRecoveredRun as N, toolResultOutput as O, handleAgentRequest as P, interceptExecution as Q, generateConversationId as R, createReducedInstanceState as S, toolOutcomeKey as T, defineWorkflow as U, generateTurnId as V, assertProductEventV3 as W, parseOffset as X, formatOffset as Y, runStreamPath as Z, isContextOverflow as _, getLatestCompletedAssistantEntry as a, resolveAgentProfile as at, emptyUsage as b, projectConversationModelContextEntries as c, runActionWithParsedInput as ct, findTrailingPartialToolBatch as d, assertResolvedAgentProfile as et, isRetryableModelError as f, deriveCompactionDefaults as g, compact as h, getAssistantText as i, extendAgentProfile as it, assertAgentDispatchAdmissionInput as j, toolResultText as k, projectConversationUi as l, calculateContextTokens as m, classifyConversationSubmission as n, defineAgent as nt, getLatestConversationCompaction as o, defineAction as ot, DEFAULT_COMPACTION_SETTINGS as p, SqliteEventStreamStore as q, getActiveConversationPathSince as r, defineAgentProfile as rt, projectConversationModelContext as s, parseActionInput as st, aggregateConversationUsageSince as t, createAgent as tt, countConsecutiveRetryableModelErrors as u, prepareCompaction as v, reduceConversationRecords as w, fromProviderUsage as x, shouldCompact as y, generateOperationId as z };
