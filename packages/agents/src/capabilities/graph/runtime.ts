import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";
import type { GraphStore } from "@ambient-agent/engine/graph/store.ts";

const storeSlot = createFlueGlobal<GraphStore>("graph-store", "Graph store is not configured");

export const configureGraphStore = (store: GraphStore): void => storeSlot.set(store);
export const getGraphStore = (): GraphStore => storeSlot.get();
