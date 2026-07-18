// Flue discovers agents from this package's src/agents directory; the real agent
// definition lives in the agents package next to the dispatch that hard-imports it
// (T8: dispatch and agents stay together). This file only re-exports it for discovery.
export { default, description } from "@ambient-agent/agents/speaker/agent.ts";
