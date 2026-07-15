import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import * as v from "valibot";

import { ManagedConfigSchema } from "./schema.js";

const FILE_MODE = 0o600;
const MAX_CONFIG_BYTES = 1024 * 1024;

const readManagedConfig = async (path: string) => {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
      throw new Error("The managed configuration is not a supported private JSON file.");
    }
    const source = await handle.readFile("utf8");
    const result = v.safeParse(ManagedConfigSchema, JSON.parse(source));
    if (!result.success) throw new Error("The managed configuration is malformed.");
    return result.output;
  } finally {
    await handle.close();
  }
};

const atomicWriteManagedConfig = async (path: string, value: unknown): Promise<void> => {
  const directory = dirname(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", FILE_MODE);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, FILE_MODE);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
};

export const migrateManagedChatGptCredentialReference = async (path: string): Promise<void> => {
  let config: Awaited<ReturnType<typeof readManagedConfig>>;
  try {
    config = await readManagedConfig(path);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return;
    throw cause;
  }
  if (config.model.credential === "chatgpt-oauth") return;
  await atomicWriteManagedConfig(path, {
    ...config,
    model: { ...config.model, credential: "chatgpt-oauth" },
  });
};
