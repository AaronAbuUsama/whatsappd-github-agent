import { afterEach, describe, expect, it, vi } from "vitest";

const initLogger = vi.fn();
const braintrustFlueObserver = vi.fn();
const observe = vi.fn(() => () => {});

vi.mock("braintrust", () => ({ initLogger, braintrustFlueObserver }));
vi.mock("@flue/runtime", () => ({ observe }));

const { configureBraintrustTracing } = await import("../../packages/engine/src/braintrust.ts");

describe("configureBraintrustTracing (#252)", () => {
  afterEach(() => vi.clearAllMocks());

  it("stays off and registers nothing when no API key is supplied", () => {
    // tracing.enabled = false is expressed by the caller passing no key; blank counts as none.
    expect(configureBraintrustTracing()).toBe(false);
    expect(configureBraintrustTracing({ apiKey: "   " })).toBe(false);
    expect(initLogger).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it("registers the Flue observer and initializes the logger with the key and project", () => {
    expect(configureBraintrustTracing({ apiKey: "secret", project: { name: "P", id: "42" } })).toBe(true);
    expect(initLogger).toHaveBeenCalledWith({ projectName: "P", projectId: "42", apiKey: "secret" });
    expect(observe).toHaveBeenCalledTimes(1);
  });

  it("defaults the project name to Flue when none is configured", () => {
    configureBraintrustTracing({ apiKey: "secret" });
    expect(initLogger).toHaveBeenCalledWith({ projectName: "Flue", projectId: undefined, apiKey: "secret" });
  });

  it("ignores BRAINTRUST_* in the environment — tracing follows config only (#252 negative)", () => {
    // The spec negative: BRAINTRUST_TRACING=1 in the environment with tracing disabled in config
    // must leave tracing OFF. Config-disabled is expressed by the caller passing no key; the env
    // vars below must have no effect at all, proving the module-load env read is gone.
    const previous = { tracing: process.env.BRAINTRUST_TRACING, key: process.env.BRAINTRUST_API_KEY };
    process.env.BRAINTRUST_TRACING = "1";
    process.env.BRAINTRUST_API_KEY = "env-secret";
    try {
      expect(configureBraintrustTracing()).toBe(false);
      expect(initLogger).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
    } finally {
      if (previous.tracing === undefined) delete process.env.BRAINTRUST_TRACING;
      else process.env.BRAINTRUST_TRACING = previous.tracing;
      if (previous.key === undefined) delete process.env.BRAINTRUST_API_KEY;
      else process.env.BRAINTRUST_API_KEY = previous.key;
    }
  });
});
