import type { ChatGptOAuthAdapter } from "../model/chatgpt-authentication.js";
import {
  createChatGptAuthentication,
  createManagedChatGptCredentialStore,
} from "../model/chatgpt-authentication.js";
import { migrateManagedChatGptCredentialReference } from "./configuration.js";
import type { ManagedPaths } from "./paths.js";

export const createManagedChatGptAuthentication = (paths: ManagedPaths, oauth?: ChatGptOAuthAdapter) =>
  createChatGptAuthentication({
    store: createManagedChatGptCredentialStore({
      path: paths.chatGptOAuthCredential,
      managedRoot: paths.root,
      legacyPath: paths.legacyPiAuthCredential,
      onLegacyMigration: async () => await migrateManagedChatGptCredentialReference(paths.config),
    }),
    oauth,
  });
