import { _ as ConversationRecord, a as StoredAttachment, c as createAttachmentRef, f as AttachmentRef, i as PutAttachmentInput, l as sameAttachmentRef, n as GetAttachmentInput, o as attachmentBytesEqual, r as InMemoryAttachmentStore, s as copyAttachmentBytes, t as AttachmentStore, u as verifyAttachmentBytes, v as SubmissionSettledRecord } from "./attachment-store-Cf3tPUa0.mjs";
import { A as ConversationStreamMeta, D as ConversationProducerClaim, F as StreamListenerRegistry, M as ConversationStreamStore, N as InMemoryConversationStreamStore, O as ConversationStreamBatch, _ as DirectAgentSubmissionInput, a as AgentSubmission, b as createDispatchAgentSubmissionInput, c as DURABILITY_DEFAULT_TIMEOUT_MS, d as PersistenceStores, f as SubmissionAttemptRef, h as SubmissionSettlementObligation, i as AgentExecutionStore, j as ConversationStreamReadResult, k as ConversationStreamIdentity, l as LEASE_DURATION_MS, m as SubmissionDurability, n as AgentDispatchAdmission, o as AgentSubmissionStore, p as SubmissionClaimRef, r as AgentDispatchReceipt, s as DURABILITY_DEFAULT_MAX_ATTEMPTS, t as AgentAttemptMarker, u as PersistenceAdapter, v as DispatchAgentSubmissionInput, x as DispatchInput } from "./agent-execution-store-BCmrE5Jm.mjs";
import { a as ListRunsResponse, c as RunRecord, f as decodeRunCursor, i as ListRunsOpts, l as RunStatus, n as DEFAULT_LIST_LIMIT, o as MAX_LIST_LIMIT, p as encodeRunCursor, r as EndRunInput, s as RunPointer, t as CreateRunInput, u as RunStore } from "./run-store-tKpCS1yQ.mjs";
import { a as MAX_READ_LIMIT, c as parseOffset, i as EventStreamStore, n as EventStreamMeta, r as EventStreamReadResult, s as formatOffset, t as DEFAULT_READ_LIMIT } from "./event-stream-store-CSiWecIp.mjs";
import { a as AttachmentIntegrityError, f as PersistedSchemaVersionError, i as AttachmentConflictError, s as ConversationStreamStoreError } from "./errors-CZfAM_Do.mjs";
//#region src/adapter-helpers.d.ts
/**
 * Agent-mode submissions (HTTP and dispatch) always target the
 * default harness. Named harnesses exist for multi-harness workflows
 * (for example, named internal scopes), but external submissions do
 * not select a harness — they implicitly use `'default'`.
 *
 * Exported for adapter implementations that construct session storage keys.
 */
declare const SUBMISSION_HARNESS_NAME = "default";
/**
 * Agent-mode submissions always target the default session of the
 * default harness; external submissions cannot select a session.
 *
 * Exported for adapter implementations that construct session storage keys.
 */
declare const SUBMISSION_SESSION_NAME = "default";
/**
 * Context needed for submission payload validation.
 *
 * Adapters extract these fields from their storage-specific row/document
 * type before calling {@link isSubmissionPayload}.
 */
interface SubmissionPayloadContext {
  readonly kind: string;
  readonly submissionId: string;
  readonly sessionKey: string;
  readonly acceptedAt: number;
}
/**
 * Validate that a parsed JSON payload matches the expected submission shape.
 *
 * Used after `JSON.parse(payload)` to verify the deserialized object is a
 * well-formed `AgentSubmissionInput` that is consistent with the stored
 * submission metadata.
 */
declare function isSubmissionPayload(input: unknown, ctx: SubmissionPayloadContext): input is AgentSubmission['input'];
/**
 * Parse an ISO timestamp string into epoch milliseconds.
 * Throws with a `[flue]` error if the value is not a finite number.
 */
declare function parseAcceptedAt(value: string, label: string): number;
/**
 * Clamp a caller-supplied page/chunk limit to a safe range.
 *
 * Invalid, non-finite, and non-positive values fall back to `defaultLimit`;
 * valid values are capped at `maxLimit`. Used by run listings
 * (`DEFAULT_LIST_LIMIT`/`MAX_LIST_LIMIT`) and event stream reads
 * (`DEFAULT_READ_LIMIT`/`MAX_READ_LIMIT`).
 */
declare function clampLimit(limit: number | undefined, defaultLimit: number, maxLimit: number): number;
//#endregion
//#region src/session-identity.d.ts
declare function createSessionStorageKey(instanceId: string, harness: string, session: string): string;
//#endregion
//#region src/schema-version.d.ts
/**
 * Current schema/format version of Flue's built-in persisted stores.
 *
 * Bump this when a persisted format changes incompatibly. Pre-1.0 stores with
 * another version are rejected and must be cleared.
 */
declare const FLUE_SCHEMA_VERSION = 4;
/**
 * Throw {@link PersistedSchemaVersionError} unless the stored version matches
 * the current {@link FLUE_SCHEMA_VERSION}.
 *
 * Adapters call this with the version value they recorded at store creation.
 * A version greater than the current one means the store was written by a
 * newer Flue version and must not be read; any other mismatch means the
 * version marker is unrecognized.
 */
declare function assertSupportedFlueSchemaVersion(storedVersion: string): void;
//#endregion
//#region src/persisted-images.d.ts
interface PersistedImageChunk {
  imageId: string;
  index: number;
  count: number;
  data: string;
}
interface ExtractedImages<T> {
  value: T;
  chunks: PersistedImageChunk[];
}
//#endregion
//#region src/persisted-image-placement.d.ts
interface PersistedChunkOwner {
  kind: 'submission';
  id: string;
  part: '';
}
interface PersistedChunkRow {
  imageId: string;
  index: number;
  count: number;
  data: string;
}
interface PersistedChunkStore<Result = void> {
  read(owner: PersistedChunkOwner): Result extends Promise<unknown> ? Promise<PersistedChunkRow[]> : PersistedChunkRow[];
  replace(owner: PersistedChunkOwner, chunks: readonly PersistedImageChunk[]): Result;
  delete(owner: PersistedChunkOwner): Result;
  deleteMany(owners: readonly PersistedChunkOwner[]): Result;
  deleteOwner(kind: PersistedChunkOwner['kind'], id: string): Result;
}
declare function submissionChunkOwner(submissionId: string): PersistedChunkOwner;
declare function prepareDirectSubmission(input: DirectAgentSubmissionInput): ExtractedImages<DirectAgentSubmissionInput>;
declare function hydratePersistedDirectSubmission(input: DirectAgentSubmissionInput, rows: readonly PersistedChunkRow[]): DirectAgentSubmissionInput;
declare function matchesPersistedDirectSubmission(input: DirectAgentSubmissionInput, persistedInput: DirectAgentSubmissionInput, rows: readonly PersistedChunkRow[]): boolean;
declare function samePersistedChunks(left: readonly PersistedChunkRow[], right: readonly PersistedImageChunk[]): boolean;
//#endregion
//#region src/runtime/sql-conversation-stream-store.d.ts
/**
 * A query inside a {@link SqlConversationDialect} transaction: a SQL string
 * built from dialect placeholders plus positional parameters, resolving to
 * result rows as plain objects.
 */
interface SqlConversationDialectTx {
  query(sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]>;
}
/**
 * The async SQL dialect seam that {@link defineSqlConversationStreamStore} runs
 * the canonical conversation-stream fence against. A backend supplies its own
 * placeholder syntax, row-locking clause, upsert spelling, and `RETURNING`
 * support so the Postgres / libSQL / MySQL adapters share one fence
 * implementation rather than hand-copying it.
 */
interface SqlConversationDialect {
  /** Render a 1-based positional placeholder (pg: `$N`; libsql/mysql: `?`). */
  placeholder(index1Based: number): string;
  /** Appended to row-locking SELECTs (`FOR UPDATE` for pg/mysql; `''` for libsql). */
  readonly lockClause: string;
  /** Leading keywords for the createStream insert (`INSERT` or `INSERT IGNORE`). */
  readonly insertIgnorePrefix: string;
  /** Trailing clause for the createStream insert (`ON CONFLICT (path) DO NOTHING` or `''`). */
  readonly insertIgnoreSuffix: string;
  /** Whether the backend supports `UPDATE ... RETURNING` (pg/libsql) or not (mysql). */
  readonly supportsReturning: boolean;
  /** Inline the read `LIMIT` as a literal rather than a placeholder (mysql). */
  readonly inlineReadLimit?: boolean;
  /** Optional per-operation path validation (mysql enforces a length limit). */
  validatePath?(path: string, operation: string): void;
  query(sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]>;
  transaction<T>(fn: (tx: SqlConversationDialectTx) => Promise<T>): Promise<T>;
}
/**
 * Build a {@link ConversationStreamStore} over an async SQL backend described by
 * {@link SqlConversationDialect}. The fence algorithm — producer epoch / incarnation
 * staleness checks, idempotent retry detection, sequence-gap rejection, and
 * submission-authorization — is identical across Postgres, libSQL, and MySQL; only
 * the dialect constants differ.
 */
declare function defineSqlConversationStreamStore(dialect: SqlConversationDialect): ConversationStreamStore;
//#endregion
export { type AgentAttemptMarker, type AgentDispatchAdmission, type AgentDispatchReceipt, type AgentExecutionStore, type AgentSubmission, type AgentSubmissionStore, AttachmentConflictError, AttachmentIntegrityError, type AttachmentRef, type AttachmentStore, type ConversationProducerClaim, type ConversationRecord, type ConversationStreamBatch, type ConversationStreamIdentity, type ConversationStreamMeta, type ConversationStreamReadResult, type ConversationStreamStore, ConversationStreamStoreError, type CreateRunInput, DEFAULT_LIST_LIMIT, DEFAULT_READ_LIMIT, DURABILITY_DEFAULT_MAX_ATTEMPTS, DURABILITY_DEFAULT_TIMEOUT_MS, type DirectAgentSubmissionInput, type DispatchAgentSubmissionInput, type DispatchInput, type EndRunInput, type EventStreamMeta, type EventStreamReadResult, type EventStreamStore, FLUE_SCHEMA_VERSION, type GetAttachmentInput, InMemoryAttachmentStore, InMemoryConversationStreamStore, LEASE_DURATION_MS, type ListRunsOpts, type ListRunsResponse, MAX_LIST_LIMIT, MAX_READ_LIMIT, type PersistedChunkOwner, type PersistedChunkRow, type PersistedChunkStore, PersistedSchemaVersionError, type PersistenceAdapter, type PersistenceStores, type PutAttachmentInput, type RunPointer, type RunRecord, type RunStatus, type RunStore, SUBMISSION_HARNESS_NAME, SUBMISSION_SESSION_NAME, type SqlConversationDialect, type SqlConversationDialectTx, type StoredAttachment, StreamListenerRegistry, type SubmissionAttemptRef, type SubmissionClaimRef, type SubmissionDurability, type SubmissionPayloadContext, type SubmissionSettledRecord, type SubmissionSettlementObligation, assertSupportedFlueSchemaVersion, attachmentBytesEqual, clampLimit, copyAttachmentBytes, createAttachmentRef, createDispatchAgentSubmissionInput, createSessionStorageKey, decodeRunCursor, defineSqlConversationStreamStore, encodeRunCursor, formatOffset, hydratePersistedDirectSubmission, isSubmissionPayload, matchesPersistedDirectSubmission, parseAcceptedAt, parseOffset, prepareDirectSubmission, sameAttachmentRef, samePersistedChunks, submissionChunkOwner, verifyAttachmentBytes };