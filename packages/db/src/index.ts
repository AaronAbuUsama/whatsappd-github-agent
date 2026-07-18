import { env } from "@ambient-agent/env/server";

import { openControlDb } from "./control-db";

export * from "./control-db";

export const controlDb = await openControlDb({
  url: env.DATABASE_URL,
  authToken: env.DATABASE_AUTH_TOKEN,
});
export const { client, db } = controlDb;
