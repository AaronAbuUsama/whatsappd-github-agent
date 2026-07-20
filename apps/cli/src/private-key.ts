import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** What a terminal leaves behind when a multi-line PEM is pasted into a single-line prompt. */
const TRUNCATED_PASTE = /^-{5}END [A-Z ]*PRIVATE KEY-{5}$/u;

const expandHome = (path: string): string =>
  path === "~" || path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(path);

/**
 * Resolve one App's private key from what the operator supplied: the path to the downloaded
 * .pem, or the key text itself. Either way the result is proven to parse before setup can
 * promote it, so a bad key fails here rather than at the first GitHub call of a live install.
 *
 * The truncation branch exists because the guided prompt is single-line: pasting a 28-line PEM
 * used to store the string "-----END PRIVATE KEY-----" behind a full-width asterisk mask, with
 * nothing to see and nothing to check until GitHub rejected it much later.
 */
export const readSuppliedPrivateKey = async (label: string, supplied: string): Promise<string> => {
  const value = supplied.trim();
  if (TRUNCATED_PASTE.test(value)) {
    throw new Error(
      `The ${label} private key is only its last line, so the paste was cut at the first newline. Supply the path to the downloaded .pem file instead.`,
    );
  }
  return (value.includes("-----BEGIN") ? value.replaceAll(String.raw`\n`, "\n") : await readPem(label, value)).trim();
};

/** As above, and proven to parse — for the guided paste, whose damage is otherwise invisible. */
export const resolvePrivateKey = async (label: string, supplied: string): Promise<string> => {
  const pem = await readSuppliedPrivateKey(label, supplied);
  try {
    createPrivateKey(pem);
  } catch (cause) {
    throw new Error(
      `The ${label} private key is not a usable private key. Supply the path to the .pem file GitHub generated for the App.`,
      { cause },
    );
  }
  return pem;
};

const readPem = async (label: string, path: string): Promise<string> => {
  const resolved = expandHome(path);
  try {
    return await readFile(resolved, "utf8");
  } catch (cause) {
    throw new Error(
      `Could not read the ${label} private key from ${resolved}. Supply the path to the .pem file, or the key itself.`,
      { cause },
    );
  }
};
