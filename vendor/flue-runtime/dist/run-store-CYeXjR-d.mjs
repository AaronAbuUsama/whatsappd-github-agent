import { v as PersistedSchemaVersionError } from "./errors-DUgRtE8e.mjs";
import * as v from "valibot";
//#region src/runtime/schemas.ts
const MAX_IMAGE_DATA_LENGTH = 14 * 1024 * 1024;
const DirectAgentImageSchema = v.object({
	type: v.literal("image"),
	data: v.pipe(v.string(), v.maxLength(MAX_IMAGE_DATA_LENGTH, `Image data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`)),
	mimeType: v.string(),
	filename: v.optional(v.string())
});
const DirectAgentPayloadSchema = v.object({
	message: v.string(),
	images: v.optional(v.array(DirectAgentImageSchema))
});
const WorkflowRouteParamSchema = v.object({ name: v.string() });
/** Shared `?wait` query contract for agent and workflow invocation routes. */
const InvocationQuerySchema = v.object({ wait: v.optional(v.literal("result")) });
const AgentRouteParamSchema = v.object({
	name: v.string(),
	id: v.string()
});
//#endregion
//#region src/session-identity.ts
const TASK_SESSION_PREFIX = "task:";
const ACTION_SCOPE_PREFIX = "action:";
const SESSION_STORAGE_PREFIX = "agent-session:";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(value) {
	return UUID_PATTERN.test(value);
}
function isTaskSessionName(name) {
	return name.startsWith(TASK_SESSION_PREFIX);
}
function isActionScopeName(name) {
	return name.startsWith(ACTION_SCOPE_PREFIX);
}
function isPublicSessionName(name) {
	return !isTaskSessionName(name) && !isActionScopeName(name);
}
function assertPublicSessionName(name) {
	if (isTaskSessionName(name)) throw new Error("[flue] Session names beginning with \"task:\" are reserved for delegated tasks.");
	if (isActionScopeName(name)) throw new Error("[flue] Session names beginning with \"action:\" are reserved for Actions.");
}
function createTaskSessionName(parentSession, taskId) {
	return `${TASK_SESSION_PREFIX}${parentSession}:${taskId}`;
}
function createSessionStorageKey(instanceId, harness, session) {
	return `${SESSION_STORAGE_PREFIX}${JSON.stringify([
		instanceId,
		harness,
		session
	])}`;
}
function createActionScopeName(invocationId) {
	return `${ACTION_SCOPE_PREFIX}${invocationId}`;
}
function parseSessionStorageKey(storageKey) {
	if (!storageKey.startsWith(SESSION_STORAGE_PREFIX)) return void 0;
	let value;
	try {
		value = JSON.parse(storageKey.slice(14));
	} catch {
		return;
	}
	if (!Array.isArray(value) || value.length !== 3 || value.some((part) => typeof part !== "string")) return;
	return {
		instanceId: value[0],
		harness: value[1],
		session: value[2]
	};
}
//#endregion
//#region src/adapter-helpers.ts
/**
* Shared helpers for persistence adapter implementations.
*
* These pure functions are consumed by the built-in SQLite adapter, the
* Postgres adapter (`@flue/postgres`), and any future community adapters
* via `@flue/runtime/adapter`.
*
* All functions operate on plain values — no database driver types.
*/
/**
* Agent-mode submissions (HTTP and dispatch) always target the
* default harness. Named harnesses exist for multi-harness workflows
* (for example, named internal scopes), but external submissions do
* not select a harness — they implicitly use `'default'`.
*
* Exported for adapter implementations that construct session storage keys.
*/
const SUBMISSION_HARNESS_NAME = "default";
/**
* Agent-mode submissions always target the default session of the
* default harness; external submissions cannot select a session.
*
* Exported for adapter implementations that construct session storage keys.
*/
const SUBMISSION_SESSION_NAME = "default";
/**
* Validate that a parsed JSON payload matches the expected submission shape.
*
* Used after `JSON.parse(payload)` to verify the deserialized object is a
* well-formed `AgentSubmissionInput` that is consistent with the stored
* submission metadata.
*/
function isSubmissionPayload(input, ctx) {
	if (!input || typeof input !== "object") return false;
	const value = input;
	if (value.kind !== ctx.kind || value.submissionId !== ctx.submissionId) return false;
	if (value.kind === "dispatch") return typeof value.dispatchId === "string" && value.dispatchId === value.submissionId && typeof value.agent === "string" && typeof value.id === "string" && createSessionStorageKey(value.id, "default", "default") === ctx.sessionKey && typeof value.acceptedAt === "string" && Date.parse(value.acceptedAt) === ctx.acceptedAt && "input" in value && value.input !== void 0;
	return typeof value.agent === "string" && typeof value.id === "string" && createSessionStorageKey(value.id, "default", "default") === ctx.sessionKey && typeof value.acceptedAt === "string" && Date.parse(value.acceptedAt) === ctx.acceptedAt && v.safeParse(DirectAgentPayloadSchema, value.payload).success;
}
/**
* Parse an ISO timestamp string into epoch milliseconds.
* Throws with a `[flue]` error if the value is not a finite number.
*/
function parseAcceptedAt(value, label) {
	const acceptedAt = Date.parse(value);
	if (!Number.isFinite(acceptedAt)) throw new Error(`[flue] Internal ${label} received an invalid acceptedAt timestamp.`);
	return acceptedAt;
}
/**
* Clamp a caller-supplied page/chunk limit to a safe range.
*
* Invalid, non-finite, and non-positive values fall back to `defaultLimit`;
* valid values are capped at `maxLimit`. Used by run listings
* (`DEFAULT_LIST_LIMIT`/`MAX_LIST_LIMIT`) and event stream reads
* (`DEFAULT_READ_LIMIT`/`MAX_READ_LIMIT`).
*/
function clampLimit(limit, defaultLimit, maxLimit) {
	if (!limit || !Number.isFinite(limit) || limit <= 0) return defaultLimit;
	return Math.min(limit, maxLimit);
}
//#endregion
//#region src/schema-version.ts
/**
* Persisted-store schema versioning.
*
* Every persisted Flue store durably records the schema/format version it was
* created with, and refuses to open a store recorded with an unknown or newer
* version. This is a storage-agnostic obligation of the
* {@link PersistenceAdapter} contract: the built-in SQL backends implement it
* with a one-row `flue_meta` key/value table; non-SQL adapters implement the
* same obligation natively (a key, a meta document, etc.).
*/
/**
* Current schema/format version of Flue's built-in persisted stores.
*
* Bump this when a persisted format changes incompatibly. Pre-1.0 stores with
* another version are rejected and must be cleared.
*/
const FLUE_SCHEMA_VERSION = 4;
/**
* Throw {@link PersistedSchemaVersionError} unless the stored version matches
* the current {@link FLUE_SCHEMA_VERSION}.
*
* Adapters call this with the version value they recorded at store creation.
* A version greater than the current one means the store was written by a
* newer Flue version and must not be read; any other mismatch means the
* version marker is unrecognized.
*/
function assertSupportedFlueSchemaVersion(storedVersion) {
	if (storedVersion === String(4)) return;
	throw new PersistedSchemaVersionError({
		storedVersion,
		supportedVersion: 4
	});
}
function migrateFlueSqlSchema(sql, ensureCurrentSchema) {
	sql.exec(`CREATE TABLE IF NOT EXISTS flue_meta (
		 key TEXT PRIMARY KEY,
		 value TEXT NOT NULL
		)`);
	const stored = sql.exec(`SELECT value FROM flue_meta WHERE key = 'schema_version'`).toArray()[0]?.value;
	if (stored !== void 0 && stored !== null) assertSupportedFlueSchemaVersion(String(stored));
	else if (sql.exec(`SELECT name FROM sqlite_master
				 WHERE type = 'table' AND name LIKE 'flue_%' AND name <> 'flue_meta'
				 LIMIT 1`).toArray()[0]) throw new PersistedSchemaVersionError({
		storedVersion: "unversioned",
		supportedVersion: 4
	});
	ensureCurrentSchema();
	sql.exec(`INSERT INTO flue_meta (key, value) VALUES ('schema_version', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`, String(4));
	const persisted = sql.exec(`SELECT value FROM flue_meta WHERE key = 'schema_version'`).toArray()[0]?.value;
	assertSupportedFlueSchemaVersion(String(persisted));
}
//#endregion
//#region src/runtime/run-store.ts
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 1e3;
function encodeRunCursor(pointer) {
	return base64UrlEncode(JSON.stringify({
		s: pointer.startedAt,
		r: pointer.runId
	}));
}
function decodeRunCursor(cursor) {
	if (!cursor) return void 0;
	try {
		const decoded = JSON.parse(base64UrlDecode(cursor));
		if (typeof decoded?.s === "string" && typeof decoded?.r === "string") return {
			startedAt: decoded.s,
			runId: decoded.r
		};
	} catch {}
}
function base64UrlEncode(value) {
	const bytes = new TextEncoder().encode(value);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(value) {
	const b64 = (value + "=".repeat((4 - value.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(b64);
	return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}
/**
* Per-chunk streaming events that are buffered before persistence.
* These events are flushed at most once per interval (~3 s) to avoid
* starting one storage write per streamed chunk during generation.
*/
const BUFFERED_RUN_EVENT_TYPES = new Set([
	"text_delta",
	"thinking_start",
	"thinking_delta",
	"thinking_end"
]);
function isBufferedRunEvent(event) {
	return BUFFERED_RUN_EVENT_TYPES.has(event.type);
}
/**
* Events excluded from durable streams entirely: never persisted and never
* served over HTTP, on agent streams and run streams alike. In-process
* delivery is unaffected — `observe()` subscribers and exporters such as
* `@flue/opentelemetry` receive these events with full fidelity.
*
* `turn_request` re-serializes the full system prompt, the entire message
* history, and all tool schemas on every model turn; persisting it grows
* stream storage quadratically with conversation length and exposes full
* prompts to every stream reader. Production prompt forensics belongs to an
* exporter-side content-export opt-in, not the primary database.
*/
const STREAM_EXCLUDED_EVENT_TYPES = new Set(["turn_request"]);
function isStreamExcludedEvent(event) {
	return STREAM_EXCLUDED_EVENT_TYPES.has(event.type);
}
//#endregion
export { DirectAgentPayloadSchema as C, WorkflowRouteParamSchema as E, AgentRouteParamSchema as S, MAX_IMAGE_DATA_LENGTH as T, createSessionStorageKey as _, isBufferedRunEvent as a, isUuid as b, assertSupportedFlueSchemaVersion as c, SUBMISSION_SESSION_NAME as d, clampLimit as f, createActionScopeName as g, assertPublicSessionName as h, encodeRunCursor as i, migrateFlueSqlSchema as l, parseAcceptedAt as m, MAX_LIST_LIMIT as n, isStreamExcludedEvent as o, isSubmissionPayload as p, decodeRunCursor as r, FLUE_SCHEMA_VERSION as s, DEFAULT_LIST_LIMIT as t, SUBMISSION_HARNESS_NAME as u, createTaskSessionName as v, InvocationQuerySchema as w, parseSessionStorageKey as x, isPublicSessionName as y };
