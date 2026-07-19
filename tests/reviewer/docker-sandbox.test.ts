import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { reviewerDockerSandbox } from "../../packages/installation/src/reviewer-docker-sandbox.ts";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("Reviewer Docker sandbox", () => {
  it("runs commands through the configured container boundary and rejects path escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewer-docker-sandbox-"));
    roots.push(root);
    const docker = join(root, "docker");
    await writeFile(docker, `#!/bin/sh
if [ "$1" = "rm" ]; then exit 0; fi
while [ "$1" != "sh" ]; do
  if [ "$1" = "--env" ]; then export "$2"; shift 2
  elif [ "$1" = "--name" ] || [ "$1" = "--network" ] || [ "$1" = "--mount" ] || [ "$1" = "--workdir" ]; then shift 2
  else shift
  fi
done
exec sh -c "$3"
`);
    await chmod(docker, 0o700);
    const env = await reviewerDockerSandbox({
      root,
      cwd: "/workspace",
      image: "reviewer-fixture",
      executable: docker,
    }).createSessionEnv({ id: "review-42" });

    await expect(env.exec("printf '%s:%s:%s' \"$BOUNDARY\" \"$npm_config_store_dir\" \"$pnpm_config_store_dir\"", { env: { BOUNDARY: "container" } })).resolves.toEqual({
      stdout: "container:/tmp/pnpm-store:/tmp/pnpm-store",
      stderr: "",
      exitCode: 0,
    });
    await expect(env.readFile("/etc/passwd")).rejects.toThrow("escapes /workspace");
  });

  it("rejects safely when Docker exits before consuming stdin", async () => {
    const root = await mkdtemp(join(tmpdir(), "reviewer-docker-sandbox-"));
    roots.push(root);
    const docker = join(root, "docker");
    await writeFile(docker, "#!/bin/sh\nexit 23\n");
    await chmod(docker, 0o700);
    const env = await reviewerDockerSandbox({
      root,
      cwd: "/workspace",
      image: "missing-reviewer-image",
      executable: docker,
    }).createSessionEnv({ id: "review-early-exit" });

    await expect(env.writeFile("/workspace/package.tgz", new Uint8Array(8 * 1024 * 1024))).rejects.toThrow();
  });
});
