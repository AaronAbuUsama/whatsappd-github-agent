/**
 * GitHub worker — declared subagent (`DECISION-SPEC.md` §2a, G2).
 *
 * The voice orchestrator delegates a single GitHub task here and gets back a
 * typed result (see `outputSchema`), never the worker's tool-call chatter. This
 * child reuses the root agent's 13 `github_*` tools (thin re-export shims under
 * `tools/`) and the root `instructions.md` prompt (via `instructions.ts`) —
 * both unchanged — but runs as its own agent with its own structured contract.
 *
 * Model wiring mirrors the root: eve's `experimental_chatgpt()` bills the local
 * `codex login` (ChatGPT subscription), so no ANTHROPIC/OPENAI key is needed.
 */
import { defineAgent } from "eve";
import { experimental_chatgpt } from "eve/models/openai";
import { githubResultSchema } from "./lib/output-schema.ts";

// Optional model-slug override, same escape hatch as the root agent.
const slug = process.env.EVE_MODEL_ID;

export default defineAgent({
  description:
    "GitHub worker for the configured repo: files and triages issues, reviews PRs, and reads " +
    "code/issues/PRs. Hand it one GitHub task in `message`; it returns a typed " +
    "{ action, number?, url?, summary }. It defaults hard to the configured repo — only name " +
    "another owner/repo when the task is explicitly about a different repository (reads only).",
  model: slug ? experimental_chatgpt(slug) : experimental_chatgpt(),
  // Non-gateway model → declare the window so compaction has a threshold.
  modelContextWindowTokens: 200_000,
  // Task-mode structured return: the voice reads this, not the child's text.
  outputSchema: githubResultSchema,
  limits: {
    maxOutputTokensPerSession: 200_000,
  },
});
