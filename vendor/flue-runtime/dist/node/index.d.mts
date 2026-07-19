import { et as SandboxFactory } from "../types-USSZhfC6.mjs";
import { u as PersistenceAdapter } from "../agent-execution-store-BCmrE5Jm.mjs";

//#region src/node/agent-execution-store.d.ts
/**
 * Built-in SQLite persistence adapter for Node.js.
 *
 * @param path - SQLite database file path. Omit or pass `':memory:'` for an
 *   in-memory database (data lost on process exit). Pass a file path for
 *   persistent storage across restarts.
 *
 * @example
 * ```ts
 * // src/db.ts
 * import { sqlite } from '@flue/runtime/node';
 * export default sqlite('./data/flue.db');
 * ```
 */
declare function sqlite(path?: string): PersistenceAdapter;
//#endregion
//#region src/node/local-env.d.ts
interface LocalSessionEnvOptions {
  /** Working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /**
   * Env vars layered on top of `DEFAULT_LOCAL_ENV_ALLOWLIST`. Set a key
   * to `undefined` to drop a default. Per-call `opts.env` on `exec()`
   * layers on top of this.
   *
   * Pass-through is intentionally explicit:
   *
   * ```ts
   * // Expose one host var.
   * local({ env: { GH_TOKEN: process.env.GH_TOKEN } });
   *
   * // Inherit everything (exposes host secrets to the model's bash tool).
   * local({ env: { ...process.env } });
   * ```
   */
  env?: Record<string, string | undefined>;
}
//#endregion
//#region src/node/local.d.ts
type LocalSandboxOptions = LocalSessionEnvOptions;
declare function local(options?: LocalSandboxOptions): SandboxFactory;
//#endregion
export { type LocalSandboxOptions, local, sqlite };