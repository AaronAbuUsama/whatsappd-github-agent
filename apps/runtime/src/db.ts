import { sqlite } from "@flue/runtime/node";

import { resolveTenantRuntimeBoot } from "@ambient-agent/installation/runtime-dependencies.ts";

export const flueDatabasePath = (): string => resolveTenantRuntimeBoot().paths.flueDatabase;

export default sqlite(flueDatabasePath());
