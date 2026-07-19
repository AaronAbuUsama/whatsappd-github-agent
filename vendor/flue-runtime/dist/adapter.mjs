import { a as AttachmentIntegrityError, d as ConversationStreamStoreError, i as AttachmentConflictError, v as PersistedSchemaVersionError } from "./errors-DUgRtE8e.mjs";
import { G as DEFAULT_READ_LIMIT, K as MAX_READ_LIMIT, X as parseOffset, Y as formatOffset } from "./conversation-projections-XMug3C6A.mjs";
import { _ as createSessionStorageKey, c as assertSupportedFlueSchemaVersion, d as SUBMISSION_SESSION_NAME, f as clampLimit, i as encodeRunCursor, m as parseAcceptedAt, n as MAX_LIST_LIMIT, p as isSubmissionPayload, r as decodeRunCursor, s as FLUE_SCHEMA_VERSION, t as DEFAULT_LIST_LIMIT, u as SUBMISSION_HARNESS_NAME } from "./run-store-CYeXjR-d.mjs";
import { C as LEASE_DURATION_MS, S as DURABILITY_DEFAULT_TIMEOUT_MS, a as hydratePersistedDirectSubmission, c as samePersistedChunks, f as createDispatchAgentSubmissionInput, l as submissionChunkOwner, o as matchesPersistedDirectSubmission, r as StreamListenerRegistry, s as prepareDirectSubmission, t as InMemoryConversationStreamStore, x as DURABILITY_DEFAULT_MAX_ATTEMPTS } from "./conversation-stream-store-Bitz7UoW.mjs";
import { a as sameAttachmentRef, i as createAttachmentRef, n as attachmentBytesEqual, o as verifyAttachmentBytes, r as copyAttachmentBytes, t as InMemoryAttachmentStore } from "./attachment-store-C1jHXs6y.mjs";
//#region src/runtime/sql-conversation-stream-store.ts
const DEFAULT_READ_LIMIT$1 = 100;
const MAX_READ_LIMIT$1 = 1e3;
/**
* Build a {@link ConversationStreamStore} over an async SQL backend described by
* {@link SqlConversationDialect}. The fence algorithm — producer epoch / incarnation
* staleness checks, idempotent retry detection, sequence-gap rejection, and
* submission-authorization — is identical across Postgres, libSQL, and MySQL; only
* the dialect constants differ.
*/
function defineSqlConversationStreamStore(dialect) {
	return new SqlConversationStreamStore(dialect);
}
var SqlConversationStreamStore = class {
	dialect;
	listeners = new StreamListenerRegistry();
	constructor(dialect) {
		this.dialect = dialect;
	}
	async createStream(path, identity) {
		const dialect = this.dialect;
		const p = (index) => dialect.placeholder(index);
		dialect.validatePath?.(path, "create");
		const data = JSON.stringify(identity);
		await dialect.transaction(async (tx) => {
			await tx.query(`${dialect.insertIgnorePrefix} INTO flue_conversation_streams (path, identity_json, incarnation)
				 VALUES (${p(1)}, ${p(2)}, ${p(3)}) ${dialect.insertIgnoreSuffix}`, [
				path,
				data,
				crypto.randomUUID()
			]);
			if ((await tx.query(`SELECT identity_json FROM flue_conversation_streams WHERE path = ${p(1)}`, [path]))[0]?.identity_json !== data) throw failure(path, "Stream identity conflicts.", "create");
		});
	}
	async acquireProducer(path, producerId) {
		const dialect = this.dialect;
		const p = (index) => dialect.placeholder(index);
		dialect.validatePath?.(path, "acquire_producer");
		return dialect.transaction(async (tx) => {
			if (dialect.supportsReturning) {
				const row = (await tx.query(`UPDATE flue_conversation_streams
					 SET producer_id = ${p(1)}, producer_epoch = producer_epoch + 1, next_producer_sequence = 0
					 WHERE path = ${p(2)}
					 RETURNING producer_epoch, next_offset, incarnation`, [producerId, path]))[0];
				if (!row) throw failure(path, "Stream does not exist.", "acquire_producer");
				return {
					producerId,
					producerEpoch: Number(row.producer_epoch),
					incarnation: String(row.incarnation),
					nextProducerSequence: 0,
					offset: formatOffset(Number(row.next_offset) - 1)
				};
			}
			const row = (await tx.query(`SELECT next_offset, producer_epoch, incarnation
				 FROM flue_conversation_streams WHERE path = ${p(1)} ${dialect.lockClause}`, [path]))[0];
			if (!row) throw failure(path, "Stream does not exist.", "acquire_producer");
			const producerEpoch = Number(row.producer_epoch) + 1;
			await tx.query(`UPDATE flue_conversation_streams
				 SET producer_id = ${p(1)}, producer_epoch = ${p(2)}, next_producer_sequence = 0
				 WHERE path = ${p(3)}`, [
				producerId,
				producerEpoch,
				path
			]);
			return {
				producerId,
				producerEpoch,
				incarnation: String(row.incarnation),
				nextProducerSequence: 0,
				offset: formatOffset(Number(row.next_offset) - 1)
			};
		});
	}
	async append(input) {
		const dialect = this.dialect;
		const p = (index) => dialect.placeholder(index);
		dialect.validatePath?.(input.path, "append");
		if (input.records.length === 0) throw failure(input.path, "A canonical batch cannot be empty.", "append");
		const data = JSON.stringify(input.records);
		const result = await dialect.transaction(async (tx) => {
			const meta = (await tx.query(`SELECT next_offset, producer_id, producer_epoch, next_producer_sequence, incarnation
				 FROM flue_conversation_streams WHERE path = ${p(1)} ${dialect.lockClause}`, [input.path]))[0];
			if (!meta) throw failure(input.path, "Stream does not exist.");
			if (meta.producer_id !== input.producerId || Number(meta.producer_epoch) !== input.producerEpoch || meta.incarnation !== input.incarnation) throw failure(input.path, "Producer ownership is stale.");
			const retry = (await tx.query(`SELECT seq, data, submission_id, attempt_id FROM flue_conversation_stream_batches
				 WHERE path = ${p(1)} AND producer_id = ${p(2)} AND producer_epoch = ${p(3)} AND producer_sequence = ${p(4)}`, [
				input.path,
				input.producerId,
				input.producerEpoch,
				input.producerSequence
			]))[0];
			if (retry) {
				if (retry.data !== data || (retry.submission_id ?? null) !== (input.submission?.submissionId ?? null) || (retry.attempt_id ?? null) !== (input.submission?.attemptId ?? null)) throw failure(input.path, "Producer sequence has conflicting content.");
				return {
					offset: formatOffset(Number(retry.seq)),
					appended: false
				};
			}
			if (Number(meta.next_producer_sequence) !== input.producerSequence) throw failure(input.path, "Producer sequence is not the next expected value.");
			await assertSubmissionAuthorization(dialect, tx, input.path, input.submission, input.records);
			const seq = Number(meta.next_offset);
			await tx.query(`INSERT INTO flue_conversation_stream_batches
				 (path, seq, producer_id, producer_epoch, producer_sequence, data, submission_id, attempt_id)
				 VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)})`, [
				input.path,
				seq,
				input.producerId,
				input.producerEpoch,
				input.producerSequence,
				data,
				input.submission?.submissionId ?? null,
				input.submission?.attemptId ?? null
			]);
			await tx.query(`UPDATE flue_conversation_streams
				 SET next_offset = next_offset + 1, next_producer_sequence = next_producer_sequence + 1
				 WHERE path = ${p(1)}`, [input.path]);
			return {
				offset: formatOffset(seq),
				appended: true
			};
		});
		if (result.appended) this.listeners.notify(input.path);
		return { offset: result.offset };
	}
	async read(path, options) {
		const dialect = this.dialect;
		const p = (index) => dialect.placeholder(index);
		dialect.validatePath?.(path, "read");
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
		if (!Number.isSafeInteger(startAfter) || startAfter > parseOffset(meta.nextOffset)) throw failure(path, "Read offset is beyond the canonical stream head.", "read");
		const limit = clampLimit(options?.limit, DEFAULT_READ_LIMIT$1, MAX_READ_LIMIT$1);
		const limitSql = dialect.inlineReadLimit ? `${limit + 1}` : p(3);
		const params = dialect.inlineReadLimit ? [path, startAfter] : [
			path,
			startAfter,
			limit + 1
		];
		const rows = await dialect.query(`SELECT seq, data FROM flue_conversation_stream_batches
			 WHERE path = ${p(1)} AND seq > ${p(2)} ORDER BY seq ASC LIMIT ${limitSql}`, params);
		const batches = rows.slice(0, limit).map((row) => ({
			offset: formatOffset(Number(row.seq)),
			records: JSON.parse(String(row.data))
		}));
		return {
			batches,
			nextOffset: batches.at(-1)?.offset ?? formatOffset(startAfter),
			upToDate: rows.length <= limit
		};
	}
	async getMeta(path) {
		const dialect = this.dialect;
		const p = (index) => dialect.placeholder(index);
		dialect.validatePath?.(path, "get_meta");
		const row = (await dialect.query(`SELECT identity_json, next_offset, producer_id, producer_epoch, next_producer_sequence, incarnation
			 FROM flue_conversation_streams WHERE path = ${p(1)}`, [path]))[0];
		if (!row) return null;
		return {
			identity: JSON.parse(String(row.identity_json)),
			incarnation: String(row.incarnation),
			nextOffset: formatOffset(Number(row.next_offset) - 1),
			producerId: row.producer_id == null ? null : String(row.producer_id),
			producerEpoch: Number(row.producer_epoch),
			nextProducerSequence: Number(row.next_producer_sequence)
		};
	}
	async delete(path) {
		const dialect = this.dialect;
		const p = (index) => dialect.placeholder(index);
		dialect.validatePath?.(path, "delete");
		await dialect.transaction(async (tx) => {
			await tx.query(`DELETE FROM flue_conversation_stream_batches WHERE path = ${p(1)}`, [path]);
			await tx.query(`DELETE FROM flue_conversation_streams WHERE path = ${p(1)}`, [path]);
		});
		this.listeners.notify(path);
	}
	subscribe(path, listener) {
		return this.listeners.subscribe(path, listener);
	}
};
async function assertSubmissionAuthorization(dialect, tx, path, submission, records) {
	const p = (index) => dialect.placeholder(index);
	const owned = records.filter((record) => record.submissionId !== void 0 || record.attemptId !== void 0);
	if (!submission) {
		if (owned.length > 0) throw failure(path, "Submission-owned records require attempt authorization.");
		return;
	}
	if (owned.some((record) => record.submissionId !== submission.submissionId || record.attemptId !== submission.attemptId)) throw failure(path, "Record ownership does not match the authorized submission attempt.");
	const row = (await tx.query(`SELECT status, attempt_id, session_key, settlement_record_id, settlement_record
		 FROM flue_agent_submissions WHERE submission_id = ${p(1)} ${dialect.lockClause}`, [submission.submissionId]))[0];
	const streams = await tx.query(`SELECT identity_json FROM flue_conversation_streams WHERE path = ${p(1)}`, [path]);
	const streamIdentity = streams[0] ? JSON.parse(String(streams[0].identity_json)) : void 0;
	const terminalizingSettlement = row?.status === "terminalizing" && records.length === 1 && owned.length === 1 && owned[0]?.type === "submission_settled" && row.settlement_record_id === owned[0].id && row.settlement_record === JSON.stringify(owned[0]);
	if (!row || row.status !== "running" && !terminalizingSettlement || row.attempt_id !== submission.attemptId || parseSessionInstance(row.session_key) !== streamIdentity?.instanceId) throw failure(path, "Submission attempt no longer owns work for this agent instance.");
}
function parseSessionInstance(value) {
	if (typeof value !== "string" || !value.startsWith("agent-session:")) return void 0;
	try {
		const parsed = JSON.parse(value.slice(14));
		return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : void 0;
	} catch {
		return;
	}
}
function failure(path, reason, operation = "append") {
	return new ConversationStreamStoreError({
		operation,
		path,
		reason
	});
}
//#endregion
export { AttachmentConflictError, AttachmentIntegrityError, ConversationStreamStoreError, DEFAULT_LIST_LIMIT, DEFAULT_READ_LIMIT, DURABILITY_DEFAULT_MAX_ATTEMPTS, DURABILITY_DEFAULT_TIMEOUT_MS, FLUE_SCHEMA_VERSION, InMemoryAttachmentStore, InMemoryConversationStreamStore, LEASE_DURATION_MS, MAX_LIST_LIMIT, MAX_READ_LIMIT, PersistedSchemaVersionError, SUBMISSION_HARNESS_NAME, SUBMISSION_SESSION_NAME, StreamListenerRegistry, assertSupportedFlueSchemaVersion, attachmentBytesEqual, clampLimit, copyAttachmentBytes, createAttachmentRef, createDispatchAgentSubmissionInput, createSessionStorageKey, decodeRunCursor, defineSqlConversationStreamStore, encodeRunCursor, formatOffset, hydratePersistedDirectSubmission, isSubmissionPayload, matchesPersistedDirectSubmission, parseAcceptedAt, parseOffset, prepareDirectSubmission, sameAttachmentRef, samePersistedChunks, submissionChunkOwner, verifyAttachmentBytes };
