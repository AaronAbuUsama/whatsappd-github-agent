import { serve } from "@hono/node-server";

import { configureLogging, getLogger } from "@ambient-agent/engine/logging/logging.ts";
import { resolveTenantRuntimeSetupBoot } from "@ambient-agent/installation/runtime-dependencies.ts";
import { createAmbientAgentSetupApp } from "./setup-app.ts";

const boot = resolveTenantRuntimeSetupBoot();
await configureLogging({ logsDirectory: boot.paths.logs });
const log = getLogger("setup");
const app = createAmbientAgentSetupApp(boot);

serve(
  {
    fetch: app.fetch,
    port: boot.port,
  },
  ({ port }) => {
    log.info({ port }, "Ambient Agent tenant setup is listening");
  },
);
