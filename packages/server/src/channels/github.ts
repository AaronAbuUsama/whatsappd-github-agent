import { createGitHubChannel } from "@flue/github";

import { handleGitHubDelivery } from "@ambient-agent/core/github/ingress-runtime.ts";
import { getManagedRuntimeDependencies } from "@ambient-agent/core/managed/runtime-dependencies.ts";

const webhookSecret = getManagedRuntimeDependencies().githubCredential.webhookSecret;

// flue-blueprint: channel/github@1
export const channel = createGitHubChannel({
  webhookSecret,
  webhook: async ({ delivery }) => {
    const result = await handleGitHubDelivery(delivery);
    return new Response(JSON.stringify(result), {
      // Keep the delivery retryable while a referenced issue-create operation awaits reconciliation.
      status: result.status === "deferred" ? 503 : 200,
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  },
});
