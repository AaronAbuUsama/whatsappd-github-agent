import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vite-plus/test";

import { createRootLogger } from "../../src/logging/logging.ts";
import { createWhatsAppAccount } from "../../src/whatsapp/account.ts";

vi.mock("whatsappd", () => {
  const session = {
    onMessage: () => () => undefined,
    onUpdate: () => () => undefined,
    onConversationSync: () => () => undefined,
  };
  return {
    createSession: vi.fn(() => session),
    fileStore: vi.fn((directory: string) => ({ directory })),
    qrAuth: vi.fn(() => ({ kind: "qr" })),
    isOnline: vi.fn(() => false),
    isTerminal: vi.fn(() => false),
  };
});

describe("upstream WhatsApp logger injection", () => {
  it("passes the app-owned child through whatsappd's public SessionConfig.logger seam", async () => {
    const { createSession } = await import("whatsappd");
    const logger = createRootLogger({
      format: "json",
      consoleStream: new Writable({ write: (_c, _e, cb) => cb() }),
    }).child({ subsystem: "whatsappd" });
    createWhatsAppAccount({ storeDirectory: "/tmp/wa-store", archive: { append: () => true }, logger });
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ logger }));
  });

  it("does not inject a logger when none is configured", async () => {
    const { createSession } = await import("whatsappd");
    vi.mocked(createSession).mockClear();
    createWhatsAppAccount({ storeDirectory: "/tmp/wa-store", archive: { append: () => true } });
    expect(vi.mocked(createSession).mock.calls[0]![0]).not.toHaveProperty("logger");
  });
});
