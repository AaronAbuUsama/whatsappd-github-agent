import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";

import { ManagedConfigSchema, type ManagedConfig } from "./schema.ts";

/**
 * The single-row, DB-backed managed-configuration store (#179). It holds the full validated
 * {@link ManagedConfig} as the re-validated live snapshot the runtime reloads its AUTHORIZATION KNOBS
 * from (managedChats, allowedRepositories, reviewRepositories) without a restart. `config.json` on disk
 * stays the durable source of truth — the real `ambient-agent config` command commits there; the store
 * is re-seeded from it at boot and refreshed from it on every reload.
 *
 * Every read re-parses through {@link ManagedConfigSchema}, so a hand-edited or partially-written row
 * is refused loudly rather than reloaded silently — the same fail-closed posture as boot config.
 */
export interface ManagedConfigStore {
  /** The current live configuration, re-validated against {@link ManagedConfigSchema}. Throws if unset or malformed. */
  current(): ManagedConfig;
  /** Overwrite the single row with a validated configuration (boot re-seed, or a committed live change). */
  replace(config: ManagedConfig): void;
  close(): void;
}

interface ConfigRow {
  config_json: string;
}

export const createManagedConfigStore = (databasePath: string): ManagedConfigStore => {
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(`
    CREATE TABLE IF NOT EXISTS managed_configuration (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `);
  const selectRow = database.prepare("SELECT config_json FROM managed_configuration WHERE id = 1");
  const upsertRow = database.prepare(`
    INSERT INTO managed_configuration (id, config_json, updated_at) VALUES (1, ?, ?)
    ON CONFLICT (id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
  `);
  return {
    current: () => {
      const row = selectRow.get() as ConfigRow | undefined;
      if (row === undefined) throw new Error("The managed configuration store has no configuration row.");
      return v.parse(ManagedConfigSchema, JSON.parse(row.config_json));
    },
    replace: (config) => {
      const validated = v.parse(ManagedConfigSchema, config);
      upsertRow.run(JSON.stringify(validated), new Date().toISOString());
    },
    close: () => database.close(),
  };
};
