import type { ChatGptOAuthAdapter } from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import {
  createChatGptAuthentication,
  createManagedChatGptCredentialStore,
} from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import { migrateManagedChatGptCredentialReference } from "./configuration.ts";
import type { ManagedPaths } from "./paths.ts";
import {
  createLibsqlChatGptCredentialStore,
  tenantCredentialDatabaseFromEnvironment,
  type TenantCredentialEnvironment,
} from "./tenant-credentials.ts";

export const createManagedChatGptAuthentication = (
  paths: ManagedPaths,
  oauth?: ChatGptOAuthAdapter,
  environment: TenantCredentialEnvironment = process.env,
) => {
  const tenantDatabase = tenantCredentialDatabaseFromEnvironment(environment);
  return createChatGptAuthentication({
    store:
      tenantDatabase === undefined
        ? createManagedChatGptCredentialStore({
            path: paths.chatGptOAuthCredential,
            managedRoot: paths.root,
            legacyPath: paths.legacyPiAuthCredential,
            onLegacyMigration: async () => await migrateManagedChatGptCredentialReference(paths.config),
          })
        : createLibsqlChatGptCredentialStore(tenantDatabase),
    oauth,
  });
};
