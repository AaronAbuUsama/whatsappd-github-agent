import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";
import type { SpecialistInput } from "@ambient-agent/engine/inputs.ts";
import type { RunLedger } from "./ledger.ts";

/**
 * Delivering a Specialist result to its home chat's Speaker. Typed locally (not as
 * `DispatchSpeaker`) so this capability never imports the Speaker — `dispatchSpeaker`
 * accepts a `SpeakerInput`, of which `SpecialistInput` is a member, so it is assignable
 * at the composition root.
 */
export type DispatchSpecialist = (request: { readonly id: string; readonly input: SpecialistInput }) => Promise<unknown>;

export interface DelegationRuntime {
  readonly ledger: RunLedger;
  readonly dispatch: DispatchSpecialist;
}

const runtimeSlot = createFlueGlobal<DelegationRuntime>("delegation-runtime", "Delegation runtime is not configured");

export const configureDelegationRuntime = (runtime: DelegationRuntime): void => runtimeSlot.set(runtime);
export const getDelegationRuntime = (): DelegationRuntime => runtimeSlot.get();
