import { defineAgent, type AgentRouteHandler } from "@flue/runtime";

import {
  DEFAULT_AGENT_MODEL_PROFILES,
  modelSpecifier,
  SUBSCRIPTION_PROVIDER_ID,
} from "../../../../../packages/engine/src/model/pi-subscription.ts";

export const description = "Fixture-only LLM judge for the ratified Speaker participation rubric.";

export const route: AgentRouteHandler = async (_context, next) => next();

export default defineAgent(() => ({
  model: modelSpecifier(SUBSCRIPTION_PROVIDER_ID, DEFAULT_AGENT_MODEL_PROFILES.speaker.id),
  thinkingLevel: "low",
  instructions: [
    "You are an independent evaluation judge, not Speaker.",
    "Grade only the supplied transcript, observable effects, quoted rubric criterion, and skill-bundle text.",
    "Return one JSON object with exactly: score (a number from 0 to 1) and rationale (a concise string).",
    "A score of 1 fully satisfies the quoted criterion; 0 fully violates it. Do not perform tools or add prose outside JSON.",
  ].join("\n"),
}));
