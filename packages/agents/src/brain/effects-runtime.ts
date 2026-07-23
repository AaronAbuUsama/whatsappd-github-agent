import type { DispatchReceipt } from "@flue/runtime";

import type {
  BrainInbox,
  FileIssueEffect,
  FileIssueOutcome,
  FileIssueRequest,
  PromptSpeakerEffect,
} from "@ambient-agent/engine/brain/inbox.ts";
import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";

export interface BrainEffectsRuntime {
  readonly inbox: BrainInbox;
  readonly deliverPrompt: (effect: PromptSpeakerEffect) => Promise<DispatchReceipt>;
  readonly wake: () => Promise<unknown>;
  /** File one GitHub issue durably. Absent when this runtime carries no GitHub write binding. */
  readonly fileIssue?: (request: FileIssueRequest) => Promise<FileIssueOutcome>;
  /** Resolve the repository a Surface's issues are filed into. Absent without a GitHub binding. */
  readonly repositoryForSurface?: (surfaceId: string) => string;
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

const deliverFiling = async (effect: FileIssueEffect): Promise<FileIssueEffect> => {
  if (effect.status === "completed") return effect;
  const runtime = getBrainEffectsRuntime();
  if (runtime.fileIssue === undefined) throw new Error("This Brain runtime has no GitHub issue-filing binding.");
  // Recovery routes through createIssue's duplicate guard, so a re-run after a crash finds the
  // already-created issue instead of filing a second one — file_issue is synchronous, never blind-redispatched.
  return runtime.inbox.completeIssueFiling(effect.id, await runtime.fileIssue(effect.request));
};

export const deliverIssueFilingEffect = async (effect: FileIssueEffect): Promise<FileIssueEffect> =>
  deliverFiling(effect);

export const recoverPendingIssueFilings = async (): Promise<void> => {
  const runtime = getBrainEffectsRuntime();
  for (const effect of runtime.inbox.pendingIssueFilings()) await deliverFiling(effect);
};
