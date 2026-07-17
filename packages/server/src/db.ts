import { sqlite } from "@flue/runtime/node";

import { getManagedRuntimeDependencies } from "@ambient-agent/core/managed/runtime-dependencies.ts";

export const flueDatabasePath = (): string => getManagedRuntimeDependencies().paths.flueDatabase;

export default sqlite(flueDatabasePath());
