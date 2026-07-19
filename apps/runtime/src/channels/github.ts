import { createGitHubChannel } from "@flue/github";

import { handleGitHubDelivery } from "@ambient-agent/engine/github/ingress-runtime.ts";
import { getManagedRuntimeDependencies } from "@ambient-agent/installation/runtime-dependencies.ts";

const { githubCredential } = getManagedRuntimeDependencies();

// flue-blueprint: channel/github@1
export const channel = createGitHubChannel({
  webhookSecret: githubCredential.webhookSecret,
  webhook: async ({ delivery }) => {
    const result = await handleGitHubDelivery({ ...delivery, githubAppId: String(githubCredential.appId) });
    return new Response(JSON.stringify(result), {
      // Keep the delivery retryable while a referenced issue-create operation awaits reconciliation.
      status: result.status === "deferred" ? 503 : 200,
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  },
});
