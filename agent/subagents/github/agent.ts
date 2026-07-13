/**
 * GitHub worker — declared subagent (`DECISION-SPEC.md` §2a, G2).
 *
 * The voice orchestrator delegates a single GitHub task here and gets back a
 * typed result (see `outputSchema`), never the worker's tool-call chatter. This
 * child reuses the root agent's 13 `github_*` tools (thin re-export shims under
 * `tools/`), and carries its own GitHub-triage prompt in `instructions.md` (the
 * "GitHub Concierge" instructions). The worker returns structured output and has
 * no `say` tool, so it must NOT inherit the voice/root prompt (which owns `say`
 * and ambient-chatter judgment) — a test guards that separation.
 *
 * Model wiring mirrors the root: eve's `experimental_chatgpt()` bills the local
 * `codex login` (ChatGPT subscription), so no ANTHROPIC/OPENAI key is needed.
 */
import { defineAgent } from "eve";
import { subscriptionModel } from "../../../src/model/subscription.ts";
import { githubResultSchema } from "./lib/output-schema.ts";

// Optional model-slug override, same escape hatch as the root agent.
const slug = process.env.EVE_MODEL_ID;

export default defineAgent({
  description:
    "GitHub worker for the configured repo: files and triages issues, reviews PRs, and reads " +
    "code/issues/PRs. Hand it one GitHub task in `message`; it returns a typed " +
    "{ action, number?, url?, summary }. It defaults hard to the configured repo — only name " +
    "another owner/repo when the task is explicitly about a different repository (reads only).",
  model: subscriptionModel(slug),
  // Non-gateway model → declare the window so compaction has a threshold.
  modelContextWindowTokens: 200_000,
  // Task-mode structured return: the voice reads this, not the child's text.
  outputSchema: githubResultSchema,
  limits: {
    maxOutputTokensPerSession: 200_000,
  },
});
