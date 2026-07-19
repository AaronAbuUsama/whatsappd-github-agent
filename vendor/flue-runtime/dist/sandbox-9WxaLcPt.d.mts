import { D as FlueObservation, at as ShellResult, et as SandboxFactory, tt as SessionEnv, u as BashFactory, v as FileStat, x as FlueEventContext } from "./types-USSZhfC6.mjs";
import { h as FlueExecutionInterceptor } from "./run-store-tKpCS1yQ.mjs";

//#region src/observation.d.ts
type FlueObservationSubscriber = (observation: FlueObservation, ctx: FlueEventContext) => void | Promise<void>;
//#endregion
//#region src/instrumentation.d.ts
interface FlueInstrumentation {
  key?: symbol;
  observe: FlueObservationSubscriber;
  interceptor: FlueExecutionInterceptor;
  dispose(): void | Promise<void>;
}
interface InstrumentationOwner {
  dispose(): Promise<void>;
}
declare function createInstrumentationOwner(): InstrumentationOwner;
declare function runWithInstrumentationOwner<T>(owner: InstrumentationOwner, fn: () => T): T;
declare function instrument(instrumentation: FlueInstrumentation): () => Promise<void>;
//#endregion
//#region src/sandbox.d.ts
/**
 * Wrap a just-bash factory into a {@link SandboxFactory}:
 * `defineAgent(() => ({ sandbox: bash(() => new Bash({ fs })) }))`.
 */
declare function bash(factory: BashFactory): SandboxFactory;
declare function bashFactoryToSessionEnv(factory: BashFactory): Promise<SessionEnv>;
/**
 * Interface that remote sandbox providers must implement.
 *
 * `exec()` cancellation is expressed two ways. Sandbox adapters should honor at
 * least one — preferably `timeoutMs`, since most provider SDKs expose a
 * native timeout option but few support mid-flight cancellation:
 *
 *   - `timeoutMs?: number` (milliseconds): the **primary** cancellation
 *     contract. Forward to the provider's native timeout option (E2B
 *     `timeoutMs`, Daytona `timeout`, Modal `timeout`, etc.). Providers
 *     with coarser granularity may round the value up, never down.
 *     Required for parity with the LLM bash tool, which always passes a
 *     deadline hint when the model requests one.
 *   - `signal?: AbortSignal` (optional): for sandbox adapters whose SDK supports
 *     mid-flight cancellation (Mirage's executor, in-process bash). Lets
 *     Programmatic callers do ad-hoc `abort()`. Sandbox adapters that can't honor it
 *     should ignore it; the deadline is still enforced via `timeoutMs`.
 *
 * Sandbox adapters that support both should observe whichever fires first.
 */
interface SandboxApi {
  readFile(path: string): Promise<string>;
  readFileBuffer(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: {
    recursive?: boolean;
  }): Promise<void>;
  rm(path: string, options?: {
    recursive?: boolean;
    force?: boolean;
  }): Promise<void>;
  exec(command: string, options?: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<ShellResult>;
}
/** Wrap a SandboxApi into SessionEnv. No just-bash, no intermediate filesystem layer. */
declare function createSandboxSessionEnv(api: SandboxApi, cwd: string): SessionEnv;
//#endregion
export { FlueInstrumentation as a, instrument as c, createSandboxSessionEnv as i, runWithInstrumentationOwner as l, bash as n, InstrumentationOwner as o, bashFactoryToSessionEnv as r, createInstrumentationOwner as s, SandboxApi as t, FlueObservationSubscriber as u };