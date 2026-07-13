import { sqlite } from "@flue/runtime/node";

const databasePath = process.env.FLUE_DB_PATH?.trim() || "./data/flue.db";

export default sqlite(databasePath);
