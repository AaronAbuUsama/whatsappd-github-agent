/**
 * Eve runtime config — model selection for the GitHub concierge agent.
 *
 * Runs on your ChatGPT / Codex **subscription**, not API credits, via eve's
 * native `experimental_chatgpt()` helper — it reads the local `codex login`
 * (OAuth token in `~/.codex/auth.json`) and bills the ChatGPT subscription, so
 * this agent needs **no ANTHROPIC_API_KEY and no OPENAI_API_KEY**. Requires the
 * Codex CLI installed and logged in. See eve's `reference/typescript-api`
 * ("ChatGPT subscription models") and `agent-config` docs.
 *
 * Being an eve-native model, it carries the context-window / catalog metadata
 * eve needs for compaction — a third-party AI-SDK provider does not, which is
 * why `modelContextWindowTokens` is still set explicitly below.
 */
import { defineAgent } from "eve";
import { subscriptionModel } from "../src/model/subscription.ts";

// Optional model-slug override (defaults to eve's current ChatGPT-subscription
// model). Set EVE_MODEL_ID to pin a different OpenAI slug without editing code.
const slug = process.env.EVE_MODEL_ID;

export default defineAgent({
  model: subscriptionModel(slug),
  // Non-gateway model → declare the window so compaction has a threshold.
  modelContextWindowTokens: 200_000,
  // Keep the loop tight for a chat surface: a runaway tool-call chain in a
  // group chat is much more visible (and annoying) than in a web UI.
  limits: {
    maxOutputTokensPerSession: 200_000,
  },
});
