import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createBrainInbox } from "../../packages/engine/src/brain/inbox.ts";
import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";
import type { ConversationArrival } from "../../packages/engine/src/intake/conversation-event.ts";
import { wakeBrain } from "../../packages/agents/src/brain/dispatch.ts";

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

  it("claims one immutable Brain Batch and recovers its exact membership after restart", () => {
    const databasePath = fixture();
    const inbox = openInbox(databasePath);
    const firstIntent = inbox.admitIntent({
      sourceSurfaceId: SURFACE,
      interpretation: "Investigate the first failure.",
      evidenceIds: ["evidence:1"],
    });
    const secondIntent = inbox.admitIntent({
      sourceSurfaceId: SURFACE,
      interpretation: "Investigate the second failure.",
      evidenceIds: ["evidence:2"],
    });

    const claimed = inbox.claimBatch(1);
    expect(claimed).toEqual({
      id: expect.stringMatching(/^brain-batch:[a-f0-9]{64}$/u),
      createdAt: "2026-07-22T12:00:00.000Z",
      intents: [firstIntent],
    });
    expect(inbox.pendingIntents()).toEqual([secondIntent]);
    inbox.close();

    const reopened = openInbox(databasePath, () => "2099-01-01T00:00:00.000Z");
    expect(reopened.claimBatch(50)).toEqual(claimed);
    expect(reopened.pendingIntents()).toEqual([secondIntent]);
    reopened.close();
  });

  it("wakes the one global Brain once for an admitted Batch", async () => {
    const inbox = openInbox(fixture());
    const intent = inbox.admitIntent({
      sourceSurfaceId: SURFACE,
      interpretation: "Ask what failure the team means.",
      evidenceIds: ["evidence:1"],
    });
    const requests: unknown[] = [];

    const first = await wakeBrain(inbox, async (request) => {
      requests.push(request);
      return { dispatchId: "dispatch:brain:1", acceptedAt: "2026-07-22T12:01:00.000Z" };
    });
    expect(requests).toEqual([{
      id: "global",
      input: {
        type: "brain.batch",
        batch: {
          id: expect.stringMatching(/^brain-batch:[a-f0-9]{64}$/u),
          createdAt: "2026-07-22T12:00:00.000Z",
          intents: [intent],
        },
      },
    }]);
    expect(first?.dispatch).toEqual({
      dispatchId: "dispatch:brain:1",
      acceptedAt: "2026-07-22T12:01:00.000Z",
    });

    expect(await wakeBrain(inbox, async () => {
      throw new Error("an admitted wake must not be dispatched twice");
    })).toEqual(first);
    inbox.close();
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
