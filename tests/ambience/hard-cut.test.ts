import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

const root = process.cwd();

async function exists(relativePath: string): Promise<boolean> {
  try {
    await stat(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

async function sourceFiles(relativeDirectory: string): Promise<string[]> {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return sourceFiles(relativePath);
      return entry.isFile() && relativePath.endsWith(".ts") ? [relativePath] : [];
    }),
  );
  return nested.flat();
}

describe("the post-Eve production cut", () => {
  it("keeps Flue as the server build while packaging the CLI separately", async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.dev).toBe("pnpm run build && pnpm start");
    expect(packageJson.scripts["build:server"]).toBe("flue build --target node --root packages/server --output dist");
    expect(packageJson.scripts["build:cli"]).toBe("vp pack");
    expect(packageJson.scripts.build).toBe("pnpm run build:server && pnpm run build:cli");
    expect(packageJson.scripts.start).toBe("node dist/cli/main.js start");
    expect(Object.keys(packageJson.scripts)).not.toContain("ambience:build");
    expect(Object.values(packageJson.scripts).join("\n")).not.toMatch(
      /(?:eve|src\/index\.ts|coalescer\/(?:doorway|live|repl|voice|worker)|spike-(?:loopback|resume))/,
    );
    for (const dependency of ["eve", "@ai-sdk/openai", "ai", "zod"]) {
      expect(packageJson.dependencies, dependency).not.toHaveProperty(dependency);
    }

    const lockfile = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8");
    expect(lockfile).toContain("autoInstallPeers: false");
    expect(lockfile).not.toMatch(/^  eve@/m);
    expect(lockfile).not.toMatch(/^\s+version: .+\(eve@/m);
  });

  it("deletes the Eve-only adapter and compensation machinery", async () => {
    const deletedPaths = [
      "agent/agent.ts",
      "src/index.ts",
      "src/gateway/job-runner.ts",
      "src/config/index.ts",
      "src/coalescer/doorway.ts",
      "src/coalescer/live.ts",
      "src/coalescer/model.ts",
      "src/coalescer/repl.ts",
      "src/coalescer/voice.ts",
      "src/coalescer/worker.ts",
      "scripts/spike-loopback.ts",
      "scripts/spike-resume.ts",
      "scripts/find-group-jid.ts",
    ];

    await expect(Promise.all(deletedPaths.map((relativePath) => exists(relativePath)))).resolves.toEqual(
      deletedPaths.map(() => false),
    );
  });

  it("keeps the canonical Coalescer-to-Ambience dispatch free of API-key fallback", async () => {
    const runtime = await readFile(path.join(root, "packages/server/src/host/whatsapp-runtime.ts"), "utf8");
    expect(runtime).toContain("makeAmbienceWindowDispatcher");

    const files = (
      await Promise.all(["src", "packages/core/src", "packages/server/src"].map(sourceFiles))
    ).flat();
    const productionSource = await Promise.all(
      files.map(async (relativePath) => ({
        relativePath,
        source: await readFile(path.join(root, relativePath), "utf8"),
      })),
    );

    for (const { relativePath, source } of productionSource) {
      expect(source, relativePath).not.toMatch(/from ["']eve(?:\/[^"']*)?["']/);
      expect(source, relativePath).not.toContain("OPENAI_API_KEY");
    }
  });

  it("keeps the workspace boundaries: core imports no sibling, cli and server meet only via the handshake", async () => {
    const boundaries: ReadonlyArray<readonly [string, RegExp]> = [
      // core is the foundation: it must never import the application, server, or test support
      ["packages/core/src", /@ambient-agent\/(?:server|test-support)|from ["'][^"']*\/(?:cli|setup)\//],
      // the CLI application never imports the server package (globalThis handshake only)
      ["src", /@ambient-agent\/(?:server|test-support)/],
      // the server never imports the CLI application or test support
      ["packages/server/src", /@ambient-agent\/test-support|from ["'][^"']*\/(?:cli|setup)\//],
    ];
    for (const [directory, forbidden] of boundaries) {
      for (const relativePath of await sourceFiles(directory)) {
        expect(await readFile(path.join(root, relativePath), "utf8"), relativePath).not.toMatch(forbidden);
      }
    }
  });
});
