import type { ChatGptAuthentication } from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import type { AgentSandbox } from "./agent-sandbox.ts";
import type { ManagedPaths } from "./paths.ts";
import type { GitHubAppCredential, ManagedConfig } from "./schema.ts";

export interface ManagedRuntimeDependencies {
  readonly authentication: ChatGptAuthentication;
  readonly configuration: ManagedConfig;
  /** The Planner App credential — the runtime's issue-filing identity and webhook-secret owner (#135). */
  readonly githubCredential: GitHubAppCredential & { readonly webhookSecret: string };
  readonly paths: ManagedPaths;
  /**
   * The per-job agent sandbox both Specialist shells run in, and the workspace root it extracts
   * repos into (#251) — resolved together by {@link resolveAgentSandbox}. Always present: the
   * selector defaults to a `local` sandbox, so there is no "unconfigured, silently disabled"
   * state any more (#247).
   */
  readonly agentSandbox: AgentSandbox;
  /**
   * The key from `credentials/model-api-key.json`. Present exactly when
   * `configuration.model.provider` is not the subscription provider; the CLI reads it before
   * boot, so an absent credential fails the process rather than degrading to a runtime with
   * no inference.
   */
  readonly modelApiKey?: string;
  /**
   * The key from `credentials/braintrust.json`, present exactly when `runtime.tracing.enabled` is
   * true (#252). The CLI reads it before boot and threads it here so `configureBraintrustTracing`
   * runs inside the runtime bundle — where `@flue/runtime`'s isolate-scoped observer lives — while
   * the secret is never read from `process.env`.
   */
  readonly braintrustApiKey?: string;
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
