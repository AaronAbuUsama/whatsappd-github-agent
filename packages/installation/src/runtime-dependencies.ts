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
}

export interface TenantRuntimeEnvironment extends TenantCredentialEnvironment {
  readonly AMBIENT_AGENT_RUNTIME_PROFILE?: string;
  readonly AMBIENT_AGENT_RUNTIME_ID?: string;
  readonly AMBIENT_AGENT_RUNTIME_BRIDGE_SECRET?: string;
}

export interface TenantRuntimeSetupBoot {
  readonly mode: "setup";
  readonly runtimeId: string;
  readonly bridgeSecret: string;
  readonly paths: ManagedPaths;
  readonly credentialEnvironment: Required<TenantCredentialEnvironment>;
}

export type TenantRuntimeOperateBoot = ManagedRuntimeDependencies & { readonly mode: "operate" };
export type TenantRuntimeBoot = TenantRuntimeSetupBoot | TenantRuntimeOperateBoot;

export interface TenantRuntimeProfileState {
  readonly applicationId: string;
  readonly mode: TenantRuntimeBoot["mode"];
  readonly managedChats: readonly string[];
}

export type TenantRuntimeProfileEvent =
  | "activation.succeeded"
  | "activation.failed"
  | "repair.started"
  | "repair.completed";

const profileAfter = {
  "activation.succeeded": "operate",
  "activation.failed": "setup",
  "repair.started": "setup",
  "repair.completed": "operate",
} as const satisfies Record<TenantRuntimeProfileEvent, TenantRuntimeBoot["mode"]>;

export const transitionTenantRuntimeProfile = (
  current: TenantRuntimeProfileState,
  event: TenantRuntimeProfileEvent,
): TenantRuntimeProfileState => ({ ...current, mode: profileAfter[event] });

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

export const resolveTenantRuntimeBoot = (
  environment: TenantRuntimeEnvironment = process.env,
  paths: ManagedPaths = managedPaths(),
): TenantRuntimeBoot => {
  const profile = environment.AMBIENT_AGENT_RUNTIME_PROFILE?.trim();
  if (profile === "setup") {
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
      paths,
      credentialEnvironment: {
        TENANT_DB_URL: tenantDatabase.url,
        TENANT_DB_TOKEN: requiredSetupValue("TENANT_DB_TOKEN", tenantDatabase.authToken),
      },
    };
  }
  if (profile !== undefined && profile !== "operate") {
    throw new Error(`Unsupported AMBIENT_AGENT_RUNTIME_PROFILE: ${profile}`);
  }
  return { mode: "operate", ...getManagedRuntimeDependencies() };
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
