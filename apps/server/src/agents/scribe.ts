// Flue discovers agents from this package's src/agents directory; the real Scribe
// definition lives in the agents package next to the funnel coalescer that dispatches
// it. This file only re-exports it for discovery.
export { default, description, route } from "@ambient-agent/agents/scribe/agent.ts";
