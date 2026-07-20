import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { acquireInstanceLock } from "../../apps/cli/src/lifecycle.ts";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const dataDirectory = async () => {
  const root = await mkdtemp(join(tmpdir(), "ambient-instance-lock-"));
  roots.push(root);
  return root;
};

describe("the single-instance lock on the data directory", () => {
  it("refuses a second runtime while the first is alive", async () => {
    // T2's second-instance negative (#253): two runtimes on one data directory share the SQLite
    // pair and the WhatsApp session. The second must fail loudly, not start beside the first.
    const root = await dataDirectory();
    await acquireInstanceLock(root);

    await expect(acquireInstanceLock(root)).rejects.toThrow(
      new RegExp(`Another ambient-agent runtime \\(pid ${process.pid}\\) is already using`, "u"),
    );
  });

  it("reclaims the lock a crashed or signalled runtime left behind", async () => {
    // stopRuntimeOnSignal re-raises the signal, so the file always outlives the process:
    // reclaiming a dead owner's lock is the normal restart-and-reboot path, not an edge case.
    const root = await dataDirectory();
    await writeFile(join(root, "runtime.lock"), "2147483646\n");

    await acquireInstanceLock(root);

    expect((await readFile(join(root, "runtime.lock"), "utf8")).trim()).toBe(String(process.pid));
  });
});
