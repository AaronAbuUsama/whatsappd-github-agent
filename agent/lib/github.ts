/**
 * Shared Octokit client + repo resolution for the `agent/tools/github_*.ts`
 * tools. Kept out of `tools/` itself: `lib/` is import-only and never
 * discovered as a tool (see https://eve.dev/docs/reference/project-layout).
 */
import { Octokit } from "@octokit/rest";

let client: Octokit | undefined;

/**
 * Lazily construct (and memoize) the Octokit client from `GITHUB_TOKEN`.
 * Lazy on purpose: importing this module must not throw before a tool
 * actually runs (e.g. during `eve build` discovery, or in tests that mock
 * this function outright).
 */
export function getOctokit(): Octokit {
  if (client) return client;
  const auth = process.env.GITHUB_TOKEN;
  if (!auth) {
    throw new Error(
      "GITHUB_TOKEN is not set. Add it to your environment (see .env.example) before using GitHub tools.",
    );
  }
  client = new Octokit({ auth, userAgent: "whatsappd-github-agent" });
  return client;
}

/** Testing seam — clears the memoized client so tests can inject a fresh mock. */
export function resetOctokitForTests(): void {
  client = undefined;
}

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export interface RepoInput {
  readonly owner?: string;
  readonly repo?: string;
}

/**
 * Env-var *names* (and other placeholders) the model has been seen to echo into
 * the `owner`/`repo` fields instead of a real value — the F4/F5 failure where
 * it issued `GET /repos/GITHUB_REPO/GITHUB_REPO/…` (404). Matched
 * case-insensitively and treated as "not provided" so resolution falls through
 * to the configured repo rather than trusting the junk string. Deliberately
 * excludes bare `owner`/`repo`, which are plausible real GitHub names.
 */
const PLACEHOLDER_FIELDS: ReadonlySet<string> = new Set([
  "github_repo",
  "github_owner",
  "github_repository",
  "github_allowed_repos",
  "owner/repo",
]);

/**
 * Normalize a caller-supplied owner/repo field. Trims, then treats empty
 * strings and known env-var-name echoes as *absent* (`undefined`) so the caller
 * defaults HARD to the configured repo instead of targeting a bogus one. This
 * is the empty-string + placeholder half of the F4/F5 fix.
 */
function cleanField(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (PLACEHOLDER_FIELDS.has(trimmed.toLowerCase())) return undefined;
  return trimmed;
}

/**
 * Parse the configured default repo from `GITHUB_REPO` ("owner/repo"). This is
 * the single hard default; it is never derived from model-supplied strings.
 */
function configuredRepo(): RepoRef {
  const raw = process.env.GITHUB_REPO?.trim();
  if (!raw) {
    throw new Error(
      "No repo specified and GITHUB_REPO is not set. Pass owner/repo explicitly or set GITHUB_REPO=owner/repo.",
    );
  }
  const [owner, repo] = raw.split("/");
  if (!owner || !repo) {
    throw new Error(`GITHUB_REPO must be "owner/repo", got "${raw}".`);
  }
  return { owner, repo };
}

/**
 * Resolve `{ owner, repo }`, defaulting **hard** to the configured `GITHUB_REPO`.
 *
 * Only a *complete, clean* owner+repo pair from the caller overrides the
 * default — that keeps legitimate cross-repo reads ("review PR #3 in
 * acme/widgets") working. Anything less resolves to the configured repo:
 *
 * - a lone `owner` or `repo` (no per-field mixing — a stray `owner:"foo"` must
 *   never become `foo/<configured-repo>`, the F4 `ios-design-system/…` vector);
 * - an empty string (`"" ?? default` used to leak the empty string through);
 * - an env-var-name echo like `GITHUB_REPO` (the F4 `GITHUB_REPO/GITHUB_REPO`).
 *
 * The default is derived only from `GITHUB_REPO`, never from model output.
 */
export function resolveRepo(input: RepoInput): RepoRef {
  const owner = cleanField(input.owner);
  const repo = cleanField(input.repo);
  if (owner && repo) return { owner, repo };
  return configuredRepo();
}

/**
 * The repos this agent is permitted to WRITE to. Defaults to `GITHUB_REPO`;
 * override with `GITHUB_ALLOWED_REPOS` (comma-separated "owner/repo"). Keys are
 * lower-cased for case-insensitive matching (GitHub owners/repos are).
 *
 * Why this exists: the WhatsApp gate authorizes by *group membership*, and tool
 * inputs come from model output derived from untrusted chat text. Without an
 * allow-list, a prompt-injected "open an issue in someone-else/their-repo" would
 * turn the bot's `GITHUB_TOKEN` into a write primitive against any repository
 * the token can reach. Reads stay unrestricted (lower blast radius, and
 * "review PR in acme/widgets" is a legitimate ask); mutations do not.
 */
export function allowedWriteRepos(): ReadonlySet<string> {
  const raw = process.env.GITHUB_ALLOWED_REPOS?.trim() || process.env.GITHUB_REPO?.trim() || "";
  const set = new Set<string>();
  for (const entry of raw.split(",")) {
    const key = entry.trim().toLowerCase();
    if (key) set.add(key);
  }
  return set;
}

/**
 * Resolve owner/repo like {@link resolveRepo}, then enforce the write
 * allow-list. Every tool that MUTATES GitHub state must resolve through this,
 * never through {@link resolveRepo} directly.
 */
export function resolveWritableRepo(input: RepoInput): RepoRef {
  const ref = resolveRepo(input);
  const allowed = allowedWriteRepos();
  if (allowed.size === 0) {
    throw new Error(
      "No writable repos configured. Set GITHUB_REPO (or GITHUB_ALLOWED_REPOS=owner/repo,owner/repo) " +
        "to authorize which repositories this bot may modify.",
    );
  }
  if (!allowed.has(`${ref.owner}/${ref.repo}`.toLowerCase())) {
    throw new Error(
      `Refusing to write to ${ref.owner}/${ref.repo}: not in the write allow-list (${[...allowed].join(", ")}). ` +
        "Add it to GITHUB_ALLOWED_REPOS to permit writes.",
    );
  }
  return ref;
}
