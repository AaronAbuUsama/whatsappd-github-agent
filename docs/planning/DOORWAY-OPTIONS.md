# The doorway, in code — options (so you can judge, not trust me)

You doubted the "loopback" idea and asked to see it in code with alternatives. Fair.
Here's every real way the Coalescer's background timer can wake an Eve session, as
concrete code grounded in the verified Eve APIs, with an honest real-vs-hacky verdict.

## First: the mental model (you had it right)

Even in **one process** there are two logical halves:

```
  GATEWAY half                         AGENT half
  ┌───────────────────────┐            ┌────────────────────────────┐
  │ whatsappd session      │  DOORWAY  │ Eve session per chat        │
  │ Coalescer (debounce)   │ ───────►  │ tools / subagents / state   │
  └───────────────────────┘            └────────────────────────────┘
```

The Coalescer **is** in the gateway half — you were right. The only question is the
**wire between the two halves**: how does `fire(window)` (a background timer, no
`send()` in scope — `coalescer.ts:95`) become a session turn? That wire is the doorway.

**Why a wire is unavoidable:** starting/resuming a session needs `send`/`receive`/
`deliver`, which are closures over the host `Runtime` (`channel/send.d.ts`). Authored
code gets one **only** inside a route/WS/schedule handler, or via `eve/client` over HTTP.
There is **no public API to grab the `Runtime` from background code** (verified: no
`createApp`/`toNodeHandler`/`createRuntime` export). So the timer must reach a real
doorway. The options differ only in *which* doorway and *how much magic*.

---

## Option 1 — Loopback `eve/client` (the app is its own client)

```ts
// src/gateway/eve-doorway.ts — a new Conversationalist behind the SAME port (ports.ts)
import { Client } from "eve/client";
import { Effect, Layer } from "effect";
import { Conversationalist, ConversationError } from "../coalescer/ports.ts";
import { renderWindow } from "../coalescer/render.ts";

// The eve agent (agent/) serves HTTP in THIS process. 127.0.0.1 = "call myself".
const client = new Client({ host: process.env.EVE_URL ?? "http://127.0.0.1:3000" });

export const eveDoorway: Layer.Layer<Conversationalist> = Layer.succeed(Conversationalist, {
  turn: (window) =>
    Effect.tryPromise({
      // continuationToken = chatId → resume THIS chat's durable session, run one turn
      try: () => client.session(window.chatId).send({ message: renderWindow(window) }),
      catch: (cause) => new ConversationError({ cause }),
    }).pipe(Effect.asVoid),
});
```

**What "loopback" actually means:** nothing exotic — the client's `host` is `127.0.0.1`,
so the HTTP call goes to the eve server running in the same process. `eve/client` is
**the** sanctioned way for *any* external system to drive an eve agent; the fact that the
caller lives in the same process is irrelevant to it. It is a plain public-API call.

- **Real?** ✅ Fully. `new Client({host})` + `client.session(token).send({message})` are
  verified public exports (`client/client.d.ts`, `client/types.d.ts:95`).
- **Cost:** the process makes an HTTP request to itself; the eve server must be up and a
  port chosen. One extra localhost round-trip per fire (negligible).
- **Delivery back to WhatsApp:** the agent delivers *itself* — via a `whatsapp_send` tool
  (or a channel delivery hook). The `send()` return value (the reply text) can be ignored
  by the gateway. This is the clean separation: gateway wakes it, agent speaks.
- **Verdict:** most *real and supported*. The "hacky" smell is just self-HTTP; it isn't.

---

## Option 2 — In-process, no HTTP: capture a channel `send` for the timer

```ts
// agent/channels/whatsapp.ts
import { defineChannel, POST } from "eve/channels";
import type { SendFn } from "eve/channels";

let doorway: SendFn | undefined;               // captured once, reused by the timer

export default defineChannel({
  routes: [
    // one "arm" call captures send; the timer reuses it (send closes over the runtime)
    POST("/wa/arm", async (_req, { send }) => { doorway ??= send; return new Response("armed"); }),
  ],
  events: {
    // NATIVE delivery: the agent's assistant text goes straight to WhatsApp — no tool,
    // no relay hop (this is what kills the "delegated, no reply" black hole)
    "message.completed": (ev, ch) => whatsappd.send(ch.state.chatId, ev.text),
  },
});

// Coalescer fire →  doorway?.(renderWindow(window), { continuationToken: window.chatId })
```

- **Real?** ⚠️ Partially. `send` is a closure over the singleton runtime, and the `WS()`
  case proves it survives a whole connection lifetime — so reusing a captured `send` from
  a timer *should* work. But it is **not a documented pattern**, and because whatsappd is
  push-based (a callback, not an HTTP client hitting our routes) there's no natural request
  to capture from — hence the awkward `/wa/arm` bootstrap.
- **Upside:** no self-HTTP, and **native text delivery** via `message.completed` (Option 1
  needs a `whatsapp_send` tool for that).
- **Verdict:** the most elegant *if the capture is stable* — but it's the one with magic.
  Treat as an optimization to adopt only after a spike proves the captured `send` holds.

---

## Option 3 — A 1-minute schedule pumps ready buffers (Eve-blessed, but coarse)

```ts
// agent/schedules/pump.ts
import { defineSchedule } from "eve/schedules";
import whatsapp from "../channels/whatsapp";

export default defineSchedule({
  cron: "* * * * *",                            // ⬅ minimum granularity is ONE MINUTE
  run({ receive, appAuth, waitUntil }) {
    for (const { chatId, window } of coalescer.drainReady())
      waitUntil(receive(whatsapp, { message: renderWindow(window), target: { chatId }, auth: appAuth }));
  },
});
```

- **Real?** ✅ Documented (`patterns/dynamic-scheduling.md`). But **1-minute floor** wrecks
  the 3–10s debounce feel, and scheduled sessions **can't `ask_question`**
  (`SessionCapabilities.requestInput`). Only useful as a slow safety-net flush.
- **Verdict:** complement, not the primary doorway.

---

## Option 4 — Drop the external timer; open a session per message, decide inside the agent

Every inbound message resumes the per-chat session immediately (Eve's `deliver` coalesces
rapid messages), and the agent itself decides speak-now / stay-quiet. **But** "wait until
the chat goes quiet, *then* maybe speak" still needs a delayed wake = a timer = a doorway.
So this doesn't remove the problem — it relocates the silence decision and loses the
Coalescer's burst-batching + relevance timing. Named for completeness; not recommended.

---

## Honest verdict + recommendation

| | Real/supported | Delivery | Debounce feel | Magic |
|---|---|---|---|---|
| **1 loopback client** | ✅ public API | `whatsapp_send` tool | exact | none (just self-HTTP) |
| **2 captured send** | ⚠️ undocumented | ✅ native | exact | needs `/wa/arm` + capture holds |
| **3 schedule** | ✅ documented | native | ✗ 1-min floor | none |
| **4 per-message** | ✅ | native | ✗ loses batching | none |

**Recommendation:** prove **Option 1** with a runnable spike (it's the one that's
unambiguously real), and keep **Option 2** as the delivery optimization if a spike shows
the captured `send` is stable. The spike is small and turns "is this even a real thing?"
into a yes/no you can watch: boot the eve agent, have a background timer call
`client.session("test").send({message:"hi"})`, confirm a turn runs and a reply comes back.

**Still open on top of the doorway** (from your latest steer, to fold into a revised spec):
- **Model** is not gpt-5.6-sol — your pick (you floated "5.6 luna"); left TBD.
- **GitHub triage as dynamic context** (`defineDynamic` per-chat instructions/skills), not
  a hard-wired subagent — so triage capabilities grow without rewiring. See
  `context-control.md` §dynamic + `patterns/multi-tenant-memory.md`.
- **Richer provenance state** — not just "what I filed" but *what it did, why, with
  supporting evidence*, stored so evals can replay and score decisions.
- **CLI** — the real vision: `npx` entry, **zero env vars**, everything configured through
  a clack-style flow (`eve/setup` `createPrompter`/`composeOnboardingBoxes`): WhatsApp
  login (QR), pick the chats, etc. Config persisted, not env.
