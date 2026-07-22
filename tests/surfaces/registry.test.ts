import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createSurfaceRegistry } from "../../packages/engine/src/surfaces/registry.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "ambient-surface-registry-"));
  roots.push(root);
  return join(root, "application.sqlite");
};

describe("Surface registry", () => {
  it("seeds configured chats once and preserves their application identity across restart", () => {
    const databasePath = fixture();
    const first = createSurfaceRegistry(databasePath);
    const seeded = first.activateConfigured("account:one", ["team@g.us", "alice@s.whatsapp.net"]);

    expect(seeded).toEqual([
      {
        id: expect.stringMatching(/^surface:[0-9a-f-]{36}$/u),
        providerAccountId: "account:one",
        providerChatId: "team@g.us",
      },
      {
        id: expect.stringMatching(/^surface:[0-9a-f-]{36}$/u),
        providerAccountId: "account:one",
        providerChatId: "alice@s.whatsapp.net",
      },
    ]);
    first.close();

    const reopened = createSurfaceRegistry(databasePath);
    expect(reopened.activateConfigured("account:one", ["team@g.us", "alice@s.whatsapp.net"])).toEqual(seeded);
    expect(reopened.activeSurface("account:one", "team@g.us")).toEqual(seeded[0]);
    expect(reopened.activeBinding(seeded[0]!.id)).toEqual(seeded[0]);
    reopened.close();
  });

  it("retires removed and replacement-account bindings without silently moving a Surface", () => {
    const registry = createSurfaceRegistry(fixture());
    const [oldTeam, removed] = registry.activateConfigured("account:old", ["team@g.us", "removed@g.us"]);

    const [replacementTeam] = registry.activateConfigured("account:new", ["team@g.us"]);

    expect(replacementTeam!.id).not.toBe(oldTeam!.id);
    expect(registry.activeBinding(oldTeam!.id)).toBeUndefined();
    expect(registry.activeBinding(removed!.id)).toBeUndefined();
    expect(registry.activeSurface("account:old", "team@g.us")).toBeUndefined();
    expect(registry.activeSurface("account:new", "team@g.us")).toEqual(replacementTeam);
    registry.close();
  });

  it("deactivates a configured chat removed from the current account", () => {
    const registry = createSurfaceRegistry(fixture());
    const [kept, removed] = registry.activateConfigured("account:one", ["kept@g.us", "removed@g.us"]);

    expect(registry.activateConfigured("account:one", ["kept@g.us"])).toEqual([kept]);
    expect(registry.activeBinding(removed!.id)).toBeUndefined();
    registry.close();
  });
});
