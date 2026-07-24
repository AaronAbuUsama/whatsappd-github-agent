import type { DispatchReceipt } from "@flue/runtime";

import type {
  BrainInbox,
  FileIssueEffect,
  FileIssueOutcome,
  FileIssueRequest,
  IssueMutation,
  IssueMutationEffect,
  IssueMutationOutcome,
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
  /** Run one Brain-chosen GitHub issue mutation durably (comment create/update/delete, issue update,
   * state change). Absent when this runtime carries no GitHub write binding. `effectId` scopes the
   * mutation's Operation Identity so a recovered attempt reconciles, never re-mutates. */
  readonly mutateIssue?: (mutation: IssueMutation, effectId: string) => Promise<IssueMutationOutcome>;
  /**
   * Resolve a Brain-chosen target entity — a `thread` (group) or a `person` (DM) — to its Surface id,
   * so `prompt_speaker` targets EITHER a stable Surface OR a known Person through one operation (§8).
   * Trusted code maps the entity to its provider chat and the ordinary Surface registry: a thread resolves
   * only to an already-active operator-authorized Surface (discovery never grants participation), while a
   * known person's DM Surface is opened on demand. Returns undefined for an unknown/unaddressable entity
   * (fail-closed — the Brain then stays silent).
   *
   * `release` undoes a DM Surface this call newly opened, keeping materialization atomic with admission:
   * the tool calls it iff the subsequent recordPrompt rejects, so no active binding is left behind a
   * never-accepted prompt. It is a no-op for a stable Surface or an already-live DM.
   */
  readonly resolveSurfaceForEntity?: (
    entityId: string,
  ) => { readonly surfaceId: string; readonly release: () => void } | undefined;
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

const deliverMutation = async (effect: IssueMutationEffect): Promise<IssueMutationEffect> => {
  if (effect.status === "completed") return effect;
  const runtime = getBrainEffectsRuntime();
  if (runtime.mutateIssue === undefined) throw new Error("This Brain runtime has no GitHub issue-mutation binding.");
  // Recovery reconciles by Operation Identity (createIssueMutator), so a re-run after a crash observes the
  // already-applied mutation instead of re-mutating — issue mutations are synchronous, never blind-redispatched.
  return runtime.inbox.completeIssueMutation(effect.id, await runtime.mutateIssue(effect.mutation, effect.id));
};

export const deliverIssueMutationEffect = async (effect: IssueMutationEffect): Promise<IssueMutationEffect> =>
  deliverMutation(effect);

export const recoverPendingIssueMutations = async (): Promise<void> => {
  const runtime = getBrainEffectsRuntime();
  for (const effect of runtime.inbox.pendingIssueMutations()) {
    // Same per-effect boot containment as pending filings: a mutation we cannot complete now is logged and
    // left pending to retry next boot; it never propagates and kills the runtime fiber (§9/§10).
    try {
      await deliverMutation(effect);
    } catch (cause) {
      getLogger("brain").warn(
        { effectId: effect.id, mutation: effect.mutation.kind, error: errorMessage(cause) },
        "Pending issue mutation could not be recovered at boot; left pending to retry",
      );
    }
  }
};
