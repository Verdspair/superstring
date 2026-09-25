import { toDraft } from "../features/agents/draft";
import { dirtyPages } from "../features/agents/page-drafts";
import {
  knowledgeModelDirty,
  knowledgeReadDirty,
  organizationDirty,
} from "../features/knowledge/types";
import { msg } from "../i18n";
import { errorText } from "./helpers";
import type { PendingNavigation, StoreGet, StoreSet, SuperstringState } from "./types";

async function performNavigation(
  get: () => SuperstringState,
  set: (patch: Partial<SuperstringState>) => void,
  pending: PendingNavigation,
  discard: boolean,
): Promise<void> {
  if (pending.kind === "knowledge") {
    const previous = {
      knowledgeEditor: get().knowledgeEditor,
      knowledgeDirty: get().knowledgeDirty,
    };
    set({ knowledgeDirty: false });
    if (await get().openKnowledgeEditor(pending.target)) {
      set({
        pendingNavigation: null,
        navigationConfirmOpen: false,
        navigationConfirmMessage: "",
      });
    } else {
      set({ ...previous, navigationConfirmOpen: true });
    }
    return;
  }
  const dirtyBefore = get().dirty;
  const correctionBefore = {
    memoryContent: get().memoryContent,
    memoryCorrectionDraft: get().memoryCorrectionDraft,
    memoryCorrectionDirty: get().memoryCorrectionDirty,
  };
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
      ...(pending.settingsRoute ? { settingsRoute: pending.settingsRoute } : {}),
      feedback: "",
    };
    // 放弃修改并离开 agents 页时清除草稿，使再次进入按默认规则读取而非显示已放弃改动；
    // 普通导航（保存后或取消）保留草稿。
    if (
      discard &&
      (pending.page !== "settings" ||
        (dirtyBefore && (get().settingsView === "agents" || get().editorAgentId === "__new__")))
    ) {
      get().discardOrganization();
      get().discardKnowledgeModel();
      get().discardKnowledgeRead();
      patch.pageEditor = null;
      patch.editorDraft = null;
      patch.dirty = false;
      patch.editorAgentId = "__new__";
    }
    get().discardMemoryCorrection();
    if (pending.page !== "settings") get().discardKnowledgeEditor();
    set(patch);
    return;
  }
  if (pending.kind === "agent") {
    const previous = {
      editorAgentId: get().editorAgentId,
      pageEditor: get().pageEditor,
      knowledgeReadEditor: get().knowledgeReadEditor,
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
        ...correctionBefore,
        pendingNavigation: pending,
        navigationConfirmOpen: true,
        dirty: dirtyBefore,
        navigationConfirmMessage: msg(
          "读取目标 Agent 失败：{0}；未放弃修改，可重试或取消。",
          get().error ?? msg("未知错误"),
        ),
      });
    }
    return;
  }
  if (discard && dirtyBefore && get().editorAgentId !== "__new__") {
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
  get().discardMemoryCorrection();
  if (discard) get().discardKnowledgeRead();
  set({ activeSection: pending.section, feedback: "", dirty: false });
}
export function createNavigationActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  SuperstringState,
  | "openSettingsRoute"
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
    openSettingsRoute: (settingsRoute) => {
      if (settingsRoute === "knowledge-model" || settingsRoute === "management")
        settingsRoute = "models";
      if (
        get().settingsSaving ||
        get().editorLoading ||
        get().knowledgeReadLoading ||
        get().organizationLoading ||
        get().knowledgeModelLoading ||
        get().memoryCorrectionSaving ||
        get().qqMemoryBatchSaving ||
        get().knowledgeBusy
      )
        return;
      if (settingsRoute === "basic") {
        get().openAgentSettings();
        return;
      }
      if (
        settingsRoute === "models" &&
        get().page === "settings" &&
        get().settingsView === "agents" &&
        get().editorAgentId === "__new__" &&
        get().editorDraft &&
        !get().memoryCorrectionDirty &&
        Object.keys(get().qqMemoryBatchDrafts).length === 0
      ) {
        set({ settingsView: "workspace", settingsRoute, feedback: "" });
        return;
      }
      if (
        settingsRoute !== "models" &&
        get().settingsView === "workspace" &&
        get().editorAgentId === "__new__" &&
        get().dirty
      ) {
        set({
          pendingNavigation: {
            kind: "page",
            page: "settings",
            settingsView: "workspace",
            settingsRoute,
          },
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("当前 Agent 有未保存修改，是否先保存再离开？"),
        });
        return;
      }
      get().requestPageNavigation("settings", "workspace");
      const pending = get().pendingNavigation;
      if (pending?.kind === "page" && pending.settingsView === "workspace") {
        set({ pendingNavigation: { ...pending, settingsRoute } });
      } else if (get().page === "settings" && get().settingsView === "workspace") {
        set({ settingsRoute, feedback: "" });
      }
    },
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
      if (page === "settings" && settingsView === "knowledge") {
        get().openSettingsRoute("knowledge-config");
        return;
      }
      if (
        get().settingsSaving ||
        get().editorLoading ||
        get().knowledgeReadLoading ||
        get().organizationLoading ||
        get().knowledgeModelLoading ||
        get().memoryCorrectionSaving ||
        get().qqMemoryBatchSaving ||
        get().knowledgeBusy
      )
        return;
      if (get().memoryCorrectionDirty || Object.keys(get().qqMemoryBatchDrafts).length > 0) {
        set({
          pendingNavigation: { kind: "page", page, settingsView },
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("记忆设置或纠正有未保存修改，是否保存后再继续？"),
        });
        return;
      }
      if (get().page === page && get().settingsView === settingsView) return;
      if (get().dirty && get().editorAgentId === "__new__" && get().settingsView === "workspace") {
        if (page === "settings" && settingsView === "agents") {
          set({ page, settingsView, feedback: "" });
          return;
        }
        set({
          pendingNavigation: { kind: "page", page, settingsView },
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("当前 Agent 有未保存修改，是否先保存再离开？"),
        });
        return;
      }
      if (
        (dirtyPages(get().pageEditor).length ||
          organizationDirty(get().organizationEditor) ||
          knowledgeModelDirty(get().knowledgeModelEditor) ||
          knowledgeReadDirty(get().knowledgeReadEditor)) &&
        page !== "settings"
      ) {
        set({
          pendingNavigation: { kind: "page", page, settingsView },
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("设置中有未保存页面，是否全部保存再继续？"),
        });
        return;
      }
      if (get().knowledgeDirty && page !== "settings") {
        set({
          pendingNavigation: { kind: "page", page, settingsView },
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("知识库有未保存修改，是否先保存再继续？"),
        });
        return;
      }
      if (
        (get().dirty || get().memoryCorrectionDirty) &&
        get().page === "settings" &&
        get().settingsView === "agents"
      ) {
        set({
          pendingNavigation: { kind: "page", page, settingsView },
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("当前 Agent 有未保存修改，是否先保存再离开？"),
        });
        return;
      }
      if (page !== "settings") get().discardKnowledgeEditor();
      set({ page, settingsView, feedback: "" });
    },
    requestAgentNavigation: (id) => {
      if (
        get().settingsSaving ||
        get().editorLoading ||
        get().knowledgeReadLoading ||
        get().organizationLoading ||
        get().knowledgeModelLoading ||
        get().memoryCorrectionSaving ||
        get().qqMemoryBatchSaving ||
        get().knowledgeBusy
      )
        return;
      // 同 ID 仅当已有草稿时才直接返回；__new__ 且草稿为 null 需要（重新）初始化。
      if (id === get().editorAgentId && get().editorDraft !== null) return;
      if (
        get().dirty ||
        get().memoryCorrectionDirty ||
        Object.keys(get().qqMemoryBatchDrafts).length > 0 ||
        dirtyPages(get().pageEditor).length ||
        knowledgeReadDirty(get().knowledgeReadEditor)
      ) {
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
      if (
        get().settingsSaving ||
        get().editorLoading ||
        get().knowledgeReadLoading ||
        get().organizationLoading ||
        get().knowledgeModelLoading ||
        get().memoryCorrectionSaving ||
        get().qqMemoryBatchSaving ||
        get().knowledgeBusy
      )
        return;
      if (section === get().activeSection) return;
      // 新建草稿尚未创建基础记录时，除 A 外的分区不可用（UI 会禁用）。
      if (get().editorAgentId === "__new__" && get().editorDraft !== null && section !== "A") {
        set({ feedback: msg("请先创建 Agent 基础记录，再切换到其它分区。") });
        return;
      }
      if (
        get().dirty ||
        get().memoryCorrectionDirty ||
        Object.keys(get().qqMemoryBatchDrafts).length > 0 ||
        dirtyPages(get().pageEditor).length ||
        knowledgeReadDirty(get().knowledgeReadEditor)
      ) {
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
      if (
        !pending ||
        get().settingsSaving ||
        get().editorLoading ||
        get().knowledgeBusy ||
        get().qqMemoryBatchSaving
      )
        return;
      if (!(await get().saveQqMemoryBatchDrafts())) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存失败：{0}", get().error ?? msg("未知错误")),
        });
        return;
      }
      const leavingWorkspace =
        pending.kind === "agent" ||
        pending.kind === "section" ||
        (pending.kind === "page" && pending.page !== "settings");
      if (
        leavingWorkspace &&
        dirtyPages(get().pageEditor).length &&
        !(await get().saveAllSettingsPages())
      ) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
        return;
      }
      if (
        leavingWorkspace &&
        knowledgeReadDirty(get().knowledgeReadEditor) &&
        !(await get().saveKnowledgeRead())
      ) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
        return;
      }
      if (
        leavingWorkspace &&
        pending.kind === "page" &&
        knowledgeModelDirty(get().knowledgeModelEditor) &&
        !(await get().saveKnowledgeModel())
      ) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
        return;
      }
      if (
        leavingWorkspace &&
        pending.kind === "page" &&
        organizationDirty(get().organizationEditor) &&
        !(await get().saveOrganization())
      ) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
        return;
      }
      if (
        pending.kind !== "agent" &&
        pending.kind !== "section" &&
        get().knowledgeDirty &&
        !(await get().saveKnowledgeEditor())
      ) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存失败：{0}", get().error ?? msg("未知错误")),
        });
        return;
      }
      if (get().memoryCorrectionDirty && !(await get().saveMemoryCorrection())) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存失败：{0}", get().error ?? msg("未知错误")),
        });
        return;
      }
      const saved = !get().dirty
        ? true
        : get().activeSection === "D"
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
      if (
        !pending ||
        get().settingsSaving ||
        get().editorLoading ||
        get().knowledgeBusy ||
        get().qqMemoryBatchSaving
      )
        return;
      await performNavigation(get, set, pending, true);
      if (!get().pendingNavigation) get().discardQqMemoryBatchDrafts();
    },
    cancelPendingNavigation: () =>
      set({
        pendingNavigation: null,
        navigationConfirmOpen: false,
        navigationConfirmMessage: "",
      }),
  };
}
