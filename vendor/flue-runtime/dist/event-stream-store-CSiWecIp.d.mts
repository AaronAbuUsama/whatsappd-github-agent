import { t as SqlStorage } from "./sql-storage-DNzKo_Mr.mjs";

//#region src/runtime/event-stream-store.d.ts
/**
 * Format an integer sequence number as a DS-compatible offset string.
 *
 * Produces `<readSeq>_<seq>` with both components zero-padded to 16 digits,
 * matching the DS reference server's offset format. The first component is
 * always `0` (Flue uses integer sequences, not segmented files).
 */
declare function formatOffset(seq: number): string;
/**
 * Parse a DS offset string back to an integer sequence number.
 * Accepts the `<readSeq>_<seq>` format and extracts the second component.
 * Returns -1 for the sentinel `"-1"`. Throws on any other format.
 */
declare function parseOffset(offset: string): number;
interface EventStreamReadResult {
  events: Array<{
    data: unknown;
    offset: string;
  }>;
  /**
   * Resume cursor: the offset of the last event delivered in this read, or
   * the caller's effective start offset when no events were returned. Pass
   * it back as `offset` to continue reading strictly after it. This is NOT
   * the next sequence number to be assigned — the name follows the Durable
   * Streams `Stream-Next-Offset` wire field, "the offset to use for the
   * next read".
   */
  nextOffset: string;
  upToDate: boolean;
  closed: boolean;
}
interface EventStreamMeta {
  /**
   * Resume cursor: the offset of the last appended event, or `"-1"` when
   * the stream is empty. Pass it back as `offset` to read strictly after
   * it. This is NOT the next sequence number to be assigned.
   */
  nextOffset: string;
  closed: boolean;
}
interface EventStreamStore {
  /** Create a stream. Idempotent — no-op if the stream already exists. */
  createStream(path: string): Promise<void>;
  /** Append a JSON event. Returns the new offset as a zero-padded string. */
  appendEvent(path: string, event: unknown): Promise<string>;
  /**
   * Append one event under an idempotency key. An exact retry returns the
   * original offset; reusing the key with another JSON payload rejects.
   */
  appendEventOnce(path: string, key: string, event: unknown): Promise<string>;
  /** Read events starting after the given offset. */
  readEvents(path: string, opts?: {
    /** "-1" = start, "now" = tail, or an opaque offset. */offset?: string; /** Server-defined chunk size cap. */
    limit?: number;
  }): Promise<EventStreamReadResult>;
  /** Close a stream. No further appends permitted. Idempotent. */
  closeStream(path: string): Promise<void>;
  /** Get stream metadata without reading events. Returns null if the stream does not exist. */
  getStreamMeta(path: string): Promise<EventStreamMeta | null>;
  /**
   * Register a listener for new events on a stream path. Returns unsubscribe.
   *
   * This is always synchronous — it registers an in-memory callback. Listeners
   * fire for appends made through this store instance; cross-process delivery
   * is adapter-dependent and not part of the current contract.
   */
  subscribe(path: string, listener: () => void): () => void;
}
declare const DEFAULT_READ_LIMIT = 100;
declare const MAX_READ_LIMIT = 1000;
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
declare class SqliteEventStreamStore implements EventStreamStore {
  private sql;
  private listeners;
  constructor(sql: SqlStorage);
  createStream(path: string): Promise<void>;
  appendEvent(path: string, event: unknown): Promise<string>;
  appendEventOnce(path: string, key: string, event: unknown): Promise<string>;
  readEvents(path: string, opts?: {
    offset?: string;
    limit?: number;
  }): Promise<EventStreamReadResult>;
  closeStream(path: string): Promise<void>;
  getStreamMeta(path: string): Promise<EventStreamMeta | null>;
  subscribe(path: string, listener: () => void): () => void;
  private notifyListeners;
}
//#endregion
export { MAX_READ_LIMIT as a, parseOffset as c, EventStreamStore as i, EventStreamMeta as n, SqliteEventStreamStore as o, EventStreamReadResult as r, formatOffset as s, DEFAULT_READ_LIMIT as t };