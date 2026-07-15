import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createConversationArchive } from "../../src/intake/conversation-archive.ts";
import { APPLICATION_DATABASE_ID, APPLICATION_DATABASE_SCHEMA_VERSION } from "../../src/managed/database-versions.ts";
import { inspectManagedServices } from "../../src/managed/diagnostics.ts";
import { managedPaths } from "../../src/managed/paths.ts";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("managed service diagnostics", () => {
  it("checks both SQLite files and only the WhatsApp registration fact", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-diagnostics-"));
    roots.push(root);
    const paths = managedPaths({ dataDirectory: root });
    await mkdir(paths.whatsapp, { mode: 0o700 });
    await Promise.all([
      writeFile(paths.applicationDatabase, ""),
      writeFile(paths.flueDatabase, ""),
      writeFile(
        join(paths.whatsapp, "creds.json"),
        JSON.stringify({ registered: true, privateNoise: "must-not-escape" }),
      ),
    ]);

    const checks = await inspectManagedServices(paths);
    expect(checks.map(({ state }) => state)).toEqual(["ready", "ready", "ready"]);
    expect(JSON.stringify(checks)).not.toContain("must-not-escape");
  });

  it("recognizes a persisted WhatsApp Web linked-device identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-diagnostics-linked-"));
    roots.push(root);
    const paths = managedPaths({ dataDirectory: root });
    await mkdir(paths.whatsapp, { mode: 0o700 });
    await Promise.all([
      writeFile(paths.applicationDatabase, ""),
      writeFile(paths.flueDatabase, ""),
      writeFile(
        join(paths.whatsapp, "creds.json"),
        JSON.stringify({ registered: false, me: { id: "linked-device-identity-must-not-escape" } }),
      ),
    ]);

    const checks = await inspectManagedServices(paths);
    expect(checks).toContainEqual(
      expect.objectContaining({ name: "whatsapp-session", state: "ready", code: "whatsapp.ready" }),
    );
    expect(JSON.stringify(checks)).not.toContain("linked-device-identity-must-not-escape");
  });

  it("reports a missing WhatsApp credential without creating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-diagnostics-missing-"));
    roots.push(root);
    const paths = managedPaths({ dataDirectory: root });
    await mkdir(paths.whatsapp, { mode: 0o700 });
    await Promise.all([writeFile(paths.applicationDatabase, ""), writeFile(paths.flueDatabase, "")]);

    await expect(inspectManagedServices(paths)).resolves.toContainEqual(
      expect.objectContaining({ name: "whatsapp-session", state: "warning", code: "whatsapp.credential-missing" }),
    );
  });

  it("accepts the shipped unversioned application schema by positive table evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-diagnostics-legacy-"));
    roots.push(root);
    const paths = managedPaths({ dataDirectory: root });
    await mkdir(paths.whatsapp, { mode: 0o700 });
    await Promise.all([
      writeFile(paths.applicationDatabase, ""),
      writeFile(paths.flueDatabase, ""),
      writeFile(join(paths.whatsapp, "creds.json"), JSON.stringify({ registered: true })),
    ]);
    createConversationArchive(paths.applicationDatabase).close();

    await expect(inspectManagedServices(paths)).resolves.toEqual([
      expect.objectContaining({ name: "application-database", state: "ready" }),
      expect.objectContaining({ name: "flue-database", state: "ready" }),
      expect.objectContaining({ name: "whatsapp-session", state: "ready" }),
    ]);
  });

  it("rejects foreign populated databases that do not carry positive owned-schema evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-diagnostics-foreign-"));
    roots.push(root);
    const paths = managedPaths({ dataDirectory: root });
    await mkdir(paths.whatsapp, { mode: 0o700 });
    await Promise.all([
      writeFile(paths.applicationDatabase, ""),
      writeFile(paths.flueDatabase, ""),
      writeFile(join(paths.whatsapp, "creds.json"), JSON.stringify({ registered: true })),
    ]);
    const application = new DatabaseSync(paths.applicationDatabase);
    application.exec(`
      PRAGMA application_id = ${APPLICATION_DATABASE_ID};
      PRAGMA user_version = ${APPLICATION_DATABASE_SCHEMA_VERSION};
      CREATE TABLE foreign_state (id INTEGER PRIMARY KEY);
    `);
    application.close();
    const flue = new DatabaseSync(paths.flueDatabase);
    flue.exec("CREATE TABLE foreign_state (id INTEGER PRIMARY KEY)");
    flue.close();

    const checks = await inspectManagedServices(paths);
    expect(checks.filter(({ code }) => code === "database.schema-incompatible").map(({ name }) => name)).toEqual([
      "application-database",
      "flue-database",
    ]);
  });

  it("rejects a malformed known table beside an otherwise valid legacy application schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-diagnostics-partial-"));
    roots.push(root);
    const paths = managedPaths({ dataDirectory: root });
    await mkdir(paths.whatsapp, { mode: 0o700 });
    await Promise.all([
      writeFile(paths.applicationDatabase, ""),
      writeFile(paths.flueDatabase, ""),
      writeFile(join(paths.whatsapp, "creds.json"), JSON.stringify({ registered: true })),
    ]);
    createConversationArchive(paths.applicationDatabase).close();
    const application = new DatabaseSync(paths.applicationDatabase);
    application.exec(`
      PRAGMA application_id = ${APPLICATION_DATABASE_ID};
      PRAGMA user_version = ${APPLICATION_DATABASE_SCHEMA_VERSION};
      CREATE TABLE managed_chat_inbox (fake TEXT);
    `);
    application.close();

    await expect(inspectManagedServices(paths)).resolves.toContainEqual(
      expect.objectContaining({
        name: "application-database",
        state: "failed",
        code: "database.schema-incompatible",
      }),
    );
  });

  it("accepts the supported ingress and operation predecessor signatures for startup migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-diagnostics-predecessors-"));
    roots.push(root);
    const paths = managedPaths({ dataDirectory: root });
    await mkdir(paths.whatsapp, { mode: 0o700 });
    await Promise.all([
      writeFile(paths.applicationDatabase, ""),
      writeFile(paths.flueDatabase, ""),
      writeFile(join(paths.whatsapp, "creds.json"), JSON.stringify({ registered: true })),
    ]);
    createConversationArchive(paths.applicationDatabase).close();
    const application = new DatabaseSync(paths.applicationDatabase);
    application.exec(`
      CREATE TABLE github_ingress_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        repository TEXT,
        chat_id TEXT,
        ambience TEXT,
        dispatch_id TEXT,
        status TEXT NOT NULL,
        error TEXT,
        received_at TEXT NOT NULL,
        settled_at TEXT
      ) STRICT;
      CREATE TABLE github_issue_operations (
        operation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        repository TEXT NOT NULL,
        status TEXT NOT NULL,
        issue_number INTEGER,
        error TEXT,
        started_at TEXT NOT NULL,
        settled_at TEXT
      ) STRICT;
    `);
    application.close();

    await expect(inspectManagedServices(paths)).resolves.toContainEqual(
      expect.objectContaining({ name: "application-database", state: "ready", code: "database.ready" }),
    );
  });

  it("rejects incompatible declared application and Flue schemas before runtime startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-diagnostics-schema-"));
    roots.push(root);
    const paths = managedPaths({ dataDirectory: root });
    await mkdir(paths.whatsapp, { mode: 0o700 });
    await Promise.all([
      writeFile(paths.applicationDatabase, ""),
      writeFile(paths.flueDatabase, ""),
      writeFile(join(paths.whatsapp, "creds.json"), JSON.stringify({ registered: true })),
    ]);
    const application = new DatabaseSync(paths.applicationDatabase);
    application.exec(`
      PRAGMA application_id = ${APPLICATION_DATABASE_ID};
      PRAGMA user_version = ${APPLICATION_DATABASE_SCHEMA_VERSION + 1};
    `);
    application.close();
    const flue = new DatabaseSync(paths.flueDatabase);
    flue.exec(`
      CREATE TABLE flue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO flue_meta (key, value) VALUES ('schema_version', '999');
    `);
    flue.close();

    const checks = await inspectManagedServices(paths);
    expect(checks.filter(({ code }) => code === "database.schema-incompatible").map(({ name }) => name)).toEqual([
      "application-database",
      "flue-database",
    ]);
  });
});
