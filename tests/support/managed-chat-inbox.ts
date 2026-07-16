import type { ConversationArchive } from "../../src/intake/conversation-archive.ts";
import {
  createManagedChatInbox,
  type CreateManagedChatInboxOptions,
  type ManagedChatInbox,
  type WindowAdmission,
} from "../../src/intake/managed-chat-inbox.ts";

export type TestManagedChatInbox = ManagedChatInbox & {
  admission(windowId: string): WindowAdmission | undefined;
};

export const createTestManagedChatInbox = (
  archive: ConversationArchive,
  options: CreateManagedChatInboxOptions,
): TestManagedChatInbox => {
  const inbox = createManagedChatInbox(archive, options);
  return Object.assign(inbox, {
    admission: (windowId: string) => inbox.admissions().find((admission) => admission.windowId === windowId),
  });
};
