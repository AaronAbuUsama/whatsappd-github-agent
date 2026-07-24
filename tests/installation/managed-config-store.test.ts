import { describe, expect, it } from "vite-plus/test";

import { createManagedConfigStore } from "../../packages/installation/src/managed-config-store.ts";
import { createManagedConfig } from "../../packages/installation/src/schema.ts";

const CHAT = "team@g.us";

const baseConfig = () => {
  const config = createManagedConfig([CHAT], "acme/widgets");
  // A non-authorization knob, to prove it is carried but never applied by a reload.
  return { ...config, runtime: { ...config.runtime, port: 3737 } };
};

describe("DB-backed managed configuration store (#179)", () => {
  it("round-trips a full validated configuration through the single row", () => {
    const store = createManagedConfigStore(":memory:");
    store.replace(baseConfig());

    const current = store.current();
    expect(current.managedChats).toEqual([CHAT]);
    expect(current.github.allowedRepositories).toEqual(["acme/widgets"]);
    // The full config — including restart-only knobs like the port — survives the round-trip.
    expect(current.runtime.port).toBe(3737);
    store.close();
  });

  it("throws rather than reloading silently when no configuration has been seeded", () => {
    const store = createManagedConfigStore(":memory:");
    expect(() => store.current()).toThrow("no configuration row");
    store.close();
  });

  it("re-validates against ManagedConfigSchema on write, refusing a malformed configuration", () => {
    const store = createManagedConfigStore(":memory:");
    const invalid = { ...baseConfig(), managedChats: ["not-a-jid"] };
    expect(() => store.replace(invalid as never)).toThrow();
    // The refused write left no row behind.
    expect(() => store.current()).toThrow("no configuration row");
    store.close();
  });
});
