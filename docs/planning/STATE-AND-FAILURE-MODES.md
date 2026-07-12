# State (the world model) + failure modes from the live log

Companion to [`EVE-PRIMITIVES-MAP.md`](./EVE-PRIMITIVES-MAP.md). Captures (1) the
state design the agent is missing, grounded in Eve's real state primitives, and
(2) the failure modes observed in the 2026-07-12 live run, each mapped to a root
cause and where it gets fixed. This is the evidence base for the refactor plan and
the eval suite.

---

## 1. The problem: the agent has no state of the world

In the live run the bot filed **#62, #63, #64, #65 — four duplicate issues for the
same "Profile crash / blank screen / iPhone 5s" bug** — and later created **#68, #69
instead of editing #67**. Root cause is singular: **the worker is stateless and the
agent never consults the world before acting.** Every `delegate` spins a fresh
`streamText` (`worker.ts:90`) with no memory that it already filed the bug, and
nothing ever searches GitHub to check.

"State of the world" for this bot is really **three layers**, each with a different
correct home in Eve. Getting the home wrong is the bug.

### Layer 1 — conversation working state (this chat, now)
"I'm mid-intake on the Profile bug; I already asked for the iOS version; I filed #63
for it." Home = **the durable per-chat session** (`continuationToken: chatId`,
`agent/channels/whatsapp.ts:179`). Under Eve this is *free*: one long-lived session
per chat, its turn history persisted and **compacted** past `thresholdPercent`
(`agent-definition.d.ts:95`). The reason today's bot forgets is that it runs *outside*
Eve with a naive `.slice(-30)` (`voice.ts:221`) and a **stateless** worker. Adopting
the durable session deletes that whole class of amnesia.

### Layer 2 — structured session ledger (typed, queryable this session)
"Issues touched this conversation: #63(bug,open), #67(feature,open)." Home =
**`defineState`** (`eve/context`, `guides/state.md`):
```ts
// agent/lib/filed.ts
import { defineState } from "eve/context";
export const filed = defineState("wa-github.filed", () => ({ issues: [] as
  { number: number; url: string; kind: "bug" | "feature"; title: string; status: "open" | "closed" }[] }));
```
`filed.get()` / `filed.update()` from inside a tool; durable across turns and crashes.
Lets the agent answer "how many issues have you filed today?" reliably and resolve
"make #67 a feature request" → the exact number, without re-deriving from prose.

**Load-bearing constraint (`guides/state.md:66`): `defineState` is NEVER shared with
subagents.** So if the GitHub Worker is a declared subagent, *its* state is fresh
every call — the ledger MUST live on the **parent** (the voice/root session), and the
parent must pack "you already filed #63 for this; UPDATE it, don't create" into the
subagent `message`. This is the single most important design fact for the two-tier +
Eve combination.

### Layer 3 — cross-session / cross-chat world truth (does this issue already exist?)
"Has *anyone* filed this bug before, in any chat, ever?" `defineState` **cannot** hold
this (`guides/state.md:178`: "Do not use defineState for long-term memory"). Two homes:
1. **GitHub itself is the source of truth** — the issues *are* the state. The fix is a
   `github_search_issues` tool + a hard **"search before you file"** instruction, so
   dedup happens against reality, not memory. This alone kills the #62–#65 pile.
2. **An external store** (KV/SQLite) mapping `chatThread → issue`, if we want the bot
   to link a WhatsApp thread to its issue across restarts. Optional; the
   `multi-tenant-memory.md` pattern (dynamic-instructions + tools + store) is the
   blueprint if we do.

### How the model actually *sees* its state each turn
State is useless unless it reaches the model's context. Eve's lever is **dynamic
instructions** (`defineDynamic` on `turn.started`, `patterns/multi-tenant-memory.md:59`):
resolve the ledger + recent world facts and inject them as system context before each
turn. That is how "it should know what it's done" becomes real — not hoping it's still
in the rolling window.

---

## 2. Failure modes from the 2026-07-12 live log

| # | Observed | Root cause | Fixed by |
|---|---|---|---|
| F1 | #62/#63/#64/#65 = 4 dupes of one bug | No dedup; stateless worker; never searches | Layer-3 `github_search_issues` + "search first"; durable session (L1); ledger (L2) |
| F2 | Re-files the bug on meta-commentary ("dumb model", "you stayed silent") | Voice over-delegates; no "already handled" state | Persona restraint + state (L1/L2) |
| F3 | **"delegated, no reply" → group sees nothing** (13:14, 15:24, 15:44) — worker asked "which repo?"/errored, never relayed | Two-tier relay gap: worker text isn't spoken unless the voice re-`reply`s it, and often doesn't | Eve channel **delivers assistant text natively** (no relay hop); OR subagent-result-must-narrate rule |
| F4 | `GET /repos/GITHUB_REPO/GITHUB_REPO/…` 404; `ios-design-system/ios-design-system` 404 | Repo resolution — model fills owner/repo with the env-var *name* or guesses repo-as-owner | Make owner/repo truly default-hard or drop from schema for single-repo; fix `resolveRepo` (`agent/lib/github.ts`) + `adapt()` empty-strip (`worker.ts:47`) |
| F5 | Can't fetch #67 it just created | Same as F4 (wrong owner/repo on the read) | Same as F4 |
| F6 | #67 filed as bug, was a feature; only fixed on human correction | No issue-type triage, no labels | Instructions + `github_add_labels` + a triage skill |
| F7 | Created #68/#69 instead of editing #67 | F4 (can't fetch) + no ledger linking "notifications = #67" | F4 fix + ledger (L2) + "update, don't recreate" instruction |
| F8 | "very dumb model", "two generations ago" | `OPENAI_MODEL=gpt-5.4-nano` (`model.ts:22`) | Swap to `experimental_chatgpt()` → now defaults **gpt-5.6-sol**; or a gateway model |
| F9 | Stayed silent on "whats the latest with the api repo?" (a real GitHub Q) | Relevance judgment miss (persona + weak model) | Prompts + model + eval |
| F10 | No evals; failures only caught by a human reading logs | No eval suite | `eve eval` + `defineEval`; seed cases from this table |

**Silence calibration was mostly right** (correctly silent on football, coffee, meta-tests
at 13:20–13:27), so the persona's engage/stay-silent instinct is close — F9 is the one
miss. The damage is concentrated in **state (F1/F2/F7), the relay gap (F3), and the repo
bug (F4/F5)** — none of which are "the model is dumb"; they're architecture and tools.

---

## 3. New tools the agent needs (workstream C)

**GitHub (dedup + lifecycle):**
- `github_search_issues` — search open/closed by text/label (the dedup primitive; no owner/repo needed).
- `github_update_issue` — edit title/body/labels/state (so "make it a feature request" edits, not recreates).
- (have: create/close/comment/label/assign/get/list/get-file/search-code/PR tools.)

**WhatsApp (the thread context the user asked for):**
- `whatsapp_read_thread` — read recent messages in this chat (beyond the coalesced window).
- `whatsapp_search_messages` — search the chat history for prior mentions of a bug/topic.
- `whatsapp_get_quoted` — resolve the message a user quote-replied.
**Cost check (verified):** whatsappd is **stream-only** — `session.onMessage` + `history`
sync batches (`ConversationSyncBatch`), and `SessionStore` (`ports-DeTIMztA.d.mts:18`)
is *credentials*, not a queryable message log. There is **no "get messages by chat" API**.
So `whatsapp_read_thread`/`whatsapp_search_messages` are **not free** — they require us to
**persist inbound messages ourselves** (capture `onMessage` → SQLite → query tools). Silver
lining: that same store is the natural home for the Layer-3 `chatThread → issue` ledger, so
one small SQLite store serves both the thread tools and the world-state ledger.

**State:** `defineState` ledger (L2) + `github_search_issues` (L3) together are the
"knows what it's done" fix.
