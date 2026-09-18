import { UpdateSessionRequestSchema } from "../../../shared/contracts";
import { msg } from "../../i18n";
import { errorText, persistBrowserState } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";
import { applyMessageEvent, createOptimisticMessages, toChatItem } from "./message-rules";

export function createChatActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
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
  | "deleteMessage"
> {
  return {
    selectSession: async (id) => {
      set({ currentSessionId: id, error: null });
      persistBrowserState(get().browserStateStorage, "superstring-session", id);
      const [messagesResult, runtimeResult] = await Promise.allSettled([
        get().apiClient.listMessages(id),
        get().apiClient.getSessionRuntime(id),
      ]);
      if (get().currentSessionId !== id) return;
      set({
        messages: messagesResult.status === "fulfilled" ? messagesResult.value.map(toChatItem) : [],
        runtimeConfig: runtimeResult.status === "fulfilled" ? runtimeResult.value : null,
        runtimeConfigUnavailable: runtimeResult.status === "rejected",
        error:
          messagesResult.status === "rejected"
            ? errorText(messagesResult.reason)
            : runtimeResult.status === "rejected"
              ? errorText(runtimeResult.reason)
              : null,
      });
    },
    createSession: async (title) => {
      const normalized = title.trim();
      if (!normalized) {
        set({ error: null, feedback: msg("名称不能为空，请填写后再确认") });
        return false;
      }
      if (!get().selectedNewSessionAgentId) {
        set({
          error: null,
          feedback: msg("当前没有可用于新会话的 Agent，请先启用或创建 Agent"),
          messages: [],
        });
        return false;
      }
      try {
        const created = await get().apiClient.createSession({
          title: normalized,
          agent_id: get().selectedNewSessionAgentId,
          mode: "chat",
          client_request_id: get().effects.requestId(),
        });
        set((state) => ({
          sessions: [created, ...state.sessions.filter((item) => item.id !== created.id)],
          currentSessionId: created.id,
          messages: [],
          runtimeConfig: null,
          runtimeConfigUnavailable: false,
          error: null,
          feedback: "",
        }));
        await get().selectSession(created.id);
        return true;
      } catch (error) {
        set({
          error: null,
          feedback: errorText(error) || msg("新建会话失败，请检查后端服务"),
        });
        return false;
      }
    },
    renameSession: async (id, title) => {
      const parsed = UpdateSessionRequestSchema.safeParse({
        title: title.trim(),
      });
      if (!parsed.success) {
        set({ error: msg("名称须为 1–200 个字符。") });
        return false;
      }
      if (get().sessions.find((item) => item.id === id)?.title === parsed.data.title) return true;
      try {
        const updated = await get().apiClient.renameSession(id, parsed.data.title);
        set((state) => ({
          sessions: state.sessions.map((item) => (item.id === id ? updated : item)),
          memorySessions: state.memorySessions.map((item) =>
            item.id === id ? { ...item, title: updated.title } : item,
          ),
          error: null,
          feedback: msg("会话已重命名"),
        }));
        return true;
      } catch (error) {
        set({ error: errorText(error) });
        return false;
      }
    },
    deleteSessionById: async (id) => {
      if (get().sending) {
        set({ error: msg("生成完成后再刷新或删除会话。") });
        return false;
      }
      try {
        await get().apiClient.deleteSession(id);
        const sessions = get().sessions.filter((item) => item.id !== id);
        const wasCurrent = get().currentSessionId === id;
        set({ sessions, error: null, feedback: msg("会话已删除") });
        if (wasCurrent) {
          const next = sessions[0] ?? null;
          set({
            currentSessionId: next?.id ?? null,
            messages: [],
            runtimeConfig: null,
            runtimeConfigUnavailable: false,
          });
          persistBrowserState(get().browserStateStorage, "superstring-session", next?.id ?? null);
          if (next) await get().selectSession(next.id);
        }
        return true;
      } catch (error) {
        set({ error: errorText(error) });
        return false;
      }
    },
    deleteCurrentSession: async () => {
      const id = get().currentSessionId;
      if (id) await get().deleteSessionById(id);
    },
    refreshSessionById: async (id) => {
      if (get().sending) {
        set({ error: msg("生成完成后再刷新或删除会话。") });
        return false;
      }
      try {
        const [sessions, messages, runtime] = await Promise.all([
          get().apiClient.listSessions(),
          get().apiClient.listMessages(id),
          get().apiClient.getSessionRuntime(id),
        ]);
        set((state) => ({
          sessions,
          ...(state.currentSessionId === id
            ? {
                messages: messages.map(toChatItem),
                runtimeConfig: runtime,
                runtimeConfigUnavailable: false,
              }
            : {}),
          error: null,
          feedback: msg("会话已刷新"),
        }));
        return true;
      } catch (error) {
        set({ error: errorText(error) });
        return false;
      }
    },
    refreshSession: async () => {
      try {
        const sessions = await get().apiClient.listSessions();
        const currentId = get().currentSessionId;
        const next = sessions.find((item) => item.id === currentId) ?? sessions[0] ?? null;
        set({ sessions, error: null, currentSessionId: next?.id ?? null });
        if (next) await get().selectSession(next.id);
        else
          set({
            messages: [],
            runtimeConfig: null,
            runtimeConfigUnavailable: false,
            feedback: msg("请先新建或选择会话"),
          });
      } catch (error) {
        set({ error: errorText(error) });
      }
    },
    setComposer: (composer) => set({ composer }),
    send: async () => {
      const text = get().composer.trim();
      const sessionId = get().currentSessionId;
      if (get().sending) return;
      if (!text) {
        set({ error: null, feedback: msg("消息不能为空") });
        return;
      }
      if (!sessionId) {
        set({ error: null, feedback: msg("请先新建或选择会话") });
        return;
      }
      const clientRequestId = get().effects.requestId();
      const assistantId = `optimistic-assistant-${clientRequestId}`;
      const now = get().effects.now();
      set((state) => ({
        composer: "",
        sending: true,
        error: null,
        messages: [...state.messages, ...createOptimisticMessages(text, clientRequestId, now)],
      }));
      try {
        await get().effects.streamChat(
          {
            session_id: sessionId,
            message: text,
            client_request_id: clientRequestId,
          },
          (event) => {
            set((state) => ({
              messages: applyMessageEvent(state.messages, assistantId, event),
              ...(event.event === "error" ? { error: event.message } : {}),
            }));
          },
        );
        await get().refreshSession();
      } catch (error) {
        set((state) => ({
          error: errorText(error),
          messages: state.messages.map((item) =>
            item.id === assistantId ? { ...item, status: "failed" } : item,
          ),
        }));
      } finally {
        set({ sending: false });
      }
    },
    deleteMessage: async (sessionId, id) => {
      if (!sessionId) {
        set({ feedback: msg("当前没有会话，无法删除消息") });
        return;
      }
      try {
        await get().apiClient.deleteMessage(sessionId, id);
        await get().selectSession(sessionId);
      } catch (error) {
        set({
          error: null,
          feedback: msg(
            "删除消息失败：{0}",
            error instanceof Error ? error.message : msg("请检查后端服务"),
          ),
        });
      }
    },
  };
}
