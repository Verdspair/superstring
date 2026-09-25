import type { RuntimeConfig } from "../../../shared/contracts";
import type { ContextUsage } from "../../../shared/contracts/context-usage";
import type { ConversationSummary } from "../../../shared/contracts/conversation";
import type { ChatItem, SuperstringState } from "../../state/types";

export interface ChatRequestRef {
  sessionId: string;
  text: string;
  requestId: string;
}
export type ChatPhase = "idle" | "submitting" | "streaming" | "settling" | "reconciling" | "failed";
export interface WebConversationState {
  sessionId: string;
  messages: ChatItem[];
  composer: string;
  runtimeConfig: RuntimeConfig | null;
  runtimeConfigUnavailable: boolean;
  contextUsage: ContextUsage | null;
  phase: ChatPhase;
  request: ChatRequestRef | null;
  failedChat: ChatRequestRef | null;
  knowledgeResend: ChatRequestRef | null;
  runId: string | null;
  outputId: string | null;
  error: string | null;
  feedback: string;
  loadRevision: number;
}
export function emptyWebConversation(sessionId = ""): WebConversationState {
  return {
    sessionId,
    messages: [],
    composer: "",
    runtimeConfig: null,
    runtimeConfigUnavailable: false,
    contextUsage: null,
    phase: "idle",
    request: null,
    failedChat: null,
    knowledgeResend: null,
    runId: null,
    outputId: null,
    error: null,
    feedback: "",
    loadRevision: 0,
  };
}
export interface ConversationState {
  currentConversationId: string | null;
  selectedBotConversation: ConversationSummary | null;
  sessionConversationIds: Record<string, string>;
  conversationById: Record<string, WebConversationState>;
  unselectedChat: WebConversationState;
  reconcileChat: (conversationId?: string) => Promise<void>;
}
export function currentChat(state: SuperstringState): WebConversationState {
  const id =
    state.currentConversationId ??
    (state.currentSessionId ? state.sessionConversationIds[state.currentSessionId] : null);
  return (id && state.conversationById[id]) || state.unselectedChat;
}
export const chatBusy = (chat: WebConversationState) =>
  ["submitting", "streaming", "settling", "reconciling"].includes(chat.phase);
export function sessionBusy(state: SuperstringState, sessionId: string): boolean {
  const id = state.sessionConversationIds[sessionId];
  return !!id && !!state.conversationById[id] && chatBusy(state.conversationById[id]);
}
export const initialConversationState = {
  currentConversationId: null as string | null,
  selectedBotConversation: null as ConversationSummary | null,
  sessionConversationIds: {} as Record<string, string>,
  conversationById: {} as Record<string, WebConversationState>,
  unselectedChat: emptyWebConversation(),
};
