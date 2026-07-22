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
      evidenceId: v.optional(nonEmptyString),
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
  eventOrder: v.optional(v.array(nonEmptyString)),
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

export const githubPullRequestReviewSubmittedInputSchema = v.object({
  type: v.literal("github.pull-request-review.submitted"),
  chatId: nonEmptyString,
  deliveryId: nonEmptyString,
  installationId: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  repository: v.object({
    owner: nonEmptyString,
    repo: nonEmptyString,
    id: v.pipe(v.number(), v.integer(), v.minValue(1)),
    url: nonEmptyString,
  }),
  pullRequest: v.object({
    number: v.pipe(v.number(), v.integer(), v.minValue(1)),
    url: nonEmptyString,
    title: nonEmptyString,
    state: v.union([v.literal("open"), v.literal("closed")]),
    draft: v.boolean(),
  }),
  review: v.object({
    id: v.pipe(v.number(), v.integer(), v.minValue(1)),
    url: nonEmptyString,
    state: v.union([
      v.literal("commented"),
      v.literal("changes_requested"),
      v.literal("approved"),
      v.literal("dismissed"),
    ]),
  }),
  sender: v.object({
    login: nonEmptyString,
    id: v.pipe(v.number(), v.integer(), v.minValue(1)),
    type: nonEmptyString,
  }),
  graphContext,
});

export type GitHubPullRequestReviewSubmittedInput = v.InferOutput<
  typeof githubPullRequestReviewSubmittedInputSchema
>;
export type GitHubIngressInput =
  | GitHubIssueOpenedInput
  | GitHubPullRequestOpenedInput
  | GitHubPullRequestReviewSubmittedInput;

/**
 * A finished Specialist run returning as an input (MEMORY-STATE-SPEC §8, ADR 0001).
 *
 * An ENVELOPE, not the payload: the same member carries every Specialist, so the
 * transport facts (`runId`, `status`) and each Specialist's own output live at
 * different levels. `status` is the TRANSPORT status — the boot sweep sets
 * `"interrupted"` with no `result` at all; the durable-gated bridge sets `"ok"` and
 * nests the workflow's output under `result` (the Coder issue defines its `result`
 * shape). `graphContext` stays flat on the envelope (§5), never double-wrapped.
 */
export const specialistResultInputSchema = v.object({
  type: v.literal("specialist.result"),
  chatId: v.optional(nonEmptyString),
  runId: nonEmptyString,
  status: v.union([v.literal("ok"), v.literal("interrupted")]),
  result: v.optional(v.unknown()),
  graphContext,
});

export type SpecialistResultInput = v.InferOutput<typeof specialistResultInputSchema>;

/**
 * The rare, domain-significant progress a Specialist explicitly interrupts the thread
 * with (§8 Progress, ADR 0001's `workflow.progress`) — same delivery seam as
 * `specialist.result`. `milestone` carries the workflow-specific payload.
 */
export const specialistMilestoneInputSchema = v.object({
  type: v.literal("specialist.milestone"),
  chatId: v.optional(nonEmptyString),
  runId: nonEmptyString,
  milestone: v.optional(v.unknown()),
  graphContext,
});

export type SpecialistMilestoneInput = v.InferOutput<typeof specialistMilestoneInputSchema>;
export type SpecialistInput = SpecialistResultInput | SpecialistMilestoneInput;

export type SpeakerInput = WhatsAppWindowInput | GitHubIngressInput | SpecialistInput;

export const whatsappWindowInput = (window: ConversationWindow): WhatsAppWindowInput =>
  v.parse(whatsappWindowInputSchema, {
    type: "whatsapp.window",
    windowId: window.id,
    chatId: window.chatId,
    reason: window.reason,
    messages: window.messages.map((message) => ({
      ...message,
      evidenceId: `arrival:${message.chatId}:${message.id}`,
    })),
    updates: window.updates,
    ...(window.eventOrder === undefined ? {} : { eventOrder: window.eventOrder }),
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
  // A returning Specialist carries only its home thread as a seed; its GitHub work is
  // already in the graph the digest walk reaches from the thread.
  if (input.type === "specialist.result" || input.type === "specialist.milestone") {
    return { ...(input.chatId === undefined ? {} : { chatId: input.chatId }), identities: [] };
  }
  const repo = `${input.repository.owner}/${input.repository.repo}`;
  const externalIds = new Set<string>([repo, input.sender.login]);
  if (input.type === "github.issue.opened") {
    externalIds.add(`${repo}#${input.issue.number}`);
  } else {
    externalIds.add(`${repo}#${input.pullRequest.number}`);
    if (input.type === "github.pull-request.opened") {
      for (const issue of input.issues) externalIds.add(`${repo}#${issue.number}`);
    }
  }
  return {
    chatId: input.chatId,
    identities: [...externalIds].map((externalId) => ({ platform: "github", externalId })),
  };
};
