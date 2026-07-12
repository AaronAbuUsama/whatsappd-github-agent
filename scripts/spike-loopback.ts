/**
 * Spike (ticket #4, R1/R2): prove the **loopback doorway**.
 *
 * This is a plain `tsx` entry — a long-lived *background caller*, NOT an Eve
 * request handler. It reaches the running Eve server (`eve start` / `eve dev`)
 * over HTTP via the sanctioned `eve/client`, exactly as `DOORWAY-OPTIONS.md`
 * Option 1 / `DECISION-SPEC.md` G1 describe:
 *
 *     new Client({ host: "http://127.0.0.1:PORT" })
 *       .session(chatId)            // continuationToken = chatId  (D4)
 *       .send({ message })          // open-or-resume this chat's durable session
 *
 * Run it to prove a background caller gets a non-empty reply. NOTE: this alone
 * does NOT prove per-chat resume — a fixed continuationToken across cold client
 * calls starts a fresh session each time (see the spike finding). Durable resume
 * is characterized by `scripts/spike-resume.ts`; look there, not here.
 *
 * Usage:
 *   tsx scripts/spike-loopback.ts "<message>"
 * Env:
 *   EVE_URL     full server URL; else built from PORT (eve's default is 3000)
 *   SPIKE_TOKEN continuationToken / chatId (default "spike-chat-001")
 */
import { Client } from "eve/client";

const host = process.env.EVE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;
const token = process.env.SPIKE_TOKEN ?? "spike-chat-001";
const message = process.argv[2] ?? "Hello! Reply with one short sentence.";

async function main(): Promise<void> {
  const client = new Client({ host });

  // Fail fast with a clear message if the server isn't up.
  const health = await client.health();
  console.log(`[spike] server healthy: ${JSON.stringify(health)}`);

  console.log(`[spike] host=${host} token=${token}`);
  console.log(`[spike] → send: ${message}`);

  const started = Date.now();
  // continuationToken = chatId. String form == resume-by-token (client.d.ts).
  const response = await client.session(token).send({ message });
  const result = await response.result();
  const ms = Date.now() - started;

  const reply = (result.message ?? "").trim();
  console.log(`[spike] ← status=${result.status} sessionId=${result.sessionId} (${ms}ms)`);
  console.log(`[spike] ← reply: ${reply || "(empty)"}`);

  if (reply.length === 0) {
    console.error("[spike] FAIL: assistant reply was empty");
    process.exit(2);
  }
  console.log("[spike] OK: non-empty assistant reply received via loopback client");
}

main().catch((err) => {
  console.error("[spike] ERROR:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
