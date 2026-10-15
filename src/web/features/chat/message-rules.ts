import type { MessageResponse } from "../../../shared/contracts";
import type { ChatItem } from "../../state/types";

export const toChatItem = (message: MessageResponse): ChatItem => ({
  id: message.id,
  role: message.role,
  content: message.content,
  status: message.status,
  errorCode: message.error_code,
  createdAt: message.created_at,
  completedAt: message.completed_at,
});

export function createOptimisticMessages(text: string, requestId: string, now: string): ChatItem[] {
  return [
    {
      id: `optimistic-user-${requestId}`,
      role: "user",
      content: text,
      status: "completed",
      errorCode: null,
      createdAt: now,
      completedAt: now,
    },
    {
      id: `optimistic-assistant-${requestId}`,
      role: "assistant",
      content: "",
      status: "pending",
      errorCode: null,
      createdAt: now,
      completedAt: null,
    },
  ];
}
