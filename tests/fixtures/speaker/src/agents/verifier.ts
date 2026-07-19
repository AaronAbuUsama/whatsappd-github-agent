import { defineAgent, type AgentRouteHandler } from "@flue/runtime";

import verifierSkill from "../../../../../packages/agents/src/capabilities/coder/verifier/verify/SKILL.md" with { type: "skill" };
import { resolveAgentModelProfile } from "../../../../../packages/engine/src/model/pi-subscription.ts";

export const description = "Fixture surface for the Verifier role prose.";
export const route: AgentRouteHandler = async (_context, next) => next();

export default defineAgent(() => ({
  ...resolveAgentModelProfile("verifier"),
  skills: [verifierSkill],
  instructions: "Activate and follow the verify skill. Drive the runtime surface and return one evidence-backed PASS, FAIL, BLOCKED, or SKIP report.",
}));
