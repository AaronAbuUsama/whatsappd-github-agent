import { sqlite } from "@flue/runtime/node";

export const flueDatabasePath = (env: Readonly<Record<string, string | undefined>> = process.env): string =>
  env.FLUE_DB_PATH?.trim() || "./flue.sqlite";

export default sqlite(flueDatabasePath());
