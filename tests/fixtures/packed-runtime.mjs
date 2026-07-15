import { registerHooks } from "node:module";

const whatsappSource = String.raw`
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  const subscribe = (set, fn) => { set.add(fn); return () => set.delete(fn); };
  return {
    onStatus: (fn) => subscribe(status, fn),
    onMessage: (fn) => subscribe(messages, fn),
    onUpdate: (fn) => subscribe(updates, fn),
    onConversationSync: (fn) => subscribe(sync, fn),
    start: async () => {
      await store.write({ creds: JSON.stringify({ registered: true }) });
      for (const fn of sync) await fn({
        chats: [{ id: "120363000@g.us", subject: "Packed Managed Chat", isGroup: true, lastMessageAt: 1 }],
        contacts: [],
        messages: [],
      });
      online = true;
      for (const fn of status) fn({ phase: "online" });
    },
    stop: async () => { online = false; },
    identity: () => online ? { jid: "15550000000@s.whatsapp.net", lid: "packed-bot@lid" } : undefined,
    send: async () => ({ id: "packed-message" }),
    setTyping: async () => undefined,
  };
};
`;

const octokitSource = String.raw`
const ok = async () => ({ data: {} });
const issues = new Proxy({}, { get: () => ok });
export class Octokit {
  constructor() {
    this.users = { getAuthenticated: ok };
    this.repos = { get: ok };
    this.rest = { users: this.users, repos: this.repos, issues, search: { issuesAndPullRequests: ok } };
  }
  async paginate() { return []; }
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "whatsappd") return { url: "ambient-fixture:whatsappd", shortCircuit: true };
    if (specifier === "@octokit/rest") return { url: "ambient-fixture:octokit", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "ambient-fixture:whatsappd") return { format: "module", source: whatsappSource, shortCircuit: true };
    if (url === "ambient-fixture:octokit") return { format: "module", source: octokitSource, shortCircuit: true };
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
