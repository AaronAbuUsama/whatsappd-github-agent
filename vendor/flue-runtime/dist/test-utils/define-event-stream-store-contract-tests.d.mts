import { i as EventStreamStore } from "../event-stream-store-CSiWecIp.mjs";

//#region src/test-utils/define-event-stream-store-contract-tests.d.ts
interface EventStreamStoreContractBackend {
  create(): EventStreamStore | Promise<EventStreamStore>;
  cleanup?(): void | Promise<void>;
}
declare function defineEventStreamStoreContractTests(label: string, backend: EventStreamStoreContractBackend): void;
//#endregion
export { EventStreamStoreContractBackend, defineEventStreamStoreContractTests };