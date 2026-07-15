import { createGitHubChannel } from "@flue/github";

import { handleGitHubDelivery } from "../github/ingress-runtime.js";
import { getManagedRuntimeDependencies } from "../managed/runtime-dependencies.js";

const webhookSecret = getManagedRuntimeDependencies().githubCredential.webhookSecret;

// flue-blueprint: channel/github@1
export const channel = createGitHubChannel({
  webhookSecret,
  webhook: async ({ delivery }) => {
    const result = await handleGitHubDelivery(delivery);
    return new Response(JSON.stringify(result), {
      status: result.status === "uncertain" ? 409 : 200,
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  },
});
