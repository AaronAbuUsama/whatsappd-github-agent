import type { DispatchReceipt } from "@flue/runtime";

import type { BrainInbox, PromptSpeakerEffect } from "@ambient-agent/engine/brain/inbox.ts";
import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";

export interface BrainEffectsRuntime {
  readonly inbox: BrainInbox;
  readonly deliverPrompt: (effect: PromptSpeakerEffect) => Promise<DispatchReceipt>;
  readonly wake: () => Promise<unknown>;
}

const runtimeSlot = createFlueGlobal<BrainEffectsRuntime>(
  "brain-effects-runtime",
  "Brain Effects runtime is not configured",
);

export const configureBrainEffectsRuntime = (runtime: BrainEffectsRuntime): void => runtimeSlot.set(runtime);
export const getBrainEffectsRuntime = (): BrainEffectsRuntime => runtimeSlot.get();

const deliver = async (effect: PromptSpeakerEffect): Promise<PromptSpeakerEffect> => {
  if (effect.status === "accepted") return effect;
  const runtime = getBrainEffectsRuntime();
  return runtime.inbox.markPromptAccepted(effect.id, await runtime.deliverPrompt(effect));
};

export const deliverPromptEffect = async (effect: PromptSpeakerEffect): Promise<PromptSpeakerEffect> => deliver(effect);

export const recoverPendingPrompts = async (): Promise<void> => {
  const runtime = getBrainEffectsRuntime();
  for (const effect of runtime.inbox.pendingPrompts()) await deliver(effect);
};
