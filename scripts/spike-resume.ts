/**
 * Spike (ticket #4, R1): determine HOW the loopback doorway achieves durable
 * per-chat memory. DECISION-SPEC G1/D4 assume `continuationToken = chatId`
 * resumes one durable session per chat via `eve/client`. This harness tests the
 * three candidate resume strategies against the live server and prints, for
 * each, whether the SAME server session is reused (sessionId) and whether the
 * conversation history actually carries (a codeword memory probe).
 *
 * Strategy 1 — same ClientSession object, two sends (one long-lived caller).
 *              This is the REAL gateway usage: one process holds the session.
 * Strategy 2 — persist SessionState (incl. sessionId) from turn 1, rebuild a
 *              fresh Client + resume from that state. Simulates a cold restart
 *              that persisted its cursor (D6 SQLite).
 * Strategy 3 — continuationToken ALONE via a fresh Client.session(token).
 *              This is what the DoD's "run the script twice with the same token"
 *              literally does across cold processes.
 *
 * Usage: tsx scripts/spike-resume.ts
 * Env:   EVE_URL full server URL; else built from PORT (eve's default is 3000)
 *
 * Acts as a gate: exits non-zero unless strategies 1 & 2 carry history and
 * strategy 3 (token-only) does not — i.e. the documented resume finding holds.
 */
import { Client } from "eve/client";
import type { SessionState } from "eve/client";

const host = process.env.EVE_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`;

const CODEWORD = "BANANA-42";
const PLANT = `Please remember this codeword for later: ${CODEWORD}. Just acknowledge in one short sentence.`;
const PROBE = "What was the codeword I gave you earlier? Reply with ONLY the codeword, nothing else.";

async function turn(client: Client, sel: SessionState | string, message: string) {
  const session = client.session(sel);
  const resp = await session.send({ message });
  const result = await resp.result();
  return {
    sessionId: result.sessionId,
    status: result.status,
    reply: (result.message ?? "").trim(),
    state: session.state,
  };
}

const remembered = (reply: string) => reply.toUpperCase().includes(CODEWORD);

type Outcome = { label: string; sameSession: boolean; remembered: boolean; reply: string };

function formatRow(o: Outcome, a: { sessionId: string }, b: { sessionId: string }): string {
  return `${o.label.padEnd(24)}| sess1=${a.sessionId.slice(-8)} sess2=${b.sessionId.slice(-8)} same=${o.sameSession} | remembered=${o.remembered} | probeReply="${o.reply}"`;
}

async function main() {
  const client = new Client({ host });
  await client.health();
  const rows: string[] = [];
  const outcomes: Outcome[] = [];

  // ---- Strategy 1: one long-lived ClientSession, two sends on the SAME handle ----
  {
    // The whole point is reusing one handle, so this legitimately doesn't route
    // through turn() (which resolves a fresh session from a selector each call).
    const session = client.session(`s1-${process.pid}`);
    const r1 = await session.send({ message: PLANT }).then((r) => r.result());
    const r2 = await session.send({ message: PROBE }).then((r) => r.result());
    const a = { sessionId: r1.sessionId };
    const b = { sessionId: r2.sessionId };
    const reply = (r2.message ?? "").trim();
    const o: Outcome = { label: "1 same-ClientSession", sameSession: a.sessionId === b.sessionId, remembered: remembered(reply), reply };
    outcomes.push(o);
    rows.push(formatRow(o, a, b));
  }

  // ---- Strategy 2: persist SessionState, resume with a fresh Client ----
  {
    const a = await turn(client, `s2-${process.pid}`, PLANT); // plant
    // "cold restart": brand-new Client, resume from the persisted state cursor
    const b = await turn(new Client({ host }), a.state, PROBE);
    const o: Outcome = { label: "2 persisted-SessionState", sameSession: a.sessionId === b.sessionId, remembered: remembered(b.reply), reply: b.reply };
    outcomes.push(o);
    rows.push(formatRow(o, a, b));
  }

  // ---- Strategy 3: continuationToken ALONE, fresh Client each turn ----
  {
    const token = `s3-${process.pid}`;
    const a = await turn(new Client({ host }), token, PLANT);
    const b = await turn(new Client({ host }), token, PROBE);
    const o: Outcome = { label: "3 token-only cold", sameSession: a.sessionId === b.sessionId, remembered: remembered(b.reply), reply: b.reply };
    outcomes.push(o);
    rows.push(formatRow(o, a, b));
  }

  console.log("\n=== RESUME STRATEGY RESULTS (codeword=" + CODEWORD + ") ===");
  for (const r of rows) console.log(r);

  // Gate: the documented finding must hold — 1 & 2 carry history, 3 does not.
  const [s1, s2, s3] = outcomes;
  const ok = s1!.remembered && s2!.remembered && !s3!.remembered;
  if (!ok) {
    console.error(
      `\n[spike-resume] FAIL: expected remembered=[true,true,false], got ` +
        `[${s1!.remembered},${s2!.remembered},${s3!.remembered}]. The resume finding no longer holds.`,
    );
    process.exit(2);
  }
  console.log("\n[spike-resume] OK: durable resume via long-lived/persisted session; token-only does not resume.");
}

main().catch((err) => {
  console.error("[spike-resume] ERROR:", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
