/**
 * WhatsApp connectivity dry-run — proves a credential store actually connects,
 * WITHOUT sending or reading anything. Points whatsappd at a store directory,
 * reports the connection phase it reaches, then disconnects. Use it to verify a
 * pairing before you wire the bot into a group.
 *
 *   npx tsx scripts/whatsapp-dry-run.ts [store-dir]
 *
 * store-dir defaults to $WHATSAPP_STORE_DIR or ./.wa-auth. A completed pairing
 * reaches `online`; an unregistered/empty store stops at `pairing` (a QR or
 * pairing code is required — this script only OBSERVES, it never completes the
 * link, sends a message, or marks anything read).
 */
import { createSession, fileStore, qrAuth } from "whatsappd";

const dir = process.argv[2] ?? process.env.WHATSAPP_STORE_DIR ?? "./.wa-auth";
const DEADLINE_MS = Number(process.env.DRY_RUN_TIMEOUT_MS ?? 30_000);

const session = createSession({ store: fileStore(dir), auth: qrAuth() });
let done = false;

async function finish(code: number, why: string): Promise<void> {
  if (done) return;
  done = true;
  console.log(`\n[dry-run] ${why}`);
  try {
    await session.stop();
  } catch {
    /* stop() is best-effort on the way out */
  }
  process.exit(code);
}

session.onStatus((s) => {
  if (s.phase === "pairing") {
    console.log(
      `[dry-run] status: pairing (step: ${s.pairing.step}) — a QR/pairing code is required; not completing it here.`,
    );
    void finish(
      0,
      "Reached the pairing gate: whatsappd connected to WhatsApp and requested a device link. " +
        "These creds are NOT a completed pairing — scan a QR / enter a pairing code to finish (tutorial §5).",
    );
    return;
  }
  console.log(`[dry-run] status: ${s.phase}`);
  if (s.phase === "online") {
    const id = session.identity();
    void finish(
      0,
      `ONLINE — connected as ${id?.jid ?? "?"} (${id?.pushName ?? id?.phoneE164 ?? ""}). No messages sent. Creds are valid.`,
    );
  } else if (s.phase === "logged_out" || s.phase === "suspended") {
    void finish(1, `Terminal: ${s.phase} (${s.reason}). Creds are dead — re-pair.`);
  }
});

setTimeout(
  () => void finish(0, `Timed out after ${DEADLINE_MS}ms without reaching online — see the phases above.`),
  DEADLINE_MS,
);

console.log(`[dry-run] connecting with store: ${dir} (send-nothing probe)…`);
session.start().catch((e: unknown) => void finish(1, `start() failed: ${e instanceof Error ? e.message : String(e)}`));
