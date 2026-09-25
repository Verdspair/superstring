import { loadBrowserStateStorage } from "../browser-state";
import { translate } from "../i18n";
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
        const [agentsResult, sessionsResult, catalogResult, providersResult, storageResult] =
          await Promise.allSettled([
            get().apiClient.listAgents(),
            get().apiClient.listConversations(),
            get().apiClient.listModels(),
            // 外部模型 API（0032）：登记过的外部模型名与本地模型并列进入选择器。取不到就当没有。
            get().apiClient.listModelProviders(),
            loadBrowserStateStorage(() => get().apiClient.getBrowserStateConfig()),
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
        // 本地模型目录连不上不等于"没有模型可用"（用户 2026-09-25）：只要还登记着外部模型，它就是
        // 一条提示（`modelStatus`），不是错误。一个模型来源都拿不到时才按错误报出来。
        const catalogFailure =
          catalogResult.status === "rejected" ? errorText(catalogResult.reason) : null;
        const failures = [agentsResult, sessionsResult, providersResult, storageResult]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => errorText(result.reason));
        if (catalogFailure !== null && external.length === 0) failures.push(catalogFailure);
        if (restorationError) failures.push(restorationError);
        set({
          status: "ready",
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
          error: failures.length ? failures.join("；") : null,
        });
        if (selected) await get().selectConversation(selected.id);
      } finally {
        endProcessing(get, set);
      }
    },
  };
}
