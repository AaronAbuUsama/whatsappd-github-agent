/**
 * In-process boot hook (issue #6, on #4's R2 mechanism).
 *
 * `defineInstrumentation().setup` runs once, in the server process, at startup
 * (via eve's generated instrumentation Nitro plugin). That makes it the boot
 * hook the gateway needs: the whatsappd connection + Coalescer start here, under
 * `eve start`, in the same process that serves HTTP — so the coalesced windows
 * can fire back into the agent over the loopback doorway (`eve/client`).
 *
 * `setup` is not an ALS-scoped request handler, so it starts the gateway as a
 * detached background task (the #4 R2 finding: a long-lived caller inside the
 * server process can open sessions over the loopback door). It is gated behind
 * `WA_GATEWAY=1` so ordinary boots — a bare `eve dev`, a CI `eve build`, the
 * sidecar-channel path — never try to open a WhatsApp connection (which would
 * block on QR pairing). Turn it on when you actually want the always-on bot:
 *
 *     WA_GATEWAY=1 WHATSAPP_GROUP_ID=<jid@g.us> pnpm start
 *
 * The gateway itself (agent/gateway.ts) reads the WhatsApp store dir, chat gate,
 * bot LID, and loopback port from the environment, mirroring `pnpm run live`.
 */
import { Effect } from "effect";
import { defineInstrumentation } from "eve/instrumentation";

export default defineInstrumentation({
  setup({ agentName }) {
    if (process.env.WA_GATEWAY !== "1") return;
    // setup is a plain lifecycle callback (no Effect runtime yet); route the one boot
    // line through Effect's logger for a consistent format with the gateway program.
    Effect.runSync(Effect.logInfo(`gateway boot: instrumentation setup fired (agent=${agentName})`));
    // Detached on purpose: this is the always-on WhatsApp connection, not request work.
    // Imported dynamically so a boot with WA_GATEWAY unset never pulls whatsappd/Baileys
    // (and its native connection machinery) into the process.
    void import("./gateway.ts").then(({ startGateway }) => startGateway(agentName));
  },
});
