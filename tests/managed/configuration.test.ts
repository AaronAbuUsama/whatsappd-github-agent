import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { ensureManagedGitHubWebhookSecret, writeManagedConfiguration } from "@ambient-agent/core/managed/configuration.ts";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("managed configuration migrations", () => {
  it("adds an app-owned webhook secret without replacing the GitHub token", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-config-migration-"));
    roots.push(root);
    const path = join(root, "github.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, kind: "personal-token", token: "original-token" }), {
      mode: 0o600,
    });

    await ensureManagedGitHubWebhookSecret(path);

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schemaVersion: 1,
      kind: "personal-token",
      token: "original-token",
      webhookSecret: expect.any(String),
    });
  });

  it("leaves the previous credential byte-for-byte usable when migration cannot commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-config-migration-failure-"));
    roots.push(root);
    const path = join(root, "github.json");
    const previous = `${JSON.stringify({ schemaVersion: 1, kind: "personal-token", token: "original-token" })}\n`;
    await writeFile(path, previous, { mode: 0o600 });

    await expect(
      ensureManagedGitHubWebhookSecret(path, async () => {
        throw new Error("injected commit failure");
      }),
    ).rejects.toThrow("injected commit failure");
    await expect(readFile(path, "utf8")).resolves.toBe(previous);
  });

  it("restores both previous files when a write replaces its target and then reports failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-config-rollback-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const credentialPath = join(root, "github.json");
    const config = {
      schemaVersion: 1,
      managedChats: ["chat@g.us"],
      model: { provider: "openai-codex", credential: "chatgpt-oauth" },
      github: {
        kind: "personal-token",
        credential: "github",
        defaultRepository: "owner/old",
        allowedRepositories: ["owner/old"],
      },
    } as const;
    for (const failedPath of [credentialPath, configPath]) {
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      await writeFile(
        credentialPath,
        JSON.stringify({ schemaVersion: 1, kind: "personal-token", token: "old-token", webhookSecret: "secret" }),
        { mode: 0o600 },
      );

      let injected = false;
      await expect(
        writeManagedConfiguration(
          configPath,
          credentialPath,
          {
            ...config,
            github: {
              ...config.github,
              defaultRepository: "owner/new",
              allowedRepositories: ["owner/new"],
            },
          },
          { schemaVersion: 1, kind: "personal-token", token: "new-token", webhookSecret: "secret" },
          async (path, value) => {
            await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
            if (path === failedPath && !injected) {
              injected = true;
              throw new Error("injected post-replacement failure");
            }
          },
        ),
      ).rejects.toThrow("injected post-replacement failure");
      expect(JSON.parse(await readFile(credentialPath, "utf8"))).toMatchObject({ token: "old-token" });
      expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
        github: { defaultRepository: "owner/old" },
      });
    }
  });
});
