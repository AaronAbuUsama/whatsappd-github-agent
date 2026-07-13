import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ToolContext } from "eve/tools";
import { describe, expect, it } from "vitest";
import say from "../../agent/tools/say.ts";

const EMPTY_DELIVERY = "<eve-empty-delivery/>";
const instructionsPath = fileURLToPath(new URL("../../agent/instructions.md", import.meta.url));

describe("say — clean private turn completion", () => {
  it("tells the model how to close the tool loop without an empty response", async () => {
    const output = await say.execute({ text: "gateway online" }, {} as ToolContext);

    expect(output).toEqual({ delivered: true });
    expect(say.toModelOutput).toBeTypeOf("function");
    expect(await say.toModelOutput!(output)).toEqual({
      type: "text",
      value: expect.stringContaining(EMPTY_DELIVERY),
    });
  });

  it("defines an intentional non-empty completion for both silence and post-say turns", () => {
    const instructions = readFileSync(instructionsPath, "utf8");

    expect(instructions).toContain("Never leave your private final output empty");
    expect(instructions).toContain(EMPTY_DELIVERY);
    expect(instructions).toMatch(/When you choose silence[\s\S]*same marker/);
  });
});
