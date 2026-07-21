import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveAgentSandbox } from "../../packages/installation/src/agent-sandbox.ts";
import { managedPaths } from "../../packages/installation/src/paths.ts";
import { createManagedConfig } from "../../packages/installation/src/schema.ts";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const localConfig = () => ({
  ...createManagedConfig(["120363000@g.us"], "owner/repo"),
  runtime: { port: 3000, sandbox: { kind: "local" as const }, tracing: { enabled: false } },
});

/**
 * The model-independent half of the T3 pre-flight (#251): prove the resolved local sandbox can
 * actually run the model's shell — the layer the one-box plan calls "the path that has never
 * worked". This needs no model, no GitHub, and no key, so the owner can run it on capxul-vps to
 * de-risk the redeploy before spending a model run. The Coder-writes-a-PR half is the live gate.
 */
describe("local agent sandbox shell (#251 pre-flight, model-independent)", () => {
  it("runs a real command and spawns a binary out of the workspace-local TMPDIR (#172)", async () => {
    const root = await mkdtemp(join(tmpdir(), "aa-preflight-local-"));
    roots.push(root);
    const paths = managedPaths({ dataDirectory: root });

    const { sandbox, workspacesRoot } = await resolveAgentSandbox(localConfig(), paths, process.env);
    expect(workspacesRoot).toBe(paths.workspaces);
    const env = await sandbox.createSessionEnv({ id: "preflight" });

    // TMPDIR points inside the workspace tree, not /tmp (the #172 fix).
    const tmp = (await env.exec("printf %s \"$TMPDIR\"")).stdout.trim();
    expect(tmp).toBe(join(paths.workspaces, ".tmp"));

    // The #172 scenario: the model's tools write an executable into TMPDIR and run it. On a
    // noexec /tmp this fails EACCES; pointed at the workspace tree it succeeds.
    const spawned = await env.exec(
      `printf '#!/bin/sh\\necho ran-from-tmpdir\\n' > "$TMPDIR/probe.sh" && chmod +x "$TMPDIR/probe.sh" && "$TMPDIR/probe.sh"`,
    );
    expect(spawned.exitCode).toBe(0);
    expect(spawned.stdout.trim()).toBe("ran-from-tmpdir");

    // A real interpreter resolves on PATH inside the sandbox (local() keeps the host PATH).
    const node = await env.exec("node --version");
    expect(node.exitCode).toBe(0);
    expect(node.stdout.trim()).toMatch(/^v\d+\./u);
  });
});
