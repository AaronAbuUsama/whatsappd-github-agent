import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { registerProvider } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Duration, Effect, Layer, Queue } from "effect";
import { Hono } from "hono";

import * as Coalescer from "../../../../src/coalescer/coalescer.js";
import { configLayer } from "../../../../src/coalescer/config.js";
import type { IncomingMessage } from "../../../../src/coalescer/events.js";
import { queueEventSource } from "../../../../src/coalescer/mocks.js";
import { ambienceDoorway } from "../../../../src/ambience/doorway.js";
import { createFakeWhatsAppHost } from "../../../../src/host/fake-whatsapp-host.js";
import { configureWhatsAppHost } from "../../../../src/host/whatsapp-host.js";

const provider = registerFauxProvider({ provider: "ambience-fixture" });
const respond = (context: Context) => {
  const last = context.messages.at(-1);
  const serialized = JSON.stringify(last);
  const transcript = JSON.stringify(context.messages);
  if (last?.role === "toolResult") {
    return fauxAssistantMessage("Private speech outcome retained for the next Ambience turn.");
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

const source = await Effect.runPromise(Queue.unbounded<IncomingMessage>());
Effect.runFork(
  Effect.scoped(
    Coalescer.run.pipe(
      Effect.provide(
        Layer.mergeAll(
          queueEventSource(source),
          ambienceDoorway,
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
app.route("/", flue());

export default app;
