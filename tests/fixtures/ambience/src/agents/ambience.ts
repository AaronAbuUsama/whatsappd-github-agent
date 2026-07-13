import type { AgentRouteHandler } from "@flue/runtime";

export { default } from "../../../../../src/agents/ambience.js";

export const route: AgentRouteHandler = async (_context, next) => next();
