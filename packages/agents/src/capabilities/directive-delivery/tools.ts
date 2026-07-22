import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { deliverDirective } from "./runtime.ts";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const base = {
  directiveId: nonEmptyString,
  surfaceId: nonEmptyString,
};
const outcomeSchema = v.union([
  v.object({
    ...base,
    deliveryId: nonEmptyString,
    status: v.literal("delivered"),
    providerMessageId: nonEmptyString,
    conversationEventId: nonEmptyString,
  }),
  v.object({
    ...base,
    deliveryId: v.optional(nonEmptyString),
    status: v.union([v.literal("failed"), v.literal("uncertain")]),
    error: nonEmptyString,
    providerMessageId: v.optional(nonEmptyString),
    conversationEventId: v.optional(nonEmptyString),
  }),
  v.object({
    ...base,
    status: v.literal("settled_without_say"),
    reason: nonEmptyString,
  }),
]);

export const createSayDirectiveTool = (speakerId: string) =>
  defineTool({
    name: "say_directive",
    description:
      "Attempt the current Brain Directive once on this Speaker's Surface and return its durable Directive Outcome.",
    input: v.object({
      directiveId: nonEmptyString,
      text: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
    }),
    output: outcomeSchema,
    run: ({ input }) => deliverDirective(speakerId, input.directiveId, input.text),
  });
