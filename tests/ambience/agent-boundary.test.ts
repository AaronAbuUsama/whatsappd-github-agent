import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as ambienceModule from "../../src/agents/ambience.js";

describe("Ambience admission boundary", () => {
  it("does not expose the production agent through an unauthenticated HTTP route", () => {
    expect(ambienceModule).not.toHaveProperty("route");
  });

  it("loads the repository environment for the packaged Ambience server", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["start"]).toBe(
      "node --env-file-if-exists=.env dist/server.mjs",
    );
  });
});
