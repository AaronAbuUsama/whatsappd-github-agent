import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { assertSupportedFlueSchemaVersion } from "@flue/runtime/adapter";

import { APPLICATION_DATABASE_ID, APPLICATION_DATABASE_SCHEMA_VERSION } from "./database-versions.js";
import type { ManagedPaths } from "./paths.js";

export type ManagedCheckState = "ready" | "warning" | "failed";

export interface ManagedCheck {
  readonly name:
    | "application-database"
    | "flue-database"
    | "github-access"
    | "github-webhook-secret"
    | "whatsapp-session";
  readonly state: ManagedCheckState;
  readonly code: string;
  readonly message: string;
  readonly remediation?: string;
}

const pragmaInteger = (database: DatabaseSync, pragma: "application_id" | "user_version"): number => {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>;
  const value = row[pragma];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`Invalid ${pragma}`);
  return value;
};

const userTableNames = (database: DatabaseSync): readonly string[] =>
  (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ readonly name: string }>
  ).map(({ name }) => name);

const hasColumns = (database: DatabaseSync, table: string, required: readonly string[]): boolean => {
  const columns = new Set(
    (database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ readonly name: string }>).map(
      ({ name }) => name,
    ),
  );
  return required.every((column) => columns.has(column));
};

const LEGACY_APPLICATION_CORE_SCHEMA = [
  [
    "conversation_events",
    [
      "event_id",
      "kind",
      "provider_message_id",
      "chat_id",
      "sender_id",
      "sender_name",
      "direction",
      "occurred_at_ms",
      "payload_json",
      "created_at",
    ],
  ],
  [
    "conversation_messages",
    ["chat_id", "message_id", "direction", "sender_id", "sender_name", "kind", "text", "timestamp_ms", "revoked"],
  ],
  ["conversation_reactions", ["chat_id", "message_id", "actor_id", "emoji"]],
  ["conversation_receipts", ["chat_id", "message_id", "actor_id", "status"]],
] as const satisfies ReadonlyArray<readonly [string, readonly string[]]>;
const LEGACY_APPLICATION_OPTIONAL_SCHEMA = [
  ["managed_chat_windows", ["window_id", "chat_id", "reason", "created_at_ms"]],
  ["managed_chat_inbox", ["inbox_sequence", "event_id", "chat_id", "window_id", "accepted_at_ms"]],
  [
    "managed_chat_admissions",
    ["window_id", "status", "attempt_id", "dispatch_id", "accepted_at", "reason", "updated_at_ms"],
  ],
  ["managed_chat_admission_resolutions", ["window_id", "attempt_id", "resolution", "operator_reason", "resolved_at"]],
  ["managed_chat_admission_examinations", ["window_id", "attempt_id", "examined_at"]],
  [
    "github_ingress_deliveries",
    [
      "delivery_id",
      "event_name",
      "repository",
      "chat_id",
      "ambience",
      "dispatch_id",
      "status",
      "error",
      "received_at",
      "settled_at",
    ],
  ],
  ["github_ingress_migrations", ["migration_id", "completed_at"]],
  [
    "github_issue_operations",
    ["operation_id", "kind", "repository", "status", "issue_number", "error", "started_at", "settled_at"],
  ],
  ["github_issue_operation_examinations", ["operation_id", "examined_at"]],
] as const satisfies ReadonlyArray<readonly [string, readonly string[]]>;
const LEGACY_APPLICATION_SCHEMA = new Map<string, readonly string[]>([
  ...LEGACY_APPLICATION_CORE_SCHEMA,
  ...LEGACY_APPLICATION_OPTIONAL_SCHEMA,
]);

const applicationTableShapeCompatible = (database: DatabaseSync): boolean => {
  const tables = userTableNames(database);
  if (tables.length === 0) return true;
  if (tables.some((table) => !LEGACY_APPLICATION_SCHEMA.has(table))) return false;
  if (!LEGACY_APPLICATION_CORE_SCHEMA.every(([table, columns]) => hasColumns(database, table, columns))) {
    return false;
  }
  return tables.every((table) => hasColumns(database, table, LEGACY_APPLICATION_SCHEMA.get(table)!));
};

const applicationSchemaCompatible = (database: DatabaseSync): boolean => {
  const applicationId = pragmaInteger(database, "application_id");
  const schemaVersion = pragmaInteger(database, "user_version");
  const shippedUnversionedPredecessor =
    applicationId === 0 && schemaVersion === 0 && applicationTableShapeCompatible(database);
  const current =
    applicationId === APPLICATION_DATABASE_ID &&
    schemaVersion === APPLICATION_DATABASE_SCHEMA_VERSION &&
    applicationTableShapeCompatible(database);
  return shippedUnversionedPredecessor || current;
};

const flueSchemaCompatible = (database: DatabaseSync): boolean => {
  const tables = userTableNames(database);
  if (!tables.includes("flue_meta")) return tables.length === 0;
  if (tables.some((name) => !name.startsWith("flue_"))) return false;
  const row = database.prepare("SELECT value FROM flue_meta WHERE key = 'schema_version'").get() as
    | { readonly value: unknown }
    | undefined;
  if (typeof row?.value !== "string") return false;
  try {
    assertSupportedFlueSchemaVersion(row.value);
    return true;
  } catch {
    return false;
  }
};

const databaseCheck = (name: "application-database" | "flue-database", path: string): ManagedCheck => {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const rows = database.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const healthy = rows.length === 1 && Object.values(rows[0] ?? {})[0] === "ok";
    if (!healthy) {
      return {
        name,
        state: "failed",
        code: "database.integrity-failed",
        message: `${name === "application-database" ? "Application" : "Flue"} database failed SQLite quick_check.`,
        remediation: "Stop Ambient Agent, restore this database from a known-good backup, then run doctor again.",
      };
    }
    let compatible = false;
    try {
      compatible =
        name === "application-database" ? applicationSchemaCompatible(database) : flueSchemaCompatible(database);
    } catch {
      // A malformed schema is incompatible even when SQLite can open the file.
    }
    return compatible
      ? {
          name,
          state: "ready",
          code: "database.ready",
          message: `${name === "application-database" ? "Application" : "Flue"} database passed SQLite quick_check and schema compatibility.`,
        }
      : {
          name,
          state: "failed",
          code: "database.schema-incompatible",
          message: `${name === "application-database" ? "Application" : "Flue"} database schema is not compatible with this Ambient Agent version.`,
          remediation: "Keep Ambient Agent stopped and use a runtime version compatible with this complete backup.",
        };
  } catch {
    return {
      name,
      state: "failed",
      code: "database.unreadable",
      message: `${name === "application-database" ? "Application" : "Flue"} database could not be opened read-only.`,
      remediation: "Stop Ambient Agent, check the file and its permissions, then run doctor again.",
    };
  } finally {
    database?.close();
  }
};

const whatsappSessionCheck = async (path: string): Promise<ManagedCheck> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("unsupported");
    const value = JSON.parse(await handle.readFile("utf8")) as unknown;
    const identity = typeof value === "object" && value !== null ? Reflect.get(value, "me") : undefined;
    const linkedIdentity =
      typeof identity === "object" &&
      identity !== null &&
      typeof Reflect.get(identity, "id") === "string" &&
      Reflect.get(identity, "id").trim().length > 0;
    const registered =
      typeof value === "object" && value !== null && (Reflect.get(value, "registered") === true || linkedIdentity);
    return registered
      ? {
          name: "whatsapp-session",
          state: "ready",
          code: "whatsapp.ready",
          message:
            "The app-owned WhatsApp credential contains persisted registration or linked-account identity evidence.",
        }
      : {
          name: "whatsapp-session",
          state: "warning",
          code: "whatsapp.not-registered",
          message: "The app-owned WhatsApp credential is not a registered linked session.",
          remediation: "Run ambient-agent init on a new installation, or repair the linked device before starting.",
        };
  } catch {
    return {
      name: "whatsapp-session",
      state: "warning",
      code: "whatsapp.credential-missing",
      message: "No readable app-owned WhatsApp session credential was found.",
      remediation: "Run ambient-agent init on a new installation, or repair the linked device before starting.",
    };
  } finally {
    await handle?.close();
  }
};

/** Read-only local checks. Live provider checks remain explicit doctor operations. */
export const inspectManagedServices = async (paths: ManagedPaths): Promise<readonly ManagedCheck[]> => [
  databaseCheck("application-database", paths.applicationDatabase),
  databaseCheck("flue-database", paths.flueDatabase),
  await whatsappSessionCheck(`${paths.whatsapp}/creds.json`),
];
