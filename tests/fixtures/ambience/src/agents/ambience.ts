import type { AgentRouteHandler } from "@flue/runtime";

export { default } from "@ambient-agent/core/agents/ambience.ts";

export const route: AgentRouteHandler = async (_context, next) => next();
