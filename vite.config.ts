import { readFileSync } from "node:fs";
import { defineConfig } from "vite-plus";

export default defineConfig(({ mode }) => ({
  plugins:
    mode === "test"
      ? [
          {
            name: "flue-test-skill-reference",
            enforce: "pre",
            load(id) {
              if (!id.endsWith("/SKILL.md")) return;
              const frontmatter = readFileSync(id, "utf8").match(/^---\n([\s\S]*?)\n---/u)?.[1];
              const name = frontmatter?.match(/^name:\s*(.+)$/mu)?.[1]?.trim();
              const description = frontmatter?.match(/^description:\s*(.+)$/mu)?.[1]?.trim();
              if (!name || !description) throw new Error(`Test skill ${id} must declare name and description`);
              return `export default ${JSON.stringify({
                __flueSkillReference: true,
                id: `test:${name}`,
                name,
                description,
              })};`;
            },
          },
        ]
      : [],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
  },
  fmt: {
    printWidth: 120,
  },
  pack: {
    noExternal: [/^@ambient-agent\//],
    entry: {
      main: "apps/cli/src/main.ts",
      setup: "apps/runtime/src/setup-server.ts",
    },
    outDir: "dist/cli",
    format: "esm",
    platform: "node",
    target: "node22.19.0",
    fixedExtension: false,
    dts: false,
    sourcemap: true,
  },
}));
