import { t as SqlStorage } from "../sql-storage-DNzKo_Mr.mjs";
import { u as RunStore } from "../run-store-tKpCS1yQ.mjs";
import { n as CloudflareAIBindingApi } from "../cloudflare-model-vD6fKgyg.mjs";
import { d as runWithCloudflareContext, i as ResolvedCloudflareExtension, m as cfSandboxToSessionEnv, o as resolveCloudflareExtension } from "../extension-DJLrZrOa.mjs";
import { ApiProvider, StreamOptions } from "@earendil-works/pi-ai/compat";
import { DurableObject } from "cloudflare:workers";

//#region src/cloudflare/registry-do.d.ts
interface DurableObjectStateLike {
  storage: {
    sql: SqlStorage;
  };
}
declare class FlueRegistry extends DurableObject {
  private ops;
  constructor(state: DurableObjectStateLike, env: unknown);
  fetch(request: Request): Promise<Response>;
}
//#endregion
//#region src/cloudflare/run-store.d.ts
interface FlueRegistryNamespace {
  idFromName(name: string): object;
  get(id: object): {
    fetch(input: Request): Promise<Response>;
  };
}
/** Cross-deployment run lookup/listing surface of the index DO. */
type CloudflareRunIndex = Pick<RunStore, 'lookupRun' | 'listRuns'>;
/**
 * Request-scoped client for the `FlueRegistry` index DO, used by the outer
 * worker for `/runs/:runId` lookups and `listRuns()`.
 */
declare function createCloudflareRunIndex(namespace: FlueRegistryNamespace | undefined): CloudflareRunIndex | undefined;
/**
 * Compose the per-workflow-DO record store with the `FlueRegistry` index DO.
 * Without a registry binding the record store is used as-is (no
 * cross-deployment index).
 */
declare function createCloudflareRunStore(records: RunStore, namespace: FlueRegistryNamespace | undefined): RunStore;
//#endregion
//#region src/cloudflare/workers-ai-provider.d.ts
/**
 * Return the pi-ai `ApiProvider` definition for the Cloudflare AI binding.
 */
declare function getCloudflareAIBindingApiProvider(): ApiProvider<CloudflareAIBindingApi, StreamOptions>;
//#endregion
export { type CloudflareRunIndex, FlueRegistry, type ResolvedCloudflareExtension, cfSandboxToSessionEnv, createCloudflareRunIndex, createCloudflareRunStore, getCloudflareAIBindingApiProvider, resolveCloudflareExtension, runWithCloudflareContext };