import { a as AttachmentIntegrityError, i as AttachmentConflictError } from "./errors-DUgRtE8e.mjs";
import { _ as createSessionStorageKey, d as SUBMISSION_SESSION_NAME, f as clampLimit, i as encodeRunCursor, l as migrateFlueSqlSchema, m as parseAcceptedAt, n as MAX_LIST_LIMIT, p as isSubmissionPayload, r as decodeRunCursor, u as SUBMISSION_HARNESS_NAME } from "./run-store-CYeXjR-d.mjs";
import { C as LEASE_DURATION_MS, S as DURABILITY_DEFAULT_TIMEOUT_MS, a as hydratePersistedDirectSubmission, c as samePersistedChunks, f as createDispatchAgentSubmissionInput, l as submissionChunkOwner, o as matchesPersistedDirectSubmission, s as prepareDirectSubmission } from "./conversation-stream-store-Bitz7UoW.mjs";
import { a as sameAttachmentRef, n as attachmentBytesEqual, o as verifyAttachmentBytes, r as copyAttachmentBytes } from "./attachment-store-C1jHXs6y.mjs";
//#region src/sql-persisted-chunk-store.ts
function ensureSqlPersistedChunkTable(sql) {
	sql.exec(`CREATE TABLE IF NOT EXISTS flue_image_chunks (
		 owner_kind TEXT NOT NULL,
		 owner_id TEXT NOT NULL,
		 owner_part TEXT NOT NULL,
		 image_id TEXT NOT NULL,
		 chunk_index INTEGER NOT NULL,
		 chunk_count INTEGER NOT NULL,
		 data TEXT NOT NULL,
		 PRIMARY KEY (owner_kind, owner_id, owner_part, image_id, chunk_index)
		)`);
}
function createSqlPersistedChunkStore(sql) {
	return {
		read(owner) {
			return sql.exec(`SELECT image_id, chunk_index, chunk_count, data
					 FROM flue_image_chunks
					 WHERE owner_kind = ? AND owner_id = ? AND owner_part = ?
					 ORDER BY image_id, chunk_index`, owner.kind, owner.id, owner.part).toArray().map(parseChunkRow);
		},
		replace(owner, chunks) {
			deleteOwner(sql, owner);
			insertChunks(sql, owner, chunks);
		},
		delete(owner) {
			deleteOwner(sql, owner);
		},
		deleteMany(owners) {
			for (const owner of owners) deleteOwner(sql, owner);
		},
		deleteOwner(kind, id) {
			sql.exec("DELETE FROM flue_image_chunks WHERE owner_kind = ? AND owner_id = ?", kind, id);
		}
	};
}
function parseChunkRow(row) {
	if (typeof row.image_id !== "string" || typeof row.chunk_index !== "number" || !Number.isInteger(row.chunk_index) || typeof row.chunk_count !== "number" || !Number.isInteger(row.chunk_count) || typeof row.data !== "string") throw new Error("[flue] Persisted image chunk row is malformed.");
	return {
		imageId: row.image_id,
		index: row.chunk_index,
		count: row.chunk_count,
		data: row.data
	};
}
function deleteOwner(sql, owner) {
	sql.exec("DELETE FROM flue_image_chunks WHERE owner_kind = ? AND owner_id = ? AND owner_part = ?", owner.kind, owner.id, owner.part);
}
function insertChunks(sql, owner, chunks) {
	for (const chunk of chunks) sql.exec(`INSERT INTO flue_image_chunks
			 (owner_kind, owner_id, owner_part, image_id, chunk_index, chunk_count, data)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`, owner.kind, owner.id, owner.part, chunk.imageId, chunk.index, chunk.count, chunk.data);
}
//#endregion
//#region src/sql-agent-execution-store.ts
/**
* Shared SQL agent execution store implementation.
*
* Used by both Cloudflare (DO SQLite) and Node (`node:sqlite`). Contains all
* SQL-level storage logic — table DDL, row parsing, and the
* {@link AgentSubmissionStore} implementation.
*
* Platform-specific wiring (opening the database, providing a transaction
* wrapper) lives in `cloudflare/agent-execution-store.ts` and
* `node/agent-execution-store.ts`.
*
* INTERNAL convenience, scoped to the SQLite dialect family (`node:sqlite`
* and Durable Object SQLite). Do NOT generalize this module across SQL
* dialects: there is deliberately no generic-SQL abstraction spanning
* SQLite and Postgres, and `@flue/postgres` implements the store contract
* directly on purpose. Cross-backend parity is enforced by the documented
* invariants on the store interfaces and the contract suites in
* `@flue/runtime/test-utils`, not by code sharing.
*/
function ensureSqlAgentExecutionTables(sql) {
	migrateFlueSqlSchema(sql, () => {
		ensureSubmissionTable(sql);
		ensureSqlPersistedChunkTable(sql);
	});
}
/**
* Initialize an {@link AgentExecutionStore} from raw SQL primitives.
* Used by both Cloudflare (DO SQLite) and Node (`node:sqlite`).
*
* **Does not run DDL.** Call {@link ensureSqlAgentExecutionTables} first
* to ensure the schema exists.
*/
function createSqlAgentExecutionStoreFromSql(sql, runTransaction) {
	return { submissions: new AgentSubmissionStoreImpl(sql, runTransaction) };
}
var AgentSubmissionStoreImpl = class {
	sql;
	transactionSync;
	constructor(sql, transactionSync) {
		this.sql = sql;
		this.transactionSync = transactionSync;
	}
	async getSubmission(submissionId) {
		const row = this.readSubmissionRow(submissionId);
		return row ? this.parseSubmission(row) : null;
	}
	async replaceSubmissionAttempt(attempt, nextAttemptId, lease) {
		const now = Date.now();
		const row = this.sql.exec(`UPDATE flue_agent_submissions
				 SET attempt_id = ?, recovery_requested_at = NULL, started_at = ?, attempt_count = attempt_count + 1${lease ? ", owner_id = ?, lease_expires_at = ?" : ""}
				 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
				 RETURNING ${submissionColumns}`, ...lease ? [
			nextAttemptId,
			now,
			lease.ownerId,
			lease.leaseExpiresAt,
			attempt.submissionId,
			attempt.attemptId
		] : [
			nextAttemptId,
			now,
			attempt.submissionId,
			attempt.attemptId
		]).toArray()[0];
		return row ? this.parseSubmission(row) : null;
	}
	getDispatchReceipt(submissionId) {
		const row = this.sql.exec("SELECT dispatch_id, accepted_at FROM flue_agent_dispatch_receipts WHERE dispatch_id = ? LIMIT 1", submissionId).toArray()[0];
		if (!row) return null;
		if (typeof row.dispatch_id !== "string" || typeof row.accepted_at !== "number") throw new Error("[flue] Persisted dispatch receipt row is malformed.");
		return {
			submissionId: row.dispatch_id,
			acceptedAt: row.accepted_at
		};
	}
	async admitDispatch(input) {
		return this.admitSubmission(createDispatchAgentSubmissionInput(input));
	}
	async admitDirect(input) {
		const admission = this.admitSubmission(input);
		if (admission.kind !== "submission") throw new Error("[flue] Internal direct admission returned an unexpected result.");
		return admission.submission;
	}
	async markSubmissionCanonicalReady(submissionId) {
		const row = this.sql.exec(`UPDATE flue_agent_submissions
				 SET canonical_ready_at = COALESCE(canonical_ready_at, ?)
				 WHERE submission_id = ? AND status = 'queued'
				 RETURNING ${submissionColumns}`, Date.now(), submissionId).toArray()[0];
		return row ? this.parseSubmission(row) : null;
	}
	async hasUnsettledSubmissions() {
		return this.sql.exec(`SELECT 1
					 FROM flue_agent_submissions
				 WHERE status IN ('queued', 'running', 'terminalizing')
				 LIMIT 1`).toArray().length > 0;
	}
	async listUnreadySubmissions() {
		return this.parseOperationalRows(this.sql.exec(`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status = 'queued' AND canonical_ready_at IS NULL
					 ORDER BY sequence ASC`).toArray(), "queued");
	}
	async listRunnableSubmissions() {
		const rows = this.sql.exec(`SELECT ${submissionColumnsFor("current")}
				 FROM flue_agent_submissions AS current
				 WHERE current.status = 'queued'
				   AND current.canonical_ready_at IS NOT NULL
				   AND NOT EXISTS (
				     SELECT 1
				     FROM flue_agent_submissions AS earlier
				     WHERE earlier.session_key = current.session_key
				       AND earlier.status IN ('queued', 'running', 'terminalizing')
				       AND earlier.sequence < current.sequence
				   )
				 ORDER BY current.sequence ASC`).toArray();
		return this.parseOperationalRows(rows, "queued");
	}
	async listRunningSubmissions() {
		return this.parseOperationalRows(this.sql.exec(`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status = 'running'
					 ORDER BY sequence ASC`).toArray(), "active");
	}
	async listPendingSubmissionSettlements() {
		return this.sql.exec(`SELECT submission_id, session_key, attempt_id, settlement_record_id,
				        settlement_record_json
				 FROM flue_agent_submissions
				 WHERE status = 'terminalizing'
				 ORDER BY sequence ASC`).toArray().map(parseSettlementObligation);
	}
	async insertAttemptMarker(attempt) {
		this.sql.exec(`INSERT OR IGNORE INTO flue_agent_attempt_markers (submission_id, attempt_id, created_at)
			 VALUES (?, ?, ?)`, attempt.submissionId, attempt.attemptId, Date.now());
	}
	async deleteAttemptMarker(attempt) {
		this.sql.exec("DELETE FROM flue_agent_attempt_markers WHERE submission_id = ? AND attempt_id = ?", attempt.submissionId, attempt.attemptId);
	}
	async listAttemptMarkers() {
		return this.sql.exec("SELECT submission_id, attempt_id, created_at FROM flue_agent_attempt_markers").toArray().map((row) => {
			if (typeof row.submission_id !== "string" || typeof row.attempt_id !== "string" || typeof row.created_at !== "number") throw new Error("[flue] Persisted attempt marker row is malformed.");
			return {
				submissionId: row.submission_id,
				attemptId: row.attempt_id,
				createdAt: row.created_at
			};
		});
	}
	async renewLeases(ownerId, submissionIds) {
		if (submissionIds.length === 0) return;
		const leaseExpiresAt = Date.now() + LEASE_DURATION_MS;
		const placeholders = submissionIds.map(() => "?").join(", ");
		this.sql.exec(`UPDATE flue_agent_submissions
			 SET lease_expires_at = ?
			 WHERE owner_id = ? AND status = 'running'
			   AND submission_id IN (${placeholders})`, leaseExpiresAt, ownerId, ...submissionIds);
	}
	async listExpiredSubmissions() {
		const now = Date.now();
		return this.parseOperationalRows(this.sql.exec(`SELECT ${submissionColumns}
					 FROM flue_agent_submissions
					 WHERE status = 'running' AND lease_expires_at > 0 AND lease_expires_at < ?
					 ORDER BY sequence ASC`, now).toArray(), "active");
	}
	async claimSubmission(claim) {
		const now = Date.now();
		const timeoutAt = now + DURABILITY_DEFAULT_TIMEOUT_MS;
		const row = this.sql.exec(`UPDATE flue_agent_submissions AS current
				 SET status = 'running', attempt_id = ?, started_at = ?, attempt_count = attempt_count + 1,
				     max_retry = ?, timeout_at = CASE WHEN timeout_at = 0 THEN ? ELSE timeout_at END,
				     owner_id = ?, lease_expires_at = ?
				 WHERE current.submission_id = ? AND current.status = 'queued'
				   AND current.canonical_ready_at IS NOT NULL
				   AND NOT EXISTS (
				     SELECT 1
				     FROM flue_agent_submissions AS earlier
				     WHERE earlier.session_key = current.session_key
				       AND earlier.status IN ('queued', 'running', 'terminalizing')
				       AND earlier.sequence < current.sequence
				   )
				 RETURNING ${submissionColumns}`, claim.attemptId, now, 10, timeoutAt, claim.ownerId, claim.leaseExpiresAt, claim.submissionId).toArray()[0];
		return row ? this.parseSubmission(row) : null;
	}
	async markSubmissionInputApplied(attempt, durability) {
		return this.updateOwnedSubmission(`UPDATE flue_agent_submissions
			 SET input_applied_at = COALESCE(input_applied_at, ?),
			     max_retry = CASE WHEN input_applied_at IS NULL THEN ? ELSE max_retry END,
			     timeout_at = CASE WHEN input_applied_at IS NULL THEN ? ELSE timeout_at END
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`, Date.now(), durability?.maxRetry ?? 10, durability?.timeoutAt ?? Date.now() + 36e5, attempt.submissionId, attempt.attemptId);
	}
	async requestSubmissionRecovery(attempt) {
		return this.updateOwnedSubmission(`UPDATE flue_agent_submissions
			 SET recovery_requested_at = COALESCE(recovery_requested_at, ?)
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`, Date.now(), attempt.submissionId, attempt.attemptId);
	}
	async requestSessionAbort(sessionKey) {
		return this.sql.exec(`UPDATE flue_agent_submissions
				 SET abort_requested_at = COALESCE(abort_requested_at, ?)
				 WHERE session_key = ? AND status IN ('queued', 'running')
				 RETURNING submission_id`, Date.now(), sessionKey).toArray().map((row) => String(row.submission_id));
	}
	async requeueSubmissionBeforeInputApplied(attempt) {
		return this.sql.exec(`UPDATE flue_agent_submissions
					 SET status = 'queued', attempt_id = NULL, recovery_requested_at = NULL, started_at = NULL, owner_id = NULL, lease_expires_at = 0
					 WHERE submission_id = ? AND status = 'running'
					   AND attempt_id = ? AND input_applied_at IS NULL
					 RETURNING submission_id`, attempt.submissionId, attempt.attemptId).toArray().length > 0;
	}
	async reserveSubmissionSettlement(attempt, settlement) {
		if (settlement.record.id !== settlement.recordId) return null;
		const recordJson = JSON.stringify(settlement.record);
		return this.transactionSync(() => {
			const inserted = this.sql.exec(`UPDATE flue_agent_submissions
					 SET status = 'terminalizing', settlement_record_id = ?, settlement_record_json = ?
					 WHERE submission_id = ? AND kind = 'direct' AND status = 'running' AND attempt_id = ?
					 RETURNING submission_id, session_key, attempt_id, settlement_record_id,
					           settlement_record_json`, settlement.recordId, recordJson, attempt.submissionId, attempt.attemptId).toArray()[0];
			if (inserted) return parseSettlementObligation(inserted);
			const existing = this.sql.exec(`SELECT submission_id, session_key, attempt_id, settlement_record_id,
					        settlement_record_json
					 FROM flue_agent_submissions
					 WHERE submission_id = ? AND kind = 'direct' AND status = 'terminalizing'
					   AND attempt_id = ? AND settlement_record_id = ? AND settlement_record_json = ?`, attempt.submissionId, attempt.attemptId, settlement.recordId, recordJson).toArray()[0];
			return existing ? parseSettlementObligation(existing) : null;
		});
	}
	async finalizeSubmissionSettlement(attempt, recordId) {
		return this.updateOwnedSubmission(`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = NULL
			 WHERE submission_id = ? AND status = 'terminalizing' AND attempt_id = ?
			   AND settlement_record_id = ?
			 RETURNING submission_id`, Date.now(), attempt.submissionId, attempt.attemptId, recordId);
	}
	async completeSubmission(attempt) {
		return this.updateOwnedSubmission(`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = NULL
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`, Date.now(), attempt.submissionId, attempt.attemptId);
	}
	async failSubmission(attempt, error) {
		return this.updateOwnedSubmission(`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE submission_id = ? AND status = 'running' AND attempt_id = ?
			 RETURNING submission_id`, Date.now(), error instanceof Error ? error.message : String(error), attempt.submissionId, attempt.attemptId);
	}
	admitSubmission(input) {
		const { kind, submissionId } = input;
		const prepared = kind === "direct" ? prepareDirectSubmission(input) : {
			value: input,
			chunks: []
		};
		const payload = JSON.stringify(prepared.value);
		const acceptedAt = parseAcceptedAt(input.acceptedAt, `${kind} admission`);
		const sessionKey = createSessionStorageKey(input.id, SUBMISSION_HARNESS_NAME, SUBMISSION_SESSION_NAME);
		return this.transactionSync(() => {
			const chunkStore = createSqlPersistedChunkStore(this.sql);
			if (kind === "dispatch") {
				const receipt = this.getDispatchReceipt(submissionId);
				if (receipt) return {
					kind: "retained_receipt",
					receipt
				};
			}
			this.sql.exec(`INSERT OR IGNORE INTO flue_agent_submissions
				 (submission_id, session_key, kind, payload, status, accepted_at)
				 VALUES (?, ?, ?, ?, 'queued', ?)`, submissionId, sessionKey, kind, payload, acceptedAt);
			const row = this.readSubmissionRow(submissionId);
			if (!row) throw new Error(`[flue] Durable ${kind} admission did not create a submission row.`);
			if (row.kind !== kind) return { kind: "conflict" };
			const owner = submissionChunkOwner(submissionId);
			if (row.payload !== payload) {
				if (kind !== "direct" || typeof row.payload !== "string" || !matchesPersistedDirectSubmission(input, JSON.parse(row.payload), chunkStore.read(owner))) return { kind: "conflict" };
				return {
					kind: "submission",
					submission: this.parseSubmission(row)
				};
			}
			const persistedChunks = chunkStore.read(owner);
			if (persistedChunks.length === 0 && prepared.chunks.length > 0) chunkStore.replace(owner, prepared.chunks);
			else if (!samePersistedChunks(persistedChunks, prepared.chunks)) return { kind: "conflict" };
			return {
				kind: "submission",
				submission: this.parseSubmission(row)
			};
		});
	}
	updateOwnedSubmission(query, ...bindings) {
		return this.sql.exec(query, ...bindings).toArray().length > 0;
	}
	parseSubmission(row) {
		return parseSubmission(row, createSqlPersistedChunkStore(this.sql).read(submissionChunkOwner(String(row.submission_id))));
	}
	parseOperationalRows(rows, status) {
		const submissions = [];
		for (const row of rows) try {
			submissions.push(this.parseSubmission(row));
		} catch (error) {
			if (typeof row.sequence !== "number") throw error;
			console.error("[flue] Terminating malformed submission (sequence %d):", row.sequence, error);
			this.failSubmissionSequence(row.sequence, status, error);
		}
		return submissions;
	}
	failSubmissionSequence(sequence, status, error) {
		this.sql.exec(`UPDATE flue_agent_submissions
			 SET status = 'settled', settled_at = ?, error = ?
			 WHERE sequence = ? AND ${status === "queued" ? "status = 'queued'" : "status = 'running'"}`, Date.now(), error instanceof Error ? error.message : String(error), sequence);
	}
	readSubmissionRow(submissionId) {
		return this.sql.exec(`SELECT ${submissionColumns}
				 FROM flue_agent_submissions
				 WHERE submission_id = ?
				 LIMIT 1`, submissionId).toArray()[0];
	}
};
const submissionColumns = "sequence, submission_id, session_key, kind, payload, status, accepted_at, canonical_ready_at, attempt_id, input_applied_at, recovery_requested_at, abort_requested_at, started_at, error, attempt_count, max_retry, timeout_at, owner_id, lease_expires_at";
function submissionColumnsFor(table) {
	return submissionColumns.split(", ").map((column) => `${table}.${column}`).join(", ");
}
function parseSettlementObligation(row) {
	if (typeof row.submission_id !== "string" || typeof row.session_key !== "string" || typeof row.attempt_id !== "string" || typeof row.settlement_record_id !== "string" || typeof row.settlement_record_json !== "string") throw new Error("[flue] Persisted submission settlement obligation is malformed.");
	return {
		submissionId: row.submission_id,
		sessionKey: row.session_key,
		attemptId: row.attempt_id,
		recordId: row.settlement_record_id,
		record: JSON.parse(row.settlement_record_json)
	};
}
function parseSubmission(row, chunks) {
	if (typeof row.sequence !== "number" || typeof row.submission_id !== "string" || typeof row.session_key !== "string" || row.kind !== "dispatch" && row.kind !== "direct" || typeof row.payload !== "string" || row.status !== "queued" && row.status !== "running" && row.status !== "terminalizing" && row.status !== "settled" || typeof row.accepted_at !== "number" || row.canonical_ready_at !== null && row.canonical_ready_at !== void 0 && typeof row.canonical_ready_at !== "number" || row.attempt_id !== null && row.attempt_id !== void 0 && typeof row.attempt_id !== "string" || row.input_applied_at !== null && row.input_applied_at !== void 0 && typeof row.input_applied_at !== "number" || row.recovery_requested_at !== null && row.recovery_requested_at !== void 0 && typeof row.recovery_requested_at !== "number" || row.abort_requested_at !== null && row.abort_requested_at !== void 0 && typeof row.abort_requested_at !== "number" || row.started_at !== null && row.started_at !== void 0 && typeof row.started_at !== "number" || row.status === "queued" && (row.attempt_id !== null || row.input_applied_at !== null || row.recovery_requested_at !== null || row.started_at !== null) || (row.status === "running" || row.status === "terminalizing") && (typeof row.attempt_id !== "string" || typeof row.started_at !== "number") || typeof row.attempt_count !== "number" || typeof row.max_retry !== "number" || typeof row.timeout_at !== "number") throw new Error("[flue] Persisted agent submission row is malformed.");
	const parsedPayload = JSON.parse(row.payload);
	const input = row.kind === "direct" ? hydratePersistedDirectSubmission(parsedPayload, chunks) : parsedPayload;
	if (!isSubmissionPayload(input, {
		kind: row.kind,
		submissionId: row.submission_id,
		sessionKey: row.session_key,
		acceptedAt: row.accepted_at
	})) throw new Error("[flue] Persisted agent submission payload is malformed.");
	return {
		sequence: row.sequence,
		submissionId: row.submission_id,
		sessionKey: row.session_key,
		kind: row.kind,
		input,
		status: row.status,
		acceptedAt: row.accepted_at,
		canonicalReadyAt: typeof row.canonical_ready_at === "number" ? row.canonical_ready_at : null,
		...typeof row.attempt_id === "string" ? { attemptId: row.attempt_id } : {},
		...typeof row.input_applied_at === "number" ? { inputAppliedAt: row.input_applied_at } : {},
		...typeof row.recovery_requested_at === "number" ? { recoveryRequestedAt: row.recovery_requested_at } : {},
		...typeof row.abort_requested_at === "number" ? { abortRequestedAt: row.abort_requested_at } : {},
		...typeof row.started_at === "number" ? { startedAt: row.started_at } : {},
		...typeof row.error === "string" ? { error: row.error } : {},
		attemptCount: row.attempt_count,
		maxRetry: row.max_retry,
		timeoutAt: row.timeout_at,
		...typeof row.owner_id === "string" ? { ownerId: row.owner_id } : {},
		leaseExpiresAt: typeof row.lease_expires_at === "number" ? row.lease_expires_at : 0
	};
}
function ensureSubmissionTable(sql) {
	sql.exec(`CREATE TABLE IF NOT EXISTS flue_agent_submissions (
		 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
		 submission_id TEXT NOT NULL UNIQUE,
		 session_key TEXT NOT NULL,
		 kind TEXT NOT NULL,
		 payload TEXT NOT NULL,
		 status TEXT NOT NULL,
		 accepted_at INTEGER NOT NULL,
		 canonical_ready_at INTEGER,
		 attempt_id TEXT,
		 input_applied_at INTEGER,
		 recovery_requested_at INTEGER,
		 abort_requested_at INTEGER,
		 started_at INTEGER,
		 settled_at INTEGER,
		 error TEXT,
		 attempt_count INTEGER NOT NULL DEFAULT 0,
		 max_retry INTEGER NOT NULL DEFAULT 10,
		 timeout_at INTEGER NOT NULL DEFAULT 0,
		 owner_id TEXT,
		 lease_expires_at INTEGER NOT NULL DEFAULT 0,
		 settlement_record_id TEXT,
		 settlement_record_json TEXT
		)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS flue_agent_dispatch_receipts (
		 dispatch_id TEXT PRIMARY KEY,
		 accepted_at INTEGER NOT NULL
		)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS flue_agent_attempt_markers (
		 submission_id TEXT NOT NULL,
		 attempt_id TEXT NOT NULL,
		 created_at INTEGER NOT NULL,
		 PRIMARY KEY (submission_id, attempt_id)
		)`);
	sql.exec("CREATE INDEX IF NOT EXISTS flue_agent_submissions_status_sequence_idx ON flue_agent_submissions (status, sequence ASC)");
	sql.exec("CREATE INDEX IF NOT EXISTS flue_agent_submissions_session_status_sequence_idx ON flue_agent_submissions (session_key, status, sequence ASC)");
}
//#endregion
//#region src/sql-attachment-store.ts
const ATTACHMENT_CHUNK_BYTE_LENGTH = 512 * 1024;
function ensureSqlAttachmentTable(sql) {
	sql.exec(`CREATE TABLE IF NOT EXISTS flue_attachments (
			stream_path TEXT NOT NULL,
			attachment_id TEXT NOT NULL,
			mime_type TEXT NOT NULL,
			byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
			digest TEXT NOT NULL,
			conversation_id TEXT NOT NULL,
			chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
			created_at INTEGER NOT NULL,
			PRIMARY KEY (stream_path, attachment_id)
		)`);
	sql.exec(`CREATE TABLE IF NOT EXISTS flue_attachment_chunks (
			stream_path TEXT NOT NULL,
			attachment_id TEXT NOT NULL,
			chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
			bytes BLOB NOT NULL,
			PRIMARY KEY (stream_path, attachment_id, chunk_index),
			FOREIGN KEY (stream_path, attachment_id)
				REFERENCES flue_attachments (stream_path, attachment_id) ON DELETE CASCADE
		)`);
	sql.exec(`CREATE INDEX IF NOT EXISTS flue_attachments_conversation_idx
		 ON flue_attachments (stream_path, conversation_id, attachment_id)`);
}
var SqliteAttachmentStore = class {
	sql;
	runTransaction;
	constructor(sql, runTransaction) {
		this.sql = sql;
		this.runTransaction = runTransaction;
		ensureSqlAttachmentTable(sql);
	}
	async put(input) {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		this.runTransaction(() => {
			const existing = this.read(input.streamPath, input.attachment.id);
			if (existing) {
				if (!matchesInput(existing, input)) this.conflict(input.streamPath, input.attachment.id);
				return;
			}
			const chunks = splitAttachmentBytes(input.bytes);
			this.sql.exec(`INSERT INTO flue_attachments
				 (stream_path, attachment_id, mime_type, byte_size, digest, conversation_id, chunk_count, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, input.streamPath, input.attachment.id, input.attachment.mimeType, input.attachment.size, input.attachment.digest, input.conversationId, chunks.length, Date.now());
			for (const [index, bytes] of chunks.entries()) this.sql.exec(`INSERT INTO flue_attachment_chunks
					 (stream_path, attachment_id, chunk_index, bytes) VALUES (?, ?, ?, ?)`, input.streamPath, input.attachment.id, index, bytes);
		});
	}
	async get(input) {
		const row = this.read(input.streamPath, input.attachmentId);
		if (!row || row.conversationId !== input.conversationId) return null;
		await verifyAttachmentBytes(row.attachment, row.bytes);
		return {
			attachment: { ...row.attachment },
			bytes: copyAttachmentBytes(row.bytes)
		};
	}
	async deleteForInstance(streamPath) {
		this.runTransaction(() => {
			this.sql.exec("DELETE FROM flue_attachment_chunks WHERE stream_path = ?", streamPath);
			this.sql.exec("DELETE FROM flue_attachments WHERE stream_path = ?", streamPath);
		});
	}
	read(streamPath, attachmentId) {
		const value = this.sql.exec(`SELECT mime_type, byte_size, digest, conversation_id, chunk_count
				 FROM flue_attachments WHERE stream_path = ? AND attachment_id = ?`, streamPath, attachmentId).toArray()[0];
		if (!value) return null;
		const chunkCount = parseChunkCount(value.chunk_count, attachmentId);
		const chunks = this.sql.exec(`SELECT chunk_index, bytes FROM flue_attachment_chunks
			 WHERE stream_path = ? AND attachment_id = ? ORDER BY chunk_index`, streamPath, attachmentId).toArray();
		return {
			attachment: {
				id: attachmentId,
				mimeType: String(value.mime_type),
				size: Number(value.byte_size),
				digest: String(value.digest)
			},
			bytes: reassembleAttachmentBytes(attachmentId, chunkCount, chunks),
			conversationId: String(value.conversation_id)
		};
	}
	conflict(path, attachmentId) {
		throw new AttachmentConflictError({
			path,
			attachmentId
		});
	}
};
function matchesInput(existing, input) {
	return sameAttachmentRef(existing.attachment, input.attachment) && existing.conversationId === input.conversationId && attachmentBytesEqual(existing.bytes, input.bytes);
}
function splitAttachmentBytes(bytes) {
	const count = Math.max(1, Math.ceil(bytes.byteLength / ATTACHMENT_CHUNK_BYTE_LENGTH));
	return Array.from({ length: count }, (_, index) => copyAttachmentBytes(bytes.subarray(index * ATTACHMENT_CHUNK_BYTE_LENGTH, Math.min(bytes.byteLength, (index + 1) * ATTACHMENT_CHUNK_BYTE_LENGTH))));
}
function parseChunkCount(value, attachmentId) {
	const count = Number(value);
	if (!Number.isSafeInteger(count) || count <= 0) throw new AttachmentIntegrityError({
		attachmentId,
		reason: "chunks"
	});
	return count;
}
function reassembleAttachmentBytes(attachmentId, chunkCount, rows) {
	if (rows.length !== chunkCount) throw new AttachmentIntegrityError({
		attachmentId,
		reason: "chunks"
	});
	const chunks = rows.map((row, index) => {
		if (Number(row.chunk_index) !== index) throw new AttachmentIntegrityError({
			attachmentId,
			reason: "chunks"
		});
		const bytes = sqlBytes(row.bytes);
		if (bytes.byteLength > 524288 || index < chunkCount - 1 && bytes.byteLength === 0) throw new AttachmentIntegrityError({
			attachmentId,
			reason: "chunks"
		});
		return bytes;
	});
	const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
function sqlBytes(value) {
	if (value instanceof Uint8Array) return copyAttachmentBytes(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	throw new TypeError("Persisted attachment bytes are not binary data.");
}
//#endregion
//#region src/sql-run-store.ts
/**
* SQL-backed `RunStore` over the generic {@link SqlStorage} interface.
*
* Backend-agnostic: runs against Cloudflare DO SQLite (workflow Durable
* Objects) and `node:sqlite` (the Node `sqlite()` persistence adapter).
* One `flue_runs` table backs records, lookups, and listings; pointers are
* a column-subset projection of the run record.
*/
function createSqlRunStore(sql) {
	ensureRunTables(sql);
	return new SqlRunStore(sql);
}
var SqlRunStore = class {
	sql;
	constructor(sql) {
		this.sql = sql;
	}
	async createRun(input) {
		this.sql.exec(`INSERT OR IGNORE INTO flue_runs
			 (run_id, workflow_name, status, started_at, payload, traceparent, tracestate, ended_at, is_error, duration_ms, result, error)
			 VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`, input.runId, input.workflowName, "active", input.startedAt, serializeSqlJson(input.input), input.traceCarrier?.traceparent ?? null, input.traceCarrier?.tracestate ?? null);
	}
	async endRun(input) {
		this.sql.exec(`UPDATE flue_runs
			 SET status = ?, ended_at = ?, is_error = ?, duration_ms = ?, result = ?, error = ?
			 WHERE run_id = ?`, input.isError ? "errored" : "completed", input.endedAt, input.isError ? 1 : 0, input.durationMs, serializeSqlJson(input.result), serializeSqlJson(input.error), input.runId);
	}
	async getRun(runId) {
		const row = this.sql.exec("SELECT * FROM flue_runs WHERE run_id = ?", runId).toArray()[0];
		if (!row) return null;
		return rowToRunRecord(row);
	}
	async lookupRun(runId) {
		const row = this.sql.exec("SELECT run_id, workflow_name FROM flue_runs WHERE run_id = ?", runId).toArray()[0];
		return row ? {
			runId: String(row.run_id),
			workflowName: String(row.workflow_name)
		} : null;
	}
	async listRuns(opts = {}) {
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
		const rows = this.sql.exec(`SELECT run_id, workflow_name, status, started_at, ended_at, duration_ms, is_error
			 FROM flue_runs ${where}
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
function ensureRunTables(sql) {
	migrateFlueSqlSchema(sql, () => {
		sql.exec(`CREATE TABLE IF NOT EXISTS flue_runs (
			 run_id TEXT PRIMARY KEY,
			 workflow_name TEXT,
			 status TEXT NOT NULL,
			 started_at TEXT NOT NULL,
			 payload TEXT,
			 traceparent TEXT,
			 tracestate TEXT,
			 ended_at TEXT,
			 is_error INTEGER,
			 duration_ms INTEGER,
			 result TEXT,
			 error TEXT
			)`);
		sql.exec("CREATE INDEX IF NOT EXISTS flue_runs_workflow_started_idx ON flue_runs (workflow_name, started_at DESC)");
		sql.exec("CREATE INDEX IF NOT EXISTS flue_runs_status_started_idx ON flue_runs (status, started_at DESC, run_id DESC)");
	});
}
function serializeSqlJson(value) {
	return JSON.stringify(value) ?? null;
}
function rowToRunRecord(row) {
	const input = typeof row.payload === "string" ? JSON.parse(row.payload) : void 0;
	const result = typeof row.result === "string" ? JSON.parse(row.result) : void 0;
	const error = typeof row.error === "string" ? JSON.parse(row.error) : void 0;
	return {
		runId: String(row.run_id),
		workflowName: String(row.workflow_name),
		status: row.status,
		startedAt: String(row.started_at),
		input,
		traceCarrier: typeof row.traceparent === "string" ? {
			traceparent: row.traceparent,
			...typeof row.tracestate === "string" ? { tracestate: row.tracestate } : {}
		} : void 0,
		endedAt: typeof row.ended_at === "string" ? row.ended_at : void 0,
		isError: row.is_error === null || row.is_error === void 0 ? void 0 : Boolean(row.is_error),
		durationMs: typeof row.duration_ms === "number" ? row.duration_ms : void 0,
		result,
		error
	};
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
export { ensureSqlAgentExecutionTables as a, createSqlAgentExecutionStoreFromSql as i, SqliteAttachmentStore as n, ensureSqlAttachmentTable as r, createSqlRunStore as t };
