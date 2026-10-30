import {
  type MessagePageResponse,
  type MessageResponse,
  UpdateSessionRequestSchema,
} from "../../../shared/contracts";
import type { RunEvent } from "../../../shared/contracts/agent-run";
import { ApiError } from "../../api";
import { msg } from "../../i18n";
import {
  loadWebChatCache,
  removeWebChatCache,
  saveWebChatCache,
} from "../../services/page-snapshot-cache";
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

const transcriptItem = (message: MessageResponse) => ({
  ...toChatItem(message),
  sequenceNo: message.sequence_no,
  turnId: message.turn_id,
});

// 同一 request 重试复用原 turn：按 turn_id + assistant 对上服务器终态助手行，重试只应替换这一条。
const failedReplyIdForTurn = (messages: MessageResponse[], turnId: string | null) =>
  (turnId
    ? messages.findLast((item) => item.turn_id === turnId && item.role === "assistant")
    : undefined
  )?.id;

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
  | "loadOlderMessages"
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
    const summary = await get().resolveConversationSource("web", sessionId, null);
    if (!summary)
      throw new ApiError(404, "CONVERSATION_NOT_FOUND", msg("未找到对应会话，请刷新后重试。"));
    set((state) => ({
      sessionConversationIds: { ...state.sessionConversationIds, [sessionId]: summary.id },
      conversationById: {
        ...state.conversationById,
        [summary.id]: state.conversationById[summary.id] ?? emptyWebConversation(sessionId),
      },
    }));
    return summary.id;
  };
  const readOwner = (id: string) => {
    const view = get().conversationById[id];
    const client = get().apiClient;
    if (!view) return null;
    const revision = view.loadRevision + 1;
    write(id, { loadRevision: revision, loadingOlderMessages: false });
    return {
      client,
      sessionId: view.sessionId,
      revision,
      current: () =>
        get().apiClient === client &&
        get().conversationById[id]?.sessionId === view.sessionId &&
        get().conversationById[id]?.loadRevision === revision,
    };
  };
  const loadedPage = async (
    view: WebConversationState,
    owner: NonNullable<ReturnType<typeof readOwner>>,
  ): Promise<MessagePageResponse> => {
    let page = await owner.client.listMessages(
      view.sessionId,
      view.loadedFromSequence === null ? {} : { after_sequence_no: view.loadedFromSequence - 1 },
    );
    if (view.loadedFromSequence === null) return page;
    const items = [...page.items];
    while (page.has_more && owner.current()) {
      const cursor = page.items.at(-1)?.sequence_no;
      if (cursor === undefined) throw Error("Message history cursor did not advance");
      page = await owner.client.listMessages(view.sessionId, { after_sequence_no: cursor });
      if (page.items.length && page.items[0].sequence_no <= cursor)
        throw Error("Message history cursor did not advance");
      items.push(...page.items);
    }
    if (
      owner.current() &&
      view.request &&
      view.outputId &&
      !items.some((item) => item.id === view.outputId)
    ) {
      const pair = await owner.client.listMessages(view.sessionId, {
        client_request_id: view.request.requestId,
      });
      items.push(...pair.items.filter((item) => !items.some((loaded) => loaded.id === item.id)));
      items.sort((a, b) => a.sequence_no - b.sequence_no);
    }
    return { items, has_more: view.hasOlderMessages };
  };
  const pagePatch = (
    captured: WebConversationState,
    current: WebConversationState,
    page: MessagePageResponse,
  ) => {
    // A concurrent older read extends the range outside this refresh's authority.
    const extendedOlder =
      captured.loadedFromSequence !== null &&
      current.loadedFromSequence !== null &&
      current.loadedFromSequence < captured.loadedFromSequence;
    const older = extendedOlder
      ? current.messages.filter(
          (item) =>
            item.sequenceNo !== undefined &&
            item.sequenceNo >= current.loadedFromSequence! &&
            item.sequenceNo < captured.loadedFromSequence!,
        )
      : [];
    const messages = [
      ...new Map(
        [...older, ...page.items.map(transcriptItem)].map((item) => [item.id, item]),
      ).values(),
    ].sort((a, b) => (a.sequenceNo ?? Infinity) - (b.sequenceNo ?? Infinity));
    return {
      messages,
      loadedFromSequence: extendedOlder
        ? current.loadedFromSequence
        : (captured.loadedFromSequence ?? page.items[0]?.sequence_no ?? null),
      hasOlderMessages: extendedOlder ? current.hasOlderMessages : page.has_more,
    };
  };
  const settleMessages = async (
    id: string,
    request?: ChatRequestRef,
    turnId?: string,
  ): Promise<MessageResponse[] | null> => {
    const view = get().conversationById[id];
    const owner = readOwner(id);
    if (!view || !owner) return null;
    const page = await loadedPage(view, owner);
    if (!owner.current()) return null;
    let pair: MessageResponse[] = [];
    if (request && turnId && !page.items.some((item) => item.turn_id === turnId)) {
      pair = (
        await owner.client.listMessages(view.sessionId, { client_request_id: request.requestId })
      ).items;
      if (!owner.current()) return null;
    }
    const messages = [
      ...new Map([...pair, ...page.items].map((item) => [item.id, item])).values(),
    ].sort((a, b) => a.sequence_no - b.sequence_no);
    write(id, (current) => pagePatch(view, current, { ...page, items: messages }));
    return messages;
  };
  const recoverPendingTurn = async (
    id: string,
    messages: MessageResponse[],
    owner: NonNullable<ReturnType<typeof readOwner>>,
  ) => {
    const pending = messages.findLast(
      (item) => item.role === "assistant" && item.status === "pending",
    );
    if (!pending || !owner.current()) return;
    write(id, { phase: "reconciling" });
    let settlementRevision: number | null = null;
    try {
      const { runs } = await owner.client.listRuns("web_turn", pending.turn_id);
      if (!owner.current()) return;
      const run = runs.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      if (!run) {
        write(id, { phase: "idle" });
        return;
      }
      get().receiveRunSnapshot(run);
      write(id, { runId: run.runId, outputId: pending.id });
      const { events } = await owner.client.getRunEvents(run.runId, 0);
      if (!owner.current()) return;
      const started = events.find((event) => event.type === "started");
      let user = messages.find((item) => item.turn_id === pending.turn_id && item.role === "user");
      if (!user) {
        user = (
          await owner.client.listMessages(owner.sessionId, { turn_id: pending.turn_id })
        ).items.find((item) => item.role === "user");
        if (!owner.current()) return;
      }
      if (started?.requestId && user)
        write(id, {
          request: { sessionId: owner.sessionId, text: user.content, requestId: started.requestId },
        });
      if (["completed", "no_output", "failed", "cancelled"].includes(run.status)) {
        const request = get().conversationById[id].request ?? undefined;
        const settling = settleMessages(id, request, pending.turn_id);
        settlementRevision = get().conversationById[id]?.loadRevision ?? null;
        const settled = await settling;
        if (!settled) return;
        if (get().apiClient !== owner.client || !get().conversationById[id]) return;
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
      if (
        owner.current() ||
        (settlementRevision !== null &&
          get().apiClient === owner.client &&
          get().conversationById[id]?.loadRevision === settlementRevision)
      )
        write(id, { error: errorText(reason), feedback: msg("结果尚未确认，请核对结果后继续。") });
    }
  };
  const reload = async (id: string) => {
    const initial = get().conversationById[id];
    const owner = readOwner(id);
    if (!initial || !owner) return;
    write(id, { error: null });
    let networkSettled = false;
    const storage = get().sessionStateStorage;
    const currentAgentId = initial.runtimeConfig?.agent_id ?? get().selectedNewSessionAgentId;
    if (storage && initial.messages.length === 0) {
      void loadWebChatCache(storage, initial.sessionId, currentAgentId).then((cached) => {
        if (
          !networkSettled &&
          cached?.messages.length &&
          owner.current() &&
          get().conversationById[id]?.messages.length === 0
        )
          write(id, { messages: cached.messages, phase: "idle" });
      });
    }
    const [messages, runtime] = await Promise.allSettled([
      loadedPage(initial, owner),
      owner.client.getSessionRuntime(initial.sessionId),
    ]);
    networkSettled = true;
    if (!owner.current()) return;
    const view = get().conversationById[id];
    const recoveryRead = view.phase === "reconciling" && !view.request;
    const recover = !chatBusy(view) || recoveryRead;
    write(id, (current) => ({
      ...(messages.status === "fulfilled" && recover
        ? {
            ...pagePatch(initial, current, messages.value),
            ...(recoveryRead && !messages.value.items.some((item) => item.status === "pending")
              ? { phase: "idle" as const, feedback: "" }
              : {}),
          }
        : {}),
      runtimeConfig: runtime.status === "fulfilled" ? runtime.value : null,
      runtimeConfigUnavailable: runtime.status === "rejected",
      ...(messages.status === "rejected" ? { error: errorText(messages.reason) } : {}),
    }));
    if (messages.status === "fulfilled" && recover) {
      const agentId =
        runtime.status === "fulfilled" && runtime.value ? runtime.value.agent_id : currentAgentId;
      void saveWebChatCache(
        get().sessionStateStorage,
        initial.sessionId,
        agentId,
        owner.revision,
        messages.value.items.map(transcriptItem),
      );
      await recoverPendingTurn(id, messages.value.items, owner);
    } else if (messages.status === "rejected") {
      const err = errorText(messages.reason);
      if (err.includes("403") || err.includes("revoked") || err.includes("Forbidden"))
        void removeWebChatCache(get().sessionStateStorage, initial.sessionId);
    }
  };
  const checking = new Set<string>();
  const reconcile = async (id: string) => {
    const view = get().conversationById[id];
    const client = get().apiClient;
    if (!view?.request || checking.has(id)) return;
    const current = () =>
      get().apiClient === client &&
      get().conversationById[id]?.request?.requestId === view.request?.requestId;
    checking.add(id);
    write(id, {
      phase: "reconciling",
      error: null,
      feedback: msg("连接中断，正在核对服务端结果…"),
    });
    try {
      const run = await client.getRunByRequest(view.sessionId, view.request.requestId);
      if (!current()) return;
      get().receiveRunSnapshot(run);
      write(id, { runId: run.runId });
      const terminal = ["completed", "no_output", "failed", "cancelled"].includes(run.status);
      if (!terminal) {
        write(id, { feedback: msg("服务端仍在处理，可稍后核对结果。") });
        return;
      }
      const settled = await settleMessages(
        id,
        view.request,
        run.owner.kind === "web_turn" ? run.owner.id : undefined,
      );
      if (!settled) return;
      const failed = run.status === "failed" || run.status === "cancelled";
      const failedReplyId = failed
        ? failedReplyIdForTurn(settled, run.owner.kind === "web_turn" ? run.owner.id : null)
        : undefined;
      write(id, {
        phase: failed ? "failed" : "idle",
        failedChat: failed ? view.request : null,
        knowledgeResend: run.errorCode === "KNOWLEDGE_ACCESS_CHANGED" ? view.request : null,
        error: failed ? (run.errorCode ?? msg("运行已取消")) : null,
        feedback: run.status === "no_output" ? msg("本次未发言") : "",
        ...(failedReplyId ? { outputId: failedReplyId } : {}),
      });
    } catch (reason) {
      if (!current()) return;
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
    const client = get().apiClient;
    const current = () =>
      get().apiClient === client &&
      get().conversationById[id]?.request?.requestId === request.requestId;
    const assistantId = `optimistic-assistant-${request.requestId}`;
    let terminal = false;
    let knownFailure = false;
    let started = false;
    let responseId = assistantId;
    let appliedSeq = 0;
    const pending = new Map<number, RunEvent>();
    write(id, (view) => ({
      phase: "submitting",
      loadRevision: view.loadRevision + 1,
      loadingOlderMessages: false,
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
          if (!current()) return;
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
      if (!current()) return;
      if (!terminal) {
        await reconcile(id);
        return;
      }
      const failedRun = knownFailure
        ? await client.getRunByRequest(request.sessionId, request.requestId).catch(() => null)
        : null;
      if (!current()) return;
      const settled = await settleMessages(
        id,
        request,
        failedRun?.owner.kind === "web_turn" ? failedRun.owner.id : undefined,
      );
      if (!settled) return;
      if (knownFailure) {
        const failedReplyId = failedReplyIdForTurn(
          settled,
          failedRun?.owner.kind === "web_turn" ? failedRun.owner.id : null,
        );
        if (failedReplyId) write(id, { outputId: failedReplyId });
      }
      await syncSessions();
    } catch (reason) {
      if (!current()) return;
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
      if (terminal && current()) write(id, { phase: knownFailure ? "failed" : "idle" });
    }
  };
  return {
    loadOlderMessages: async () => {
      const id = get().currentConversationId;
      const view = id ? get().conversationById[id] : null;
      if (
        !id ||
        !view ||
        chatBusy(view) ||
        view.loadingOlderMessages ||
        !view.hasOlderMessages ||
        view.loadedFromSequence === null
      )
        return;
      const client = get().apiClient;
      const revision = view.loadRevision;
      const current = () =>
        get().apiClient === client &&
        get().conversationById[id]?.sessionId === view.sessionId &&
        get().conversationById[id]?.loadRevision === revision;
      write(id, { loadingOlderMessages: true, error: null });
      try {
        const page = await client.listMessages(view.sessionId, {
          before_sequence_no: view.loadedFromSequence,
        });
        if (!current()) return;
        write(id, (chat) => ({
          messages: [
            ...new Map(
              [...page.items.map(transcriptItem), ...chat.messages].map((item) => [item.id, item]),
            ).values(),
          ].sort((a, b) => (a.sequenceNo ?? Infinity) - (b.sequenceNo ?? Infinity)),
          loadedFromSequence: page.items[0]?.sequence_no ?? chat.loadedFromSequence,
          hasOlderMessages: page.has_more,
        }));
      } catch (reason) {
        if (current()) write(id, { error: errorText(reason) });
      } finally {
        if (current()) write(id, { loadingOlderMessages: false });
      }
    },
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
      const api = get().apiClient;
      const mappedId = get().sessionConversationIds[id];
      const target = get().summaryById[mappedId];
      const matches = () =>
        get().apiClient === api &&
        get().sessionConversationIds[id] === mappedId &&
        get().summaryById[mappedId]?.sourceId === target?.sourceId &&
        get().summaryById[mappedId]?.agentId === target?.agentId &&
        get().summaryById[mappedId]?.bindingEpoch === target?.bindingEpoch;
      try {
        const updated = await api.renameSession(id, parsed.data.title);
        if (!matches()) return false;
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
        if (matches()) set({ error: errorText(reason) });
        return false;
      }
    },
    deleteSessionById: async (sessionId) => {
      if (sessionBusy(get(), sessionId)) {
        set({ error: msg("生成完成后再刷新或删除会话。") });
        return false;
      }
      const api = get().apiClient;
      const id = get().sessionConversationIds[sessionId];
      const target = get().summaryById[id];
      const matches = () =>
        get().apiClient === api &&
        get().sessionConversationIds[sessionId] === id &&
        get().summaryById[id]?.sourceId === target?.sourceId &&
        get().summaryById[id]?.agentId === target?.agentId &&
        get().summaryById[id]?.bindingEpoch === target?.bindingEpoch;
      try {
        await api.deleteSession(sessionId);
        if (!matches()) return false;
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
        if (wasCurrent && get().apiClient === api) {
          const next = get().directoryIds[0];
          persistBrowserState(get().browserStateStorage, "superstring-session", null);
          persistBrowserState(get().browserStateStorage, "superstring-conversation", next ?? null);
          if (next) await get().selectConversation(next);
        }
        return true;
      } catch (reason) {
        if (matches()) set({ error: errorText(reason) });
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
