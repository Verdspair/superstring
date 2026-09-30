import { permissionSettingsDirty } from "../features/access/permission-state";
import { webAccessDraftDirty } from "../features/access/web-access-state";
import { toDraft } from "../features/agents/draft";
import { dirtyPages } from "../features/agents/page-drafts";
import {
  knowledgeModelDirty,
  knowledgeReadDirty,
  organizationDirty,
} from "../features/knowledge/types";
import { qqDraftChanges, settingsHaveDrafts } from "../features/qq/draft-state";
import { msg } from "../i18n";
import { errorText } from "./helpers";
import type { PendingNavigation, StoreGet, StoreSet, SuperstringState } from "./types";

function navigationBusy(get: () => SuperstringState) {
  const state = get();
  return (
    state.qqAccessSaving ||
    state.qqSchemeSaving ||
    state.qqStickerSaving ||
    // 存储管理（保留设置保存与清理预览/执行）同样持写：保存期间导航必须被拦住。
    state.qqStorageSaving ||
    state.settingsSaving ||
    state.permissionSaving ||
    state.webAccessSaving ||
    state.webAccessTesting ||
    state.editorLoading ||
    state.knowledgeReadLoading ||
    state.organizationLoading ||
    state.knowledgeModelLoading ||
    state.memoryCorrectionSaving ||
    state.qqMemoryBatchSaving ||
    state.knowledgeBusy
  );
}

async function performNavigation(
  get: () => SuperstringState,
  set: (patch: Partial<SuperstringState>) => void,
  pending: PendingNavigation,
  discard: boolean,
  markLanded: () => void,
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
      markLanded();
    } else {
      set({ ...previous, navigationConfirmOpen: true });
    }
    return;
  }
  if (pending.kind === "scheme") {
    // 先确认目标仍存在，避免丢弃当前方案后进入空页。
    if (!get().qqSchemes.some((row) => row.id === pending.id)) {
      set({
        pendingNavigation: pending,
        navigationConfirmOpen: true,
        error: msg("操作失败，请重试。"),
      });
      return;
    }
    if (discard) get().discardQqDrafts();
    // 同一方案只切任务视图，重建编辑器会丢失草稿。
    if (get().qqSchemeEditor?.source.id !== pending.id) get().selectQqScheme(pending.id);
    set({
      pendingNavigation: null,
      navigationConfirmOpen: false,
      navigationConfirmMessage: "",
      error: null,
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-scheme-config",
      qqSchemeView: pending.view ?? "settings",
      feedback: "",
    });
    markLanded();
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
      ...(pending.conversationView ? { conversationView: pending.conversationView } : {}),
      ...(pending.conversationScope ? { conversationScope: pending.conversationScope } : {}),
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
    if (discard && pending.page !== "settings") {
      get().discardPermissionSettings();
      get().discardWebAccessDraft();
    }
    if (discard) get().discardQqDrafts();
    set(patch);
    markLanded();
    if (pending.conversationId) await get().selectConversation(pending.conversationId);
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
    if (changed && discard) get().discardQqDrafts();
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
  if (discard) get().discardQqDrafts();
  set({ activeSection: pending.section, feedback: "", dirty: false });
  markLanded();
}
export function createNavigationActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  SuperstringState,
  | "requestConversationNavigation"
  | "requestConversationView"
  | "openSettingsRoute"
  | "openChat"
  | "openSettings"
  | "openAgentSettings"
  | "closeAgentSettings"
  | "requestPageNavigation"
  | "requestAgentNavigation"
  | "requestQqSchemeNavigation"
  | "confirmSaveAndContinue"
  | "confirmDiscardAndContinue"
  | "cancelPendingNavigation"
> {
  const guardQqDrafts = (pending: PendingNavigation) => {
    if (!qqDraftChanges(get()).length) return false;
    set({
      pendingNavigation: pending,
      navigationConfirmOpen: true,
      navigationConfirmMessage: msg("设置中有未保存页面，是否全部保存再继续？"),
    });
    return true;
  };
  // 导航落地序号：每次有效落地递增，晚到的会话选择完成不得覆盖更新的视图/位置。
  let navigationSequence = 0;
  const markLanded = () => {
    navigationSequence += 1;
  };
  return {
    requestConversationNavigation: async (id) => {
      if (navigationBusy(get)) return;
      if (
        (get().currentConversationId !== id ||
          get().conversationView !== "messages" ||
          get().conversationScope !== "current") &&
        guardQqDrafts({
          kind: "page",
          page: "chat",
          settingsView: "hub",
          conversationId: id,
          conversationView: "messages",
          conversationScope: "current",
        })
      )
        return;
      get().requestPageNavigation("chat", "hub");
      const pending = get().pendingNavigation;
      if (pending?.kind === "page" && pending.page === "chat") {
        set({
          pendingNavigation: {
            ...pending,
            conversationId: id,
            conversationView: "messages",
            conversationScope: "current",
          },
        });
        return;
      }
      if (pending || get().page !== "chat") return;
      const api = get().apiClient;
      const sequence = navigationSequence;
      await get().selectConversation(id);
      if (navigationSequence !== sequence || get().apiClient !== api) return;
      if (get().currentConversationId === id) {
        set({ conversationView: "messages", conversationScope: "current" });
        markLanded();
      }
    },
    requestConversationView: (view, scope = "current") => {
      if (navigationBusy(get)) return;
      // 目标真正变化时统一走草稿聚合守卫：同页视图切换不得绕过 permission/pageEditor/knowledge 草稿。
      if (
        (get().conversationView !== view || get().conversationScope !== scope) &&
        settingsHaveDrafts(get())
      ) {
        set({
          pendingNavigation: {
            kind: "page",
            page: "chat",
            settingsView: "hub",
            conversationView: view,
            conversationScope: scope,
          },
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("设置中有未保存页面，是否全部保存再继续？"),
        });
        return;
      }
      get().requestPageNavigation("chat", "hub");
      const pending = get().pendingNavigation;
      if (pending?.kind === "page" && pending.page === "chat") {
        set({
          pendingNavigation: { ...pending, conversationView: view, conversationScope: scope },
        });
        return;
      }
      if (pending) return;
      if (get().page === "chat") {
        set({ conversationView: view, conversationScope: scope });
        markLanded();
      }
    },
    openSettingsRoute: (settingsRoute) => {
      if (settingsRoute === "execution-ledger" || settingsRoute === "task-ledger") {
        get().requestConversationView(
          settingsRoute === "execution-ledger" ? "activity" : "tasks",
          "global",
        );
        return;
      }
      if (settingsRoute === "knowledge-model" || settingsRoute === "management")
        settingsRoute = "models";
      if (navigationBusy(get)) return;
      if (
        !(
          get().page === "settings" &&
          get().settingsView === "workspace" &&
          get().settingsRoute === settingsRoute
        ) &&
        guardQqDrafts({ kind: "page", page: "settings", settingsView: "workspace", settingsRoute })
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
        markLanded();
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
        markLanded();
      }
    },
    openChat: () => get().requestConversationView("messages", "current"),
    openSettings: () => get().requestPageNavigation("settings", "hub"),
    openAgentSettings: () => {
      if (navigationBusy(get)) return;
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
      if (page === "settings" && settingsView === "observability") {
        get().requestConversationView("activity", "global");
        return;
      }
      // 旧的 QQ 连接别名归一到应用管理里的连接页，复用同一条 busy/三选守卫链。
      if (page === "settings" && settingsView === "operating-mode") {
        get().openSettingsRoute("qq-connection");
        return;
      }
      if (navigationBusy(get)) return;
      if (
        !(get().page === page && get().settingsView === settingsView) &&
        guardQqDrafts({ kind: "page", page, settingsView })
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
          markLanded();
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
        (permissionSettingsDirty(get().permissionEditor) ||
          webAccessDraftDirty(get().webAccessSnapshot, get().webAccessDraft) ||
          dirtyPages(get().pageEditor).length ||
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
      markLanded();
    },
    requestAgentNavigation: (id) => {
      if (navigationBusy(get)) return;
      // 保存会清空 pageEditor，但保留 editorDraft；既有助手须重建编辑器。
      if (
        id === get().editorAgentId &&
        (id === "__new__" ? get().editorDraft !== null : get().pageEditor !== null)
      )
        return;
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
    requestQqSchemeNavigation: (id, view = "settings") => {
      if (navigationBusy(get)) return;
      if (!get().qqSchemes.some((row) => row.id === id)) {
        // 目标不存在（含已删的脏方案）：显式报错，不改路由也不切视图，草稿原样保留。
        set({ error: msg("操作失败，请重试。") });
        return;
      }
      const sameDetail =
        get().qqSchemeEditor?.source.id === id &&
        get().page === "settings" &&
        get().settingsView === "workspace" &&
        get().settingsRoute === "qq-scheme-config";
      if (sameDetail) {
        if (get().qqSchemeView !== view) set({ qqSchemeView: view });
        return;
      }
      const pending: PendingNavigation =
        view === "settings" ? { kind: "scheme", id } : { kind: "scheme", id, view };
      if (qqDraftChanges(get()).length) {
        set({
          pendingNavigation: pending,
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("设置中有未保存页面，是否全部保存再继续？"),
        });
        return;
      }
      void performNavigation(get, set, pending, false, markLanded);
    },
    confirmSaveAndContinue: async () => {
      const pending = get().pendingNavigation;
      if (!pending || navigationBusy(get)) return;
      if (pending.kind === "scheme") {
        if (!(await get().saveQqDrafts())) {
          set({
            navigationConfirmOpen: true,
            navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
          });
          return;
        }
        await performNavigation(get, set, pending, false, markLanded);
        return;
      }
      if (!(await get().saveQqDrafts())) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
        return;
      }
      if (!(await get().saveQqMemoryBatchDrafts())) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存失败：{0}", get().error ?? msg("未知错误")),
        });
        return;
      }
      if (
        pending.kind === "page" &&
        pending.page !== "settings" &&
        !(await get().savePermissionSettings())
      ) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
        return;
      }
      if (
        pending.kind === "page" &&
        pending.page !== "settings" &&
        webAccessDraftDirty(get().webAccessSnapshot, get().webAccessDraft) &&
        !(await get().saveWebAccessDraft())
      ) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
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
      await performNavigation(get, set, pending, false, markLanded);
    },
    confirmDiscardAndContinue: async () => {
      const pending = get().pendingNavigation;
      if (!pending || navigationBusy(get)) return;
      await performNavigation(get, set, pending, true, markLanded);
      // 切换方案不能顺带丢弃其他资料草稿。
      if (!get().pendingNavigation && pending.kind !== "scheme") get().discardQqMemoryBatchDrafts();
    },
    cancelPendingNavigation: () => {
      if (!get().pendingNavigation) return;
      set({
        pendingNavigation: null,
        navigationConfirmOpen: false,
        navigationConfirmMessage: "",
      });
    },
  };
}
