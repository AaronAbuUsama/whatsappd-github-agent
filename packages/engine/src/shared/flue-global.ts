/**
 * A well-known global slot shared across bundles. Flue-routed handlers and tool
 * factories cannot receive dependency injection, and the CLI and the generated
 * server are separate bundles — Symbol.for on globalThis is the one channel that
 * crosses both. Every configure/get pair in the codebase goes through here so
 * the mechanism (and its failure mode) lives in exactly one place.
 */
export const createFlueGlobal = <T>(name: string, missing: string): { set(value: T): void; get(): T; peek(): T | undefined } => {
  const key = Symbol.for(`ambient-agent.${name}`);
  const slot = globalThis as Record<symbol, T | undefined>;
  return {
    set(value: T): void {
      slot[key] = value;
    },
    get(): T {
      const value = slot[key];
      if (value === undefined) throw new Error(missing);
      return value;
    },
    peek(): T | undefined {
      return slot[key];
    },
  };
};
