import { installPreparedManagedData, type InstallManagedDataResult } from "../../src/managed/installation.ts";
import type { ManagedPathEnvironment, ManagedPaths } from "../../src/managed/paths.ts";

export interface InstallManagedDataInput extends ManagedPathEnvironment {
  readonly managedChats: readonly string[];
  readonly defaultRepository: string;
  readonly githubToken: string;
  readonly authenticateChatGpt: (paths: ManagedPaths) => Promise<void>;
}

export const installManagedData = async (input: InstallManagedDataInput): Promise<InstallManagedDataResult> =>
  await installPreparedManagedData({
    ...input,
    prepare: async (paths) => {
      await input.authenticateChatGpt(paths);
      return {
        managedChats: input.managedChats,
        defaultRepository: input.defaultRepository,
        githubToken: input.githubToken,
      };
    },
  });
