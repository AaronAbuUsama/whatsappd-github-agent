import { createContext } from "@ambient-agent/api/context";
import { createAppRouter } from "@ambient-agent/api/routers/index";
import { auth, getEntitlementSnapshot } from "@ambient-agent/auth";
import { client } from "@ambient-agent/db";
import { env } from "@ambient-agent/env/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { installHostedGitHub } from "./github-hosted";
import { createHostedTenantProvisioner } from "./provisioner-hosted";

const app = new Hono();
const appRouter = createAppRouter({ getEntitlementSnapshot });

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

if (process.env.GITHUB_APPS_JSON) {
  installHostedGitHub({
    app,
    client,
    appsJson: process.env.GITHUB_APPS_JSON,
    ...(process.env.GITHUB_RUNTIME_DELIVERY_SECRETS_JSON
      ? { runtimeSecretsJson: process.env.GITHUB_RUNTIME_DELIVERY_SECRETS_JSON }
      : {}),
  });
}

export const hostedTenantProvisioner = createHostedTenantProvisioner({ client });
if (hostedTenantProvisioner) {
  void hostedTenantProvisioner.reconcilePendingTenants().catch(() => {
    console.error("[tenant-provisioner] startup reconciliation failed");
  });
}

export const apiHandler = new OpenAPIHandler(appRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
  ],
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

export const rpcHandler = new RPCHandler(appRouter, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
});

app.use("/*", async (c, next) => {
  const context = await createContext({ context: c });

  const rpcResult = await rpcHandler.handle(c.req.raw, {
    prefix: "/rpc",
    context: context,
  });

  if (rpcResult.matched) {
    return c.newResponse(rpcResult.response.body, rpcResult.response);
  }

  const apiResult = await apiHandler.handle(c.req.raw, {
    prefix: "/api-reference",
    context: context,
  });

  if (apiResult.matched) {
    return c.newResponse(apiResult.response.body, apiResult.response);
  }

  await next();
});

app.get("/", (c) => {
  return c.text("OK");
});

import { serve } from "@hono/node-server";

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
