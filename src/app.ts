import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import { connectPiChatGptSubscription } from "./model/pi-subscription.js";

const subscription = await connectPiChatGptSubscription();

const app = new Hono();
app.get("/health", (context) => context.json({ ok: true, ...subscription }));
app.route("/", flue());

export default app;
