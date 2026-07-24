import type { BrainInbox } from "@ambient-agent/engine/brain/inbox.ts";
import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";

export interface IntentEscalationRuntime {
  readonly inbox: Pick<BrainInbox, "admitIntent">;
  readonly surfaceIdForSpeaker: (speakerId: string) => string | undefined;
  readonly wake: () => Promise<unknown>;
}

const runtimeSlot = createFlueGlobal<IntentEscalationRuntime>(
  "intent-escalation-runtime",
  "Intent escalation runtime is not configured",
);

export const configureIntentEscalationRuntime = (runtime: IntentEscalationRuntime): void => runtimeSlot.set(runtime);
export const getIntentEscalationRuntime = (): IntentEscalationRuntime => runtimeSlot.get();
