import type { AgentRouteHandler } from "@flue/runtime";

export { default } from "../../../../../packages/agents/src/speaker/agent.ts";

export const route: AgentRouteHandler = async (_context, next) => next();
