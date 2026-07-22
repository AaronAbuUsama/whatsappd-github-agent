import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { getIntentEscalationRuntime } from "./runtime.ts";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

export const createEscalateIntentTool = (speakerId: string) =>
  defineTool({
    name: "escalate_intent",
    description:
      "Ask the global Brain to judge a cross-Surface consequence or possible work. Select immutable evidenceIds from the current WhatsApp Window. Admission is not completion: never claim that the Brain acted.",
    input: v.object({
      interpretation: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
      evidenceIds: v.pipe(v.array(nonEmptyString), v.minLength(1), v.maxLength(50)),
    }),
    output: v.object({ intentId: nonEmptyString }),
    run: async ({ input }) => {
      const runtime = getIntentEscalationRuntime();
      const sourceSurfaceId = runtime.surfaceIdForSpeaker(speakerId);
      if (sourceSurfaceId === undefined) throw new Error(`Speaker ${speakerId} has no active Surface.`);
      const intent = runtime.inbox.admitIntent({ sourceSurfaceId, ...input });
      await runtime.wake();
      return { intentId: intent.id };
    },
  });
