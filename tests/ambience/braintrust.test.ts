import { describe, expect, it } from "vitest";

import { braintrustTracingEnabled } from "@ambient-agent/core/braintrust.ts";

describe("Braintrust production tracing configuration", () => {
  it("requires both an API key and explicit tracing opt-in", () => {
    expect(braintrustTracingEnabled({ BRAINTRUST_API_KEY: "secret" })).toBe(false);
    expect(braintrustTracingEnabled({ BRAINTRUST_TRACING: "1" })).toBe(false);
    expect(braintrustTracingEnabled({ BRAINTRUST_API_KEY: "secret", BRAINTRUST_TRACING: "1" })).toBe(true);
  });
});
