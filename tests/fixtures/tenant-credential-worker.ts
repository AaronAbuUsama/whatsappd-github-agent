import { createLibsqlChatGptCredentialStore } from "@ambient-agent/installation/tenant-credentials.ts";

const url = process.argv[2];
if (url === undefined) throw new Error("Tenant credential worker requires a database URL.");

const store = createLibsqlChatGptCredentialStore({ url, authToken: "local-test-token" });
let refreshed = false;
await store.modify("openai-codex", async (current) => {
  if (current === undefined) throw new Error("Seeded tenant credential is missing.");
  if (current.access === "cross-process-rotated") return undefined;
  refreshed = true;
  await new Promise((resolve) => setTimeout(resolve, 150));
  return {
    ...current,
    access: "cross-process-rotated",
    refresh: "cross-process-refresh",
    expires: 3_000,
  };
});
process.stdout.write(JSON.stringify({ refreshed }));
