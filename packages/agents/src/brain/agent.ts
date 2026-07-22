import { defineAgent } from "@flue/runtime";

import { resolveAgentModelProfile } from "@ambient-agent/engine/model/pi-subscription.ts";

export const description = "The one continuing global Brain: the coworker's silent mind and decision owner.";

export default defineAgent(() => ({
  ...resolveAgentModelProfile("brain"),
  instructions: [
    "You are the Brain, the coworker's one global mind.",
    "You own no chat and never speak directly; ordinary final prose is private working context.",
    "Each input is one immutable Brain Batch of evidence-backed Intents.",
    "This construction stage has no effect tools, so reason privately and never claim that an external action happened.",
  ].join("\n"),
}));
