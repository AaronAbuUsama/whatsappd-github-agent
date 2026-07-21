import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolvePrivateKey } from "../../apps/cli/src/private-key.ts";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const pem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const pemFile = async () => {
  const root = await mkdtemp(join(tmpdir(), "ambient-private-key-"));
  roots.push(root);
  const path = join(root, "coder.private-key.pem");
  await writeFile(path, pem);
  return path;
};

describe("resolving an App private key", () => {
  it("reads the key from the path to the downloaded .pem", async () => {
    expect(await resolvePrivateKey("coder", await pemFile())).toBe(pem.trim());
  });

  it("still accepts the key itself, so a triples file may inline it", async () => {
    expect(await resolvePrivateKey("coder", pem)).toBe(pem.trim());
  });

  it("repairs a key whose newlines survived only as escapes", async () => {
    expect(await resolvePrivateKey("coder", pem.replaceAll("\n", String.raw`\n`))).toBe(pem.trim());
  });

  it("names truncation for what it is when only the last PEM line arrives", async () => {
    // The single-line prompt cut a pasted 28-line key here and stored these 25 characters
    // behind an asterisk mask; the install promoted and only GitHub noticed, much later.
    await expect(resolvePrivateKey("coder", "-----END PRIVATE KEY-----")).rejects.toThrow(
      /only its last line, so the paste was cut at the first newline/u,
    );
  });

  it("rejects a key that does not parse rather than promoting it", async () => {
    await expect(resolvePrivateKey("planner", "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----")).rejects.toThrow(
      /not a usable private key/u,
    );
  });

  it("reports the resolved path when the .pem is not there", async () => {
    await expect(resolvePrivateKey("reviewer", "/nonexistent/reviewer.pem")).rejects.toThrow(
      /Could not read the reviewer private key from \/nonexistent\/reviewer\.pem/u,
    );
  });
});
