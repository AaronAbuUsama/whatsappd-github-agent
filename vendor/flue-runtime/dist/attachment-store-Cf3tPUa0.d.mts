import { $ as PromptUsage } from "./types-USSZhfC6.mjs";
import { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

//#region src/conversation-records.d.ts
interface ConversationRecordEnvelope {
  v: 1;
  id: string;
  type: string;
  conversationId: string;
  harness: string;
  session: string;
  timestamp: string;
  submissionId?: string;
  dispatchId?: string;
  operationId?: string;
  turnId?: string;
  attemptId?: string;
}
interface AttachmentRef {
  id: string;
  mimeType: string;
  size: number;
  digest: string;
  /**
   * Original filename, when the uploader provided one. Presentation metadata,
   * not part of byte identity — excluded from attachment-store equality and not
   * required by the attachment stores (it travels in the canonical record).
   */
  filename?: string;
}
type CanonicalUserContent = {
  type: 'text';
  text: string;
} | {
  type: 'attachment';
  attachment: AttachmentRef;
};
type CanonicalToolResultContent = Extract<ToolResultMessage['content'][number], {
  type: 'text';
}> | {
  type: 'attachment';
  attachment: AttachmentRef;
};
interface ConversationCreatedRecordBase extends ConversationRecordEnvelope {
  type: 'conversation_created';
  affinityKey: string;
  createdAt: string;
}
type ConversationCreatedRecord = ConversationCreatedRecordBase & ({
  kind: 'root';
  parentConversationId?: never;
  taskId?: never;
  actionInvocationId?: never;
  agent?: never;
} | {
  kind: 'task';
  parentConversationId: string;
  taskId: string;
  actionInvocationId?: never;
  /**
   * Subagent profile name this task ran, when a profile was selected.
   * Absent for agent-less tasks. Presentation metadata for the task
   * tree — never part of conversation identity.
   */
  agent?: string;
} | {
  kind: 'action';
  parentConversationId: string;
  actionInvocationId: string;
  taskId?: never;
  agent?: never;
});
interface UserMessageRecord extends ConversationRecordEnvelope {
  type: 'user_message';
  messageId: string;
  parentId: string | null;
  content: CanonicalUserContent[];
}
interface SignalRecord extends ConversationRecordEnvelope {
  type: 'signal';
  messageId: string;
  parentId: string | null;
  signalType: string;
  tagName?: string;
  content: string;
  attributes?: Record<string, string>;
}
type AssistantModelInfo = Omit<AssistantMessage, 'role' | 'content' | 'stopReason' | 'errorMessage' | 'timestamp' | 'usage'>;
interface AssistantMessageStartedRecord extends ConversationRecordEnvelope {
  type: 'assistant_message_started';
  messageId: string;
  parentId: string | null;
  modelInfo: AssistantModelInfo;
}
interface AssistantTextStartedRecord extends ConversationRecordEnvelope {
  type: 'assistant_text_started';
  messageId: string;
  blockId: string;
  blockIndex: number;
}
interface AssistantTextDeltaRecord extends ConversationRecordEnvelope {
  type: 'assistant_text_delta';
  messageId: string;
  blockId: string;
  sequence: number;
  delta: string;
}
interface AssistantTextCompletedRecord extends ConversationRecordEnvelope {
  type: 'assistant_text_completed';
  messageId: string;
  blockId: string;
  deltaCount: number;
  /** Provider signature for the completed text block, captured at completion so
   *  it round-trips back to the provider on the next turn. */
  textSignature?: string;
}
interface AssistantReasoningStartedRecord extends ConversationRecordEnvelope {
  type: 'assistant_reasoning_started';
  messageId: string;
  blockId: string;
  blockIndex: number;
}
interface AssistantReasoningDeltaRecord extends ConversationRecordEnvelope {
  type: 'assistant_reasoning_delta';
  messageId: string;
  blockId: string;
  sequence: number;
  delta: string;
}
interface AssistantReasoningCompletedRecord extends ConversationRecordEnvelope {
  type: 'assistant_reasoning_completed';
  messageId: string;
  blockId: string;
  deltaCount: number;
  encrypted?: string;
  redacted?: boolean;
}
interface AssistantToolCallRecord extends ConversationRecordEnvelope {
  type: 'assistant_tool_call';
  messageId: string;
  blockId: string;
  blockIndex: number;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  thoughtSignature?: string;
}
interface AssistantMessageCompletedRecord extends ConversationRecordEnvelope {
  type: 'assistant_message_completed';
  messageId: string;
  stopReason: AssistantMessage['stopReason'];
  usage: AssistantMessage['usage'];
  error?: string;
}
interface ToolOutcomeRecord extends ConversationRecordEnvelope {
  type: 'tool_outcome';
  assistantMessageId: string;
  toolCallId: string;
  toolName: string;
  isError: boolean;
  /**
   * Model-facing result content (text/attachment blocks) sent back to the LLM.
   */
  content: CanonicalToolResultContent[];
  /**
   * Validated structured application output, when the tool declared one. Kept
   * distinct from `content` so the UI can render the typed value instead of the
   * serialized model-facing text. Absent for tools without structured output.
   */
  output?: unknown;
}
interface ToolResultsCommittedRecord extends ConversationRecordEnvelope {
  type: 'tool_results_committed';
  assistantMessageId: string;
  parentId: string;
  outcomeIds: string[];
}
interface CompactionRecord extends ConversationRecordEnvelope {
  type: 'compaction';
  entryId: string;
  parentId: string | null;
  summary: string;
  firstKeptEntryId: string;
  sourceLeafId: string;
  tokensBefore: number;
  details?: {
    readFiles: string[];
    modifiedFiles: string[];
  };
  usage?: PromptUsage;
}
interface CanonicalChildSessionRefBase {
  conversationId: string;
  harness: string;
  session: string;
}
type CanonicalChildSessionRef = (CanonicalChildSessionRefBase & {
  type: 'task';
  taskId: string;
  invocationId?: never;
  /**
   * The parent `task` tool call that spawned this child, and the assistant
   * entry holding it. Present when the task was invoked by the model as a
   * tool call; absent for a programmatic `session.task()` (which has no
   * parent tool call). Durable join key used by recovery to resolve the
   * parent's tool call from the child — never inferred.
   */
  parentToolCallId?: string;
  parentAssistantEntryId?: string;
}) | (CanonicalChildSessionRefBase & {
  type: 'action';
  invocationId: string;
  taskId?: never;
  parentToolCallId?: never;
  parentAssistantEntryId?: never;
});
interface ChildSessionRetainedRecord extends ConversationRecordEnvelope {
  type: 'child_session_retained';
  child: CanonicalChildSessionRef;
}
interface SubmissionSettledRecord extends ConversationRecordEnvelope {
  type: 'submission_settled';
  outcome: 'completed' | 'failed' | 'aborted';
  result?: unknown;
  error?: unknown;
}
type ConversationRecord = ConversationCreatedRecord | UserMessageRecord | SignalRecord | AssistantMessageStartedRecord | AssistantTextStartedRecord | AssistantTextDeltaRecord | AssistantTextCompletedRecord | AssistantReasoningStartedRecord | AssistantReasoningDeltaRecord | AssistantReasoningCompletedRecord | AssistantToolCallRecord | AssistantMessageCompletedRecord | ToolOutcomeRecord | ToolResultsCommittedRecord | CompactionRecord | ChildSessionRetainedRecord | SubmissionSettledRecord;
//#endregion
//#region src/runtime/attachment-store.d.ts
interface PutAttachmentInput {
  streamPath: string;
  attachment: AttachmentRef;
  bytes: Uint8Array;
  conversationId: string;
}
interface GetAttachmentInput {
  streamPath: string;
  conversationId: string;
  attachmentId: string;
}
interface StoredAttachment {
  attachment: AttachmentRef;
  bytes: Uint8Array;
}
interface AttachmentStore {
  put(input: PutAttachmentInput): Promise<void>;
  get(input: GetAttachmentInput): Promise<StoredAttachment | null>;
  deleteForInstance(streamPath: string): Promise<void>;
}
declare class InMemoryAttachmentStore implements AttachmentStore {
  private records;
  put(input: PutAttachmentInput): Promise<void>;
  get(input: GetAttachmentInput): Promise<StoredAttachment | null>;
  deleteForInstance(streamPath: string): Promise<void>;
}
declare function createAttachmentRef(input: {
  id: string;
  mimeType: string;
  bytes: Uint8Array;
  filename?: string;
}): Promise<AttachmentRef>;
declare function verifyAttachmentBytes(attachment: AttachmentRef, bytes: Uint8Array): Promise<void>;
declare function copyAttachmentBytes(bytes: Uint8Array): Uint8Array;
declare function attachmentBytesEqual(left: Uint8Array, right: Uint8Array): boolean;
declare function sameAttachmentRef(left: AttachmentRef, right: AttachmentRef): boolean;
//#endregion
export { ConversationRecord as _, StoredAttachment as a, createAttachmentRef as c, AssistantMessageStartedRecord as d, AttachmentRef as f, ConversationCreatedRecord as g, CompactionRecord as h, PutAttachmentInput as i, sameAttachmentRef as l, CanonicalToolResultContent as m, GetAttachmentInput as n, attachmentBytesEqual as o, CanonicalChildSessionRef as p, InMemoryAttachmentStore as r, copyAttachmentBytes as s, AttachmentStore as t, verifyAttachmentBytes as u, SubmissionSettledRecord as v };