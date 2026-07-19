import { M as ConversationStreamStore, i as AgentExecutionStore } from "../agent-execution-store-BCmrE5Jm.mjs";

//#region src/test-utils/define-conversation-stream-store-contract-tests.d.ts
interface ConversationStreamStoreContractBackend {
  create(): {
    stream: ConversationStreamStore;
    executionStore?: AgentExecutionStore;
  } | Promise<{
    stream: ConversationStreamStore;
    executionStore?: AgentExecutionStore;
  }>;
  cleanup?(): void | Promise<void>;
}
declare function defineConversationStreamStoreContractTests(label: string, backend: ConversationStreamStoreContractBackend): void;
//#endregion
export { ConversationStreamStoreContractBackend, defineConversationStreamStoreContractTests };