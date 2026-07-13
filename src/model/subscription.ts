import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { experimental_chatgpt } from "eve/models/openai";

type CodexAuth = {
  auth_mode?: unknown;
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
  } | null;
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const codexAuthPath = (): string => {
  const home = process.env.CODEX_HOME?.trim() || join(process.env.HOME ?? "~", ".codex");
  return join(home, "auth.json");
};

/** Refuse Eve's API-key fallback: this app is subscription-only. */
const assertChatGptSubscriptionLogin = (): string => {
  const authPath = codexAuthPath();
  let auth: CodexAuth;

  try {
    auth = JSON.parse(readFileSync(authPath, "utf8")) as CodexAuth;
  } catch {
    throw new Error(
      `No readable ChatGPT subscription login at ${authPath}. Run \`pnpm run login\`.`,
    );
  }

  const hasOAuthToken =
    nonEmptyString(auth.tokens?.access_token) || nonEmptyString(auth.tokens?.refresh_token);
  if (auth.auth_mode !== "chatgpt" || !hasOAuthToken) {
    throw new Error(
      `Codex auth at ${authPath} is not a ChatGPT subscription login. Run \`pnpm run login\`.`,
    );
  }

  return authPath;
};

export const subscriptionModel = (slug?: string): LanguageModel => {
  assertChatGptSubscriptionLogin();
  return slug ? experimental_chatgpt(slug) : experimental_chatgpt();
};

export const describeSubscriptionModel = (): string => {
  try {
    return `🔑 model: ChatGPT subscription (${assertChatGptSubscriptionLogin()})`;
  } catch (error) {
    return `🔑 ⚠️  ${error instanceof Error ? error.message : String(error)}`;
  }
};
