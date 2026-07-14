import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { getRun, registerProvider } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Duration, Effect, Layer, Queue } from "effect";
import { Hono } from "hono";

import * as Coalescer from "../../../../src/coalescer/coalescer.js";
import { configLayer } from "../../../../src/coalescer/config.js";
import type { IncomingMessage } from "../../../../src/coalescer/events.js";
import { queueEventSource } from "../../../../src/coalescer/mocks.js";
import { ambienceAdmission, dispatchAmbience } from "../../../../src/ambience/admission.js";
import { createGitHubIngress, loadGitHubIngressSettings } from "../../../../src/github/ingress.js";
import { configureGitHubIngressRuntime } from "../../../../src/github/ingress-runtime.js";
import { createGitHubIngressStore } from "../../../../src/github/ingress-store.js";
import { configureGitHubProofRuntime, createGitHubProofPolicy } from "../../../../src/github/proof-runtime.js";
import {
  createControllableGitHubProofGate,
  createFakeGitHubProofHost,
} from "../../../../src/host/fake-github-proof-host.js";
import { createFakeWhatsAppHost } from "../../../../src/host/fake-whatsapp-host.js";
import { configureWhatsAppHost } from "../../../../src/host/whatsapp-host.js";
import {
  configureGitHubProofResultSink,
  installGitHubProofResultDelivery,
} from "../../../../src/workflows/github-proof.js";

const provider = registerFauxProvider({ provider: "ambience-fixture" });
const heldRecoveryMarkers = new Set<string>();
const holdAgentRecovery = process.env.AMBIENCE_FIXTURE_HOLD_AGENT_RECOVERY === "true";
const respond = async (context: Context) => {
  const last = context.messages.at(-1);
  const serialized = JSON.stringify(last);
  const transcript = JSON.stringify(context.messages);
  const recoveryMarker = serialized.match(/HOLD_AGENT_FOR_RESTART:([A-Za-z0-9_-]+)/)?.[1];
  if (recoveryMarker && holdAgentRecovery) {
    heldRecoveryMarkers.add(recoveryMarker);
    await new Promise<never>(() => undefined);
  }
  if (recoveryMarker) {
    return fauxAssistantMessage(
      transcript.includes(`HOLD_AGENT_FOR_RESTART:${recoveryMarker}`)
        ? `Recovered canonical context for ${recoveryMarker}.`
        : `Canonical context was lost for ${recoveryMarker}.`,
    );
  }
  if (last?.role === "toolResult") {
    if (serialized.includes("start_github_proof")) {
      const runId = serialized.match(/\"runId\"\s*:\s*\"([^\"]+)\"/)?.[1] ?? "missing-run-id";
      return fauxAssistantMessage(`Private workflow admission settled with runId ${runId}.`);
    }
    if (serialized.includes("run_disposable_github_issue_proof")) {
      return fauxAssistantMessage("Private GitHub specialist retained the observed proof receipt.");
    }
    return fauxAssistantMessage("Private speech outcome retained for the next Ambience turn.");
  }
  if (serialized.includes("START_GITHUB_PROOF")) {
    return fauxAssistantMessage(
      fauxToolCall("start_github_proof", { repository: "acme/widgets" }),
      { stopReason: "toolUse" },
    );
  }
  if (serialized.includes("Run the bounded disposable GitHub issue proof")) {
    return fauxAssistantMessage(
      fauxToolCall("run_disposable_github_issue_proof", {}),
      { stopReason: "toolUse" },
    );
  }
  if (serialized.includes("WHILE_WORKFLOW_HELD")) {
    return fauxAssistantMessage("Private Ambience turn settled while the workflow remained active.");
  }
  if (serialized.includes("workflow.completed")) {
    return fauxAssistantMessage("Private GitHub workflow completion input processed by the same Ambience instance.");
  }
  if (serialized.includes("workflow.uncertain")) {
    return fauxAssistantMessage("Private GitHub workflow uncertainty input processed by the same Ambience instance.");
  }
  if (serialized.includes("workflow.failed")) {
    return fauxAssistantMessage("Private GitHub workflow failure input processed by the same Ambience instance.");
  }
  if (serialized.includes("github.issue.opened")) {
    return fauxAssistantMessage("Private verified GitHub delivery processed without speaking.");
  }
  if (serialized.includes("SPEAK_ONCE")) {
    return fauxAssistantMessage(fauxToolCall("say", { text: "one explicit outbound" }), { stopReason: "toolUse" });
  }
  if (serialized.includes("FAIL_SEND")) {
    return fauxAssistantMessage(fauxToolCall("say", { text: "uncertain outbound" }), { stopReason: "toolUse" });
  }
  if (serialized.includes("first coalesced input")) return fauxAssistantMessage("private working note one");
  if (serialized.includes("second coalesced input")) return fauxAssistantMessage("private working note two");
  if (serialized.includes("A_SECOND")) {
    return fauxAssistantMessage(
      transcript.includes("A_FIRST") ? "Chat A retained its first window in context." : "Chat A context was lost.",
    );
  }
  if (serialized.includes("B_ONLY")) {
    return fauxAssistantMessage(
      transcript.includes("A_FIRST") ? "Chat B leaked Chat A context." : "Chat B remained isolated from Chat A.",
    );
  }
  return fauxAssistantMessage("Private ambient context retained without speaking.");
};
provider.setResponses(Array.from({ length: 100 }, () => respond));
const model = provider.getModel();
registerProvider("openai-codex", {
  api: model.api,
  apiKey: "fixture-only-token",
  baseUrl: model.baseUrl,
});

const fakeWhatsApp = createFakeWhatsAppHost();
configureWhatsAppHost(fakeWhatsApp);
const githubIngress = loadGitHubIngressSettings();
const githubIngressStore = createGitHubIngressStore(githubIngress.databasePath);
configureGitHubIngressRuntime(
  createGitHubIngress({
    store: githubIngressStore,
    routes: githubIngress.routes,
    admit: async (chatId, input) => await dispatchAmbience({ id: chatId, input }),
  }),
);
const workflowGate = createControllableGitHubProofGate();
const fakeGitHub = createFakeGitHubProofHost({ gate: workflowGate });
configureGitHubProofRuntime({
  host: fakeGitHub,
  policy: createGitHubProofPolicy("acme/widgets", ["acme/widgets"]),
});
configureGitHubProofResultSink(async (chatId, input) => {
  const run = await getRun(input.runId);
  const expectedStatus = input.type === "workflow.failed" ? "errored" : "completed";
  if (run?.status !== expectedStatus) {
    throw new Error(`GitHub proof workflow ${input.runId} is not durably ${expectedStatus}`);
  }
  await dispatchAmbience({ id: chatId, input });
});
installGitHubProofResultDelivery();

const source = await Effect.runPromise(Queue.unbounded<IncomingMessage>());
Effect.runFork(
  Effect.scoped(
    Coalescer.run.pipe(
      Effect.provide(
        Layer.mergeAll(
          queueEventSource(source),
          ambienceAdmission,
          configLayer({ botIds: ["bot@s.whatsapp.net"], debounceWindow: Duration.millis(25) }),
        ),
      ),
    ),
  ),
);

const app = new Hono();
app.get("/health", (context) => context.json({ ok: true }));
app.post("/test/coalescer", async (context) => {
  const input = await context.req.json<IncomingMessage>();
  await Effect.runPromise(Queue.offer(source, input));
  return context.json({ accepted: true }, 202);
});
app.get("/test/whatsapp/events", (context) => context.json(fakeWhatsApp.events()));
app.delete("/test/whatsapp/events", (context) => {
  fakeWhatsApp.reset();
  return context.body(null, 204);
});
app.post("/test/whatsapp/fail-next-send", (context) => {
  fakeWhatsApp.failNextSend(new Error("provider outcome unknown"));
  return context.body(null, 204);
});
app.get("/test/github/events", (context) => context.json(fakeGitHub.events()));
app.get("/test/github/ingress", (context) => context.json(githubIngressStore.list()));
app.delete("/test/github/events", (context) => {
  fakeGitHub.reset();
  return context.body(null, 204);
});
app.post("/test/github/fail-next-create", (context) => {
  fakeGitHub.failNextCreate(new Error("GitHub rejected the mutation"));
  return context.body(null, 204);
});
app.post("/test/github/timeout-next-create", (context) => {
  fakeGitHub.timeoutNextCreate({ afterMutation: context.req.query("afterMutation") === "true" });
  return context.body(null, 204);
});
app.get("/test/model/recovery-pending", (context) => context.json({ markers: [...heldRecoveryMarkers] }));
app.get("/test/workflows/pending", async (context) => context.json({ operationIds: await workflowGate.pending() }));
app.post("/test/workflows/:operationId/release", (context) => {
  workflowGate.release(context.req.param("operationId"));
  return context.body(null, 204);
});
app.get("/test/runs/:runId", async (context) => {
  const run = await getRun(context.req.param("runId"));
  return run ? context.json(run) : context.json({ error: "run not found" }, 404);
});
app.route("/", flue());

export default app;
