import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createBrainInbox } from "../../packages/engine/src/brain/inbox.ts";
import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";
import type { ConversationArrival } from "../../packages/engine/src/intake/conversation-event.ts";

const SURFACE = "surface:team";
const CHAT = "team@g.us";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const arrival = (id: string, chatId = CHAT): ConversationArrival => ({
  id,
  kind: "arrival",
  providerMessageId: `message:${id}`,
  chatId,
  senderId: "alice@s.whatsapp.net",
  senderName: "Alice",
  direction: "inbound",
  occurredAt: 1_000,
  payload: { live: true, isGroup: true, messageKind: "text", text: "Please investigate this." },
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "ambient-brain-inbox-"));
  roots.push(root);
  const databasePath = join(root, "application.sqlite");
  const archive = createConversationArchive(databasePath);
  archive.append(arrival("evidence:2"));
  archive.append(arrival("evidence:1"));
  archive.append(arrival("other:evidence", "other@g.us"));
  archive.close();
  return databasePath;
};

const openInbox = (databasePath: string, now = () => "2026-07-22T12:00:00.000Z") =>
  createBrainInbox(databasePath, {
    providerChatIdForSurface: (surfaceId) => surfaceId === SURFACE ? CHAT : undefined,
    now,
  });

describe("Speaker Intent admission", () => {
  it("atomically admits one content-addressed Intent and returns it on exact retry", () => {
    const databasePath = fixture();
    let clock = 0;
    const inbox = openInbox(databasePath, () => `2026-07-22T12:00:0${++clock}.000Z`);

    const first = inbox.admitIntent({
      sourceSurfaceId: SURFACE,
      interpretation: "The team wants the failure investigated.",
      evidenceIds: ["evidence:2", "evidence:1"],
    });
    const retry = inbox.admitIntent({
      sourceSurfaceId: ` ${SURFACE} `,
      interpretation: " The team wants the failure investigated. ",
      evidenceIds: ["evidence:1", "evidence:2", "evidence:1"],
    });

    expect(retry).toEqual(first);
    expect(first.id).toMatch(/^intent:[a-f0-9]{64}$/u);
    expect(first.evidenceIds).toEqual(["evidence:1", "evidence:2"]);
    expect(inbox.pendingIntents()).toEqual([first]);
    inbox.close();
  });

  it("rejects missing, cross-Surface, and unbound evidence", () => {
    const inbox = openInbox(fixture());
    const draft = { sourceSurfaceId: SURFACE, interpretation: "Investigate.", evidenceIds: ["missing"] };

    expect(() => inbox.admitIntent(draft)).toThrow("does not exist");
    expect(() => inbox.admitIntent({ ...draft, evidenceIds: ["other:evidence"] })).toThrow("does not belong");
    expect(() => inbox.admitIntent({ ...draft, sourceSurfaceId: "surface:unknown" })).toThrow("no active provider binding");
    expect(inbox.pendingIntents()).toEqual([]);
    inbox.close();
  });

  it("keeps the same admitted Intent pending across restart", () => {
    const databasePath = fixture();
    const firstInbox = openInbox(databasePath);
    const admitted = firstInbox.admitIntent({
      sourceSurfaceId: SURFACE,
      interpretation: "The team wants the failure investigated.",
      evidenceIds: ["evidence:1"],
    });
    firstInbox.close();

    const reopened = openInbox(databasePath, () => "2099-01-01T00:00:00.000Z");
    expect(reopened.intent(admitted.id)).toEqual(admitted);
    expect(reopened.pendingIntents()).toEqual([admitted]);
    reopened.close();
  });

  it("rolls back the immutable Intent when its inbox reference cannot be inserted", () => {
    const databasePath = fixture();
    const inbox = openInbox(databasePath);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TRIGGER reject_brain_inbox_input
      BEFORE INSERT ON brain_inbox_inputs
      BEGIN SELECT RAISE(ABORT, 'injected inbox failure'); END;
    `);
    database.close();

    expect(() => inbox.admitIntent({
      sourceSurfaceId: SURFACE,
      interpretation: "The team wants the failure investigated.",
      evidenceIds: ["evidence:1"],
    })).toThrow("injected inbox failure");
    expect(inbox.pendingIntents()).toEqual([]);
    inbox.close();

    const forensic = new DatabaseSync(databasePath, { readOnly: true });
    expect(forensic.prepare("SELECT count(*) AS count FROM brain_intents").get()).toEqual({ count: 0 });
    forensic.close();
  });
});
