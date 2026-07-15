import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

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
});
