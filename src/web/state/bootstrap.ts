import { createBrowserStateStorage } from "../browser-state";
import { translate } from "../i18n";
import {
  loadDirectoryCache,
  loadWebChatCache,
  removeDirectoryCache,
  saveDirectoryCache,
} from "../services/page-snapshot-cache";
import { beginProcessing, endProcessing, errorText } from "./helpers";
import type { StoreGet, StoreSet, SuperstringState } from "./types";

export function createBootstrapActions(
  set: StoreSet,
  get: StoreGet,
): Pick<SuperstringState, "bootstrap"> {
  return {
    bootstrap: async () => {
      set({ status: "loading", error: null });
      beginProcessing(get, set);
      try {
        const storageConfigPromise = get()
          .apiClient.getBrowserStateConfig()
          .catch(() => null);
        const sessionStateStoragePromise = storageConfigPromise.then((cfg) => {
          try {
            return cfg && typeof sessionStorage !== "undefined"
              ? createBrowserStateStorage(cfg, sessionStorage)
              : null;
          } catch {
            return null;
          }
        });
        const browserStateStoragePromise = storageConfigPromise.then((cfg) => {
          try {
            return cfg ? createBrowserStateStorage(cfg) : null;
          } catch {
            return null;
          }
        });

        // 权威目录独立结算守卫：一旦会话目录响应落地（不论空目录、全量还是失败），
        // 立即标记 directorySettled，杜绝慢速 modelProviders 期间迟到解密复活已删目录
        let directorySettled = false;
        const conversationsPromise = get()
          .apiClient.listConversations()
          .finally(() => {
            directorySettled = true;
          });

        // F5 刷新前台预显水合：早于慢速网络请求完成前，恢复已存目录摘要与当前会话选中态，
        // 挂载消息/事件视图并显示缓存正文（非草稿/在途动作），不等所有 modelproviders 慢 PromiseAll
        void Promise.all([sessionStateStoragePromise, browserStateStoragePromise]).then(
          async ([sessionStorageInstance, browserStorageInstance]) => {
            if (!sessionStorageInstance || directorySettled) return;
            const cachedDir = await loadDirectoryCache(sessionStorageInstance);
            if (
              !directorySettled &&
              cachedDir &&
              cachedDir.items.length > 0 &&
              get().directoryIds.length === 0
            ) {
              const savedConversation = await browserStorageInstance
                ?.read("superstring-conversation")
                .catch(() => null);
              const savedSession = await browserStorageInstance
                ?.read("superstring-session")
                .catch(() => null);
              if (directorySettled) return;
              const previewItem =
                (savedConversation
                  ? cachedDir.items.find((i) => i.id === savedConversation)
                  : null) ??
                (savedSession
                  ? cachedDir.items.find((i) => i.channel === "web" && i.sourceId === savedSession)
                  : null) ??
                cachedDir.items[0] ??
                null;
              const previewId = previewItem?.id ?? null;

              set((state) => ({
                summaryById: {
                  ...state.summaryById,
                  ...Object.fromEntries(cachedDir.items.map((item) => [item.id, item])),
                },
                directoryIds: cachedDir.items.map((item) => item.id),
                sessionConversationIds: {
                  ...state.sessionConversationIds,
                  ...Object.fromEntries(
                    cachedDir.items
                      .filter((item) => item.channel === "web")
                      .map((item) => [item.sourceId, item.id]),
                  ),
                },
                currentConversationId: state.currentConversationId ?? previewId,
                browserStateStorage: state.browserStateStorage ?? browserStorageInstance,
                sessionStateStorage: state.sessionStateStorage ?? sessionStorageInstance,
              }));

              // 若已选为 Web 会话且暂无消息，提前水合已完成历史消息
              if (previewItem && previewItem.channel === "web") {
                const cachedChat = await loadWebChatCache(
                  sessionStorageInstance,
                  previewItem.sourceId,
                  previewItem.agentId,
                );
                if (cachedChat && cachedChat.messages.length > 0 && !directorySettled) {
                  set((state) => {
                    const currentView = state.conversationById[previewItem.id];
                    if (currentView && currentView.messages.length > 0) return {};
                    return {
                      conversationById: {
                        ...state.conversationById,
                        [previewItem.id]: {
                          sessionId: previewItem.sourceId,
                          messages: cachedChat.messages,
                          phase: "idle",
                          composer: "",
                          request: null,
                          failedChat: null,
                          knowledgeResend: null,
                          loadRevision: 0,
                          runtimeConfig: null,
                          runtimeConfigUnavailable: false,
                          contextUsage: null,
                          runId: null,
                          outputId: null,
                          error: null,
                          feedback: "",
                        },
                      },
                    };
                  });
                }
              }
            }
          },
        );

        const [
          agentsResult,
          sessionsResult,
          catalogResult,
          providersResult,
          storageResult,
          sessionStorageResult,
        ] = await Promise.allSettled([
          get().apiClient.listAgents(),
          conversationsPromise,
          get().apiClient.listModels(),
          // 外部模型 API（0032）：登记过的外部模型名与本地模型并列进入选择器。取不到就当没有。
          get().apiClient.listModelProviders(),
          browserStateStoragePromise,
          sessionStateStoragePromise,
        ]);
        const agents = agentsResult.status === "fulfilled" ? agentsResult.value : [];
        let conversations = sessionsResult.status === "fulfilled" ? sessionsResult.value.items : [];
        let directoryCursor =
          sessionsResult.status === "fulfilled" ? sessionsResult.value.nextCursor : null;
        const catalog = catalogResult.status === "fulfilled" ? catalogResult.value : null;
        const browserStateStorage =
          storageResult.status === "fulfilled" ? storageResult.value : null;
        const savedAgent = await browserStateStorage?.read("superstring-agent").catch(() => null);
        const availableAgent = agents.find((item) => item.is_active && item.id === savedAgent);
        const selectedAgent = availableAgent ?? agents.find((item) => item.is_active) ?? null;
        const savedSession = await browserStateStorage
          ?.read("superstring-session")
          .catch(() => null);
        const savedConversation = await browserStateStorage
          ?.read("superstring-conversation")
          .catch(() => null);
        let restorationError: string | null = null;
        // The former session list was unpaged. Preserve the saved choice even when it is on a
        // later canonical page; only fetch onward while a persisted selection is still missing.
        const hasSavedSelection = () =>
          savedConversation
            ? conversations.some((item) => item.id === savedConversation)
            : conversations.some(
                (item) => item.channel === "web" && item.sourceId === savedSession,
              );
        while ((savedConversation || savedSession) && !hasSavedSelection() && directoryCursor) {
          try {
            const page = await get().apiClient.listConversations({ cursor: directoryCursor });
            conversations = [
              ...new Map([...conversations, ...page.items].map((item) => [item.id, item])).values(),
            ];
            directoryCursor = page.nextCursor;
          } catch (reason) {
            restorationError = errorText(reason);
            break;
          }
        }
        const selected = restorationError
          ? null
          : (conversations.find((item) => item.id === savedConversation) ??
            conversations.find(
              (item) => item.channel === "web" && item.sourceId === savedSession,
            ) ??
            conversations[0] ??
            null);
        const providers = providersResult.status === "fulfilled" ? providersResult.value : [];
        const local = [...new Set(catalog?.models ?? [])];
        const external = [
          ...new Set(providers.flatMap((provider) => provider.models.map((model) => model.name))),
        ];
        const reported = [...new Set([...local, ...external])];
        // 本地模型目录连不上不等于"没有模型可用"：只要还登记着外部模型，它就是
        // 一条提示（`modelStatus`），不是错误。一个模型来源都拿不到时才按错误报出来。
        const catalogFailure =
          catalogResult.status === "rejected" ? errorText(catalogResult.reason) : null;
        const failures = [agentsResult, sessionsResult, providersResult, storageResult]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => errorText(result.reason));
        if (catalogFailure !== null && external.length === 0) failures.push(catalogFailure);
        if (restorationError) failures.push(restorationError);
        const sessionStateStorage =
          sessionStorageResult.status === "fulfilled" ? sessionStorageResult.value : null;

        // 权威目录成功后异步保存快照缓存（非阻塞），失败或空目录时精准 purge 杜绝复活
        if (sessionsResult.status === "fulfilled") {
          if (conversations.length > 0) {
            void saveDirectoryCache(
              sessionStateStorage,
              conversations,
              get().directoryRevision + 1,
            );
          } else {
            void removeDirectoryCache(sessionStateStorage);
          }
        } else if (sessionsResult.status === "rejected") {
          void removeDirectoryCache(sessionStateStorage);
        }

        set({
          status: "ready",
          currentConversationId: selected?.id ?? null,
          agents,
          summaryById: Object.fromEntries(conversations.map((item) => [item.id, item])),
          directoryIds: conversations.map((item) => item.id),
          directoryCursor,
          directoryError: restorationError,
          sessionConversationIds: Object.fromEntries(
            conversations
              .filter((item) => item.channel === "web")
              .map((item) => [item.sourceId, item.id]),
          ),
          modelNames: reported,
          loadedModelNames: local,
          externalModelNames: external,
          modelStatus:
            catalogFailure !== null
              ? external.length
                ? translate("本地模型服务连不上：{0}；已登记的外部模型仍可选择。", catalogFailure)
                : translate("模型列表加载失败：{0}；仍可保留或手动输入模型 ID。", catalogFailure)
              : reported.length
                ? translate("LM Studio 当前报告 {0} 个已加载模型。", reported.length)
                : translate("LM Studio 当前没有报告已加载模型；仍可保留或手动输入模型 ID。"),
          selectedNewSessionAgentId: selectedAgent?.id ?? null,
          browserStateStorage,
          sessionStateStorage,
          error: failures.length ? failures.join("；") : null,
        });
        if (selected) await get().selectConversation(selected.id);
      } finally {
        endProcessing(get, set);
      }
    },
  };
}
