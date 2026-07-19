import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    DATABASE_AUTH_TOKEN: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    POLAR_ACCESS_TOKEN: z.string().min(1),
    POLAR_SUCCESS_URL: z.url(),
    POLAR_WEBHOOK_SECRET: z.string().min(1),
    CORS_ORIGIN: z.url(),
    DOKPLOY_API_URL: z.url().optional(),
    DOKPLOY_API_KEY: z.string().min(1).optional(),
    DOKPLOY_ENVIRONMENT_ID: z.string().min(1).optional(),
    DOKPLOY_SERVER_ID: z.string().min(1).optional(),
    DOKPLOY_WORKER_HOSTNAME: z.string().min(1).optional(),
    DOKPLOY_NETWORK_NAME: z.string().min(1).optional(),
    TENANT_RUNTIME_IMAGE: z.string().min(1).optional(),
    TENANT_RUNTIME_DATA_DIRECTORY: z.string().min(1).optional(),
    TENANT_RUNTIME_PORT: z.coerce.number().int().positive().max(65_535).optional(),
    TENANT_PROVISIONER_RECONCILE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(300_000)
      .optional(),
    TURSO_ORG: z.string().min(1).optional(),
    TURSO_GROUP: z.string().min(1).optional(),
    TURSO_PLATFORM_TOKEN: z.string().min(1).optional(),
    TENANT_SECRET_ENCRYPTION_KEY: z.string().min(1).optional(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
