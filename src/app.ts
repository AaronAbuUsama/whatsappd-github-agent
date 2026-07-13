import { getRun } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import { dispatchAmbience } from "./ambience/doorway.js";
import { connectPiChatGptSubscription } from "./model/pi-subscription.js";
import {
  configureTestTaskResultSink,
  installTestTaskResultDelivery,
} from "./workflows/test-task.js";

const subscription = await connectPiChatGptSubscription();
configureTestTaskResultSink(async (chatId, input) => {
  const run = await getRun(input.runId);
  const expectedStatus = input.type === "workflow.completed" ? "completed" : "errored";
  if (run?.status !== expectedStatus) {
    throw new Error(`Test workflow ${input.runId} is not durably ${expectedStatus}`);
  }
  await dispatchAmbience({ id: chatId, input });
});
installTestTaskResultDelivery();

const app = new Hono();
app.get("/health", (context) => context.json({ ok: true, ...subscription }));
app.route("/", flue());

export default app;
