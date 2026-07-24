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
   * Find-or-create one active Surface bound to a single chat, without retiring any other binding.
   * Unlike `activateConfigured` (the operator's whole authorized set), this opens exactly one
   * Surface on demand — the seam for the Brain deliberately reaching a known Person's DM. It is
   * never called from ingress, so it grants no participation to an observed/discovered chat.
   */
  readonly activateDirect: (providerAccountId: string, providerChatId: string) => SurfaceBinding;
  /**
   * Retire a direct DM binding — the compensating undo when prompt admission opened one but then failed
   * to record the Prompt Effect, so an unaccepted DM never leaves an active binding that would admit
   * inbound messages. Only ever touches `kind = 'direct'`; a configured binding is never retired here.
   */
  readonly retireDirect: (providerAccountId: string, providerChatId: string) => void;
  readonly activeSurface: (providerAccountId: string, providerChatId: string) => SurfaceBinding | undefined;
  readonly activeBinding: (surfaceId: string) => SurfaceBinding | undefined;
  readonly close: () => void;
}

interface BindingRow {
  readonly surface_id: string;
  readonly provider_account_id: string;
  readonly provider_chat_id: string;
  readonly retired_at?: string | null;
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

  // `kind` distinguishes an operator-configured binding from a Brain-opened direct DM. activateConfigured
  // retires only 'configured' bindings on re-activation; a 'direct' DM the Brain deliberately opened must
  // survive boot (else a pending direct-DM prompt loses its Surface during recovery). Existing rows predate
  // direct DMs and are all 'configured'.
  // ponytail: an orphaned 'direct' binding never reused lingers; add a retire-idle sweep only if they pile up.
  const hasKind = (database.prepare("PRAGMA table_info(surface_bindings)").all() as { name: string }[]).some(
    (column) => column.name === "kind",
  );
  if (!hasKind) {
    database.exec("ALTER TABLE surface_bindings ADD COLUMN kind TEXT NOT NULL DEFAULT 'configured'");
  }

  // Retire every active binding EXCEPT a direct DM of the account now being configured: a same-account
  // restart preserves the DMs the Brain opened, but replacing the paired account retires its predecessor's
  // direct bindings too (§8: replacing the account retires old bindings rather than silently moving them).
  const retireActive = database.prepare(
    "UPDATE surface_bindings SET retired_at = ? WHERE retired_at IS NULL AND (kind = 'configured' OR provider_account_id != ?)",
  );
  const selectAny = database.prepare(`
    SELECT surface_id, provider_account_id, provider_chat_id, retired_at
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
  // activateConfigured (re)claims a binding as 'configured' — upgrading one first opened as a direct DM,
  // so it re-enters the retire-able configured set once the operator authorizes its chat.
  const reactivateAsConfigured = database.prepare(`
    UPDATE surface_bindings SET retired_at = NULL, bound_at = ?, kind = 'configured' WHERE surface_id = ?
  `);
  // activateDirect revives a RETIRED row as a Brain-opened DM: it becomes 'direct' regardless of its prior
  // kind, so a removed-then-reopened chat is genuinely retirable via retireDirect (the rollback path).
  const reactivateAsDirect = database.prepare(`
    UPDATE surface_bindings SET retired_at = NULL, bound_at = ?, kind = 'direct' WHERE surface_id = ?
  `);
  const retireDirectBinding = database.prepare(
    "UPDATE surface_bindings SET retired_at = ? WHERE provider_account_id = ? AND provider_chat_id = ? AND kind = 'direct' AND retired_at IS NULL",
  );
  const insertSurface = database.prepare("INSERT INTO surfaces (surface_id, created_at) VALUES (?, ?)");
  const insertBinding = database.prepare(`
    INSERT INTO surface_bindings
      (surface_id, provider_account_id, provider_chat_id, bound_at, retired_at, kind)
    VALUES (?, ?, ?, ?, NULL, ?)
  `);

  return {
    activateConfigured: (rawAccountId, rawChatIds) => {
      const providerAccountId = required(rawAccountId, "Provider account id");
      const providerChatIds = [...new Set(rawChatIds.map((chatId) => required(chatId, "Provider chat id")))];
      const now = new Date().toISOString();
      const active: SurfaceBinding[] = [];

      database.exec("BEGIN IMMEDIATE");
      try {
        retireActive.run(now, providerAccountId);
        for (const providerChatId of providerChatIds) {
          const existing = selectAny.get(providerAccountId, providerChatId) as BindingRow | undefined;
          if (existing !== undefined) {
            reactivateAsConfigured.run(now, existing.surface_id);
            active.push(hydrate(existing));
            continue;
          }

          const surfaceId = `surface:${randomUUID()}`;
          insertSurface.run(surfaceId, now);
          insertBinding.run(surfaceId, providerAccountId, providerChatId, now, "configured");
          active.push({ id: surfaceId, providerAccountId, providerChatId });
        }
        database.exec("COMMIT");
        return active;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    activateDirect: (rawAccountId, rawChatId) => {
      const providerAccountId = required(rawAccountId, "Provider account id");
      const providerChatId = required(rawChatId, "Provider chat id");
      const now = new Date().toISOString();
      database.exec("BEGIN IMMEDIATE");
      try {
        const existing = selectAny.get(providerAccountId, providerChatId) as BindingRow | undefined;
        if (existing !== undefined) {
          // A currently-active binding is left exactly as-is — never downgrade a live operator-configured
          // Surface to 'direct' (and resolveEntitySurface won't roll back an already-live DM anyway). A
          // RETIRED row, whatever its prior kind, is revived AS 'direct' so this Brain-opened DM is retirable.
          if (existing.retired_at == null) reactivate.run(now, existing.surface_id);
          else reactivateAsDirect.run(now, existing.surface_id);
          database.exec("COMMIT");
          return hydrate(existing);
        }
        const surfaceId = `surface:${randomUUID()}`;
        insertSurface.run(surfaceId, now);
        insertBinding.run(surfaceId, providerAccountId, providerChatId, now, "direct");
        database.exec("COMMIT");
        return { id: surfaceId, providerAccountId, providerChatId };
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    retireDirect: (rawAccountId, rawChatId) => {
      retireDirectBinding.run(
        new Date().toISOString(),
        required(rawAccountId, "Provider account id"),
        required(rawChatId, "Provider chat id"),
      );
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
