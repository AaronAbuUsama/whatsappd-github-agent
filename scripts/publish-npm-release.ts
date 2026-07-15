import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReleaseCommand {
  readonly executable: "npm";
  readonly args: readonly string[];
}

interface ReleaseCommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

type RunReleaseCommand = (command: ReleaseCommand) => ReleaseCommandResult;

interface PackageRelease {
  readonly name: string;
  readonly version: string;
}

type PublishNpmReleaseResult =
  | { readonly published: false; readonly tag: string }
  | { readonly published: true; readonly tag: string; readonly changesetsTagAnnouncement: string };

const distTag = (version: string): string => version.split("-", 2)[1]?.split(".", 1)[0] ?? "latest";

export const publishNpmRelease = (release: PackageRelease, run: RunReleaseCommand): PublishNpmReleaseResult => {
  const tag = distTag(release.version);
  const existing = run({
    executable: "npm",
    args: ["view", `${release.name}@${release.version}`, "version", "--json"],
  });
  if (existing.status === 0) {
    if (JSON.parse(existing.stdout) === release.version) return { published: false, tag };
    throw new Error(`npm returned an unexpected version while checking ${release.name}@${release.version}.`);
  }
  if (!`${existing.stdout}\n${existing.stderr}`.match(/E404|No match found for version/)) {
    throw new Error(`npm could not determine whether ${release.name}@${release.version} is already published.`);
  }

  const published = run({
    executable: "npm",
    args: ["publish", "--access", "public", "--tag", tag],
  });
  if (published.status !== 0) {
    throw new Error(`npm failed to publish ${release.name}@${release.version}.`);
  }
  return {
    published: true,
    tag,
    changesetsTagAnnouncement: `New tag: ${release.name}@${release.version}`,
  };
};

const runCli = (): void => {
  const release = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageRelease;
  const result = publishNpmRelease(release, ({ executable, args }) => {
    const command = spawnSync(executable, args, { encoding: "utf8" });
    if (args[0] === "publish") {
      process.stdout.write(command.stdout ?? "");
      process.stderr.write(command.stderr ?? "");
    }
    return {
      status: command.status ?? 1,
      stdout: command.stdout ?? "",
      stderr: command.stderr ?? command.error?.message ?? "",
    };
  });
  if (result.published) console.log(result.changesetsTagAnnouncement);
  else console.log(`${release.name}@${release.version} is already published.`);
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) runCli();
