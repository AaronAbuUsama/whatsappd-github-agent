import { describe, expect, it } from "vite-plus/test";

import * as speakerModule from "../../packages/agents/src/speaker/agent.ts";

describe("Speaker admission boundary", () => {
  it("does not expose the production agent through an unauthenticated HTTP route", () => {
    expect(speakerModule).not.toHaveProperty("route");
  });
});
