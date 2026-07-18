// Flue discovers workflows from this package's src/workflows directory; the filename
// becomes the workflow name (`coder`). The real definition lives in the agents package
// beside its capability bundle. This file only re-exports it for discovery.
export { coder as default } from "@ambient-agent/agents/capabilities/coder/workflow.ts";
