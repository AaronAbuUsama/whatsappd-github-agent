import { a as AttachmentIntegrityError, i as AttachmentConflictError } from "./errors-DUgRtE8e.mjs";
//#region src/runtime/attachment-store.ts
var InMemoryAttachmentStore = class {
	records = /* @__PURE__ */ new Map();
	async put(input) {
		await verifyAttachmentBytes(input.attachment, input.bytes);
		const key = attachmentKey(input.streamPath, input.attachment.id);
		const existing = this.records.get(key);
		if (existing) {
			if (!sameAttachmentRef(existing.attachment, input.attachment) || existing.conversationId !== input.conversationId || !attachmentBytesEqual(existing.bytes, input.bytes)) throw new AttachmentConflictError({
				path: input.streamPath,
				attachmentId: input.attachment.id
			});
			return;
		}
		this.records.set(key, {
			streamPath: input.streamPath,
			attachment: { ...input.attachment },
			bytes: copyAttachmentBytes(input.bytes),
			conversationId: input.conversationId
		});
	}
	async get(input) {
		const record = this.records.get(attachmentKey(input.streamPath, input.attachmentId));
		if (!record || record.conversationId !== input.conversationId) return null;
		await verifyAttachmentBytes(record.attachment, record.bytes);
		return {
			attachment: { ...record.attachment },
			bytes: copyAttachmentBytes(record.bytes)
		};
	}
	async deleteForInstance(streamPath) {
		for (const [key, record] of this.records) if (record.streamPath === streamPath) this.records.delete(key);
	}
};
async function createAttachmentRef(input) {
	return {
		id: input.id,
		mimeType: input.mimeType,
		size: input.bytes.byteLength,
		digest: await attachmentDigest(input.bytes),
		...input.filename ? { filename: input.filename } : {}
	};
}
async function verifyAttachmentBytes(attachment, bytes) {
	if (attachment.size !== bytes.byteLength) throw new AttachmentIntegrityError({
		attachmentId: attachment.id,
		reason: "size"
	});
	if (attachment.digest !== await attachmentDigest(bytes)) throw new AttachmentIntegrityError({
		attachmentId: attachment.id,
		reason: "digest"
	});
}
function copyAttachmentBytes(bytes) {
	return Uint8Array.from(bytes);
}
function attachmentBytesEqual(left, right) {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
function sameAttachmentRef(left, right) {
	return left.id === right.id && left.mimeType === right.mimeType && left.size === right.size && left.digest === right.digest;
}
async function attachmentDigest(bytes) {
	const source = Uint8Array.from(bytes);
	const digest = await crypto.subtle.digest("SHA-256", source.buffer);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function attachmentKey(path, attachmentId) {
	return JSON.stringify([path, attachmentId]);
}
//#endregion
export { sameAttachmentRef as a, createAttachmentRef as i, attachmentBytesEqual as n, verifyAttachmentBytes as o, copyAttachmentBytes as r, InMemoryAttachmentStore as t };
