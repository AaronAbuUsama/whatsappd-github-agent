import { describe, expect, it } from "vite-plus/test";

import { smokeStations } from "../../src/cli/smoke.ts";
import type { InspectionReport } from "../../src/cli/rendering.ts";
import type { ManagedPaths } from "@ambient-agent/core/managed/paths.ts";

const paths = {
  root: "/missing",
  config: "/missing/config.json",
  credentials: "/missing/credentials",
  githubCredential: "/missing/credentials/github.json",
  chatGptOAuthCredential: "/missing/credentials/chatgpt-oauth.json",
  legacyPiAuthCredential: "/missing/credentials/pi-auth.json",
  applicationDatabase: "/missing/application.sqlite",
  flueDatabase: "/missing/flue.sqlite",
  whatsapp: "/missing/whatsapp",
  logs: "/missing/logs",
} satisfies ManagedPaths;

const readyReport = {
  installation: { state: "ready", dataDirectory: paths.root, diagnostics: [] },
  authentication: { state: "ready" },
  checks: [{ name: "github-access", state: "ready", code: "github.ready", message: "GitHub access verified" }],
  observedRuntime: { state: "healthy", whatsapp: { phase: "online" } },
  liveCheck: { model: "openai-codex/gpt-5.6-luna", request: "complete" },
  uncertainWork: { health: "healthy", externalMutations: 0, total: 0, mutationKinds: {} },
  windowDeliveries: { pending: 0, failed: 0 },
} satisfies InspectionReport;

describe("smoke stations", () => {
  it("does not report a GitHub failure when only the optional config detail is unreadable", async () => {
    const stations = await smokeStations(readyReport, paths, "abc123", 30_000, async () => ({
      chatId: "120363000@g.us",
      text: "SMOKE abc123 — ignore",
      stages: ["admission", "dispatch", "settled-silent"],
    }));

    expect(stations.find(({ name }) => name === "github")).toEqual({
      name: "github",
      passed: true,
      detail: "GitHub access verified",
    });
  });

  it("reports a malformed canary receipt instead of a success detail", async () => {
    const stations = await smokeStations(readyReport, paths, "abc123", 30_000, async () => ({
      chatId: "120363000@g.us",
      text: "SMOKE wrong — ignore",
      stages: ["admission", "dispatch", "settled-silent"],
    }));

    expect(stations.find(({ name }) => name === "canary")).toEqual({
      name: "canary",
      passed: false,
      detail: "The live canary response was malformed or did not prove the required lifecycle.",
    });
  });
});
