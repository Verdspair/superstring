import type { SessionResponse } from "../../../src/shared/contracts";
import type { ConversationSummary } from "../../../src/shared/contracts/conversation";
import type { SuperstringApi } from "../../../src/web/api";
import { ApiError, api } from "../../../src/web/api";
import {
  chatBusy,
  currentChat,
  emptyWebConversation,
  type WebConversationState,
} from "../../../src/web/features/chat/conversation-state";
import { currentSessionId } from "../../../src/web/features/conversations/directory-state";
import type { RuntimeEffects, SuperstringState } from "../../../src/web/state/types";
import { useSuperstringStore as actual } from "../../../src/web/store";

// Test-only fixture projection: old behavior assertions target the canonical keyed store.
// No compatibility fields are installed on the production store.
type Flat = Partial<
  SuperstringState &
    WebConversationState & {
      sending: boolean;
      sessions: SessionResponse[];
      currentSessionId: string | null;
    }
>;
export function summaryFixture(
  sourceId: string,
  session?: Partial<SessionResponse>,
): ConversationSummary {
  return {
    id: `test:${sourceId}`,
    channel: "web",
    topology: "direct",
    sourceId,
    agentId: session?.agent_id ?? "agent",
    bindingEpoch: 1,
    title: session?.title ?? sourceId,
    participants: [],
    updatedAt: session?.updated_at ?? "2026-09-26T00:00:00Z",
    lastSeq: 0,
    consumedSeq: 0,
  };
}
export function chatApi(client: Partial<SuperstringApi> = {}): SuperstringApi {
  return {
    ...client,
    listConversations:
      client.listConversations && client.listConversations !== api.listConversations
        ? client.listConversations
        : async ({ sourceId } = {}) => {
            const sessions =
              !sourceId && client.listSessions && client.listSessions !== api.listSessions
                ? await client.listSessions()
                : [];
            return {
              items: sourceId
                ? [
                    summaryFixture(
                      sourceId,
                      sessions.find((item) => item.id === sourceId),
                    ),
                  ]
                : sessions.map((item) => summaryFixture(item.id, item)),
              nextCursor: null,
            };
          },
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
      currentSessionId: currentSessionId(state),
      sessions: state.directoryIds
        .map((id) => state.summaryById[id])
        .filter((item) => item.channel === "web")
        .map((item) => ({ id: item.sourceId, title: item.title, agent_id: item.agentId })),
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
      sessions,
      currentSessionId: selectedSession,
      ...rest
    } = patch;
    if (selectedSession !== undefined) rest.selectionRevision = state.selectionRevision + 1;
    if (rest.apiClient) rest.apiClient = chatApi(rest.apiClient);
    const sessionId = selectedSession === undefined ? currentSessionId(state) : selectedSession;
    const summaries = sessions?.map((session) => summaryFixture(session.id, session));
    if (summaries)
      Object.assign(rest, {
        summaryById: {
          ...state.summaryById,
          ...Object.fromEntries(summaries.map((item) => [item.id, item])),
        },
        directoryIds: summaries.map((item) => item.id),
        sessionConversationIds: {
          ...state.sessionConversationIds,
          ...Object.fromEntries(summaries.map((item) => [item.sourceId, item.id])),
        },
      });
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
        summaryById: {
          ...(rest.summaryById ?? state.summaryById),
          [id]: (rest.summaryById ?? state.summaryById)[id] ?? summaryFixture(sessionId),
        },
        sessionConversationIds: {
          ...(rest.sessionConversationIds ?? state.sessionConversationIds),
          [sessionId]: id,
        },
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
