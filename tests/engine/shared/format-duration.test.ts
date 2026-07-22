import { describe, expect, it } from "vite-plus/test";

import { formatDuration } from "../../../packages/engine/src/shared/format-duration.ts";

describe("formatDuration", () => {
  it.each([
    [undefined, "0ms"],
    [0, "0ms"],
    [999, "999ms"],
    [1_000, "1s"],
    [1_500, "1.5s"],
    [4_349, "4.3s"],
    [4_351, "4.4s"],
  ])("formats %s milliseconds as %s", (durationMs, expected) => {
    expect(formatDuration(durationMs)).toBe(expected);
  });
});
