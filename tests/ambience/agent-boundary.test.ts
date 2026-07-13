import { describe, expect, it } from "vitest";

import * as ambienceModule from "../../src/agents/ambience.js";

describe("Ambience admission boundary", () => {
  it("does not expose the production agent through an unauthenticated HTTP route", () => {
    expect(ambienceModule).not.toHaveProperty("route");
  });
});
