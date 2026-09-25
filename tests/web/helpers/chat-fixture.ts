import type { SuperstringApi } from "../../../src/web/api";
import { ApiError, api } from "../../../src/web/api";
import {
  chatBusy,
  currentChat,
  emptyWebConversation,
  type WebConversationState,
} from "../../../src/web/features/chat/conversation-state";
import type { RuntimeEffects, SuperstringState } from "../../../src/web/state/types";
import { useSuperstringStore as actual } from "../../../src/web/store";

// Test-only fixture projection: old behavior assertions target the canonical keyed store.
// No compatibility fields are installed on the production store.
type Flat = Partial<SuperstringState & WebConversationState & { sending: boolean }>;
export function chatApi(client: Partial<SuperstringApi> = {}): SuperstringApi {
  return {
    ...client,
    listConversations:
      client.listConversations && client.listConversations !== api.listConversations
        ? client.listConversations
        : async ({ sourceId } = {}) => ({
            items: sourceId
              ? [
                  {
                    id: `test:${sourceId}`,
                    channel: "web",
                    topology: "direct",
                    sourceId,
                    agentId: "agent",
                    bindingEpoch: 0,
                    title: sourceId,
                    participants: [],
                    updatedAt: "2026-09-26T00:00:00Z",
                    lastSeq: 0,
                    consumedSeq: 0,
                  },
                ]
              : [],
            nextCursor: null,
          }),
    getRunByRequest:
      client.getRunByRequest && client.getRunByRequest !== api.getRunByRequest
        ? client.getRunByRequest
        : async () => {
            throw new ApiError(404, "NOT_FOUND", "Request not found");
          },
  } as SuperstringApi;
}
export const fixtureStore = {
  getState: () => {
    const state = actual.getState();
    const chat = currentChat(state);
    return {
      ...state,
      ...chat,
      error: chat.error ?? state.error,
      feedback: chat.feedback || state.feedback,
      sending: chatBusy(chat),
      resetForTests: (client?: SuperstringApi, effects: Partial<RuntimeEffects> = {}) =>
        state.resetForTests(chatApi(client), effects),
    };
  },
  setState: (patch: Flat) => {
    const state = actual.getState();
    const {
      messages,
      composer,
      runtimeConfig,
      runtimeConfigUnavailable,
      contextUsage,
      failedChat,
      knowledgeResend,
      sending,
      ...rest
    } = patch;
    if (rest.apiClient) rest.apiClient = chatApi(rest.apiClient);
    const sessionId =
      patch.currentSessionId === undefined ? state.currentSessionId : patch.currentSessionId;
    const changes = {
      ...(messages !== undefined ? { messages } : {}),
      ...(composer !== undefined ? { composer } : {}),
      ...(runtimeConfig !== undefined ? { runtimeConfig } : {}),
      ...(runtimeConfigUnavailable !== undefined ? { runtimeConfigUnavailable } : {}),
      ...(contextUsage !== undefined ? { contextUsage } : {}),
      ...(failedChat !== undefined ? { failedChat } : {}),
      ...(knowledgeResend !== undefined ? { knowledgeResend } : {}),
      ...(sending !== undefined
        ? { phase: sending ? ("streaming" as const) : ("idle" as const) }
        : {}),
    };
    if (sessionId) {
      const id = state.sessionConversationIds[sessionId] ?? `test:${sessionId}`;
      actual.setState({
        ...rest,
        currentConversationId: id,
        sessionConversationIds: { ...state.sessionConversationIds, [sessionId]: id },
        conversationById: {
          ...state.conversationById,
          [id]: { ...(state.conversationById[id] ?? emptyWebConversation(sessionId)), ...changes },
        },
      });
    } else
      actual.setState({
        ...rest,
        currentConversationId: null,
        ...(composer !== undefined
          ? { unselectedChat: { ...state.unselectedChat, composer } }
          : {}),
      });
  },
};
