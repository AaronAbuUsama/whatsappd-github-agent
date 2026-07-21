import { describe, expect, it } from "vite-plus/test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectManagedData, prepareHostedManagedLayout } from "../../packages/installation/src/installation.ts";
import { managedPaths } from "../../packages/installation/src/paths.ts";
import { createManagedConfig } from "../../packages/installation/src/schema.ts";

describe("hosted managed-volume layout repair", () => {
  it("turns a fresh Docker-provisioned volume into a ready installation", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-layout-"));
    try {
      // Docker creates the mount point 0755 and Dokploy bind-mounts config.json 0644;
      // nothing else exists and `ambient-agent init` never runs on a hosted tenant.
      const dataDirectory = join(root, "data");
      await mkdir(dataDirectory, { mode: 0o755 });
      const paths = managedPaths({ dataDirectory });
      await writeFile(paths.config, `${JSON.stringify(createManagedConfig(["chat-42@g.us"], "acme/widgets"), null, 2)}\n`);
      await chmod(paths.config, 0o644);

      const before = await inspectManagedData({ dataDirectory });
      expect(before.state).not.toBe("ready");

      await prepareHostedManagedLayout(paths);
      const after = await inspectManagedData({ dataDirectory });
      expect(after.diagnostics).toEqual([]);
      expect(after.state).toBe("ready");

      // Repair is idempotent and keeps the private modes.
      await prepareHostedManagedLayout(paths);
      expect((await stat(paths.credentials)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.applicationDatabase)).mode & 0o777).toBe(0o600);
      expect((await inspectManagedData({ dataDirectory })).state).toBe("ready");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
