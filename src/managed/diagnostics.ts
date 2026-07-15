import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

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

const databaseCheck = (name: "application-database" | "flue-database", path: string): ManagedCheck => {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const rows = database.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
    const healthy = rows.length === 1 && Object.values(rows[0] ?? {})[0] === "ok";
    return healthy
      ? {
          name,
          state: "ready",
          code: "database.ready",
          message: `${name === "application-database" ? "Application" : "Flue"} database passed SQLite quick_check.`,
        }
      : {
          name,
          state: "failed",
          code: "database.integrity-failed",
          message: `${name === "application-database" ? "Application" : "Flue"} database failed SQLite quick_check.`,
          remediation: "Stop Ambient Agent, restore this database from a known-good backup, then run doctor again.",
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
    const registered = typeof value === "object" && value !== null && Reflect.get(value, "registered") === true;
    return registered
      ? {
          name: "whatsapp-session",
          state: "ready",
          code: "whatsapp.ready",
          message: "The app-owned WhatsApp credential reports a registered linked session.",
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
