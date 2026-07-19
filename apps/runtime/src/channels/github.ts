import { randomUUID } from "node:crypto";

import { createGitHubChannel } from "@flue/github";

import { handleGitHubDelivery } from "@ambient-agent/engine/github/ingress-runtime.ts";
import { resolveTenantRuntimeBoot } from "@ambient-agent/installation/runtime-dependencies.ts";

const boot = resolveTenantRuntimeBoot();
const setup = boot.mode === "setup";
const webhookSecret = setup ? randomUUID() : boot.githubCredential.webhookSecret;

// flue-blueprint: channel/github@1
export const channel = createGitHubChannel({
  webhookSecret,
  webhook: async ({ delivery }) => {
    if (setup) return new Response(null, { status: 404 });
    const result = await handleGitHubDelivery(delivery);
    return new Response(JSON.stringify(result), {
      // Keep the delivery retryable while a referenced issue-create operation awaits reconciliation.
      status: result.status === "deferred" ? 503 : 200,
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  },
});
