// flue-blueprint: tooling/vitest-evals@1
import {
  createFlueClient,
  type AgentPromptResponse,
  type FlueConversationMessage,
  type FlueConversationSnapshot,
} from "@flue/sdk";
import { createHarness, type JsonValue, toJsonValue, type TranscriptEvent } from "vitest-evals";

export interface FlueAgentHarnessOptions {
  agentName: string;
  baseUrl?: string;
  token?: string;
  headers?: Record<string, string>;
}

interface FixtureHistorySeed {
  scope: "current" | "other";
  text: string;
  chatId?: string;
}

interface FixtureIssueMilestone {
  number: number;
  title: string;
  state: "open" | "closed";
}

interface FlueAgentEvalFixture {
  resetWhatsApp?: boolean;
  resetGitHub?: boolean;
  history?: FixtureHistorySeed[];
  githubIssues?: Array<{
    title: string;
    body: string;
    labels?: string[];
    assignees?: string[];
    milestone?: FixtureIssueMilestone | null;
  }>;
  githubOptions?: {
    labels: string[];
    assignees: string[];
    milestones: FixtureIssueMilestone[];
  };
}

export type FlueAgentEvalInput =
  | {
      message: string;
      window?: never;
      fixture?: FlueAgentEvalFixture;
    }
  | {
      message?: never;
      window: { texts: WindowText[] };
      fixture?: FlueAgentEvalFixture;
    };

export type WindowText = string | { text: string; from: string; pushName: string };

export type FlueAgentEvalOutput = {
  text: string;
  instanceId: string;
  windowMessages?: Array<{ id: string; text: string; from: string; pushName: string }>;
  whatsappEvents: JsonValue[];
  githubEvents: JsonValue[];
  githubOperations: JsonValue[];
};

const jsonRecord = (value: unknown): Record<string, JsonValue> | undefined => {
  const json = toJsonValue(value);
  if (json === undefined) return undefined;
  if (json !== null && typeof json === "object" && !Array.isArray(json)) return json as Record<string, JsonValue>;
  return { value: json };
};

const conversationEvents = (messages: FlueConversationMessage[]): TranscriptEvent[] =>
  messages.flatMap((message) => {
    const events: TranscriptEvent[] = [];
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (text.length > 0) events.push({ type: "message", role: message.role, content: text });

    for (const part of message.parts) {
      if (part.type !== "dynamic-tool") continue;
      events.push({
        type: "tool_call",
        id: part.toolCallId,
        name: part.toolName,
        ...(jsonRecord(part.input) === undefined ? {} : { arguments: jsonRecord(part.input) }),
      });
      if (part.state === "output-available") {
        events.push({
          type: "tool_result",
          toolCallId: part.toolCallId,
          name: part.toolName,
          content: toJsonValue(part.output),
        });
      } else if (part.state === "output-error") {
        events.push({
          type: "tool_result",
          toolCallId: part.toolCallId,
          name: part.toolName,
          error: { message: part.errorText },
        });
      }
    }
    return events;
  });

const checkedFetch = async (url: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Fixture request ${init?.method ?? "GET"} ${url} failed: ${await response.text()}`);
  return response;
};

const abortReason = (signal: AbortSignal): unknown => signal.reason ?? new DOMException("Aborted", "AbortError");

const pollDelay = async (signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted === true) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const finished = () => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    };
    const timer = setTimeout(finished, 20);
    const aborted = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
};

// Keep fixture polling inside the 120-second Vitest eval timeout so failures surface from this harness first.
const WINDOW_POLL_DEADLINE_MS = 110_000;
const withinPollDeadline = (startedAt: number, description: string): void => {
  if (performance.now() - startedAt > WINDOW_POLL_DEADLINE_MS) throw new Error(`Timed out waiting for ${description}.`);
};

interface FixtureAdmission {
  status: "pending" | "done" | "failed";
  windowId: string;
  chatId: string;
  dispatchId?: string;
  reason?: string;
}

const submitWindow = async (
  baseUrl: string,
  instanceId: string,
  texts: WindowText[],
  signal?: AbortSignal,
): Promise<{ dispatchId: string; messages: Array<{ id: string; text: string; from: string; pushName: string }> }> => {
  if (texts.length === 0) throw new Error("A coalesced eval Window requires at least one text.");
  const timestamp = Date.now();
  const messages = texts.map((entry, index) => {
    const message = typeof entry === "string" ? { text: entry, from: "alice@s.whatsapp.net", pushName: "Alice" } : entry;
    return { id: `eval-window-${crypto.randomUUID()}-${index}`, ...message };
  });
  for (const [index, message] of messages.entries()) {
    await checkedFetch(`${baseUrl}/test/coalescer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: message.id,
        chatId: instanceId,
        from: message.from,
        pushName: message.pushName,
        text: message.text,
        timestamp: timestamp + index,
        isGroup: true,
        fromMe: false,
        live: true,
        mentions: [],
      }),
      signal,
    });
  }

  const startedAt = performance.now();
  for (;;) {
    const admissions = (await (
      await checkedFetch(`${baseUrl}/test/admission?chatId=${encodeURIComponent(instanceId)}`, { signal })
    ).json()) as FixtureAdmission[];
    const admission = admissions.at(-1);
    if (admission?.status === "failed") throw new Error(`Window admission failed: ${admission.reason ?? "unknown"}`);
    if (admission?.status === "done" && admission.dispatchId !== undefined) {
      return { dispatchId: admission.dispatchId, messages };
    }
    withinPollDeadline(startedAt, "the coalesced Window admission");
    await pollDelay(signal);
  }
};

const agentResult = (value: unknown): AgentPromptResponse => {
  if (value === null || typeof value !== "object") throw new Error("Window submission returned no agent result.");
  const result = value as Partial<AgentPromptResponse>;
  if (typeof result.text !== "string" || result.usage === undefined || result.model === undefined) {
    throw new Error("Window submission returned an invalid agent result.");
  }
  return result as AgentPromptResponse;
};

const waitForWindowSettlement = async (
  baseUrl: string,
  dispatchId: string,
  signal?: AbortSignal,
): Promise<{ result: AgentPromptResponse }> => {
  const startedAt = performance.now();
  for (;;) {
    const settlement = (await (
      await checkedFetch(`${baseUrl}/test/submission?dispatchId=${encodeURIComponent(dispatchId)}`, { signal })
    ).json()) as {
      outcome: "completed" | "failed";
      result?: unknown;
      error?: unknown;
    } | null;
    if (settlement?.outcome === "failed") {
      throw new Error(`Window submission ${settlement.outcome}: ${JSON.stringify(settlement.error)}`);
    }
    if (settlement?.outcome === "completed") {
      return { result: agentResult(settlement.result) };
    }
    withinPollDeadline(startedAt, "the coalesced Window submission to settle");
    await pollDelay(signal);
  }
};

const seedFixture = async (
  baseUrl: string,
  instanceId: string,
  fixture: NonNullable<FlueAgentEvalInput["fixture"]>,
): Promise<void> => {
  if (fixture.resetWhatsApp === true) {
    await checkedFetch(`${baseUrl}/test/whatsapp/events`, { method: "DELETE" });
  }
  if (fixture.resetGitHub === true) {
    await checkedFetch(`${baseUrl}/test/github/events`, { method: "DELETE" });
  }
  if (fixture.githubOptions !== undefined) {
    await checkedFetch(`${baseUrl}/test/github/options`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixture.githubOptions),
    });
  }
  for (const [index, seed] of (fixture.history ?? []).entries()) {
    const chatId = seed.scope === "current" ? instanceId : (seed.chatId ?? `eval-other-${crypto.randomUUID()}@g.us`);
    await checkedFetch(`${baseUrl}/test/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: `eval-history-${crypto.randomUUID()}-${index}`,
        chatId,
        from: "alice@s.whatsapp.net",
        pushName: "Alice",
        text: seed.text,
        timestamp: Date.now() + index,
        isGroup: true,
        fromMe: false,
        live: true,
        mentions: [],
      }),
    });
  }
  for (const issue of fixture.githubIssues ?? []) {
    await checkedFetch(`${baseUrl}/test/github/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(issue),
    });
  }
};

export function createFlueAgentHarness(options: FlueAgentHarnessOptions) {
  const baseUrl = options.baseUrl ?? process.env.FLUE_BASE_URL ?? "http://127.0.0.1:3583";
  const client = createFlueClient({ baseUrl, token: options.token, headers: options.headers });

  return createHarness<FlueAgentEvalInput, FlueAgentEvalOutput>({
    name: `flue-${options.agentName}-agent`,
    run: async ({ input, signal }) => {
      const startedAt = performance.now();
      const instanceId = `eval-${crypto.randomUUID()}@g.us`;
      if (input.fixture !== undefined) await seedFixture(baseUrl, instanceId, input.fixture);
      const priorGitHubOperationIds =
        input.fixture === undefined
          ? new Set<string>()
          : new Set(
              (
                (await (await checkedFetch(`${baseUrl}/test/github/operations`)).json()) as Array<{
                  operationId?: string;
                }>
              ).flatMap((operation) => (operation.operationId === undefined ? [] : [operation.operationId])),
            );

      let result: AgentPromptResponse;
      let history: FlueConversationSnapshot;
      let submissionId: string | undefined;
      let dispatchId: string | undefined;
      let windowMessages: Array<{ id: string; text: string; from: string; pushName: string }> | undefined;
      if (input.window === undefined) {
        const invocation = await client.agents.prompt(options.agentName, instanceId, {
          message: input.message,
          signal,
        });
        result = invocation.result;
        submissionId = invocation.submissionId;
        history = await client.agents.history(options.agentName, instanceId, { signal });
      } else {
        const window = await submitWindow(baseUrl, instanceId, input.window.texts, signal);
        dispatchId = window.dispatchId;
        windowMessages = window.messages;
        const settled = await waitForWindowSettlement(baseUrl, dispatchId, signal);
        result = settled.result;
        history = await client.agents.history(options.agentName, instanceId, { signal });
      }
      const events = conversationEvents(history.messages);
      const whatsappEvents =
        input.fixture === undefined
          ? []
          : ((await checkedFetch(`${baseUrl}/test/whatsapp/events`)).json() as Promise<JsonValue[]>);
      const githubEvents =
        input.fixture === undefined
          ? []
          : ((await checkedFetch(`${baseUrl}/test/github/events`)).json() as Promise<JsonValue[]>);
      const githubOperations =
        input.fixture === undefined
          ? []
          : (
              (await (await checkedFetch(`${baseUrl}/test/github/operations`)).json()) as Array<{
                operationId?: string;
              }>
            ).filter(
              (operation) => operation.operationId === undefined || !priorGitHubOperationIds.has(operation.operationId),
            );

      return {
        output: {
          text: result.text,
          instanceId,
          ...(windowMessages === undefined ? {} : { windowMessages }),
          whatsappEvents: await whatsappEvents,
          githubEvents: await githubEvents,
          githubOperations: toJsonValue(githubOperations) as JsonValue[],
        },
        events,
        usage: {
          provider: result.model.provider,
          model: result.model.id,
          inputTokens: result.usage.input,
          outputTokens: result.usage.output,
          totalTokens: result.usage.totalTokens,
          toolCalls: events.filter((event) => event.type === "tool_call").length,
          metadata: { cost: result.usage.cost.total },
        },
        timings: { totalMs: performance.now() - startedAt },
        artifacts: {
          instanceId,
          ...(submissionId === undefined ? {} : { submissionId }),
          ...(dispatchId === undefined ? {} : { dispatchId }),
        },
      };
    },
  });
}
