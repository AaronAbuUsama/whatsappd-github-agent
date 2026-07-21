import { describe, expect, it } from "vite-plus/test";

import { route as discoveredRoute } from "../../apps/runtime/src/agents/scribe.ts";
import { route as packagedRoute } from "../../packages/agents/src/scribe/agent.ts";
import {
  acceptsScribeDirectToken,
  scribeDirectBaseUrl,
  scribeDirectToken,
} from "../../packages/agents/src/scribe/direct-access.ts";

describe("Scribe private direct access", () => {
  it("uses the configured runtime port for loopback prompts", () => {
    expect(scribeDirectBaseUrl(4_321)).toBe("http://127.0.0.1:4321");
  });

  it("exports the authenticated route through the generated-server discovery shim", () => {
    expect(discoveredRoute).toBe(packagedRoute);
    expect(acceptsScribeDirectToken(`Bearer ${scribeDirectToken()}`)).toBe(true);
    expect(acceptsScribeDirectToken("Bearer wrong-token")).toBe(false);
  });
});
