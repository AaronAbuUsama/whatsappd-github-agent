import type { ConversationWindow } from "./coalescer/events.ts";
import * as v from "valibot";

import { graphDigestSchema, type DigestSeeds } from "./graph/digest.ts";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

/**
 * The pushed graph digest (§5), computed at the `dispatchSpeaker` funnel and carried
 * as a flat optional field on every input-union member — never an envelope wrapper,
 * so existing `input.type` consumers are untouched. Must appear in each schema or
 * valibot's `object` would strip it on parse.
 */
const graphContext = v.optional(graphDigestSchema);
const updateBase = {
  id: nonEmptyString,
  providerMessageId: nonEmptyString,
  chatId: nonEmptyString,
  senderId: v.optional(nonEmptyString),
  senderName: v.optional(v.string()),
  direction: v.union([v.literal("inbound"), v.literal("outbound")]),
  occurredAt: v.pipe(v.number(), v.finite()),
};

const whatsappWindowInputSchema = v.object({
  type: v.literal("whatsapp.window"),
  windowId: nonEmptyString,
  chatId: nonEmptyString,
  reason: v.union([
    v.literal("debounce"),
    v.literal("maximum-wait"),
    v.literal("capacity"),
    v.literal("mention"),
    v.literal("quote-reply"),
  ]),
  messages: v.array(
    v.object({
      id: nonEmptyString,
      chatId: nonEmptyString,
      from: nonEmptyString,
      pushName: v.optional(v.string()),
      text: v.string(),
      timestamp: v.pipe(v.number(), v.finite()),
      isGroup: v.boolean(),
      fromMe: v.boolean(),
      live: v.boolean(),
      mentions: v.array(nonEmptyString),
      quotedFrom: v.optional(nonEmptyString),
    }),
  ),
  updates: v.array(
    v.union([
      v.object({
        ...updateBase,
        kind: v.literal("edit"),
        payload: v.object({ messageKind: nonEmptyString, text: v.string() }),
      }),
      v.object({
        ...updateBase,
        kind: v.literal("reaction"),
        payload: v.object({
          by: v.optional(nonEmptyString),
          emoji: v.optional(v.string()),
          removed: v.boolean(),
        }),
      }),
      v.object({
        ...updateBase,
        kind: v.literal("revocation"),
        payload: v.object({ by: v.optional(nonEmptyString) }),
      }),
    ]),
  ),
  graphContext,
});

export type WhatsAppWindowInput = v.InferOutput<typeof whatsappWindowInputSchema>;

export const githubIssueOpenedInputSchema = v.object({
  type: v.literal("github.issue.opened"),
  chatId: nonEmptyString,
  deliveryId: nonEmptyString,
  installationId: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  repository: v.object({
    owner: nonEmptyString,
    repo: nonEmptyString,
    id: v.pipe(v.number(), v.integer(), v.minValue(1)),
    url: nonEmptyString,
  }),
  issue: v.object({
    number: v.pipe(v.number(), v.integer(), v.minValue(1)),
    url: nonEmptyString,
    title: nonEmptyString,
    state: v.literal("open"),
  }),
  sender: v.object({
    login: nonEmptyString,
    id: v.pipe(v.number(), v.integer(), v.minValue(1)),
    type: nonEmptyString,
  }),
  graphContext,
});

export type GitHubIssueOpenedInput = v.InferOutput<typeof githubIssueOpenedInputSchema>;

export const githubPullRequestOpenedInputSchema = v.object({
  type: v.literal("github.pull-request.opened"),
  chatId: nonEmptyString,
  deliveryId: nonEmptyString,
  installationId: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  repository: v.object({
    owner: nonEmptyString,
    repo: nonEmptyString,
    id: v.pipe(v.number(), v.integer(), v.minValue(1)),
    url: nonEmptyString,
  }),
  issues: v.pipe(
    v.array(v.object({ number: v.pipe(v.number(), v.integer(), v.minValue(1)) })),
    v.minLength(1),
  ),
  pullRequest: v.object({
    number: v.pipe(v.number(), v.integer(), v.minValue(1)),
    url: nonEmptyString,
    title: nonEmptyString,
    state: v.literal("open"),
    draft: v.boolean(),
  }),
  sender: v.object({
    login: nonEmptyString,
    id: v.pipe(v.number(), v.integer(), v.minValue(1)),
    type: nonEmptyString,
  }),
  graphContext,
});

export type GitHubPullRequestOpenedInput = v.InferOutput<typeof githubPullRequestOpenedInputSchema>;
export type GitHubIngressInput = GitHubIssueOpenedInput | GitHubPullRequestOpenedInput;
export type SpeakerInput = WhatsAppWindowInput | GitHubIngressInput;

export const whatsappWindowInput = (window: ConversationWindow): WhatsAppWindowInput =>
  v.parse(whatsappWindowInputSchema, {
    type: "whatsapp.window",
    windowId: window.id,
    chatId: window.chatId,
    reason: window.reason,
    messages: window.messages,
    updates: window.updates,
  });

/**
 * Seeds the digest walk (§5 D2/D6) from keys already in the window: the thread's chat
 * id, its human participants, and any GitHub objects in view — all natural keys that
 * `graph_identities` resolves to entities.
 */
export const speakerDigestSeeds = (input: SpeakerInput): DigestSeeds => {
  if (input.type === "whatsapp.window") {
    const identities = new Set<string>();
    for (const message of input.messages) {
      if (!message.fromMe) identities.add(message.from);
      for (const mention of message.mentions) identities.add(mention);
    }
    return {
      chatId: input.chatId,
      identities: [...identities].map((externalId) => ({ platform: "whatsapp", externalId })),
    };
  }
  const repo = `${input.repository.owner}/${input.repository.repo}`;
  const externalIds = new Set<string>([repo, input.sender.login]);
  if (input.type === "github.issue.opened") {
    externalIds.add(`${repo}#${input.issue.number}`);
  } else {
    externalIds.add(`${repo}#${input.pullRequest.number}`);
    for (const issue of input.issues) externalIds.add(`${repo}#${issue.number}`);
  }
  return {
    chatId: input.chatId,
    identities: [...externalIds].map((externalId) => ({ platform: "github", externalId })),
  };
};
