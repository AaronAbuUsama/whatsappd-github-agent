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

  it("keeps a Brain-opened direct DM alive across a boot re-activation, and stays fail-closed for others", () => {
    const databasePath = fixture();
    const registry = createSurfaceRegistry(databasePath);
    registry.activateConfigured("account:one", ["team@g.us"]);
    // The Brain deliberately opens a known person's DM (never a configured chat).
    const dm = registry.activateDirect("account:one", "204663831932940@lid");
    expect(registry.activeSurface("account:one", "204663831932940@lid")).toEqual(dm); // admit ⇒ two-way.
    registry.close();

    // Restart: activateConfigured re-runs before pending-prompt recovery. The direct DM must survive it —
    // a configured chat that was removed does not, and a chat never opened stays closed.
    const reopened = createSurfaceRegistry(databasePath);
    reopened.activateConfigured("account:one", ["team@g.us"]);
    expect(reopened.activeSurface("account:one", "204663831932940@lid")).toEqual(dm); // survived retirement.
    expect(reopened.activeBinding(dm.id)).toEqual(dm); // recovery's deliverPrompt still resolves the Surface.
    expect(reopened.activeSurface("account:one", "stranger@g.us")).toBeUndefined(); // never opened ⇒ rejected.

    // activateDirect is idempotent and never downgrades a configured binding.
    expect(reopened.activateDirect("account:one", "204663831932940@lid")).toEqual(dm);
    reopened.close();
  });

  it("makes a removed-configured chat reopened as a direct DM genuinely retirable", () => {
    const registry = createSurfaceRegistry(fixture());
    registry.activateConfigured("account:one", ["dm@s.whatsapp.net"]); // configured...
    registry.activateConfigured("account:one", []); // ...then removed → retired, still kind='configured'.
    expect(registry.activeSurface("account:one", "dm@s.whatsapp.net")).toBeUndefined();

    // Reopened via the person path: the revived row must become 'direct', not stay 'configured'.
    const reopened = registry.activateDirect("account:one", "dm@s.whatsapp.net");
    expect(registry.activeSurface("account:one", "dm@s.whatsapp.net")).toEqual(reopened);

    // retireDirect (the admission-rollback path) actually retires it — which only works if kind='direct'.
    registry.retireDirect("account:one", "dm@s.whatsapp.net");
    expect(registry.activeSurface("account:one", "dm@s.whatsapp.net")).toBeUndefined();
    registry.close();
  });

  it("retires a direct DM when the paired account is replaced, not merely restarted", () => {
    const registry = createSurfaceRegistry(fixture());
    registry.activateConfigured("account:A", ["team@g.us"]);
    const dm = registry.activateDirect("account:A", "204663831932940@lid");
    expect(registry.activeSurface("account:A", "204663831932940@lid")).toEqual(dm);

    // Re-pairing to a DIFFERENT account retires the previous account's direct bindings (§8: replacing the
    // account retires old bindings rather than silently moving them) — so a stale DM never delivers through
    // the new session.
    registry.activateConfigured("account:B", ["team@g.us"]);
    expect(registry.activeSurface("account:A", "204663831932940@lid")).toBeUndefined();
    expect(registry.activeBinding(dm.id)).toBeUndefined();
    registry.close();
  });
});
