import { createGitHubChannel } from "@flue/github";

import { handleGitHubDelivery } from "../../../../../packages/engine/src/github/ingress-runtime.ts";

const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
if (!webhookSecret) throw new Error("GITHUB_WEBHOOK_SECRET is required by the persisted-runtime fixture.");

export const channel = createGitHubChannel({
  webhookSecret,
  webhook: async ({ delivery }) => {
    const result = await handleGitHubDelivery({
      ...delivery,
      githubAppId: process.env.GITHUB_APP_ID ?? "fixture-app",
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "content-type": "application/json; charset=UTF-8" },
    });
  },
});
