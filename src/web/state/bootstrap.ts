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
        const [agentsResult, sessionsResult, catalogResult, storageResult] =
          await Promise.allSettled([
            get().apiClient.listAgents(),
            get().apiClient.listSessions(),
            get().apiClient.listModels(),
            loadBrowserStateStorage(() => get().apiClient.getBrowserStateConfig()),
          ]);
        const agents = agentsResult.status === "fulfilled" ? agentsResult.value : [];
        const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
        const catalog = catalogResult.status === "fulfilled" ? catalogResult.value : null;
        const browserStateStorage =
          storageResult.status === "fulfilled" ? storageResult.value : null;
        const savedAgent = await browserStateStorage?.read("superstring-agent").catch(() => null);
        const availableAgent = agents.find((item) => item.is_active && item.id === savedAgent);
        const selectedAgent = availableAgent ?? agents.find((item) => item.is_active) ?? null;
        const savedSession = await browserStateStorage
          ?.read("superstring-session")
          .catch(() => null);
        const selectedSession =
          sessions.find((item) => item.id === savedSession) ?? sessions[0] ?? null;
        const reported = [...new Set(catalog?.models ?? [])];
        const failures = [agentsResult, sessionsResult, catalogResult, storageResult]
          .filter((result): result is PromiseRejectedResult => result.status === "rejected")
          .map((result) => errorText(result.reason));
        set({
          status: "ready",
          agents,
          sessions,
          modelNames: reported,
          modelStatus:
            catalogResult.status === "rejected"
              ? translate(
                  "模型列表加载失败：{0}；仍可保留或手动输入模型 ID。",
                  errorText(catalogResult.reason),
                )
              : reported.length
                ? translate("LM Studio 当前报告 {0} 个已加载模型。", reported.length)
                : translate("LM Studio 当前没有报告已加载模型；仍可保留或手动输入模型 ID。"),
          selectedNewSessionAgentId: selectedAgent?.id ?? null,
          currentSessionId: selectedSession?.id ?? null,
          browserStateStorage,
          error: failures.length ? failures.join("；") : null,
        });
        if (selectedSession) await get().selectSession(selectedSession.id);
      } finally {
        endProcessing(get, set);
      }
    },
  };
}
