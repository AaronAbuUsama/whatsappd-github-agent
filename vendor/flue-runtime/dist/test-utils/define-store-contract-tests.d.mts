import { i as AgentExecutionStore } from "../agent-execution-store-BCmrE5Jm.mjs";
import { u as RunStore } from "../run-store-tKpCS1yQ.mjs";
import { defineAttachmentStoreContractTests } from "./define-attachment-store-contract-tests.mjs";
import { defineConversationStreamStoreContractTests } from "./define-conversation-stream-store-contract-tests.mjs";
import { defineEventStreamStoreContractTests } from "./define-event-stream-store-contract-tests.mjs";

//#region src/test-utils/define-run-store-contract-tests.d.ts
interface RunStoreContractBackend {
  create(): RunStore | Promise<RunStore>;
  cleanup?(): void | Promise<void>;
}
declare function defineRunStoreContractTests(label: string, backend: RunStoreContractBackend): void;
//#endregion
//#region src/test-utils/define-store-contract-tests.d.ts
interface StoreContractTestBackend {
  /** Create a fresh store instance for a single test. */
  create(): AgentExecutionStore | Promise<AgentExecutionStore>;
  /** Optional cleanup after each test (e.g. close connections, delete temp files). */
  cleanup?(): void | Promise<void>;
}
/**
 * Register the standard AgentExecutionStore contract tests under the given
 * describe label. Each test gets a fresh store from `backend.create()`.
 */
declare function defineStoreContractTests(label: string, backend: StoreContractTestBackend): void;
//#endregion
export { StoreContractTestBackend, defineAttachmentStoreContractTests, defineConversationStreamStoreContractTests, defineEventStreamStoreContractTests, defineRunStoreContractTests, defineStoreContractTests };