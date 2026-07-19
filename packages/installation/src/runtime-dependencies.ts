import type { ChatGptAuthentication } from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import { managedPaths, type ManagedPaths } from "./paths.ts";
import type { GitHubAppCredential, ManagedConfig } from "./schema.ts";
import { tenantCredentialDatabaseFromEnvironment, type TenantCredentialEnvironment } from "./tenant-credentials.ts";

export interface ManagedRuntimeDependencies {
  readonly authentication: ChatGptAuthentication;
  readonly configuration: ManagedConfig;
  /** The Planner App credential — the runtime's issue-filing identity and webhook-secret owner (#135). */
  readonly githubCredential: GitHubAppCredential & { readonly webhookSecret: string };
  readonly paths: ManagedPaths;
  readonly deployment?: RuntimeDeploymentIdentity;
}

export interface TenantRuntimeEnvironment extends TenantCredentialEnvironment {
  readonly AMBIENT_AGENT_RUNTIME_PROFILE?: string;
  readonly AMBIENT_AGENT_CONFIG_VERSION?: string;
  readonly AMBIENT_AGENT_RUNTIME_ID?: string;
  readonly AMBIENT_AGENT_RUNTIME_BRIDGE_SECRET?: string;
  readonly PORT?: string;
}

export interface RuntimeDeploymentIdentity {
  readonly configVersion: number;
  readonly mode: "setup" | "operate";
}

export interface TenantRuntimeSetupBoot {
  readonly mode: "setup";
  readonly runtimeId: string;
  readonly bridgeSecret: string;
  readonly port: number;
  readonly paths: ManagedPaths;
  readonly credentialEnvironment: Required<TenantCredentialEnvironment>;
  readonly deployment: RuntimeDeploymentIdentity & { readonly mode: "setup" };
}

const RUNTIME_DEPENDENCIES = Symbol.for("ambient-agent.managed-runtime-dependencies");
const WHATSAPP_RUNTIME_START = Symbol.for("ambient-agent.deferred-whatsapp-runtime-start");

type RuntimeGlobal = typeof globalThis & {
  [RUNTIME_DEPENDENCIES]?: ManagedRuntimeDependencies;
  [WHATSAPP_RUNTIME_START]?: () => void;
};

const runtimeGlobal = globalThis as RuntimeGlobal;

export const installManagedRuntimeDependencies = (next: ManagedRuntimeDependencies): void => {
  runtimeGlobal[RUNTIME_DEPENDENCIES] = next;
};

export const getManagedRuntimeDependencies = (): ManagedRuntimeDependencies => {
  const dependencies = runtimeGlobal[RUNTIME_DEPENDENCIES];
  if (dependencies === undefined) {
    throw new Error("Managed runtime dependencies were not configured by the Ambient Agent CLI.");
  }
  return dependencies;
};

const requiredSetupValue = (name: string, value: string | undefined): string => {
  const configured = value?.trim();
  if (!configured) throw new Error(`${name} is required for the tenant runtime setup profile.`);
  return configured;
};

const setupRuntimePort = (value: string | undefined): number => {
  const port = value === undefined ? 3000 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The tenant setup runtime port must be an integer from 1 through 65535.");
  }
  return port;
};

export const runtimeDeploymentIdentityFromEnvironment = (
  environment: TenantRuntimeEnvironment = process.env,
): RuntimeDeploymentIdentity | undefined => {
  const mode = environment.AMBIENT_AGENT_RUNTIME_PROFILE?.trim();
  const versionValue = environment.AMBIENT_AGENT_CONFIG_VERSION?.trim();
  if (!mode && !versionValue) return undefined;
  if (mode !== "setup" && mode !== "operate") {
    throw new Error("AMBIENT_AGENT_RUNTIME_PROFILE must be setup or operate.");
  }
  const configVersion = Number(versionValue);
  if (!Number.isSafeInteger(configVersion) || configVersion < 1) {
    throw new Error("AMBIENT_AGENT_CONFIG_VERSION must be a positive integer.");
  }
  return { configVersion, mode };
};

/** Composition-root boundary for the standalone, setup-only tenant server. */
export const resolveTenantRuntimeSetupBoot = (
  environment: TenantRuntimeEnvironment = process.env,
  paths: ManagedPaths = managedPaths(),
): TenantRuntimeSetupBoot => {
  const deployment = runtimeDeploymentIdentityFromEnvironment(environment);
  if (deployment?.mode !== "setup") {
    throw new Error("The tenant setup server requires AMBIENT_AGENT_RUNTIME_PROFILE=setup.");
  }
  const tenantDatabase = tenantCredentialDatabaseFromEnvironment(environment);
  if (tenantDatabase === undefined) {
    throw new Error("TENANT_DB_URL and TENANT_DB_TOKEN are required for the tenant runtime setup profile.");
  }
  return {
    mode: "setup",
    runtimeId: requiredSetupValue("AMBIENT_AGENT_RUNTIME_ID", environment.AMBIENT_AGENT_RUNTIME_ID),
    bridgeSecret: requiredSetupValue(
      "AMBIENT_AGENT_RUNTIME_BRIDGE_SECRET",
      environment.AMBIENT_AGENT_RUNTIME_BRIDGE_SECRET,
    ),
    port: setupRuntimePort(environment.PORT),
    paths,
    credentialEnvironment: {
      TENANT_DB_URL: tenantDatabase.url,
      TENANT_DB_TOKEN: requiredSetupValue("TENANT_DB_TOKEN", tenantDatabase.authToken),
    },
    deployment: { configVersion: deployment.configVersion, mode: "setup" },
  };
};

// The generated server and the CLI are separate bundles, so this handoff crosses
// module-instance boundaries the same way the dependencies above do: the app module
// registers how to start WhatsApp, and the CLI invokes it only after the HTTP
// listener has bound its configured port (#87).
export const deferWhatsAppRuntimeStart = (start: () => void): void => {
  runtimeGlobal[WHATSAPP_RUNTIME_START] = start;
};

export const startDeferredWhatsAppRuntime = (): void => {
  const start = runtimeGlobal[WHATSAPP_RUNTIME_START];
  if (start === undefined) {
    throw new Error("The generated server did not register a deferred WhatsApp runtime start.");
  }
  runtimeGlobal[WHATSAPP_RUNTIME_START] = undefined;
  start();
};
