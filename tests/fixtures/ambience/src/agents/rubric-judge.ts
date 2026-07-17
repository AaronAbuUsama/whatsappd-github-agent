import { defineAgent, type AgentRouteHandler } from "@flue/runtime";

import { AMBIENCE_MODEL_SPECIFIER } from "@ambient-agent/core/model/pi-subscription.ts";

export const description = "Fixture-only LLM judge for the ratified Ambience participation rubric.";

export const route: AgentRouteHandler = async (_context, next) => next();

export default defineAgent(() => ({
  model: AMBIENCE_MODEL_SPECIFIER,
  thinkingLevel: "low",
  instructions: [
    "You are an independent evaluation judge, not Ambience.",
    "Grade only the supplied transcript, observable effects, quoted rubric criterion, and skill-bundle text.",
    "Return one JSON object with exactly: score (a number from 0 to 1) and rationale (a concise string).",
    "A score of 1 fully satisfies the quoted criterion; 0 fully violates it. Do not perform tools or add prose outside JSON.",
  ].join("\n"),
}));
