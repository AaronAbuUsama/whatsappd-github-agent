import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { registerProvider } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Duration, Effect, Layer, Queue } from "effect";
import { Hono } from "hono";
import { join } from "node:path";
import type { IncomingMessage as WhatsAppMessage } from "whatsappd";

import { makeAmbienceWindowDispatcher, dispatchAmbience } from "../../../../src/ambience/dispatch.js";
import type {
  IssueMilestone,
  IssueRepositoryOptions,
} from "../../../../src/capabilities/issue-management/issue-repository.js";
import { createIssueOperationStore } from "../../../../src/capabilities/issue-management/operation-store.js";
import {
  configureIssueManagementRuntime,
  createIssueManagementPolicy,
} from "../../../../src/capabilities/issue-management/runtime.js";
import { configureWhatsAppParticipationPort } from "../../../../src/capabilities/whatsapp-participation/whatsapp-port.js";
import * as Coalescer from "../../../../src/coalescer/coalescer.js";
import { configLayer } from "../../../../src/coalescer/config.js";
import type { IncomingMessage } from "../../../../src/coalescer/events.js";
import { queueEventSource } from "../../../../src/coalescer/mocks.js";
import { loadGitHubIngressSettings } from "../../../../src/github/ingress.js";
import { installGitHubIngressRuntime } from "../../../../src/github/ingress-runtime.js";
import { createFakeIssueRepository } from "../../../../src/host/fake-issue-repository.js";
import { createFakeWhatsAppHost } from "../../../../src/host/fake-whatsapp-host.js";
import { createConversationArchive } from "../../../../src/intake/conversation-archive.js";
import { conversationArrival } from "../../../../src/intake/conversation-event.js";
import { createManagedChatInbox, managedChatWindowStore } from "../../../../src/intake/managed-chat-inbox.js";
import { createManagedChatGptAuthentication } from "../../../../src/managed/chatgpt-authentication.js";
import { managedPaths } from "../../../../src/managed/paths.js";
import { connectPiChatGptSubscription } from "../../../../src/model/pi-subscription.js";

const liveModel = process.env.AMBIENCE_FIXTURE_LIVE_MODEL === "true";
const provider = liveModel ? undefined : registerFauxProvider({ provider: "ambience-fixture" });
const heldRecoveryMarkers = new Set<string>();
const holdAgentRecovery = process.env.AMBIENCE_FIXTURE_HOLD_AGENT_RECOVERY === "true";
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
  if (last?.role === "toolResult") {
    if (serialized.includes("whatsapp_search")) {
      return fauxAssistantMessage("Private bound-history result retained without speaking.");
    }
    if (serialized.includes("github_create_issue")) {
      return fauxAssistantMessage("Private Issue Management receipt retained without an extra mutation.");
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
configureIssueManagementRuntime({
  repository: fakeIssues,
  operations: issueOperations,
  policy: createIssueManagementPolicy("acme/widgets", ["acme/widgets"]),
});
const githubIngress = loadGitHubIngressSettings(process.env);
const githubIngressStore = installGitHubIngressRuntime(
  githubIngress,
  async (chatId, input) => await dispatchAmbience({ id: chatId, input }),
);
const source = await Effect.runPromise(Queue.unbounded<IncomingMessage>());
configureWhatsAppParticipationPort({
  say: fakeWhatsApp.say,
  readThread: (chatId, limit) => archive.readThread(chatId, limit),
  search: (chatId, query, limit) => archive.search(chatId, query, limit),
});
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

const app = new Hono();
app.get("/health", (context) => context.json({ ok: true }));
const archiveMessage = (input: IncomingMessage): void => {
  const archived = {
    ...input,
    kind: "text",
    reply: async () => ({ id: "unused", chatId: input.chatId, fromMe: true }),
  } as WhatsAppMessage;
  inbox.recorder.append(conversationArrival(archived));
};
app.post("/test/archive", async (context) => {
  archiveMessage(await context.req.json<IncomingMessage>());
  return context.body(null, 204);
});
app.post("/test/coalescer", async (context) => {
  const input = await context.req.json<IncomingMessage>();
  archiveMessage(input);
  const accepted = inbox.pendingArrival(input.chatId, input.id);
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
app.route("/", flue());

export default app;
