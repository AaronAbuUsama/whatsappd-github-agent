/**
 * Eve runtime config — model selection for the GitHub concierge agent.
 *
 * Runs on your ChatGPT / Codex **subscription**, not API credits. The
 * `ai-sdk-provider-codex-cli` provider spawns the local Codex CLI and rides the
 * OAuth token from `codex login` (stored at `~/.codex/auth.json`) — so this
 * agent needs **no ANTHROPIC_API_KEY and no OPENAI_API_KEY**. Requires the
 * Codex CLI (`>=0.144.x`) installed and logged in. See
 * https://github.com/ben-vargas/ai-sdk-provider-codex-cli.
 *
 * Mode: `codexExec` (process-per-call) — the simplest, stateless fit for Eve's
 * per-session request model. Tool calls (our github_* tools) round-trip as
 * AI-SDK tool calls; outputs arrive in the final event. If we later want token
 * streaming / tool-call deltas ("one voice" polish), swap to
 * `createCodexAppServer()` (persistent process + provider.close()).
 */
import { defineAgent } from "eve";
import { codexExec } from "ai-sdk-provider-codex-cli";

// Model slugs are whatever your installed Codex CLI exposes (discover with the
// provider's listModels()). "gpt-5.5" is the current default; override with
// EVE_MODEL_ID without editing code.
const modelId = process.env.EVE_MODEL_ID ?? "gpt-5.5";

export default defineAgent({
  model: codexExec(modelId, {
    // We use Codex purely as a chat/tool brain; don't make it demand a git repo.
    skipGitRepoCheck: true,
  }),
  // Keep the loop tight for a chat surface: a runaway tool-call chain in a
  // group chat is much more visible (and annoying) than in a web UI.
  limits: {
    maxOutputTokensPerSession: 200_000,
  },
});
