import { useSuperstringStore } from "../../store";
import { ChatPage } from "../chat/ChatPage";
import { ConversationTimeline } from "./ConversationTimeline";
import { selectedConversation } from "./directory-state";

/** Selection/identity is shared; source ownership determines available message operations. */
export function ConversationShell() {
  const conversation = useSuperstringStore(selectedConversation);
  return conversation?.channel === "onebot11" ? (
    <ConversationTimeline key={conversation.id} conversation={conversation} />
  ) : (
    <ChatPage />
  );
}
