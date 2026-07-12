/**
 * Spike (ticket #4, R2): prove ONE process can host both the Eve server AND
 * long-lived background code that drives the loopback doorway.
 *
 * `defineInstrumentation().setup` is invoked once, in the server process, at
 * startup (via eve's generated instrumentation Nitro plugin — see
 * `harness/instrumentation-config.d.ts`). That makes it the in-process boot
 * hook R2 asks for: the eventual gateway (whatsappd connection + Coalescer)
 * starts here, under `eve start`, in the same process that serves HTTP.
 *
 * For the spike, `setup` starts a detached background task (NOT awaited, NOT a
 * request handler) that calls the app's OWN HTTP front door via `eve/client` —
 * proving a long-lived background caller inside the server process can open a
 * session over the loopback doorway. Gated behind `R2_SPIKE=1` so normal boots
 * (and the hand-rolled path) are completely unaffected: with the flag unset,
 * this file is an inert, no-op instrumentation definition.
 */
import { defineInstrumentation } from "eve/instrumentation";

async function runR2BackgroundCaller(agentName: string): Promise<void> {
  const { Client } = await import("eve/client");
  // The server sets PORT in its own process (eve start → NITRO_PORT/PORT).
  const port = process.env.PORT ?? process.env.NITRO_PORT ?? "3000";
  const host = process.env.EVE_URL ?? `http://127.0.0.1:${port}`;
  const client = new Client({ host });

  // Wait for our own HTTP server to accept connections (setup runs before the
  // listener is necessarily ready). This is a background loop, not a handler.
  const MAX_HEALTH_ATTEMPTS = 40;
  const HEALTH_RETRY_MS = 250;
  let healthy = false;
  for (let attempt = 0; attempt < MAX_HEALTH_ATTEMPTS; attempt++) {
    try {
      await client.health();
      healthy = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, HEALTH_RETRY_MS));
    }
  }
  if (!healthy) {
    console.error(
      `[R2-BOOT] FAILED: server did not become healthy at ${host} after ` +
        `${MAX_HEALTH_ATTEMPTS} attempts (${(MAX_HEALTH_ATTEMPTS * HEALTH_RETRY_MS) / 1000}s)`,
    );
    return;
  }

  try {
    const resp = await client
      .session("r2-boot-selfcall")
      .send({ message: `Reply with exactly: R2 loopback ok for ${agentName}` });
    const result = await resp.result();
    console.log(
      `[R2-BOOT] in-process background caller got reply (status=${result.status}, session=${result.sessionId}): ${(
        result.message ?? ""
      ).trim()}`,
    );
  } catch (err) {
    console.error("[R2-BOOT] FAILED:", err instanceof Error ? err.message : err);
  }
}

export default defineInstrumentation({
  // Off-label but purpose-built as the R2 proof: a real server-startup, in-process hook.
  setup({ agentName }) {
    if (process.env.R2_SPIKE !== "1") return;
    console.log(`[R2-BOOT] instrumentation setup fired in server process (agent=${agentName}); starting background caller`);
    // Detached on purpose: this models the long-lived gateway, not request work.
    void runR2BackgroundCaller(agentName);
  },
});
