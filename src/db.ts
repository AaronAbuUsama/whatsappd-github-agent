import { sqlite } from "@flue/runtime/node";

import { getManagedRuntimeDependencies } from "./managed/runtime-dependencies.js";

export const flueDatabasePath = (): string => getManagedRuntimeDependencies().paths.flueDatabase;

export default sqlite(flueDatabasePath());
