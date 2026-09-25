import { type MessageResponse, UpdateSessionRequestSchema } from "../../../shared/contracts";
import type { RunEvent } from "../../../shared/contracts/agent-run";
import { ApiError } from "../../api";
import { msg } from "../../i18n";
import { errorText, persistBrowserState } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";
import { currentSessionId } from "../conversations/directory-state";
import {
  type ChatRequestRef,
  chatBusy,
  currentChat,
  emptyWebConversation,
  sessionBusy,
  type WebConversationState,
} from "./conversation-state";
import { createOptimisticMessages, toChatItem } from "./message-rules";

type Actions = Pick<
  SuperstringState,
  | "selectSession"
  | "createSession"
  | "deleteCurrentSession"
  | "renameSession"
  | "deleteSessionById"
  | "refreshSessionById"
  | "refreshSession"
  | "setComposer"
  | "send"
  | "retryChat"
  | "resendKnowledgeChat"
  | "cancelKnowledgeResend"
  | "deleteMessage"
  | "reconcileChat"
>;
export function createChatActions(set: StoreSet, get: StoreGet): Actions {
  const write = (
    id: string,
    patch:
      | Partial<WebConversationState>
      | ((view: WebConversationState) => Partial<WebConversationState>),
  ) =>
    set((state) => {
      const view = state.conversationById[id];
      return view
        ? {
            conversationById: {
              ...state.conversationById,
              [id]: { ...view, ...(typeof patch === "function" ? patch(view) : patch) },
            },
          }
        : {};
    });
  const syncSessions = async () => {
    if (!(await get().loadConversations("refresh-loaded")) && get().directoryError)
      throw new Error(get().directoryError ?? "");
  };
  const ensureConversation = async (sessionId: string): Promise<string> => {
    const existing = get().sessionConversationIds[sessionId];
    if (existing) {
      if (!get().conversationById[existing])
        set((state) => ({
          conversationById: {
            ...state.conversationById,
            [existing]: emptyWebConversation(sessionId),
          },
        }));
      return existing;
    }
    const { items } = await get().apiClient.listConversations({
      channel: "web",
      sourceId: sessionId,
    });
    const summary = items.find((item) => item.sourceId === sessionId && item.channel === "web");
    if (!summary)
      throw new ApiError(404, "CONVERSATION_NOT_FOUND", msg("未找到对应会话，请刷新后重试。"));
    get().rememberConversation(summary);
    set((state) => ({
      sessionConversationIds: { ...state.sessionConversationIds, [sessionId]: summary.id },
      conversationById: {
        ...state.conversationById,
        [summary.id]: state.conversationById[summary.id] ?? emptyWebConversation(sessionId),
      },
    }));
    return summary.id;
  };
  const recoverPendingTurn = async (id: string, messages: MessageResponse[]) => {
    const pending = messages.findLast(
      (item) => item.role === "assistant" && item.status === "pending",
    );
    if (!pending) return;
    write(id, { phase: "reconciling" });
    try {
      const { runs } = await get().apiClient.listRuns("web_turn", pending.turn_id);
      const run = runs.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (!run) {
        write(id, { phase: "idle" });
        return;
      }
      get().receiveRunSnapshot(run);
      write(id, { runId: run.runId, outputId: pending.id });
      const { events } = await get().apiClient.getRunEvents(run.runId, 0);
      const started = events.find((event) => event.type === "started");
      const user = messages.find(
        (item) => item.turn_id === pending.turn_id && item.role === "user",
      );
      if (started?.requestId && user)
        write(id, {
          request: {
            sessionId: get().conversationById[id].sessionId,
            text: user.content,
            requestId: started.requestId,
          },
        });
      if (["completed", "no_output", "failed", "cancelled"].includes(run.status)) {
        await settleMessages(id);
        const failed = run.status === "failed" || run.status === "cancelled";
        write(id, (view) => ({
          phase: failed ? "failed" : "idle",
          failedChat: failed ? view.request : null,
          knowledgeResend: run.errorCode === "KNOWLEDGE_ACCESS_CHANGED" ? view.request : null,
          error: run.errorCode,
          feedback: run.status === "no_output" ? msg("本次未发言") : "",
        }));
      } else write(id, { feedback: msg("服务端仍在处理，可稍后核对结果。") });
    } catch (reason) {
      write(id, { error: errorText(reason), feedback: msg("结果尚未确认，请核对结果后继续。") });
    }
  };
  const reload = async (id: string) => {
    const initial = get().conversationById[id];
    if (!initial) return;
    const revision = initial.loadRevision + 1;
    write(id, { loadRevision: revision, error: null });
    const [messages, runtime] = await Promise.allSettled([
      get().apiClient.listMessages(initial.sessionId),
      get().apiClient.getSessionRuntime(initial.sessionId),
    ]);
    if (get().conversationById[id]?.loadRevision !== revision) return;
    const recoveryRead =
      get().conversationById[id].phase === "reconciling" && !get().conversationById[id].request;
    const recover = !chatBusy(get().conversationById[id]) || recoveryRead;
    write(id, (view) => ({
      ...(messages.status === "fulfilled" && (!chatBusy(view) || recoveryRead)
        ? {
            messages: messages.value.map(toChatItem),
            ...(recoveryRead && !messages.value.some((item) => item.status === "pending")
              ? { phase: "idle" as const, feedback: "" }
              : {}),
          }
        : {}),
      runtimeConfig: runtime.status === "fulfilled" ? runtime.value : null,
      runtimeConfigUnavailable: runtime.status === "rejected",
      ...(messages.status === "rejected"
        ? { error: errorText(messages.reason) }
        : runtime.status === "rejected"
          ? { error: errorText(runtime.reason) }
          : {}),
    }));
    if (messages.status === "fulfilled" && recover) await recoverPendingTurn(id, messages.value);
  };
  const settleMessages = async (id: string) => {
    const view = get().conversationById[id];
    if (!view) return;
    const messages = await get().apiClient.listMessages(view.sessionId);
    write(id, { messages: messages.map(toChatItem) });
  };
  const checking = new Set<string>();
  const reconcile = async (id: string) => {
    const view = get().conversationById[id];
    if (!view?.request || checking.has(id)) return;
    checking.add(id);
    write(id, {
      phase: "reconciling",
      error: null,
      feedback: msg("连接中断，正在核对服务端结果…"),
    });
    try {
      const run = await get().apiClient.getRunByRequest(view.sessionId, view.request.requestId);
      get().receiveRunSnapshot(run);
      write(id, { runId: run.runId });
      const terminal = ["completed", "no_output", "failed", "cancelled"].includes(run.status);
      if (!terminal) {
        write(id, { feedback: msg("服务端仍在处理，可稍后核对结果。") });
        return;
      }
      await settleMessages(id);
      const failed = run.status === "failed" || run.status === "cancelled";
      write(id, {
        phase: failed ? "failed" : "idle",
        failedChat: failed ? view.request : null,
        knowledgeResend: run.errorCode === "KNOWLEDGE_ACCESS_CHANGED" ? view.request : null,
        error: failed ? (run.errorCode ?? msg("运行已取消")) : null,
        feedback: run.status === "no_output" ? msg("本次未发言") : "",
      });
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) {
        write(id, (chat) => ({
          phase: "failed",
          failedChat: view.request,
          error: msg("服务端未找到本次请求，可重试原请求。"),
          feedback: "",
          messages: chat.messages.map((message) =>
            message.status === "pending"
              ? { ...message, status: "failed", errorCode: "REQUEST_NOT_FOUND" }
              : message,
          ),
        }));
      } else
        write(id, { error: errorText(reason), feedback: msg("结果尚未确认，请核对结果后继续。") });
    } finally {
      checking.delete(id);
    }
  };
  const transmit = async (request: ChatRequestRef, retry = false, feedback = "") => {
    const id = await ensureConversation(request.sessionId);
    if (chatBusy(get().conversationById[id])) return;
    const assistantId = `optimistic-assistant-${request.requestId}`;
    let terminal = false;
    let knownFailure = false;
    let started = false;
    let responseId = assistantId;
    let appliedSeq = 0;
    const pending = new Map<number, RunEvent>();
    write(id, (view) => ({
      phase: "submitting",
      request,
      contextUsage: null,
      error: null,
      feedback,
      failedChat: null,
      knowledgeResend: null,
      runId: null,
      messages: [
        ...view.messages.filter(
          (item) => item.id !== assistantId && (!retry || item.id !== view.outputId),
        ),
        ...createOptimisticMessages(request.text, request.requestId, get().effects.now()).filter(
          (item) => !retry || item.role === "assistant",
        ),
      ],
    }));
    try {
      await get().effects.streamChatV2(
        {
          session_id: request.sessionId,
          message: request.text,
          client_request_id: request.requestId,
        },
        (event) => {
          if (event.type === "replay") {
            terminal = true;
            write(id, (view) => ({
              phase: "settling",
              runId: event.runId ?? null,
              outputId: event.message.id,
              messages: [
                ...view.messages.filter(
                  (item) => item.id !== responseId && item.id !== event.message.id,
                ),
                {
                  id: event.message.id,
                  role: "assistant",
                  content: event.message.text,
                  status: "completed",
                  errorCode: null,
                  createdAt: event.message.createdAt,
                  completedAt: event.message.completedAt,
                },
              ],
            }));
            return;
          }
          started = true;
          get().receiveRunEvent(event);
          if (event.seq <= appliedSeq) return;
          pending.set(event.seq, event);
          let next = pending.get(appliedSeq + 1);
          while (next) {
            const event = next;
            pending.delete(++appliedSeq);
            next = pending.get(appliedSeq + 1);
            const run = get().runById[event.runId];
            write(id, { runId: event.runId, phase: "streaming" });
            if (event.type === "context_usage") {
              if (event.usage.session_id === request.sessionId)
                write(id, { contextUsage: event.usage });
              continue;
            }
            if (event.type === "output_delta") {
              const previousId = responseId;
              responseId = event.outputId;
              write(id, { outputId: responseId });
              write(id, (view) => ({
                messages: view.messages.map((item) =>
                  item.id === previousId
                    ? {
                        ...item,
                        id: responseId,
                        content: run.outputTextById[event.outputId] ?? item.content,
                      }
                    : item,
                ),
              }));
            }
            if (event.type === "completed") {
              terminal = true;
              write(id, (view) => ({
                phase: "settling",
                outputId: event.messageId ?? responseId,
                messages: view.messages.map((item) =>
                  item.id === responseId
                    ? {
                        ...item,
                        id: event.messageId ?? responseId,
                        status: "completed",
                        createdAt: event.createdAt ?? item.createdAt,
                        completedAt: event.completedAt ?? get().effects.now(),
                      }
                    : item,
                ),
              }));
            } else if (event.type === "no_output") {
              terminal = true;
              write(id, (view) => ({
                phase: "settling",
                feedback: msg("本次未发言"),
                messages: view.messages.filter((item) => item.id !== responseId),
              }));
            } else if (event.type === "failed" || event.type === "cancelled") {
              terminal = true;
              knownFailure = true;
              const code = event.type === "failed" ? event.code : "CANCELLED";
              write(id, (view) => ({
                phase: "settling",
                error: code,
                failedChat: request,
                knowledgeResend: code === "KNOWLEDGE_ACCESS_CHANGED" ? request : null,
                messages: view.messages.map((item) =>
                  item.id === responseId
                    ? {
                        ...item,
                        status: event.type === "cancelled" ? "cancelled" : "failed",
                        errorCode: code,
                      }
                    : item,
                ),
              }));
            }
          }
        },
      );
      if (!terminal) {
        await reconcile(id);
        return;
      }
      await settleMessages(id);
      await syncSessions();
    } catch (reason) {
      // An eager HTTP rejection is an explicit verdict. Transport/EOF failures require read-only reconciliation.
      if (!started && reason instanceof ApiError && reason.status >= 400 && reason.status < 500) {
        knownFailure = true;
        write(id, (view) => ({
          phase: "failed",
          error: errorText(reason),
          failedChat: request,
          knowledgeResend: reason.code === "KNOWLEDGE_ACCESS_CHANGED" ? request : null,
          messages: view.messages.map((item) =>
            item.id === responseId ? { ...item, status: "failed", errorCode: reason.code } : item,
          ),
        }));
      } else if (!terminal) await reconcile(id);
      else write(id, { error: errorText(reason) });
    } finally {
      if (terminal) write(id, { phase: knownFailure ? "failed" : "idle" });
    }
  };
  return {
    reconcileChat: async (id = get().currentConversationId ?? undefined) => {
      if (id) {
        if (get().conversationById[id]?.request) await reconcile(id);
        else await reload(id);
      }
    },
    selectSession: async (sessionId) => {
      const revision = get().selectionRevision + 1;
      set({ selectionRevision: revision });
      try {
        const id = await ensureConversation(sessionId);
        if (get().selectionRevision !== revision) return;
        set({ currentConversationId: id, error: null });
        persistBrowserState(get().browserStateStorage, "superstring-session", sessionId);
        persistBrowserState(get().browserStateStorage, "superstring-conversation", id);
        await reload(id);
      } catch (reason) {
        set({ error: errorText(reason) });
      }
    },
    createSession: async (title) => {
      const normalized = title.trim();
      if (!normalized) {
        set({ error: null, feedback: msg("名称不能为空，请填写后再确认") });
        return false;
      }
      const agentId = get().selectedNewSessionAgentId;
      if (!agentId) {
        set({ error: null, feedback: msg("当前没有可用于新会话的 Agent，请先启用或创建 Agent") });
        return false;
      }
      try {
        const created = await get().apiClient.createSession({
          title: normalized,
          agent_id: agentId,
          mode: "chat",
          client_request_id: get().effects.requestId(),
        });
        const id = await ensureConversation(created.id);
        set({ error: null, feedback: "" });
        await get().requestConversationNavigation(id);
        return true;
      } catch (reason) {
        set({ error: null, feedback: errorText(reason) || msg("新建会话失败，请检查后端服务") });
        return false;
      }
    },
    renameSession: async (id, title) => {
      const parsed = UpdateSessionRequestSchema.safeParse({ title: title.trim() });
      if (!parsed.success) {
        set({ error: msg("名称须为 1–200 个字符。") });
        return false;
      }
      if (get().summaryById[get().sessionConversationIds[id]]?.title === parsed.data.title)
        return true;
      try {
        const updated = await get().apiClient.renameSession(id, parsed.data.title);
        const summary = get().summaryById[get().sessionConversationIds[id]];
        if (summary)
          get().rememberConversation({
            ...summary,
            title: updated.title,
            updatedAt: updated.updated_at,
          });
        set((state) => ({
          memorySessions: state.memorySessions.map((item) =>
            item.id === id ? { ...item, title: updated.title } : item,
          ),
          error: null,
          feedback: msg("会话已重命名"),
        }));
        return true;
      } catch (reason) {
        set({ error: errorText(reason) });
        return false;
      }
    },
    deleteSessionById: async (sessionId) => {
      if (sessionBusy(get(), sessionId)) {
        set({ error: msg("生成完成后再刷新或删除会话。") });
        return false;
      }
      try {
        await get().apiClient.deleteSession(sessionId);

        const id = get().sessionConversationIds[sessionId];
        const wasCurrent = currentSessionId(get()) === sessionId;
        set((state) => {
          const { [sessionId]: _session, ...sessionConversationIds } = state.sessionConversationIds;
          const { [id]: _view, ...conversationById } = state.conversationById;
          const runById = Object.fromEntries(
            Object.entries(state.runById).filter(
              ([, view]) =>
                view.snapshot?.owner.id !== sessionId &&
                view.snapshot?.runId !== state.conversationById[id]?.runId,
            ),
          );
          return {
            summaryById: Object.fromEntries(
              Object.entries(state.summaryById).filter(([key]) => key !== id),
            ),
            directoryIds: state.directoryIds.filter((key) => key !== id),
            directoryRevision: state.directoryRevision + 1,
            sessionConversationIds,
            conversationById,
            runById,
            error: null,
            feedback: msg("会话已删除"),
            ...(wasCurrent ? { currentConversationId: null } : {}),
          };
        });
        if (wasCurrent) {
          const next = get().directoryIds[0];
          persistBrowserState(get().browserStateStorage, "superstring-session", null);
          persistBrowserState(get().browserStateStorage, "superstring-conversation", next ?? null);
          if (next) await get().selectConversation(next);
        }
        return true;
      } catch (reason) {
        set({ error: errorText(reason) });
        return false;
      }
    },
    deleteCurrentSession: async () => {
      const id = currentSessionId(get());
      if (id) await get().deleteSessionById(id);
    },
    refreshSessionById: async (sessionId) => {
      if (sessionBusy(get(), sessionId)) {
        set({ error: msg("生成完成后再刷新或删除会话。") });
        return false;
      }
      try {
        const id = await ensureConversation(sessionId);
        await reload(id);
        const error = get().conversationById[id].error;
        if (error) {
          set({ error });
          return false;
        }
        await syncSessions();
        set({ feedback: msg("会话已刷新"), error: null });
        return true;
      } catch (reason) {
        set({ error: errorText(reason) });
        return false;
      }
    },
    refreshSession: async () => {
      try {
        await syncSessions();
        const current = get().currentConversationId;
        const next =
          current && get().directoryIds.includes(current) ? current : get().directoryIds[0];
        if (next) await get().selectConversation(next);
        else set({ currentConversationId: null, error: null, feedback: msg("请先新建或选择会话") });
      } catch (reason) {
        set({ error: errorText(reason) });
      }
    },
    setComposer: (composer) => {
      const id = get().currentConversationId;
      if (id) write(id, { composer });
      else set({ unselectedChat: { ...get().unselectedChat, composer } });
    },
    send: async () => {
      const view = currentChat(get());
      if (chatBusy(view)) return;
      const text = view.composer.trim();
      const sessionId = currentSessionId(get());
      if (!text) {
        set({ error: null, feedback: msg("消息不能为空") });
        return;
      }
      if (!sessionId) {
        set({ error: null, feedback: msg("请先新建或选择会话") });
        return;
      }
      try {
        const id = await ensureConversation(sessionId);
        write(id, { composer: "" });
        set({ unselectedChat: emptyWebConversation(), feedback: "" });
        await transmit({ sessionId, text, requestId: get().effects.requestId() });
      } catch (reason) {
        set({ error: errorText(reason) });
      }
    },
    retryChat: async () => {
      const view = currentChat(get());
      if (view.failedChat && !view.knowledgeResend) await transmit(view.failedChat, true);
    },
    cancelKnowledgeResend: () => {
      const id = get().currentConversationId;
      if (id) write(id, { knowledgeResend: null });
    },
    resendKnowledgeChat: async () => {
      const view = currentChat(get());
      if (view.knowledgeResend && !chatBusy(view))
        await transmit(
          { ...view.knowledgeResend, requestId: get().effects.requestId() },
          false,
          msg("已按最新权限重新发送（新请求）"),
        );
    },
    deleteMessage: async (sessionId, messageId) => {
      if (!sessionId) {
        set({ feedback: msg("当前没有会话，无法删除消息") });
        return;
      }
      try {
        await get().apiClient.deleteMessage(sessionId, messageId);
        const id = await ensureConversation(sessionId);
        write(id, { contextUsage: null, runId: null });
        await reload(id);
      } catch (reason) {
        set({ error: null, feedback: msg("删除消息失败：{0}", errorText(reason)) });
      }
    },
  };
}
