import { getManagedRuntimeDependencies } from "./runtime-dependencies.ts";

/**
 * Resolve the one home chat a Specialist result returns to (#144 Decision 2).
 *
 * A job result needs a single destination, so — unlike inbound GitHub events, which broadcast
 * to every managed thread (#144 Decision 1) — the repo→chat mapping survives only here, straight
 * from managed config: `github.defaultRepository → managedChats[0]`. Returns `undefined` when the
 * repo is not the managed default, so the caller can decide how to handle an unhomed result.
 *
 * This is the resolver the delegation-transport webhook-launch path (#157) calls.
 */
export const resolveSpecialistReturnChat = (repo: string): string | undefined => {
  const { configuration } = getManagedRuntimeDependencies();
  if (repo.toLowerCase() !== configuration.github.defaultRepository.toLowerCase()) return undefined;
  return configuration.managedChats[0];
};
