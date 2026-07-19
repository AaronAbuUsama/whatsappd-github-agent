import { et as SandboxFactory, tt as SessionEnv } from "./types-USSZhfC6.mjs";
import { t as SqlStorage } from "./sql-storage-DNzKo_Mr.mjs";

//#region src/cloudflare/cf-sandbox.d.ts
/**
 * Minimal structural surface of a `@cloudflare/sandbox` Durable Object stub
 * (the value returned by `getSandbox()`). Kept structural so `@flue/runtime`
 * does not depend on `@cloudflare/sandbox` and stays importable on Node;
 * only the methods Flue calls are listed. A wrong object fails loudly on
 * the first method call.
 */
interface CloudflareSandboxStub {
  exec(command: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  }): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode?: number;
  }>;
  readFile(path: string, options?: {
    encoding?: string;
  }): Promise<{
    content: string;
  }>;
  writeFile(path: string, content: string, options?: {
    encoding?: string;
  }): Promise<unknown>;
  exists(path: string): Promise<{
    exists: boolean;
  }>;
  mkdir(path: string, options?: {
    recursive?: boolean;
  }): Promise<unknown>;
  deleteFile(path: string): Promise<unknown>;
}
interface CloudflareSandboxOptions {
  /** Working directory inside the container. Defaults to `/workspace`. */
  cwd?: string;
}
/**
 * Wrap a Cloudflare Sandbox Durable Object stub into a Flue
 * {@link SandboxFactory}:
 *
 * ```ts
 * import { getSandbox } from '@cloudflare/sandbox';
 * import { cloudflareSandbox } from '@flue/runtime/cloudflare';
 *
 * export default defineAgent(({ id, env }) => ({
 *   sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
 * }));
 * ```
 */
declare function cloudflareSandbox(sandbox: CloudflareSandboxStub, options?: CloudflareSandboxOptions): SandboxFactory;
declare function cfSandboxToSessionEnv(sandbox: CloudflareSandboxStub, cwd?: string): SessionEnv;
//#endregion
//#region src/cloudflare/context.d.ts
interface CloudflareContext {
  env: Record<string, unknown>;
  storage: {
    sql: SqlStorage;
  };
  durableObjectIdentity?: FlueDurableObjectIdentity;
}
interface FlueDurableObjectIdentity {
  /** Wrangler binding name, e.g. "FLUE_DRAFT_WORKFLOW". */
  bindingName: string;
  /** Durable Object class name, e.g. "FlueDraftWorkflow". */
  className: string;
  /** Instance name passed to idFromName/getAgentByName. */
  name: string;
  /** Durable Object id rendered by DurableObjectState.id.toString(). */
  id: string;
}
declare function runWithCloudflareContext<T>(ctx: CloudflareContext, fn: () => T): T;
declare function getCloudflareContext(): CloudflareContext;
declare function getDurableObjectIdentity(): FlueDurableObjectIdentity;
//#endregion
//#region src/cloudflare/extension.d.ts
/**
 * Minimal structural view of the Cloudflare Agents SDK `Agent` base class
 * that Flue passes to `extend()` callbacks. `@flue/runtime` does not depend
 * on the `agents` package, so this models the documented extension surface
 * (state, lifecycle, scheduling, queueing) instead of importing the real
 * class. Pass an explicit `TBase` to `extend()` to type against a richer
 * class shape.
 */
interface CloudflareAgentLike<State = Record<string, unknown>> {
  state: State;
  setState(state: State): void;
  onStart(props?: Record<string, unknown>): Promise<void> | void;
  schedule<T = string>(when: Date | string | number, callback: keyof this, payload?: T, options?: {
    retry?: unknown;
    idempotent?: boolean;
  }): Promise<unknown>;
  scheduleEvery<T = string>(intervalSeconds: number, callback: keyof this, payload?: T, options?: {
    retry?: unknown;
  }): Promise<unknown>;
  queue<T = unknown>(callback: keyof this, payload: T, options?: {
    retry?: unknown;
  }): Promise<string>;
}
type ExtensionClass<TInstance extends object = CloudflareAgentLike> = new (...args: any[]) => TInstance;
interface CloudflareExtension<TBase extends object = CloudflareAgentLike> {
  base?: (Base: ExtensionClass<TBase>) => ExtensionClass<TBase>;
  wrap?: (Final: ExtensionClass<TBase>) => ExtensionClass<TBase>;
}
/** Runtime-resolved extension; classes are opaque to the generated entry. */
interface ResolvedCloudflareExtension {
  base(Base: ExtensionClass<any>): ExtensionClass<any>;
  wrap(Final: ExtensionClass<any>): ExtensionClass<any>;
}
declare function extend<TBase extends object = CloudflareAgentLike>(extension: CloudflareExtension<TBase>): CloudflareExtension<TBase>;
declare function resolveCloudflareExtension(mod: Record<string, unknown>, name: string, kind: 'Agent' | 'Workflow'): ResolvedCloudflareExtension;
//#endregion
export { extend as a, FlueDurableObjectIdentity as c, runWithCloudflareContext as d, CloudflareSandboxOptions as f, cloudflareSandbox as h, ResolvedCloudflareExtension as i, getCloudflareContext as l, cfSandboxToSessionEnv as m, CloudflareExtension as n, resolveCloudflareExtension as o, CloudflareSandboxStub as p, ExtensionClass as r, CloudflareContext as s, CloudflareAgentLike as t, getDurableObjectIdentity as u };