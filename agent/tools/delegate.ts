import { defineTool } from "eve/tools";
import { z } from "zod";
import { GatewayStore } from "../lib/jobs.ts";

export default defineTool({
  description:
    "Start a long GitHub task without blocking this chat. This records durable work and returns " +
    "immediately; after it returns, call say with a brief 'on it' acknowledgement and end the turn. " +
    "The completed or failed result will arrive in a later turn for you to narrate with say.",
  inputSchema: z.object({
    kind: z.literal("github"),
    task: z.string().min(1).describe("Everything the GitHub worker needs; it cannot see this chat."),
  }),
  execute({ kind, task }, ctx) {
    const store = new GatewayStore();
    try {
      const jobId = store.enqueue({ voiceSessionId: ctx.session.id, kind, task });
      return { jobId, status: "started" as const };
    } finally {
      store.close();
    }
  },
});
