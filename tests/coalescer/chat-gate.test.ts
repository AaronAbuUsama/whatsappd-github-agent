import { describe, expect, it } from "vite-plus/test";

import { makeManagedChatGate } from "../../src/coalescer/chat-gate.ts";

describe("typed managed chat gate", () => {
  it("admits only exact configured group and direct-chat JIDs", () => {
    const gate = makeManagedChatGate(["GROUP@G.US", "15551234567@s.whatsapp.net"]);

    expect(gate.allowed("group@g.us", true)).toBe(true);
    expect(gate.allowed("15551234567@s.whatsapp.net", false)).toBe(true);
    expect(gate.allowed("other@g.us", true)).toBe(false);
    expect(gate.allowed("15550000000@s.whatsapp.net", false)).toBe(false);
  });
});
