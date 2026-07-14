import { describe, expect, it } from "vite-plus/test";

import { flueDatabasePath } from "../../src/db.ts";

describe("Flue database configuration", () => {
  it("preserves an operator-selected database with the managed file as fallback", () => {
    expect(flueDatabasePath({ FLUE_DB_PATH: "/persistent/ambience.sqlite" })).toBe("/persistent/ambience.sqlite");
    expect(flueDatabasePath({ FLUE_DB_PATH: "   " })).toBe("./flue.sqlite");
    expect(flueDatabasePath({})).toBe("./flue.sqlite");
  });
});
