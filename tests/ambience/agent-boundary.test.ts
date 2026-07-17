import { describe, expect, it } from "vite-plus/test";

import * as ambienceModule from "@ambient-agent/core/agents/ambience.ts";

describe("Ambience admission boundary", () => {
  it("does not expose the production agent through an unauthenticated HTTP route", () => {
    expect(ambienceModule).not.toHaveProperty("route");
  });
});
