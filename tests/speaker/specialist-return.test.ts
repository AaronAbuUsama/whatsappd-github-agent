import { describe, expect, it } from "vite-plus/test";

import { installManagedRuntimeDependencies } from "../../packages/installation/src/runtime-dependencies.ts";
import { createManagedConfig } from "../../packages/installation/src/schema.ts";
import { resolveSpecialistReturnChat } from "../../packages/installation/src/specialist-return.ts";

describe("resolveSpecialistReturnChat", () => {
  const install = (managedChats: readonly string[], defaultRepository: string): void => {
    installManagedRuntimeDependencies({
      authentication: {} as never,
      configuration: createManagedConfig(managedChats, defaultRepository),
      githubCredential: {} as never,
      paths: {} as never,
      agentSandbox: {} as never,
    });
  };

  it("resolves the managed default repository to the first managed thread", () => {
    install(["home@g.us", "other@g.us"], "acme/widgets");
    expect(resolveSpecialistReturnChat("acme/widgets")).toBe("home@g.us");
  });

  it("matches the default repository case-insensitively", () => {
    install(["home@g.us"], "acme/widgets");
    expect(resolveSpecialistReturnChat("ACME/Widgets")).toBe("home@g.us");
  });

  it("returns undefined for a repository that is not the managed default", () => {
    install(["home@g.us"], "acme/widgets");
    expect(resolveSpecialistReturnChat("other/repo")).toBeUndefined();
  });
});
