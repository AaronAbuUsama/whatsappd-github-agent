import { describe, expect, it } from "vite-plus/test";

import { installManagedRuntimeDependencies } from "@ambient-agent/core/managed/runtime-dependencies.ts";
import { managedPaths } from "@ambient-agent/core/managed/paths.ts";

describe("Flue database configuration", () => {
  it("uses the typed managed Flue database path rather than process.env", async () => {
    const paths = managedPaths({ dataDirectory: "/private/ambient-agent" });
    installManagedRuntimeDependencies({
      authentication: {} as never,
      configuration: {} as never,
      githubCredential: {} as never,
      paths,
    });
    process.env.FLUE_DB_PATH = "/external/must-not-win.sqlite";
    const { flueDatabasePath } = await import("@ambient-agent/server/db.ts");
    expect(flueDatabasePath()).toBe(paths.flueDatabase);
    delete process.env.FLUE_DB_PATH;
  });
});
