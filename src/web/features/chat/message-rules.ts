import type { MessageResponse, SseEvent } from "../../../shared/contracts";
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

export function applyMessageEvent(
  messages: ChatItem[],
  assistantId: string,
  event: SseEvent,
): ChatItem[] {
  if (event.event === "delta")
    return messages.map((item) =>
      item.id === assistantId ? { ...item, content: item.content + event.text } : item,
    );
  if (event.event === "done")
    return messages.map((item) =>
      item.id === assistantId
        ? {
            ...item,
            id: event.message_id,
            status: "completed",
            completedAt: event.completed_at,
          }
        : item,
    );
  if (event.event === "error")
    return messages.map((item) =>
      item.id === assistantId ? { ...item, status: "failed", errorCode: event.code } : item,
    );
  return messages;
}

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
