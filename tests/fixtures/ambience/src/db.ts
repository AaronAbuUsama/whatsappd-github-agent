import { sqlite } from "@flue/runtime/node";

const databasePath = process.env.FLUE_DB_PATH ?? "./flue.sqlite";

export default sqlite(databasePath);
