import { describe, expect, it } from "vite-plus/test";

import {
  ambientRuntimeHealth,
  probeAmbientRuntimeHealth,
  runtimeInstallationId,
  runtimeSmokeAuthorization,
  runtimeSmokeAuthorizationMatches,
} from "@ambient-agent/core/managed/runtime-health.ts";

describe("managed runtime health", () => {
  it.each([
    ["disabled", "starting"],
    ["starting", "starting"],
    ["online", "healthy"],
    ["failed", "failed"],
    ["stopped", "stopped"],
  ] as const)("maps WhatsApp %s to aggregate %s", (phase, state) => {
    expect(ambientRuntimeHealth({ phase }).state).toBe(state);
  });

  it("returns a sanitized observed state from the bounded local health interface", async () => {
    await expect(
      probeAmbientRuntimeHealth({
        port: 4321,
        installationId: "expected-installation",
        fetch: async (input) => {
          expect(input).toBe("http://127.0.0.1:4321/health");
          return Response.json({
            ok: false,
            installationId: "expected-installation",
            runtime: {
              state: "starting",
              whatsapp: { phase: "starting", chatTarget: "private@g.us", error: "private failure" },
            },
          });
        },
      }),
    ).resolves.toEqual({ state: "starting", whatsapp: { phase: "starting" } });
  });

  it("classifies a failed local connection as stopped without process inference", async () => {
    await expect(
      probeAmbientRuntimeHealth({
        port: 3000,
        installationId: "expected-installation",
        fetch: async () => {
          throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
        },
      }),
    ).resolves.toEqual({ state: "stopped", whatsapp: { phase: "stopped" } });
  });

  it.each([
    [
      "wrong installation",
      Response.json({ installationId: "other", runtime: { state: "healthy", whatsapp: { phase: "online" } } }),
    ],
    ["malformed responder", Response.json({ ok: true })],
    ["HTTP failure", new Response("no", { status: 503 })],
  ])("classifies a %s as failed rather than stopped", async (_name, response) => {
    await expect(
      probeAmbientRuntimeHealth({
        port: 3000,
        installationId: "expected-installation",
        fetch: async () => response,
      }),
    ).resolves.toEqual({ state: "failed", whatsapp: { phase: "failed" } });
  });

  it("derives a stable correlation token without exposing the credential", () => {
    const id = runtimeInstallationId("private-webhook-secret");
    expect(id).toBe(runtimeInstallationId("private-webhook-secret"));
    expect(id).not.toContain("private-webhook-secret");
  });

  it("requires the private credential for request-scoped smoke authorization", () => {
    const authorization = runtimeSmokeAuthorization("private-webhook-secret", "abc123", 30_000);
    expect(runtimeSmokeAuthorizationMatches(authorization, "private-webhook-secret", "abc123", 30_000)).toBe(true);
    expect(
      runtimeSmokeAuthorizationMatches(
        runtimeInstallationId("private-webhook-secret"),
        "private-webhook-secret",
        "abc123",
        30_000,
      ),
    ).toBe(false);
    expect(runtimeSmokeAuthorizationMatches(authorization, "private-webhook-secret", "other", 30_000)).toBe(false);
  });
});
