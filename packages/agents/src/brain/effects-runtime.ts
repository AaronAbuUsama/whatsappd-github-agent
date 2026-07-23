import type { DispatchReceipt } from "@flue/runtime";

import type {
  BrainInbox,
  FileIssueEffect,
  FileIssueOutcome,
  FileIssueRequest,
  PromptSpeakerEffect,
} from "@ambient-agent/engine/brain/inbox.ts";
import { getLogger } from "@ambient-agent/engine/logging/logging.ts";
import { errorMessage } from "@ambient-agent/engine/shared/errors.ts";
import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";

export interface BrainEffectsRuntime {
  readonly inbox: BrainInbox;
  readonly deliverPrompt: (effect: PromptSpeakerEffect) => Promise<DispatchReceipt>;
  readonly wake: () => Promise<unknown>;
  /** File one GitHub issue durably. Absent when this runtime carries no GitHub write binding.
   * `effectId` scopes the filing's Operation Identity so a recovered attempt reconciles, not re-creates. */
  readonly fileIssue?: (request: FileIssueRequest, effectId: string) => Promise<FileIssueOutcome>;
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
  // Recovery reconciles by Operation Identity (createIssueFiler), so a re-run after a crash finds the
  // already-created issue instead of filing a second one — file_issue is synchronous, never blind-redispatched.
  return runtime.inbox.completeIssueFiling(effect.id, await runtime.fileIssue(effect.request, effect.id));
};

export const deliverIssueFilingEffect = async (effect: FileIssueEffect): Promise<FileIssueEffect> =>
  deliverFiling(effect);

export const recoverPendingIssueFilings = async (): Promise<void> => {
  const runtime = getBrainEffectsRuntime();
  for (const effect of runtime.inbox.pendingIssueFilings()) {
    // Per-effect containment: a filing puts a fallible remote GitHub call in the boot chain. A rejection
    // here is a defect that kills the WhatsApp runtime fiber before the Coalescer starts, leaving the agent
    // silently deaf (systemd never restarts a live-but-failed process). A person waits on their Speaker, not
    // the Brain (§9/§10), so a filing we cannot complete now is logged and left pending to retry next boot;
    // it never propagates. Terminal failures already settle as `uncertain` inside createIssueFiler.
    try {
      await deliverFiling(effect);
    } catch (cause) {
      getLogger("brain").warn(
        { effectId: effect.id, repository: effect.request.repository, error: errorMessage(cause) },
        "Pending issue filing could not be recovered at boot; left pending to retry",
      );
    }
  }
};
