import { createBrowserStateStorage } from "../browser-state";
import { translate } from "../i18n";
import {
  loadDirectoryCache,
  loadWebChatCache,
  removeDirectoryCache,
  saveDirectoryCache,
} from "../services/page-snapshot-cache";
import { errorText } from "./helpers";
import type { StoreGet, StoreSet, SuperstringState } from "./types";

export function createBootstrapActions(
  set: StoreSet,
  get: StoreGet,
): Pick<SuperstringState, "bootstrap"> {
  let revision = 0;
  return {
    bootstrap: async () => {
      const currentRevision = ++revision;
      const api = get().apiClient;
      const isCurrent = () => revision === currentRevision && get().apiClient === api;
      const initialSelectionRevision = get().selectionRevision;
      const initialDirectoryRevision = get().directoryRevision;
      const ownsSelection = () =>
        isCurrent() && get().selectionRevision === initialSelectionRevision;
      set({ status: "loading", error: null });
      try {
        const storageConfigPromise = api.getBrowserStateConfig().catch(() => null);
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
        const conversationsPromise = api
          .listConversations()
          .then(
            (page) => {
              if (isCurrent() && get().directoryRevision === initialDirectoryRevision) {
                set((state) => ({
                  status: "ready",
                  summaryById: {
                    ...state.summaryById,
                    ...Object.fromEntries(page.items.map((item) => [item.id, item])),
                  },
                  directoryIds: page.items.map((item) => item.id),
                  directoryCursor: page.nextCursor,
                  sessionConversationIds: {
                    ...state.sessionConversationIds,
                    ...Object.fromEntries(
                      page.items
                        .filter((item) => item.channel === "web")
                        .map((item) => [item.sourceId, item.id]),
                    ),
                  },
                }));
              }
              return page;
            },
            (reason) => {
              if (isCurrent()) set({ status: "ready", directoryError: errorText(reason) });
              throw reason;
            },
          )
          .finally(() => {
            directorySettled = true;
          });

        // F5 刷新前台预显水合：早于慢速网络请求完成前，恢复已存目录摘要与当前会话选中态，
        // 挂载消息/事件视图并显示缓存正文（非草稿/在途动作），不等所有 modelproviders 慢 PromiseAll
        void Promise.all([sessionStateStoragePromise, browserStateStoragePromise]).then(
          async ([sessionStorageInstance, browserStorageInstance]) => {
            if (!isCurrent() || !sessionStorageInstance || directorySettled) return;
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
              if (!isCurrent() || directorySettled) return;
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
                if (
                  isCurrent() &&
                  cachedChat &&
                  cachedChat.messages.length > 0 &&
                  !directorySettled
                ) {
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

        // Model discovery is optional: a slow service must not block the directory or startup prewarm.
        const modelResults = Promise.allSettled([api.listModels(), api.listModelProviders()]);
        void modelResults.then(([catalogResult, providersResult]) => {
          if (!isCurrent()) return;
          const catalog = catalogResult.status === "fulfilled" ? catalogResult.value : null;
          const providers = providersResult.status === "fulfilled" ? providersResult.value : [];
          const local = [...new Set(catalog?.models ?? [])];
          const external = [
            ...new Set(providers.flatMap((provider) => provider.models.map((model) => model.name))),
          ];
          const reported = [...new Set([...local, ...external])];
          const catalogFailure =
            catalogResult.status === "rejected" ? errorText(catalogResult.reason) : null;
          const modelFailures =
            providersResult.status === "rejected" ? [errorText(providersResult.reason)] : [];
          if (catalogFailure !== null && external.length === 0) modelFailures.push(catalogFailure);
          set((state) => ({
            error: modelFailures.length
              ? [state.error, ...modelFailures].filter(Boolean).join("；")
              : state.error,
            modelNames: reported,
            modelProviders: providers,
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
          }));
        });
        void api
          .listAgents()
          .then(async (agents) => {
            if (!isCurrent()) return;
            set({ agents });
            const storage = await browserStateStoragePromise;
            const savedAgent = await storage?.read("superstring-agent").catch(() => null);
            if (!isCurrent() || get().selectedNewSessionAgentId !== null) return;
            const selectedAgent =
              agents.find((agent) => agent.is_active && agent.id === savedAgent) ??
              agents.find((agent) => agent.is_active);
            set({ selectedNewSessionAgentId: selectedAgent?.id ?? null });
          })
          .catch((reason) => {
            if (isCurrent())
              set((state) => ({
                error: [state.error, errorText(reason)].filter(Boolean).join("；"),
              }));
          });
        const [sessionsResult, storageResult, sessionStorageResult] = await Promise.allSettled([
          conversationsPromise,
          browserStateStoragePromise,
          sessionStateStoragePromise,
        ]);
        if (!isCurrent()) return;
        let conversations = sessionsResult.status === "fulfilled" ? sessionsResult.value.items : [];
        let directoryCursor =
          sessionsResult.status === "fulfilled" ? sessionsResult.value.nextCursor : null;
        const browserStateStorage =
          storageResult.status === "fulfilled" ? storageResult.value : null;
        const [savedSession, savedConversation] = await Promise.all([
          browserStateStorage?.read("superstring-session").catch(() => null),
          browserStateStorage?.read("superstring-conversation").catch(() => null),
        ]);
        let restorationError: string | null = null;
        // The former session list was unpaged. Preserve the saved choice even when it is on a
        // later canonical page; only fetch onward while a persisted selection is still missing.
        const hasSavedSelection = () =>
          savedConversation
            ? conversations.some((item) => item.id === savedConversation)
            : conversations.some(
                (item) => item.channel === "web" && item.sourceId === savedSession,
              );
        while (
          ownsSelection() &&
          (savedConversation || savedSession) &&
          !hasSavedSelection() &&
          directoryCursor
        ) {
          try {
            const page = await api.listConversations({ cursor: directoryCursor });
            if (!isCurrent()) return;
            conversations = [
              ...new Map([...conversations, ...page.items].map((item) => [item.id, item])).values(),
            ];
            directoryCursor = page.nextCursor;
          } catch (reason) {
            restorationError = errorText(reason);
            break;
          }
        }
        if (!isCurrent()) return;
        const selected = restorationError
          ? null
          : (conversations.find((item) => item.id === savedConversation) ??
            conversations.find(
              (item) => item.channel === "web" && item.sourceId === savedSession,
            ) ??
            conversations[0] ??
            null);
        const failures = [sessionsResult, storageResult]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => errorText(result.reason));
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
          currentConversationId: ownsSelection()
            ? (selected?.id ?? null)
            : get().currentConversationId,
          ...(get().directoryRevision === initialDirectoryRevision
            ? {
                summaryById: Object.fromEntries(conversations.map((item) => [item.id, item])),
                directoryIds: conversations.map((item) => item.id),
                directoryCursor,
                directoryError: restorationError,
                sessionConversationIds: Object.fromEntries(
                  conversations
                    .filter((item) => item.channel === "web")
                    .map((item) => [item.sourceId, item.id]),
                ),
              }
            : {}),
          browserStateStorage,
          sessionStateStorage,
          error: [get().error, ...failures].filter(Boolean).join("；") || null,
        });
        if (selected && ownsSelection()) await get().selectConversation(selected.id);
      } catch (reason) {
        if (isCurrent()) set({ status: "ready", error: errorText(reason) });
      }
    },
  };
}
