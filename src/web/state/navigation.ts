import { toDraft } from "../features/agents/draft";
import { msg } from "../i18n";
import { errorText } from "./helpers";
import type { PendingNavigation, StoreGet, StoreSet, SuperstringState } from "./types";

async function performNavigation(
  get: () => SuperstringState,
  set: (patch: Partial<SuperstringState>) => void,
  pending: PendingNavigation,
  discard: boolean,
): Promise<void> {
  set({
    pendingNavigation: null,
    navigationConfirmOpen: false,
    navigationConfirmMessage: "",
    dirty: false,
    error: null,
  });
  if (pending.kind === "page") {
    const patch: Partial<SuperstringState> = {
      page: pending.page,
      settingsView: pending.settingsView,
      feedback: "",
    };
    // 放弃修改并离开 agents 页时清除草稿，使再次进入按默认规则读取而非显示已放弃改动；
    // 普通导航（保存后或取消）保留草稿。
    if (discard) {
      patch.editorDraft = null;
      patch.dirty = false;
      patch.editorAgentId = "__new__";
    }
    set(patch);
    return;
  }
  if (pending.kind === "agent") {
    const previous = {
      editorAgentId: get().editorAgentId,
      editorDraft: get().editorDraft,
      persona: get().persona,
      policy: get().policy,
      memorySessions: get().memorySessions,
      memoryTurns: get().memoryTurns,
      memoryEntries: get().memoryEntries,
      memoryEntryTotal: get().memoryEntryTotal,
      memoryEntryDetail: get().memoryEntryDetail,
      memoryJobs: get().memoryJobs,
      activeSection: get().activeSection,
    };
    const changed = await get().editAgent(pending.id);
    if (!changed) {
      // 读取失败：保留原草稿/位置，并恢复 pendingNavigation 以便可重试或取消，否则弹窗无法重试。
      set({
        ...previous,
        pendingNavigation: pending,
        navigationConfirmOpen: true,
        dirty: discard,
        navigationConfirmMessage: msg(
          "读取目标 Agent 失败：{0}；未放弃修改，可重试或取消。",
          get().error ?? msg("未知错误"),
        ),
      });
    }
    return;
  }
  if (discard && get().editorAgentId !== "__new__") {
    try {
      const [agent, persona] = await Promise.all([
        get().apiClient.getAgent(get().editorAgentId),
        get().apiClient.getPersona(get().editorAgentId),
      ]);
      set({ editorDraft: toDraft(agent), persona });
    } catch (error) {
      // 放弃时重读目标 Agent 失败：恢复 pendingNavigation 以便可重试或取消。
      set({
        pendingNavigation: pending,
        dirty: true,
        navigationConfirmOpen: true,
        navigationConfirmMessage: msg(
          "读取 Agent 失败：{0}；未放弃修改，可重试或取消。",
          errorText(error),
        ),
      });
      return;
    }
  }
  set({ activeSection: pending.section, feedback: "", dirty: false });
}
export function createNavigationActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  SuperstringState,
  | "openChat"
  | "openSettings"
  | "openAgentSettings"
  | "closeAgentSettings"
  | "requestPageNavigation"
  | "requestAgentNavigation"
  | "requestSectionNavigation"
  | "confirmSaveAndContinue"
  | "confirmDiscardAndContinue"
  | "cancelPendingNavigation"
> {
  return {
    openChat: () => get().requestPageNavigation("chat", "hub"),
    openSettings: () => get().requestPageNavigation("settings", "hub"),
    openAgentSettings: () => {
      get().requestPageNavigation("settings", "agents");
      const state = get();
      // 仅在真正进入 agents 页（未被 dirty 确认拦截）且尚无草稿时，按默认规则载入。
      if (
        state.page === "settings" &&
        state.settingsView === "agents" &&
        state.editorDraft === null
      ) {
        const target =
          (state.selectedNewSessionAgentId &&
            state.agents.find((item) => item.id === state.selectedNewSessionAgentId)?.id) ||
          state.agents[0]?.id ||
          "__new__";
        void get().editAgent(target);
      }
    },
    closeAgentSettings: () => get().requestPageNavigation("settings", "hub"),
    requestPageNavigation: (page, settingsView = "hub") => {
      if (get().page === page && get().settingsView === settingsView) return;
      if (get().dirty && get().page === "settings" && get().settingsView === "agents") {
        set({
          pendingNavigation: { kind: "page", page, settingsView },
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("当前 Agent 有未保存修改，是否先保存再离开？"),
        });
        return;
      }
      set({ page, settingsView, feedback: "" });
    },
    requestAgentNavigation: (id) => {
      // 同 ID 仅当已有草稿时才直接返回；__new__ 且草稿为 null 需要（重新）初始化。
      if (id === get().editorAgentId && get().editorDraft !== null) return;
      if (get().dirty) {
        set({
          pendingNavigation: { kind: "agent", id },
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("当前 Agent 有未保存修改，是否先保存再切换？"),
        });
        return;
      }
      void get().editAgent(id);
    },
    requestSectionNavigation: (section) => {
      if (section === get().activeSection) return;
      // 新建草稿尚未创建基础记录时，除 A 外的分区不可用（UI 会禁用）。
      if (get().editorAgentId === "__new__" && get().editorDraft !== null && section !== "A") {
        set({ feedback: msg("请先创建 Agent 基础记录，再切换到其它分区。") });
        return;
      }
      if (get().dirty) {
        set({
          pendingNavigation: { kind: "section", section },
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("当前分区有未保存修改，是否先保存再切换？"),
        });
        return;
      }
      set({ activeSection: section, feedback: "" });
    },
    confirmSaveAndContinue: async () => {
      const pending = get().pendingNavigation;
      if (!pending) return;
      const saved =
        get().activeSection === "D"
          ? await get().savePersona({
              ...(get().persona ?? {}),
              persona_intensity: get().editorDraft?.persona_intensity ?? 60,
            })
          : await get().saveCurrentSection();
      if (!saved) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: get().error
            ? msg("保存失败：{0}", get().error)
            : msg("保存失败，请修正后重试或取消。"),
          dirty: true,
        });
        return;
      }
      await performNavigation(get, set, pending, false);
    },
    confirmDiscardAndContinue: async () => {
      const pending = get().pendingNavigation;
      if (!pending) return;
      await performNavigation(get, set, pending, true);
    },
    cancelPendingNavigation: () =>
      set({
        pendingNavigation: null,
        navigationConfirmOpen: false,
        navigationConfirmMessage: "",
      }),
  };
}
