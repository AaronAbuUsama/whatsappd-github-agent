<p align="center">
  <strong>whatsappd-github-agent</strong><br>
  A GitHub concierge you talk to from a WhatsApp group — triage issues, review PRs, and summarize code without leaving the chat.
</p>

<p align="center">
  <a href="https://github.com/AaronAbuUsama/whatsappd-github-agent/actions/workflows/ci.yml"><img src="https://github.com/AaronAbuUsama/whatsappd-github-agent/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node version">
</p>

`@github-bot open an issue: the export button is broken on Safari` in a WhatsApp
group chat — and the agent opens it, replies with the issue link, and is ready
for the next request. Built on [Eve](https://eve.dev) (the agent runtime) and
[whatsappd](https://github.com/AaronAbuUsama/whatsappd) (the WhatsApp
channel), with GitHub operations as typed, tested Eve tools over
[`@octokit/rest`](https://github.com/octokit/rest.js).

**Full walkthrough: [docs/TUTORIAL.md](./docs/TUTORIAL.md)** — scaffolding an
Eve agent, pairing a WhatsApp number, wiring GitHub tools, and running the bot,
explained from zero.

## What it does

Mention the bot in a watched WhatsApp group and it can:

| Ask it to...                          | It calls...                    |
| -------------------------------------- | ------------------------------- |
| "open an issue: title / body"          | `github_create_issue`           |
| "list open issues" / "what's outstanding" | `github_list_issues`         |
| "what's issue #42 about"               | `github_get_issue`              |
| "comment on #42: ..."                  | `github_comment_on_issue`       |
| "close #42, not planned"               | `github_close_issue`            |
| "list open PRs"                        | `github_list_pull_requests`     |
| "summarize PR #12"                     | `github_get_pull_request`       |
| "show me the diff for PR #12"          | `github_get_pull_request_diff`  |
| "review PR #12"                        | `github_review_pull_request`    |
| "label #42 as bug, p1"                 | `github_add_labels`             |
| "assign #42 to octocat"                | `github_assign`                 |
| "show me src/index.ts on main"         | `github_get_file_contents`      |
| "search the codebase for useEffect"    | `github_search_code`            |

All thirteen tools live under [`agent/tools/`](./agent/tools), each a `defineTool()`
with a Zod input schema, and each has a unit test under
[`tests/tools/`](./tests/tools) against a mocked Octokit client.

## Architecture

```
WhatsApp group  ⇄  whatsappd sidecar  ⇄  Eve agent (agent/)  ⇄  GitHub (@octokit/rest)
 (Baileys)          (src/index.ts,        channels/whatsapp.ts
                      a separate process)   tools/github_*.ts
```

The sidecar owns the WhatsApp socket and forwards inbound events over HTTP;
the Eve app's `agent/channels/whatsapp.ts` gates them (right group, contains
the trigger word) before ever starting a session, then the agent answers
using the GitHub tools and the sidecar delivers the reply back to the group.
Full diagram and explanation in [the tutorial](./docs/TUTORIAL.md#1-what-this-is).

## Quickstart

```bash
git clone https://github.com/AaronAbuUsama/whatsappd-github-agent.git
cd whatsappd-github-agent
npm install
cp .env.example .env   # fill in GITHUB_TOKEN, GITHUB_REPO, ...  (model = your `codex login`, no API key)

npm run dev             # terminal 1: the Eve agent (needs Node >= 24)
npm run whatsapp         # terminal 2: the WhatsApp sidecar — scan the QR it prints
```

Add the bot's number to a WhatsApp group, then send:

```
@github-bot list open issues
```

See [docs/TUTORIAL.md](./docs/TUTORIAL.md) for prerequisites, pairing a
WhatsApp number, and everything else in depth.

## Project layout

```
agent/
├── agent.ts                    # model config (Codex/ChatGPT subscription, via ai-sdk-provider-codex-cli)
├── instructions.md              # the GitHub-concierge persona
├── channels/whatsapp.ts         # gated WhatsApp ingress (whatsappd's Eve adapter + group gating)
├── lib/github.ts                # shared Octokit client + repo resolution
└── tools/github_*.ts            # the 13 GitHub tools
src/index.ts                     # whatsappd sidecar launcher (separate process)
tests/                           # vitest unit tests (mocked Octokit)
docs/TUTORIAL.md                 # the full walkthrough
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test             # vitest, mocked GitHub API — no network or credentials needed
npm run build        # eve build — compiles agent/ to .eve/ + .output/ (needs Node >= 24)
```

CI runs all three on Node 22 and 24 — see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).
The `eve` CLI itself requires Node ≥ 24 to run (`eve build`/`eve dev`/`eve start`
exit immediately below that), so the build step only runs on the Node 24 leg;
typecheck and tests run on both. Details in [STATUS.md](./STATUS.md).

## Safety notes

- **WhatsApp ban risk.** This uses [Baileys](https://github.com/WhiskeySockets/Baileys),
  an unofficial WhatsApp Web client. Automating a personal number can violate
  WhatsApp's terms and risks a ban — use a number you can afford to lose.
- **GitHub write access.** The bot can create/close issues and post PR
  reviews. `agent/channels/whatsapp.ts` ignores direct messages by default
  and only answers in the configured group, specifically because "anyone who
  texts this number" should not be "anyone who can write to this repo." See
  [docs/TUTORIAL.md](./docs/TUTORIAL.md#group-gating) for how the gate works
  and its limits.

## License

[MIT](./LICENSE) © Aaron AbuUsama
