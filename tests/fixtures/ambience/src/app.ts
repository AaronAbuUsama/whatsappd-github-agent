import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { observe, registerProvider } from "@flue/runtime";
import { Duration, Effect, Layer, Queue } from "effect";
import type { Hono } from "hono";
import { join } from "node:path";
import type { IncomingMessage as WhatsAppMessage } from "whatsappd";

import "@ambient-agent/core/braintrust.ts";
import { composeAmbience } from "@ambient-agent/core/ambience/compose.ts";
import { makeAmbienceWindowDispatcher, dispatchAmbience } from "@ambient-agent/core/ambience/dispatch.ts";
import type {
  IssueMilestone,
  IssueRepositoryOptions,
} from "@ambient-agent/core/capabilities/issue-management/issue-repository.ts";
import { createIssueOperationStore } from "@ambient-agent/core/capabilities/issue-management/operation-store.ts";
import { createIssueManagementPolicy } from "@ambient-agent/core/capabilities/issue-management/runtime.ts";
import * as Coalescer from "@ambient-agent/core/coalescer/coalescer.ts";
import { configLayer } from "@ambient-agent/core/coalescer/config.ts";
import type { CoalescerEvent, IncomingMessage } from "@ambient-agent/core/coalescer/events.ts";
import { queueEventSource } from "@ambient-agent/core/coalescer/mocks.ts";
import type { GitHubIngressStore } from "@ambient-agent/core/github/ingress-store.ts";
import { createFakeIssueRepository } from "@ambient-agent/test-support/fake-issue-repository.ts";
import { createFakeWhatsAppHost } from "@ambient-agent/test-support/fake-whatsapp-host.ts";
import { createConversationArchive } from "@ambient-agent/core/intake/conversation-archive.ts";
import { conversationArrival } from "@ambient-agent/core/intake/conversation-event.ts";
import { createManagedChatInbox, managedChatWindowStore } from "@ambient-agent/core/intake/managed-chat-inbox.ts";
import { createManagedChatGptAuthentication } from "@ambient-agent/core/managed/chatgpt-authentication.ts";
import { managedPaths } from "@ambient-agent/core/managed/paths.ts";
import { connectPiChatGptSubscription } from "@ambient-agent/core/model/pi-subscription.ts";

const liveModel = process.env.AMBIENCE_FIXTURE_LIVE_MODEL === "true";
const provider = liveModel ? undefined : registerFauxProvider({ provider: "ambience-fixture" });
const heldRecoveryMarkers = new Set<string>();
const settledDispatches = new Map<string, { outcome: "completed" | "failed"; result?: unknown; error?: unknown }>();
const holdAgentRecovery = process.env.AMBIENCE_FIXTURE_HOLD_AGENT_RECOVERY === "true";
observe((event) => {
  if (event.type !== "operation" || event.operationKind !== "prompt" || event.dispatchId === undefined) return;
  settledDispatches.set(event.dispatchId, {
    outcome: event.isError ? "failed" : "completed",
    ...(event.result === undefined ? {} : { result: event.result }),
    ...(event.error === undefined ? {} : { error: event.error }),
  });
});

const parsedToolResult = (message: Context["messages"][number]): unknown => {
  if (message.role !== "toolResult") return undefined;
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const respond = async (context: Context) => {
  const last = context.messages.at(-1);
  const serialized = JSON.stringify(last);
  const transcript = JSON.stringify(context.messages);
  const recoveryMarker = serialized.match(/HOLD_AGENT_FOR_RESTART:([A-Za-z0-9_-]+)/)?.[1];
  if (recoveryMarker && holdAgentRecovery) {
    heldRecoveryMarkers.add(recoveryMarker);
    await new Promise<never>(() => undefined);
  }
  if (recoveryMarker) {
    return fauxAssistantMessage(
      transcript.includes(`HOLD_AGENT_FOR_RESTART:${recoveryMarker}`)
        ? `Recovered canonical context for ${recoveryMarker}.`
        : `Canonical context was lost for ${recoveryMarker}.`,
    );
  }
  if (serialized.includes("SMOKE SPEAK_ONCE CREATE_COMPLETE_ISSUE")) {
    return fauxAssistantMessage("Private SMOKE canary retained without speaking or acting.");
  }
  if (last?.role === "toolResult") {
    if (serialized.includes("whatsapp_search")) {
      return fauxAssistantMessage("Private bound-history result retained without speaking.");
    }
    if (last.toolName === "github_create_issue") {
      const result = parsedToolResult(last) as { status?: unknown; issue?: { url?: unknown } } | undefined;
      if ((result?.status === "created" || result?.status === "reconciled") && typeof result.issue?.url === "string") {
        return fauxAssistantMessage(fauxToolCall("say", { text: `Filed ${result.issue.url}` }), {
          stopReason: "toolUse",
        });
      }
      return fauxAssistantMessage("Private non-filed Issue Management result retained without speaking.");
    }
    if (serialized.includes("github_update_issue")) {
      return fauxAssistantMessage(
        fauxToolCall("say", { text: "Updated issue #1 with the corrected title and repository organization." }),
        { stopReason: "toolUse" },
      );
    }
    if (serialized.includes("github_search_issues") || serialized.includes("github_read_issue")) {
      return fauxAssistantMessage("Private Issue Management read retained without speaking.");
    }
    if (serialized.includes("say") && transcript.includes("github_create_issue")) {
      return fauxAssistantMessage("Private Issue Management receipt retained without an extra mutation.");
    }
    return fauxAssistantMessage("Private speech outcome retained for the next Ambience turn.");
  }
  if (serialized.includes("CREATE_COMPLETE_ISSUE")) {
    return fauxAssistantMessage(
      fauxToolCall("github_create_issue", {
        kind: "bug",
        title: "The scheduler loses a queued job",
        body: "Expected the queued job to run. It disappears after restart.",
      }),
      {
        stopReason: "toolUse",
      },
    );
  }
  if (serialized.includes("UPDATE_EXISTING_ISSUE")) {
    return fauxAssistantMessage(
      fauxToolCall("github_update_issue", {
        number: 1,
        title: "Scheduler loses queued jobs after restart",
        body: "Expected queued jobs to run after restart. Observed that they disappear.",
        labels: ["bug", "priority: high"],
        assignees: ["maintainer"],
        milestone: 3,
      }),
      { stopReason: "toolUse" },
    );
  }
  if (serialized.includes("CREATE_COMPLETE_FEATURE")) {
    return fauxAssistantMessage(
      fauxToolCall("github_create_issue", {
        kind: "feature",
        title: "Show queue depth in status",
        body: "Operators need queue depth in status to diagnose backpressure.",
      }),
      { stopReason: "toolUse" },
    );
  }
  if (serialized.includes("DUPLICATE_ISSUE")) {
    return fauxAssistantMessage(
      fauxToolCall("github_create_issue", {
        kind: "bug",
        title: "The scheduler loses a queued job",
        body: "Expected the queued job to run.",
      }),
      { stopReason: "toolUse" },
    );
  }
  if (serialized.includes("INCOMPLETE_ISSUE")) {
    return fauxAssistantMessage(
      fauxToolCall("say", {
        text: "What did you expect to happen, and what happened instead?",
      }),
      { stopReason: "toolUse" },
    );
  }
  if (serialized.includes("github.issue.opened")) {
    return fauxAssistantMessage("Private verified GitHub delivery processed without speaking.");
  }
  if (serialized.includes("github.pull-request.opened")) {
    const pullRequestUrl = serialized.match(/https:\/\/github\.com\/acme\/widgets\/pull\/[0-9]+/)?.[0];
    if (!pullRequestUrl) throw new Error("Normalized pull-request delivery is missing its link");
    const issuesStart = serialized.indexOf("issues");
    const pullRequestStart = serialized.indexOf("pullRequest", issuesStart);
    const issueCount =
      issuesStart < 0 || pullRequestStart < 0
        ? 0
        : (serialized.slice(issuesStart, pullRequestStart).match(/number/g) ?? []).length;
    if (issueCount === 0) throw new Error("Normalized pull-request delivery is missing captured issues");
    return fauxAssistantMessage(
      Array.from({ length: issueCount }, () => fauxToolCall("say", { text: pullRequestUrl })),
      { stopReason: "toolUse" },
    );
  }
  if (serialized.includes("REACT_AND_REPLY")) {
    const messageId = serialized.match(/fixture-[0-9]+/)?.[0];
    if (!messageId) throw new Error("Participation proof input is missing its source message ID");
    return fauxAssistantMessage(
      [
        fauxToolCall("react", { messageId, emoji: "👀" }),
        fauxToolCall("say", { text: "I am following this one.", replyTo: messageId }),
      ],
      { stopReason: "toolUse" },
    );
  }
  if (serialized.includes("SPEAK_ONCE")) {
    return fauxAssistantMessage(fauxToolCall("say", { text: "one explicit outbound" }), { stopReason: "toolUse" });
  }
  if (serialized.includes("please tell the group that the release call starts at 16:00 UTC")) {
    return fauxAssistantMessage(fauxToolCall("say", { text: "The release call starts at 16:00 UTC." }), {
      stopReason: "toolUse",
    });
  }
  if (serialized.includes("Search WhatsApp history for release details")) {
    return fauxAssistantMessage(fauxToolCall("whatsapp_search", { query: "release" }), {
      stopReason: "toolUse",
    });
  }
  if (serialized.includes("FAIL_SEND")) {
    return fauxAssistantMessage(fauxToolCall("say", { text: "uncertain outbound" }), { stopReason: "toolUse" });
  }
  if (serialized.includes("first coalesced input")) return fauxAssistantMessage("private working note one");
  if (serialized.includes("second coalesced input")) return fauxAssistantMessage("private working note two");
  if (serialized.includes("A_SECOND")) {
    return fauxAssistantMessage(
      transcript.includes("A_FIRST") ? "Chat A retained its first window in context." : "Chat A context was lost.",
    );
  }
  if (serialized.includes("B_ONLY")) {
    return fauxAssistantMessage(
      transcript.includes("A_FIRST") ? "Chat B leaked Chat A context." : "Chat B remained isolated from Chat A.",
    );
  }
  return fauxAssistantMessage("Private ambient context retained without speaking.");
};
if (provider === undefined) {
  const dataDirectory = process.env.AMBIENCE_FIXTURE_DATA_DIR;
  if (!dataDirectory) throw new Error("AMBIENCE_FIXTURE_DATA_DIR is required for a live-model fixture.");
  await connectPiChatGptSubscription({
    authentication: createManagedChatGptAuthentication(managedPaths({ dataDirectory })),
  });
} else {
  provider.setResponses(Array.from({ length: 100 }, () => respond));
  const model = provider.getModel();
  registerProvider("openai-codex", {
    api: model.api,
    apiKey: "fixture-only-token",
    baseUrl: model.baseUrl,
  });
}

const fakeWhatsApp = createFakeWhatsAppHost();
const applicationDatabase = process.env.APPLICATION_DB_PATH ?? join(process.cwd(), "application.sqlite");
const archive = createConversationArchive(applicationDatabase);
const issueOperations = createIssueOperationStore(applicationDatabase);
const fakeIssues = createFakeIssueRepository();
const source = await Effect.runPromise(Queue.unbounded<CoalescerEvent>());
const inbox = createManagedChatInbox(archive, { allowed: () => true });
let failAfterFlueAcceptance = false;
Effect.runFork(
  Effect.scoped(
    Coalescer.run.pipe(
      Effect.provide(
        Layer.mergeAll(
          queueEventSource(source),
          makeAmbienceWindowDispatcher(
            inbox,
            async (request) => {
              const receipt = await dispatchAmbience(request);
              if (failAfterFlueAcceptance) {
                failAfterFlueAcceptance = false;
                throw new Error("injected failure after Flue acceptance");
              }
              return receipt;
            },
            { attempts: 3, delayMs: () => 0 },
          ),
          managedChatWindowStore(inbox),
          configLayer({ botIds: ["bot@s.whatsapp.net"], debounceWindow: Duration.millis(25) }),
        ),
      ),
    ),
  ),
);

const conversationEvent = (input: IncomingMessage) => {
  const archived = {
    ...input,
    kind: "text",
    reply: async () => ({ id: "unused", chatId: input.chatId, fromMe: true }),
  } as WhatsAppMessage;
  return conversationArrival(archived);
};
const app = composeAmbience({
  issues: fakeIssues,
  operations: issueOperations,
  policy: createIssueManagementPolicy("acme/widgets", ["acme/widgets"]),
  ingress: {
    settings: {
      databasePath: applicationDatabase,
      routes: new Map([["acme/widgets", "github-ingress-29@g.us"]]),
    },
    dispatch: async (chatId, input) => await dispatchAmbience({ id: chatId, input }),
  },
  participation: {
    say: fakeWhatsApp.say,
    react: fakeWhatsApp.react,
    readThread: (chatId, limit) => archive.readThread(chatId, limit),
    search: (chatId, query, limit) => archive.search(chatId, query, limit),
  },
  routes: (app, { githubIngress }) => {
    installTestRoutes(app, githubIngress);
  },
});
function installTestRoutes(app: Hono, githubIngressStore: GitHubIngressStore): void {
app.post("/test/archive", async (context) => {
  archive.append(conversationEvent(await context.req.json<IncomingMessage>()));
  return context.body(null, 204);
});
app.post("/test/coalescer", async (context) => {
  const input = await context.req.json<IncomingMessage>();
  inbox.recorder.append(conversationEvent(input));
  const accepted = inbox.pending(input);
  if (accepted !== undefined) await Effect.runPromise(Queue.offer(source, accepted));
  return context.json({ accepted: true }, 202);
});
app.post("/test/admission/fail-after-acceptance", (context) => {
  failAfterFlueAcceptance = true;
  return context.body(null, 204);
});
app.get("/test/admission", (context) => {
  const chatId = context.req.query("chatId");
  const admissions = inbox.admissions().flatMap((admission) => {
    const window = inbox.window(admission.windowId);
    return window !== undefined && (chatId === undefined || window.chatId === chatId)
      ? [{ ...admission, chatId: window.chatId }]
      : [];
  });
  return context.json(admissions);
});
app.get("/test/submission", (context) => {
  const dispatchId = context.req.query("dispatchId");
  return context.json(dispatchId === undefined ? null : (settledDispatches.get(dispatchId) ?? null));
});
app.get("/test/whatsapp/events", (context) => context.json(fakeWhatsApp.events()));
app.delete("/test/whatsapp/events", (context) => {
  fakeWhatsApp.reset();
  return context.body(null, 204);
});
app.post("/test/whatsapp/fail-next-send", (context) => {
  fakeWhatsApp.failNextSend(new Error("provider outcome unknown"));
  return context.body(null, 204);
});
app.get("/test/github/events", (context) => context.json(fakeIssues.events()));
app.get("/test/github/operations", (context) => context.json(issueOperations.list()));
app.put("/test/github/options", async (context) => {
  fakeIssues.setOptions(await context.req.json<IssueRepositoryOptions>());
  return context.body(null, 204);
});
app.post("/test/github/issues", async (context) => {
  const input = await context.req.json<{
    title: string;
    body: string;
    labels?: string[];
    assignees?: string[];
    milestone?: IssueMilestone | null;
  }>();
  return context.json(fakeIssues.seed({ repository: { owner: "acme", repo: "widgets" }, ...input }), 201);
});
app.get("/test/github/ingress", (context) => context.json(githubIngressStore.list()));
app.delete("/test/github/events", (context) => {
  fakeIssues.reset();
  return context.body(null, 204);
});
app.post("/test/github/fail-next-create", (context) => {
  fakeIssues.failNextCreate(new Error("GitHub rejected the mutation"));
  return context.body(null, 204);
});
app.post("/test/github/timeout-next-create", (context) => {
  fakeIssues.timeoutNextCreate({ afterMutation: context.req.query("afterMutation") === "true" });
  return context.body(null, 204);
});
app.get("/test/model/recovery-pending", (context) => context.json({ markers: [...heldRecoveryMarkers] }));
}

export default app;
