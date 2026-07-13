import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { registerProvider } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

const provider = registerFauxProvider({ provider: "ambience-fixture" });
provider.setResponses([
  fauxAssistantMessage("private working note one"),
  fauxAssistantMessage("private working note two"),
]);
const model = provider.getModel();
registerProvider("openai-codex", {
  api: model.api,
  apiKey: "fixture-only-token",
  baseUrl: model.baseUrl,
});

const app = new Hono();
app.get("/health", (context) => context.json({ ok: true }));
app.route("/", flue());

export default app;
