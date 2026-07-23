import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { assertSupportedFlueSchemaVersion } from "@flue/runtime/adapter";

import {
  APPLICATION_DATABASE_ID,
  APPLICATION_DATABASE_SCHEMA_VERSION,
} from "@ambient-agent/engine/intake/database-versions.ts";
import { inspectGitHubCredentialComponent } from "./installation.ts";
import type { ManagedPaths } from "./paths.ts";
import {
  libsqlStore,
  tenantCredentialDatabaseFromEnvironment,
  type TenantCredentialEnvironment,
} from "./tenant-credentials.ts";

export type ManagedCheckState = "ready" | "warning" | "failed";
/** Static evidence caps at "paired"; "online" comes only from live runtime observation. */
export type WhatsAppComponentState = "re-pair-required" | "paired" | "online";
export type CredentialComponentState = "ready" | "reauthentication-required";

export interface ManagedCheck {
  readonly name:
    | "application-database"
    | "flue-database"
    | "github-access"
    | "github-credential"
    | "github-webhook-secret"
    | "whatsapp-session";
  readonly state: ManagedCheckState | WhatsAppComponentState | CredentialComponentState;
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
] as const satisfies ReadonlyArray<readonly [string, readonly string[]]>;
const LEGACY_APPLICATION_OPTIONAL_SCHEMA = [
  ["conversation_reactions", ["chat_id", "message_id", "actor_id", "emoji"]],
  ["conversation_receipts", ["chat_id", "message_id", "actor_id", "status"]],
  ["managed_chat_windows", ["window_id", "chat_id", "reason", "created_at_ms"]],
  ["managed_chat_inbox", ["inbox_sequence", "event_id", "chat_id", "window_id", "accepted_at_ms"]],
  ["managed_chat_admissions", ["window_id", "status", "dispatch_id", "accepted_at", "reason", "updated_at_ms"]],
  // Pre-ADR-0014 audit tables remain readable until the one-way migration drops them.
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
  // ADR 0015: the one-time managed-root migration records its completed move here.
  ["managed_root_migrations", ["source", "migrated_at"]],
  // The shared graph (MEMORY-STATE-SPEC §3) lives beside the archive in application.sqlite.
  [
    "graph_entities",
    [
      "entity_id",
      "type",
      "properties_json",
      "confidence",
      "source_chat_id",
      "source_message_id",
      "source_delivery_id",
      "created_at",
      "updated_at",
    ],
  ],
  [
    "graph_relations",
    [
      "relation_id",
      "from_id",
      "relation",
      "to_id",
      "confidence",
      "source_chat_id",
      "source_message_id",
      "source_delivery_id",
      "created_at",
      "updated_at",
    ],
  ],
  ["graph_identities", ["platform", "external_id", "entity_id", "display_name"]],
  [
    "graph_attestations",
    [
      "attestation_id",
      "author_kind",
      "author_id",
      "claim_kind",
      "claim_json",
      "confidence",
      "evidence_set_id",
      "evidence_ids_json",
      "batch_id",
      "attested_at",
    ],
  ],
  ["graph_projection_meta", ["singleton", "version", "rebuilt_at"]],
  // Pre-Brain delegation launch memory remains readable on upgraded installations.
  ["delegation_launches", ["run_id", "chat_id", "workflow", "launched_at", "settled_at"]],
  // One-way compatibility: runtime migrates this cursor table into Historical Replay and drops it.
  [
    "scribe_backfills",
    [
      "chat_id",
      "mode",
      "phase",
      "snapshot_high_water",
      "snapshot_unknown_time",
      "snapshot_occurred_at_ms",
      "snapshot_sequence",
      "after_sequence",
      "run_id",
      "last_error",
      "updated_at_ms",
    ],
  ],
  [
    "historical_replay_surfaces",
    [
      "chat_id",
      "mode",
      "phase",
      "snapshot_high_water",
      "snapshot_unknown_time",
      "snapshot_occurred_at_ms",
      "snapshot_sequence",
      "after_sequence",
      "run_id",
      "last_error",
      "updated_at_ms",
    ],
  ],
  ["surfaces", ["surface_id", "created_at"]],
  ["surface_bindings", ["surface_id", "provider_account_id", "provider_chat_id", "bound_at", "retired_at"]],
  ["brain_intents", ["intent_id", "source_surface_id", "interpretation", "evidence_ids_json", "admitted_at"]],
  ["brain_batches", ["batch_id", "created_at", "dispatch_id", "accepted_at", "settled_at"]],
  ["brain_inbox_inputs", ["input_id", "kind", "intent_id", "admitted_at", "batch_id"]],
  [
    "brain_knowledge_deltas",
    [
      "delta_id",
      "scribe_batch_id",
      "attestation_ids_json",
      "evidence_ids_json",
      "projection_version",
      "admitted_at",
      "batch_id",
    ],
  ],
  [
    "brain_github_events",
    [
      "event_id",
      "github_app_id",
      "delivery_id",
      "event_name",
      "action",
      "repository",
      "summary",
      "detail_json",
      "admitted_at",
      "batch_id",
    ],
  ],
  [
    "brain_effects",
    [
      "effect_id",
      "batch_id",
      "kind",
      "payload_json",
      "status",
      "dispatch_id",
      "accepted_at",
      "completed_at",
      "created_at",
    ],
  ],
  [
    "brain_specialist_launches",
    [
      "work_id",
      "batch_id",
      "source_surface_id",
      "evidence_ids_json",
      "specialist",
      "input_json",
      "requested_at",
      "status",
      "run_id",
      "accepted_at",
    ],
  ],
  [
    "brain_specialist_results",
    [
      "result_id",
      "work_id",
      "run_id",
      "source_batch_id",
      "source_surface_id",
      "evidence_ids_json",
      "specialist",
      "transport_status",
      "result_json",
      "admitted_at",
      "batch_id",
    ],
  ],
  ["brain_work_milestones", ["milestone_id", "work_id", "note", "at"]],
  [
    "surface_deliveries",
    [
      "delivery_id",
      "directive_id",
      "surface_id",
      "provider_chat_id",
      "text",
      "status",
      "provider_message_id",
      "conversation_event_id",
      "error",
      "attempted_at",
      "settled_at",
    ],
  ],
  ["scribe_batches", ["batch_id", "created_at_ms", "active_attempt_id", "completed_at_ms"]],
  [
    "scribe_observations",
    [
      "observation_sequence",
      "evidence_id",
      "occurred_at_ms",
      "source",
      "input_json",
      "admitted_at_ms",
      "batch_id",
    ],
  ],
  [
    "scribe_attempts",
    ["attempt_id", "batch_id", "status", "started_at_ms", "finished_at_ms", "error"],
  ],
  [
    "directive_outcomes",
    [
      "directive_id",
      "delivery_id",
      "surface_id",
      "status",
      "provider_message_id",
      "conversation_event_id",
      "detail",
      "settled_at",
    ],
  ],
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

const whatsappCredentialCheck = (value: unknown): ManagedCheck => {
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
        state: "paired",
        code: "whatsapp.paired",
        message:
          "The app-owned WhatsApp store contains persisted pairing evidence; liveness is unverified until the runtime connects.",
      }
    : {
        name: "whatsapp-session",
        state: "re-pair-required",
        code: "whatsapp.not-registered",
        message: "The app-owned WhatsApp store is not a registered linked session.",
        remediation: "Run ambient-agent repair whatsapp to pair again; the rest of the installation is preserved.",
      };
};

const missingWhatsAppCredentialCheck = (): ManagedCheck => ({
  name: "whatsapp-session",
  state: "re-pair-required",
  code: "whatsapp.store-missing",
  message: "No readable app-owned WhatsApp session store was found.",
  remediation: "Run ambient-agent repair whatsapp to pair again; the rest of the installation is preserved.",
});

/** Static store evidence caps at "paired"; a missing or cleared store is "re-pair-required". */
export const inspectWhatsAppSession = async (
  paths: ManagedPaths,
  environment: TenantCredentialEnvironment = process.env,
): Promise<ManagedCheck> => {
  const tenantDatabase = tenantCredentialDatabaseFromEnvironment(environment);
  if (tenantDatabase !== undefined) {
    let serialized: string | null;
    try {
      serialized = await libsqlStore(tenantDatabase).read("creds");
    } catch {
      return {
        name: "whatsapp-session",
        state: "failed",
        code: "whatsapp.store-unreadable",
        message: "The tenant WhatsApp credential store could not be read.",
        remediation: "Check the tenant database URL, scoped token, and network access, then run doctor again.",
      };
    }
    if (serialized === null) return missingWhatsAppCredentialCheck();
    try {
      return whatsappCredentialCheck(JSON.parse(serialized));
    } catch {
      return whatsappCredentialCheck(undefined);
    }
  }

  const path = `${paths.whatsapp}/creds.json`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("unsupported");
    const value = JSON.parse(await handle.readFile("utf8")) as unknown;
    return whatsappCredentialCheck(value);
  } catch {
    return missingWhatsAppCredentialCheck();
  } finally {
    await handle?.close();
  }
};

const githubCredentialCheck = async (paths: ManagedPaths): Promise<ManagedCheck> => {
  const component = await inspectGitHubCredentialComponent(paths);
  return component.state === "ready"
    ? {
        name: "github-credential",
        state: "ready",
        code: "github.credential-ready",
        message: "The three GitHub App credential files are valid private credentials.",
      }
    : {
        name: "github-credential",
        state: "reauthentication-required",
        code: "github.reauthentication-required",
        message: `The GitHub App credential files are unusable: ${component.diagnostics
          .map(({ code }) => code)
          .join(", ")}.`,
        remediation: "Run ambient-agent config --github-app <coder|reviewer|planner> and paste a fresh App triple.",
      };
};

/** Read-only local checks. Live provider checks remain explicit doctor operations. */
export const inspectManagedServices = async (
  paths: ManagedPaths,
  environment: TenantCredentialEnvironment = process.env,
): Promise<readonly ManagedCheck[]> => [
  databaseCheck("application-database", paths.applicationDatabase),
  databaseCheck("flue-database", paths.flueDatabase),
  await inspectWhatsAppSession(paths, environment),
  await githubCredentialCheck(paths),
];
