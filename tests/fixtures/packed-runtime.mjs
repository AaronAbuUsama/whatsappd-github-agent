import { registerHooks } from "node:module";

const whatsappSource = String.raw`
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const fileName = (key) => key.replace(/[^0-9A-Za-z._-]/g, "_") + ".json";
export const fileStore = (directory) => ({
  directory,
  read: async (key) => {
    try { return await readFile(join(directory, fileName(key)), "utf8"); } catch { return null; }
  },
  write: async (entries) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const [key, value] of Object.entries(entries)) {
      const path = join(directory, fileName(key));
      if (value === null) await rm(path, { force: true });
      else await writeFile(path, value, { mode: 0o600 });
    }
  },
  clear: async () => await rm(directory, { recursive: true, force: true }),
});
export const qrAuth = () => ({ method: "qr" });
export const isOnline = (status) => status?.phase === "online";
export const isTerminal = (status) => status?.phase === "logged_out" || status?.phase === "suspended";
export const createSession = ({ store }) => {
  const status = new Set();
  const messages = new Set();
  const updates = new Set();
  const sync = new Set();
  let online = false;
  let identity;
  const subscribe = (set, fn) => { set.add(fn); return () => set.delete(fn); };
  return {
    onStatus: (fn) => subscribe(status, fn),
    onMessage: (fn) => subscribe(messages, fn),
    onUpdate: (fn) => subscribe(updates, fn),
    onConversationSync: (fn) => subscribe(sync, fn),
    start: async () => {
      const saved = await store.read("creds");
      const credential = saved === null ? undefined : JSON.parse(saved);
      identity = credential?.identity ?? {
        jid: "15550000000@s.whatsapp.net",
        lid: "packed-" + randomUUID() + "@lid",
      };
      await store.write({ creds: JSON.stringify({ registered: true, identity }) });
      for (const fn of sync) await fn({
        chats: [{ id: "120363000@g.us", subject: "Packed Managed Chat", isGroup: true, lastMessageAt: 1 }],
        contacts: [],
        messages: [],
      });
      online = true;
      for (const fn of status) fn({ phase: "online" });
      const input = process.env.PACKED_WHATSAPP_INPUT;
      if (input) {
        for (const fn of messages) await fn({
          id: process.env.PACKED_WHATSAPP_MESSAGE_ID ?? "packed-runtime-input",
          chatId: "120363000@g.us",
          from: "15550000058@s.whatsapp.net",
          pushName: "Packed backup proof",
          fromMe: false,
          timestamp: Date.now(),
          live: true,
          isGroup: true,
          kind: "text",
          text: input,
          context: { mentions: [identity.jid] },
        });
      }
    },
    stop: async () => { online = false; },
    identity: () => online ? identity : undefined,
    send: async () => ({ id: "packed-message" }),
    setTyping: async () => undefined,
  };
};
`;

// e2b's CJS entry `require`s a package-internal `#ansi-styles` subpath import, which the
// module hooks below cannot link. The CLI imports e2b statically but only constructs a
// sandbox when E2B_API_KEY is set, which no fixture run does, so a stub is enough.
const e2bSource = String.raw`
export class Sandbox {}
export class CommandExitError extends Error {}
export class TimeoutError extends Error {}
`;

const octokitSource = String.raw`
const ok = async () => ({ data: {} });
const issues = new Proxy({}, { get: () => ok });
// App-installation auth: the bot login is derived from apps.getAuthenticated() -> <slug>[bot].
const apps = {
  getAuthenticated: async () => ({ data: { slug: "packed" } }),
  // Multi-org verification proves installation via the App-JWT route, not the fixed repos.get.
  getRepoInstallation: async () => ({ data: { id: 424242 } }),
  getOrgInstallation: async () => ({ data: { id: 424242 } }),
};
export class Octokit {
  constructor() {
    this.apps = apps;
    this.repos = { get: ok };
    this.rest = { apps, users: { getAuthenticated: ok }, repos: this.repos, issues, search: { issuesAndPullRequests: ok } };
  }
  async paginate() { return []; }
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "whatsappd") return { url: "ambient-fixture:whatsappd", shortCircuit: true };
    if (specifier === "@octokit/rest") return { url: "ambient-fixture:octokit", shortCircuit: true };
    if (specifier === "e2b") return { url: "ambient-fixture:e2b", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "ambient-fixture:whatsappd") return { format: "module", source: whatsappSource, shortCircuit: true };
    if (url === "ambient-fixture:octokit") return { format: "module", source: octokitSource, shortCircuit: true };
    if (url === "ambient-fixture:e2b") return { format: "module", source: e2bSource, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const jwtPayload = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "packed-account" } }),
).toString("base64url");
const accessToken = `e30.${jwtPayload}.signature`;

const upstreamFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.startsWith("http://127.0.0.1:")) return await upstreamFetch(input);
  if (url.endsWith("/api/accounts/deviceauth/usercode")) {
    return Response.json({ device_auth_id: "packed-device", user_code: "PACK-TEST", interval: 0 });
  }
  if (url.endsWith("/api/accounts/deviceauth/token")) {
    return Response.json({ authorization_code: "packed-code", code_verifier: "packed-verifier" });
  }
  if (url.endsWith("/oauth/token")) {
    return Response.json({ access_token: accessToken, refresh_token: "packed-refresh-secret", expires_in: 3600 });
  }
  throw new Error(`Unexpected network request in packed runtime fixture: ${url}`);
};
