# Handoff: #153 credentials are provisioned — build the credential store & Octokit adapter

The three GitHub Apps that #153 (MEMORY-STATE-SPEC §7) needs already exist and
are installed. This is *not* a request to provision anything — it's the raw
material for you to build the actual `packages/installation` credential-store
and `githubAppClient(credential)` adapter that #153 describes.

## Where the credentials are

`~/ambient-agent-apps/` on this machine (the operator's laptop, self-hosted
runtime — this is not a CI secret store):

```
~/ambient-agent-apps/
├── apps.json                                   # the three {appId, installationId, slug} triples
├── ambient-coder.2026-07-17.private-key.pem
├── ambient-reviewer.2026-07-17.private-key.pem
└── ambient-planner.2026-07-17.private-key.pem
```

`apps.json`:

```json
{
  "coder":    { "appId": 4329663, "installationId": 147344362, "slug": "ambient-coder",    "pem": "ambient-coder.2026-07-17.private-key.pem" },
  "reviewer": { "appId": 4329724, "installationId": 147345618, "slug": "ambient-reviewer",  "pem": "ambient-reviewer.2026-07-17.private-key.pem" },
  "planner":  { "appId": 4329758, "installationId": 147346159, "slug": "ambient-planner",   "pem": "ambient-planner.2026-07-17.private-key.pem" }
}
```

All files `chmod 600`, dir `chmod 700`. Already verified live: each App's
`apps.listReposAccessibleToInstallation()` returns exactly
`AaronAbuUsama/ambient-agent` — no other repos, no leftover mis-scoped
installs.

## What each App is scoped to

Installed only on `AaronAbuUsama/ambient-agent`, on the personal account
(no org). No webhook (Active unchecked, no URL/secret). No OAuth / device
flow / setup URL. Repository permissions:

| Permission | Coder | Reviewer | Planner |
|---|---|---|---|
| Contents | Read & write | Read-only | No access |
| Issues | Read & write | Read & write | Read & write |
| Pull requests | Read & write | Read & write | Read-only |

(Metadata: Read-only is GitHub's automatic mandatory addition on every App.)

This matches #153's identity model: Coder pushes code + opens PRs, Reviewer
reads diffs and submits reviews/approvals but never pushes, Planner
administers issues/labels/milestones and reads PR state but never touches
repo contents or pushes changes. The Speaker shares the Planner credential
per #153 ("`planner[bot]`" for inline issue-filing) — same file, no fourth App.

Note: the permission split above was reconstructed from a garbled version of
#153's original checklist and explicitly ratified by Aaron via AskUserQuestion
before any App was created — treat it as the source of truth, not the
checklist prose in #153 itself if the two ever disagree.

## What's NOT done — this is your actual task

Only the raw Apps + local credential files exist. None of #153's Definition
of Done is implemented yet:

- `packages/installation/src/schema.ts` still needs `kind` changed to
  `v.literal("github-app")` (retiring `personal-token`).
- `credentials/github-{coder,reviewer,planner}.json` (the *runtime* store
  #153 specifies, `{ schemaVersion, kind, appId, installationId, privateKey,
  webhookSecret? }`, PEM as an escaped JSON string) don't exist yet — you'll
  generate them from the raw materials in `~/ambient-agent-apps/`, not
  re-provision the Apps.
- `githubAppClient(credential)` adapter (`@octokit/auth-app`'s
  `createAppAuth`) isn't built.
- `createOctokitIssueRepository` still expects to build its own client, not
  receive an Octokit.
- Bot-login-via-`apps.getAuthenticated()` swap (replacing
  `users.getAuthenticated()` at `packages/installation/src/github-issue-repository.ts:142`)
  isn't done.
- The guided-paste `prepare` seam / migration walk from `personal-token`
  isn't built.
- ADR 0012 front-matter (`status: superseded by #153`) isn't added yet.

Read #153 in full for the shape of all of this — this handoff only tells you
*where the credentials already are* and *what they're scoped to*, not how to
build the adapter.

## One gotcha for whoever writes the verification/smoke script

This environment is pnpm-only — never invoke `npm`, even for a throwaway
verification script outside the repo. If you hit `EBADDEVENGINES` from a
stray `~/package.json` pinning `devEngines.packageManager` to pnpm, that file
should not exist anymore (deleted during provisioning), but if it reappears,
delete it rather than working around it with npm flags.
