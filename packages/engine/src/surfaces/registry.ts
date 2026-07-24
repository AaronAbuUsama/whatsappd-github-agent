import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SurfaceBinding {
  readonly id: string;
  readonly providerAccountId: string;
  readonly providerChatId: string;
}

export interface SurfaceRegistry {
  readonly activateConfigured: (
    providerAccountId: string,
    providerChatIds: readonly string[],
  ) => readonly SurfaceBinding[];
  /**
   * Additively activate one chat's Surface (#179 live reload) — insert it, or reactivate its existing
   * binding, WITHOUT retiring any other active Surface. Unlike {@link activateConfigured} this never
   * retires the chats absent from its argument, so a live authorization reload can register a
   * newly-allowed chat's Surface without disturbing in-flight Surfaces. Idempotent for an already-active chat.
   */
  readonly activate: (providerAccountId: string, providerChatId: string) => SurfaceBinding;
  readonly activeSurface: (providerAccountId: string, providerChatId: string) => SurfaceBinding | undefined;
  readonly activeBinding: (surfaceId: string) => SurfaceBinding | undefined;
  readonly close: () => void;
}

interface BindingRow {
  readonly surface_id: string;
  readonly provider_account_id: string;
  readonly provider_chat_id: string;
}

const required = (value: string, label: string): string => {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) throw new Error(`${label} must not be empty.`);
  return normalized;
};

const hydrate = (row: BindingRow): SurfaceBinding => ({
  id: row.surface_id,
  providerAccountId: row.provider_account_id,
  providerChatId: row.provider_chat_id,
});

export const createSurfaceRegistry = (databasePath: string): SurfaceRegistry => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS surfaces (
      surface_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS surface_bindings (
      surface_id TEXT PRIMARY KEY REFERENCES surfaces(surface_id),
      provider_account_id TEXT NOT NULL,
      provider_chat_id TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      retired_at TEXT,
      UNIQUE (provider_account_id, provider_chat_id)
    ) STRICT;
  `);

  const retireActive = database.prepare(
    "UPDATE surface_bindings SET retired_at = ? WHERE retired_at IS NULL",
  );
  const selectAny = database.prepare(`
    SELECT surface_id, provider_account_id, provider_chat_id
      FROM surface_bindings
     WHERE provider_account_id = ? AND provider_chat_id = ?
  `);
  const selectActiveSurface = database.prepare(`
    SELECT surface_id, provider_account_id, provider_chat_id
      FROM surface_bindings
     WHERE provider_account_id = ? AND provider_chat_id = ? AND retired_at IS NULL
  `);
  const selectActiveBinding = database.prepare(`
    SELECT surface_id, provider_account_id, provider_chat_id
      FROM surface_bindings
     WHERE surface_id = ? AND retired_at IS NULL
  `);
  const reactivate = database.prepare(`
    UPDATE surface_bindings SET retired_at = NULL, bound_at = ? WHERE surface_id = ?
  `);
  const insertSurface = database.prepare("INSERT INTO surfaces (surface_id, created_at) VALUES (?, ?)");
  const insertBinding = database.prepare(`
    INSERT INTO surface_bindings
      (surface_id, provider_account_id, provider_chat_id, bound_at, retired_at)
    VALUES (?, ?, ?, ?, NULL)
  `);

  return {
    activateConfigured: (rawAccountId, rawChatIds) => {
      const providerAccountId = required(rawAccountId, "Provider account id");
      const providerChatIds = [...new Set(rawChatIds.map((chatId) => required(chatId, "Provider chat id")))];
      const now = new Date().toISOString();
      const active: SurfaceBinding[] = [];

      database.exec("BEGIN IMMEDIATE");
      try {
        retireActive.run(now);
        for (const providerChatId of providerChatIds) {
          const existing = selectAny.get(providerAccountId, providerChatId) as BindingRow | undefined;
          if (existing !== undefined) {
            reactivate.run(now, existing.surface_id);
            active.push(hydrate(existing));
            continue;
          }

          const surfaceId = `surface:${randomUUID()}`;
          insertSurface.run(surfaceId, now);
          insertBinding.run(surfaceId, providerAccountId, providerChatId, now);
          active.push({ id: surfaceId, providerAccountId, providerChatId });
        }
        database.exec("COMMIT");
        return active;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    activate: (rawAccountId, rawChatId) => {
      const providerAccountId = required(rawAccountId, "Provider account id");
      const providerChatId = required(rawChatId, "Provider chat id");
      const now = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        const existing = selectAny.get(providerAccountId, providerChatId) as BindingRow | undefined;
        const binding =
          existing !== undefined
            ? (reactivate.run(now, existing.surface_id), hydrate(existing))
            : ((): SurfaceBinding => {
                const surfaceId = `surface:${randomUUID()}`;
                insertSurface.run(surfaceId, now);
                insertBinding.run(surfaceId, providerAccountId, providerChatId, now);
                return { id: surfaceId, providerAccountId, providerChatId };
              })();
        database.exec("COMMIT");
        return binding;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    activeSurface: (providerAccountId, providerChatId) => {
      const row = selectActiveSurface.get(
        required(providerAccountId, "Provider account id"),
        required(providerChatId, "Provider chat id"),
      ) as BindingRow | undefined;
      return row === undefined ? undefined : hydrate(row);
    },
    activeBinding: (surfaceId) => {
      const row = selectActiveBinding.get(surfaceId.trim()) as BindingRow | undefined;
      return row === undefined ? undefined : hydrate(row);
    },
    close: () => database.close(),
  };
};
