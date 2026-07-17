import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundMessage, Update } from "whatsappd";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createConversationArchive } from "@ambient-agent/core/intake/conversation-archive.ts";
import { conversationArrival, conversationUpdate } from "@ambient-agent/core/intake/conversation-event.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const databasePath = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ambient-agent-archive-"));
  roots.push(root);
  return join(root, "application.sqlite");
};

const arrival = (overrides: Partial<InboundMessage> = {}): InboundMessage =>
  ({
    id: "message-49",
    chatId: "team-49@g.us",
    from: "15551112222@s.whatsapp.net",
    pushName: "Alice",
    fromMe: false,
    timestamp: 1_000,
    live: true,
    isGroup: true,
    kind: "text",
    text: "The stable base should remember this.",
    ...overrides,
  }) as InboundMessage;

describe("Conversation Archive", () => {
  it("appends one immutable arrival fact and projects an exact re-observation once", () => {
    const archive = createConversationArchive(databasePath());
    const event = conversationArrival(arrival());

    expect(archive.append(event)).toBe(true);
    expect(archive.append(event)).toBe(false);
    expect(archive.events("team-49@g.us")).toEqual([
      expect.objectContaining({
        id: "arrival:team-49@g.us:message-49",
        kind: "arrival",
        chatId: "team-49@g.us",
        providerMessageId: "message-49",
      }),
    ]);
    expect(archive.readThread("team-49@g.us")).toEqual([
      {
        id: "message-49",
        chatId: "team-49@g.us",
        direction: "inbound",
        senderId: "15551112222@s.whatsapp.net",
        senderName: "Alice",
        kind: "text",
        text: "The stable base should remember this.",
        timestamp: 1_000,
      },
    ]);

    archive.close();
  });

  it("retains edit, reaction, receipt, and revocation facts while projecting current message state", () => {
    const archive = createConversationArchive(databasePath());
    archive.append(conversationArrival(arrival()));
    const ref = { id: "message-49", chatId: "team-49@g.us", fromMe: false };
    const updates: Update[] = [
      {
        kind: "edit",
        ref,
        at: 2_000,
        message: arrival({
          timestamp: 2_000,
          flags: { edited: true },
          text: "The corrected stable base should remember this.",
        }),
      },
      { kind: "reaction", ref, at: 2_100, by: "15553334444@s.whatsapp.net", emoji: "✅", removed: false },
      { kind: "receipt", ref, at: 2_150, by: "15555556666@s.whatsapp.net", status: "delivered" },
      { kind: "receipt", ref, at: 2_200, by: "15555556666@s.whatsapp.net", status: "read" },
      { kind: "revoke", ref, at: 2_300, by: "15551112222@s.whatsapp.net" },
    ];

    for (const update of updates) expect(archive.append(conversationUpdate(update))).toBe(true);
    for (const update of updates) expect(archive.append(conversationUpdate(update))).toBe(false);

    expect(archive.events("team-49@g.us").map(({ kind }) => kind)).toEqual([
      "arrival",
      "edit",
      "reaction",
      "receipt",
      "receipt",
      "revocation",
    ]);
    expect(archive.messageState("team-49@g.us", "message-49")).toEqual({
      id: "message-49",
      chatId: "team-49@g.us",
      direction: "inbound",
      senderId: "15551112222@s.whatsapp.net",
      senderName: "Alice",
      kind: "text",
      text: "The corrected stable base should remember this.",
      timestamp: 1_000,
      revoked: true,
    });
    expect(archive.readThread("team-49@g.us")).toEqual([]);

    archive.close();
  });

  it("replays facts observed before arrival and retains the projection across restart", () => {
    const path = databasePath();
    const archive = createConversationArchive(path);
    const ref = { id: "message-49", chatId: "team-49@g.us", fromMe: false };
    const edit = conversationUpdate({
      kind: "edit",
      ref,
      at: 2_000,
      message: arrival({
        timestamp: 2_000,
        flags: { edited: true },
        text: "An edit can arrive before reconnect history.",
      }),
    });
    const receipt = conversationUpdate({
      kind: "receipt",
      ref,
      at: 2_100,
      by: "15555556666@s.whatsapp.net",
      status: "read",
    });

    archive.append(edit);
    archive.append(receipt);
    archive.append(conversationArrival(arrival()));

    expect(archive.messageState("team-49@g.us", "message-49")).toMatchObject({
      text: "An edit can arrive before reconnect history.",
    });
    archive.close();

    const reopened = createConversationArchive(path);
    expect(reopened.append(edit)).toBe(false);
    expect(reopened.events("team-49@g.us")).toHaveLength(3);
    expect(reopened.messageState("team-49@g.us", "message-49")).toMatchObject({
      text: "An edit can arrive before reconnect history.",
    });
    reopened.close();
  });

  it("projects event time rather than reconnect observation order", () => {
    const archive = createConversationArchive(databasePath());
    archive.append(conversationArrival(arrival()));
    const ref = { id: "message-49", chatId: "team-49@g.us", fromMe: false };
    archive.append(conversationUpdate({
      kind: "edit",
      ref,
      at: 3_000,
      message: arrival({ timestamp: 3_000, text: "Newest edit." }),
    }));
    archive.append(conversationUpdate({
      kind: "edit",
      ref,
      at: 2_000,
      message: arrival({ timestamp: 2_000, text: "Older edit observed after reconnect." }),
    }));

    expect(archive.messageState("team-49@g.us", "message-49")).toMatchObject({ text: "Newest edit." });
    archive.close();
  });

  it("retains distinct same-timestamp edits without ambiguous identity collisions", () => {
    const archive = createConversationArchive(databasePath());
    archive.append(conversationArrival(arrival()));
    const ref = { id: "message-49", chatId: "team-49@g.us", fromMe: false };
    for (const text of ["Zulu first edit.", "Alpha second edit."]) {
      archive.append(conversationUpdate({
        kind: "edit",
        ref,
        at: 2_000,
        message: arrival({ timestamp: 2_000, text }),
      }));
    }

    expect(archive.events("team-49@g.us").filter(({ kind }) => kind === "edit")).toHaveLength(2);
    expect(archive.messageState("team-49@g.us", "message-49")).toMatchObject({ text: "Alpha second edit." });

    archive.close();
  });

  it("shares one caller-owned transaction with the next application-state projection", () => {
    const archive = createConversationArchive(databasePath());
    archive.transaction(({ database }) => {
      database.exec("CREATE TABLE intake_proof (event_id TEXT PRIMARY KEY)");
    });
    const event = conversationArrival(arrival({ id: "rolled-back-49" }));

    expect(() => archive.transaction(({ append, database }) => {
      append(event);
      database.prepare("INSERT INTO intake_proof (event_id) VALUES (?)").run(event.id);
      throw new Error("roll back the combined intake");
    })).toThrow("roll back the combined intake");

    expect(archive.events().some(({ id }) => id === event.id)).toBe(false);
    expect(archive.transaction(({ database }) =>
      database.prepare("SELECT event_id FROM intake_proof").all())).toEqual([]);
    archive.close();
  });
});
