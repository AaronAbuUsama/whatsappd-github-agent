import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveAgentSandbox } from "../../packages/installation/src/agent-sandbox.ts";
import { E2B_WORKSPACES_ROOT } from "../../packages/installation/src/e2b-sandbox.ts";
import { managedPaths, type ManagedPaths } from "../../packages/installation/src/paths.ts";
import { createManagedConfig, e2bCredentialFrom, type RuntimeSandbox } from "../../packages/installation/src/schema.ts";
import { parseSandboxKind } from "../../apps/cli/src/lifecycle.ts";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

/** A real managed data directory with credentials/, for tests that write credentials/e2b.json. */
const seedManagedRoot = async (): Promise<ManagedPaths> => {
  const root = await mkdtemp(join(tmpdir(), "aa-sandbox-e2b-"));
  roots.push(root);
  const paths = managedPaths({ dataDirectory: root });
  await mkdir(paths.credentials, { recursive: true });
  return paths;
};

const configWith = (sandbox: RuntimeSandbox) => ({
  ...createManagedConfig(["120363000@g.us"], "owner/repo"),
  runtime: { port: 3000, sandbox, tracing: { enabled: false } },
});

describe("resolveAgentSandbox (#251)", () => {
  it("resolves the local sandbox against the host workspaces and creates its TMPDIR before first use", async () => {
    const root = await mkdtemp(join(tmpdir(), "aa-sandbox-local-"));
    roots.push(root);
    const paths = managedPaths({ dataDirectory: root });

    const resolved = await resolveAgentSandbox(configWith({ kind: "local" }), paths, {});

    // The local sandbox pairs with the host workspaces root, not the E2B in-VM path.
    expect(resolved.workspacesRoot).toBe(paths.workspaces);
    expect(typeof resolved.sandbox.createSessionEnv).toBe("function");
    // The #172 workspace-local TMPDIR exists before any command names it, so a noexec /tmp
    // cannot fail the repo's install or tests.
    await expect(stat(join(paths.workspaces, ".tmp")).then((s) => s.isDirectory())).resolves.toBe(true);
  });

  it("resolves the e2b sandbox against its in-VM root, reading the key from credentials/e2b.json (#252)", async () => {
    const paths = await seedManagedRoot();
    await writeFile(paths.e2bCredential, `${JSON.stringify(e2bCredentialFrom("e2b_test_key"))}\n`);
    const resolved = await resolveAgentSandbox(configWith({ kind: "e2b" }), paths, {});
    expect(resolved.workspacesRoot).toBe(E2B_WORKSPACES_ROOT);
    expect(typeof resolved.sandbox.createSessionEnv).toBe("function");
  });

  it("ignores a stale E2B_API_KEY in the environment and warns rather than adopting it (#252 carry-over)", async () => {
    const paths = await seedManagedRoot();
    await writeFile(paths.e2bCredential, `${JSON.stringify(e2bCredentialFrom("from_credentials"))}\n`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const resolved = await resolveAgentSandbox(configWith({ kind: "e2b" }), paths, { E2B_API_KEY: "garbage" });
      expect(resolved.workspacesRoot).toBe(E2B_WORKSPACES_ROOT);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/E2B_API_KEY.*ignored/u));
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses to resolve when e2b is selected but credentials/e2b.json is absent — the sandbox-misconfigured negative", async () => {
    // The absent credential must fail loudly even with a garbage env value present, rather than
    // silently adopting the environment (the exact substitution #252 removes).
    const paths = await seedManagedRoot();
    await expect(resolveAgentSandbox(configWith({ kind: "e2b" }), paths, { E2B_API_KEY: "garbage" })).rejects.toThrow(
      /e2b\.json/u,
    );
  });

  it("validates the --sandbox selector", () => {
    expect(parseSandboxKind("local")).toBe("local");
    expect(parseSandboxKind("e2b")).toBe("e2b");
    expect(() => parseSandboxKind("docker")).toThrow(/local or e2b/u);
  });
});
