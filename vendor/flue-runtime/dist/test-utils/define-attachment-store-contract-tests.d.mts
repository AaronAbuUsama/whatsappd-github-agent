import { t as AttachmentStore } from "../attachment-store-Cf3tPUa0.mjs";

//#region src/test-utils/define-attachment-store-contract-tests.d.ts
interface AttachmentStoreContractBackend {
  create(): AttachmentStore | Promise<AttachmentStore>;
  cleanup?(): void | Promise<void>;
}
declare function defineAttachmentStoreContractTests(label: string, backend: AttachmentStoreContractBackend): void;
//#endregion
export { AttachmentStoreContractBackend, defineAttachmentStoreContractTests };