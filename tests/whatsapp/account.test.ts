import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ConversationSyncBatch,
  IncomingMessage,
  Status,
  Update,
  WhatsAppSession,
} from "whatsappd";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createConversationArchive } from "../../src/intake/conversation-archive.ts";
import { createWhatsAppAccount } from "../../src/whatsapp/account.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "ambient-agent-account-"));
  roots.push(root);
  return {
    root,
    archive: createConversationArchive(join(root, "application.sqlite")),
  };
};

const message = (overrides: Partial<IncomingMessage> = {}): IncomingMessage =>
  ({
    id: "sync-message-49",
    chatId: "project-49@g.us",
    from: "15551112222@s.whatsapp.net",
    pushName: "Alice",
    fromMe: false,
    timestamp: 3_000,
    live: false,
    isGroup: true,
    kind: "text",
    text: "History is archived before participation is decided.",
    reply: vi.fn(),
    ...overrides,
  }) as IncomingMessage;

const fakeSession = (options: { readonly requiresPairing?: boolean } = {}) => {
  const statusListeners = new Set<(status: Status) => void | Promise<void>>();
  const messageListeners = new Set<(message: IncomingMessage) => void | Promise<void>>();
  const updateListeners = new Set<(update: Update) => void | Promise<void>>();
  const syncListeners = new Set<(batch: ConversationSyncBatch) => void | Promise<void>>();
  let status: Status = { phase: "disconnected" };
  let sent = 0;

  const emitStatus = async (next: Status) => {
    status = next;
    for (const listener of statusListeners) await listener(next);
  };
  const session = {
    get status() {
      return status;
    },
    onStatus(listener: (value: Status) => void | Promise<void>) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    onMessage(listener: (value: IncomingMessage) => void | Promise<void>) {
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    onUpdate(listener: (value: Update) => void | Promise<void>) {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    onConversationSync(listener: (value: ConversationSyncBatch) => void | Promise<void>) {
      syncListeners.add(listener);
      return () => syncListeners.delete(listener);
    },
    async start() {
      if (options.requiresPairing !== false) {
        await emitStatus({
          phase: "pairing",
          pairing: {
            step: "challenge_live",
            method: "qr",
            qr: "safe-qr-challenge",
            expiresAt: 60_000,
          },
        });
      }
      await emitStatus({ phase: "authenticated", sync: { step: "syncing", progress: 50 } });
      for (const listener of syncListeners) {
        await listener({
          chats: [
            { id: "person-49@s.whatsapp.net", isGroup: false, lastMessageAt: 2_000 },
            { id: "project-49@g.us", subject: "Ambient Project", isGroup: true, lastMessageAt: 3_000 },
          ],
          contacts: [{ id: "person-49@s.whatsapp.net", displayName: "Bob" }],
          messages: [message(), message({ id: "unmanaged-49", chatId: "elsewhere-49@g.us", timestamp: 2_500 })],
        });
      }
      await emitStatus({ phase: "online" });
    },
    async send(chatId: string) {
      return { id: `sent-${++sent}`, chatId, fromMe: true };
    },
    async setTyping() {},
    identity: () => ({ jid: "15550000000:7@s.whatsapp.net", pushName: "Ambient Agent", phoneE164: "+15550000000" }),
    stop: vi.fn(async () => undefined),
  } as unknown as WhatsAppSession;

  return { session, messageListeners, updateListeners, syncListeners };
};

describe("managed WhatsApp account", () => {
  it("authenticates before returning recently ordered synchronized chat candidates", async () => {
    const { root, archive } = fixture();
    const fake = fakeSession();
    const onPairing = vi.fn();
    const account = createWhatsAppAccount({
      storeDirectory: join(root, "whatsapp"),
      archive,
      sessionFactory: () => fake.session,
    });

    await expect(account.authenticate({ onPairing })).resolves.toEqual({
      jid: "15550000000:7@s.whatsapp.net",
      pushName: "Ambient Agent",
      phoneE164: "+15550000000",
    });
    expect(onPairing).toHaveBeenCalledWith({
      method: "qr",
      qr: "safe-qr-challenge",
      expiresAt: 60_000,
    });
    await expect(account.synchronizedChats()).resolves.toEqual([
      { jid: "project-49@g.us", name: "Ambient Project", kind: "group", lastActivityAt: 3_000 },
      { jid: "person-49@s.whatsapp.net", name: "Bob", kind: "direct", lastActivityAt: 2_000 },
    ]);
    expect(archive.events().map(({ providerMessageId }) => providerMessageId)).toEqual([
      "unmanaged-49",
      "sync-message-49",
    ]);
    for (const listener of fake.syncListeners) {
      await listener({
        chats: [],
        contacts: [],
        messages: [message(), message({ id: "unmanaged-49", chatId: "elsewhere-49@g.us", timestamp: 2_500 })],
      });
    }
    expect(archive.events()).toHaveLength(2);

    await account.stop();
    archive.close();

    const reopenedArchive = createConversationArchive(join(root, "application.sqlite"));
    const reconnect = fakeSession({ requiresPairing: false });
    const reconnectedAccount = createWhatsAppAccount({
      storeDirectory: join(root, "whatsapp"),
      archive: reopenedArchive,
      sessionFactory: () => reconnect.session,
    });
    await reconnectedAccount.authenticate({});
    expect(reopenedArchive.events()).toHaveLength(2);
    expect(reopenedArchive.readThread("project-49@g.us")).toHaveLength(1);
    await reconnectedAccount.stop();
    reopenedArchive.close();
  });

  it("archives each live arrival before downstream participation and archives confirmed sends", async () => {
    const { root, archive } = fixture();
    const fake = fakeSession();
    const account = createWhatsAppAccount({
      storeDirectory: join(root, "whatsapp"),
      archive,
      sessionFactory: () => fake.session,
    });
    await account.authenticate({});
    const observed: string[] = [];
    account.session().onMessage((incoming) => {
      observed.push(incoming.id);
      expect(archive.events(incoming.chatId).some(({ providerMessageId }) => providerMessageId === incoming.id)).toBe(true);
    });
    account.session().onUpdate((update) => {
      observed.push(update.kind);
      expect(archive.events(update.ref.chatId).some(({ kind }) =>
        kind === (update.kind === "revoke" ? "revocation" : update.kind))).toBe(true);
    });

    for (const listener of fake.messageListeners) {
      await listener(message({ id: "live-unmanaged-49", chatId: "unmanaged-live-49@g.us", live: true }));
    }
    const ref = { id: "live-unmanaged-49", chatId: "unmanaged-live-49@g.us", fromMe: false };
    const updates: Update[] = [
      {
        kind: "edit",
        ref,
        at: 4_000,
        message: message({ id: ref.id, chatId: ref.chatId, timestamp: 4_000, text: "Corrected." }),
      },
      { kind: "reaction", ref, at: 4_100, by: "15553334444@s.whatsapp.net", emoji: "✅", removed: false },
      { kind: "receipt", ref, at: 4_200, by: "15555556666@s.whatsapp.net", status: "read" },
      { kind: "revoke", ref, at: 4_300, by: "15551112222@s.whatsapp.net" },
    ];
    for (const update of updates) {
      for (const listener of fake.updateListeners) await listener(update);
    }
    const managedSession = account.session();
    await managedSession.send("project-49@g.us", { text: "One confirmed outbound fact." });
    await managedSession.send(ref.chatId, { react: { to: ref, emoji: "🔥" } });
    await managedSession.send(ref.chatId, { edit: { target: ref, text: "Outbound correction." } });
    await managedSession.send(ref.chatId, { delete: ref });
    await managedSession.send("project-49@g.us", {
      document: Buffer.from([1, 2, 3]),
      fileName: "proof.txt",
      mimetype: "text/plain",
      caption: "Normalized metadata only.",
    });
    const eventCountBeforeEcho = archive.events().length;
    const echoedMutations: Update[] = [
      { kind: "reaction", ref, at: 5_000, by: "15550000000@s.whatsapp.net", emoji: "🔥", removed: false },
      {
        kind: "edit",
        ref,
        at: 5_100,
        message: message({ id: ref.id, chatId: ref.chatId, timestamp: 5_100, text: "Outbound correction." }),
      },
      { kind: "revoke", ref, at: 5_200, by: "15550000000@s.whatsapp.net" },
    ];
    for (const update of echoedMutations) {
      for (const listener of fake.updateListeners) await listener(update);
    }
    expect(archive.events()).toHaveLength(eventCountBeforeEcho);

    expect(observed).toEqual([
      "live-unmanaged-49",
      "edit",
      "reaction",
      "receipt",
      "revoke",
      "reaction",
      "edit",
      "revoke",
    ]);
    expect(archive.messageState("project-49@g.us", "sent-1")).toMatchObject({
      direction: "outbound",
      kind: "text",
      text: "One confirmed outbound fact.",
    });
    expect(archive.events(ref.chatId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "reaction", providerMessageId: ref.id }),
      expect.objectContaining({ kind: "edit", providerMessageId: ref.id }),
      expect.objectContaining({ kind: "revocation", providerMessageId: ref.id }),
    ]));
    expect(archive.events("project-49@g.us").at(-1)).toMatchObject({
      kind: "arrival",
      payload: {
        messageKind: "document",
        text: "Normalized metadata only.",
        media: {
          fileName: "proof.txt",
          mimetype: "text/plain",
          fileLength: 3,
          caption: "Normalized metadata only.",
        },
      },
    });

    await account.stop();
    archive.close();
  });

  it("adopts an existing valid session without emitting a new pairing challenge", async () => {
    const { root, archive } = fixture();
    const fake = fakeSession({ requiresPairing: false });
    const onPairing = vi.fn();
    const account = createWhatsAppAccount({
      storeDirectory: join(root, "whatsapp"),
      archive,
      sessionFactory: () => fake.session,
    });

    await expect(account.authenticate({ onPairing })).resolves.toMatchObject({
      jid: "15550000000:7@s.whatsapp.net",
    });
    expect(onPairing).not.toHaveBeenCalled();

    await account.stop();
    archive.close();
  });

  it("matches only bounded same-account mutation echoes", async () => {
    const { root, archive } = fixture();
    const fake = fakeSession({ requiresPairing: false });
    let now = 1_000;
    const account = createWhatsAppAccount({
      storeDirectory: join(root, "whatsapp"),
      archive,
      sessionFactory: () => fake.session,
      now: () => now,
    });
    await account.authenticate({});
    const ref = { id: "sync-message-49", chatId: "project-49@g.us", fromMe: false };

    await account.session().send(ref.chatId, { react: { to: ref, emoji: "🔥" } });
    now = 1_100;
    for (const listener of fake.updateListeners) {
      await listener({
        kind: "reaction",
        ref,
        at: now,
        by: "15559990000@s.whatsapp.net",
        emoji: "🔥",
        removed: false,
      });
    }
    now = 1_200;
    for (const listener of fake.updateListeners) {
      await listener({
        kind: "reaction",
        ref,
        at: now,
        by: "15550000000@s.whatsapp.net",
        emoji: "🔥",
        removed: false,
      });
    }
    expect(archive.events(ref.chatId).filter(({ kind }) => kind === "reaction")).toHaveLength(2);

    await account.session().send(ref.chatId, { react: { to: ref, emoji: "🔥" } });
    now = 62_001;
    for (const listener of fake.updateListeners) {
      await listener({
        kind: "reaction",
        ref,
        at: now,
        by: "15550000000@s.whatsapp.net",
        emoji: "🔥",
        removed: false,
      });
    }
    expect(archive.events(ref.chatId).filter(({ kind }) => kind === "reaction")).toHaveLength(4);

    now = 63_000;
    await account.session().send(ref.chatId, { react: { to: ref, emoji: "✅" } });
    now = 63_100;
    for (const listener of fake.updateListeners) {
      await listener({
        kind: "reaction",
        ref,
        at: now,
        by: "15550000000@s.whatsapp.net",
        removed: true,
      });
    }
    now = 63_200;
    for (const listener of fake.updateListeners) {
      await listener({
        kind: "reaction",
        ref,
        at: now,
        by: "15550000000@s.whatsapp.net",
        emoji: "✅",
        removed: false,
      });
    }
    expect(archive.events(ref.chatId).filter(({ kind }) => kind === "reaction")).toHaveLength(7);

    await account.stop();
    archive.close();
  });

  it("classifies cancellation, logout, and connection-start failures", async () => {
    const cancelledFixture = fixture();
    const cancelled = createWhatsAppAccount({
      storeDirectory: join(cancelledFixture.root, "whatsapp"),
      archive: cancelledFixture.archive,
      sessionFactory: () => fakeSession().session,
    });
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(cancelled.authenticate({}, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    cancelledFixture.archive.close();

    const loggedOutFixture = fixture();
    const statusListeners = new Set<(status: Status) => void | Promise<void>>();
    const loggedOutSession = {
      onStatus(listener: (status: Status) => void | Promise<void>) {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      onMessage: () => () => undefined,
      onUpdate: () => () => undefined,
      onConversationSync: () => () => undefined,
      start: async () => {
        for (const listener of statusListeners) {
          await listener({ phase: "logged_out", reason: "credentials_invalid" });
        }
      },
      stop: async () => undefined,
    } as unknown as WhatsAppSession;
    const loggedOut = createWhatsAppAccount({
      storeDirectory: join(loggedOutFixture.root, "whatsapp"),
      archive: loggedOutFixture.archive,
      sessionFactory: () => loggedOutSession,
    });
    await expect(loggedOut.authenticate({})).rejects.toMatchObject({ code: "logged_out" });
    await loggedOut.stop();
    loggedOutFixture.archive.close();

    const failedFixture = fixture();
    const failedSession = {
      onStatus: () => () => undefined,
      onMessage: () => () => undefined,
      onUpdate: () => () => undefined,
      onConversationSync: () => () => undefined,
      start: async () => { throw new Error("connection refused"); },
      stop: async () => undefined,
    } as unknown as WhatsAppSession;
    const failed = createWhatsAppAccount({
      storeDirectory: join(failedFixture.root, "whatsapp"),
      archive: failedFixture.archive,
      sessionFactory: () => failedSession,
    });
    await expect(failed.authenticate({})).rejects.toMatchObject({ code: "start_failed" });
    await failed.stop();
    failedFixture.archive.close();
  });

  it("classifies an authentication timeout and stops the unfinished session", async () => {
    const { root, archive } = fixture();
    const stop = vi.fn(async () => undefined);
    const session = {
      onStatus: () => () => undefined,
      onMessage: () => () => undefined,
      onUpdate: () => () => undefined,
      onConversationSync: () => () => undefined,
      start: async () => await new Promise<void>(() => undefined),
      stop,
    } as unknown as WhatsAppSession;
    const account = createWhatsAppAccount({
      storeDirectory: join(root, "whatsapp"),
      archive,
      sessionFactory: () => session,
    });

    await expect(account.authenticate({}, AbortSignal.timeout(10))).rejects.toMatchObject({ code: "timeout" });
    expect(stop).toHaveBeenCalledOnce();

    archive.close();
  });

  it.runIf(process.env.AMBIENT_AGENT_LIVE_WHATSAPP === "1")(
    "pairs or adopts a live account and archives its synchronized public facts",
    async () => {
      const storeDirectory = process.env.AMBIENT_AGENT_LIVE_WHATSAPP_STORE?.trim();
      if (!storeDirectory) {
        throw new Error("AMBIENT_AGENT_LIVE_WHATSAPP_STORE is required for the live WhatsApp check.");
      }
      const { archive } = fixture();
      const account = createWhatsAppAccount({ storeDirectory, archive });
      try {
        await account.authenticate({
          onPairing: ({ qr, code }) => {
            if (qr !== undefined) {
              const renderer = createRequire(import.meta.url)("qrcode-terminal") as {
                generate(value: string, options: { readonly small: boolean }): void;
              };
              renderer.generate(qr, { small: true });
            } else if (code !== undefined) {
              console.info(`Live WhatsApp pairing code: ${code}`);
            }
          },
        }, AbortSignal.timeout(120_000));
        await expect(account.synchronizedChats()).resolves.not.toHaveLength(0);
        expect(archive.events()).not.toHaveLength(0);
      } finally {
        await account.stop();
        archive.close();
      }
    },
    130_000,
  );
});
