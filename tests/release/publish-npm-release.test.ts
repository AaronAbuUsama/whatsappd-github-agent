import { describe, expect, it } from "vite-plus/test";

import { publishNpmRelease, type ReleaseCommand } from "../../scripts/publish-npm-release.ts";

describe("npm release publishing", () => {
  it("forces an OIDC-capable npm publish even though the project is managed by pnpm", () => {
    const commands: ReleaseCommand[] = [];
    const result = publishNpmRelease({ name: "ambient-agent", version: "0.2.0" }, (command) => {
      commands.push(command);
      return command.args[0] === "view"
        ? { status: 1, stdout: "", stderr: "E404 No match found for version 0.2.0" }
        : { status: 0, stdout: "+ ambient-agent@0.2.0", stderr: "" };
    });

    expect(result).toEqual({ published: true, tag: "latest" });
    expect(commands).toEqual([
      { executable: "npm", args: ["view", "ambient-agent@0.2.0", "version", "--json"] },
      { executable: "npm", args: ["publish", "--access", "public", "--tag", "latest"] },
    ]);
  });

  it("does not try to republish a version already present on npm", () => {
    const commands: ReleaseCommand[] = [];
    const result = publishNpmRelease({ name: "ambient-agent", version: "0.2.0" }, (command) => {
      commands.push(command);
      return { status: 0, stdout: '"0.2.0"', stderr: "" };
    });

    expect(result).toEqual({ published: false, tag: "latest" });
    expect(commands).toHaveLength(1);
  });
});
