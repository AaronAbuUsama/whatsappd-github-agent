import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";
import type { GraphStore } from "@ambient-agent/engine/graph/store.ts";

const storeSlot = createFlueGlobal<GraphStore>("graph-store", "Graph store is not configured");

export const configureGraphStore = (store: GraphStore): void => storeSlot.set(store);
export const getGraphStore = (): GraphStore => storeSlot.get();

/** The funnel runs for every dispatch; digest injection is a no-op when no graph is wired (tests, boot). */
export const tryGetGraphStore = (): GraphStore | undefined => {
  try {
    return storeSlot.get();
  } catch {
    return undefined;
  }
};
