import { describe, expect, it } from "vite-plus/test";

import { installManagedRuntimeDependencies } from "../../packages/installation/src/runtime-dependencies.ts";
import { managedPaths } from "../../packages/installation/src/paths.ts";

describe("Flue database configuration", () => {
  it("uses the typed managed Flue database path rather than process.env", async () => {
    const paths = managedPaths({ dataDirectory: "/private/ambient-agent" });
    installManagedRuntimeDependencies({
      authentication: {} as never,
      configuration: {} as never,
      githubCredential: {} as never,
      paths,
      agentSandbox: {} as never,
    });
    process.env.FLUE_DB_PATH = "/external/must-not-win.sqlite";
    const { flueDatabasePath } = await import("../../apps/runtime/src/db.ts");
    expect(flueDatabasePath()).toBe(paths.flueDatabase);
    delete process.env.FLUE_DB_PATH;
  });
});
