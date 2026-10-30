import { agentPermissionScope, permissionSettingsDirty } from "../features/access/permission-state";
import { webAccessDraftDirty } from "../features/access/web-access-state";
import { dirtyPages } from "../features/agents/page-drafts";
import {
  emptyContextAllocationTarget,
  mergeContextAllocationTarget,
} from "../features/context-allocation";
import { conversationModeDirty } from "../features/conversations/directory-state";
import {
  knowledgeModelDirty,
  knowledgeReadDirty,
  organizationDirty,
} from "../features/knowledge/types";
import { qqDraftChanges } from "../features/qq/draft-state";
import { msg } from "../i18n";
import {
  captureWorkspacePosition,
  restoreWorkspacePosition,
} from "../workspace/navigation-context";
import type { PendingNavigation, StoreGet, StoreSet, SuperstringState } from "./types";
import { hasUnsavedDrafts, navigationBusy } from "./unsaved-changes";

// 放弃编辑对象时只清它自己的原始输入映射；global/其他 Agent 的键归各自所有者，不做全局清空。
function discardEditorInvalidInputs(
  get: () => SuperstringState,
  set: (patch: Partial<SuperstringState>) => void,
) {
  const editorId = get().editorAgentId;
  if (editorId === "__new__") return;
  const prefix = `agent:${editorId}:`;
  set({
    allocationInvalidInputs: Object.fromEntries(
      Object.entries(get().allocationInvalidInputs).filter(([key]) => !key.startsWith(prefix)),
    ),
  });
}

// models 是一级模型服务；Agent 模型字段的保存分区同名，但对话任务路由是 context。
function isAgentEditor(
  view: SuperstringState["settingsView"],
  route: SuperstringState["settingsRoute"],
) {
  return (
    view === "agents" ||
    (view === "workspace" &&
      [
        "basic",
        "identity",
        "expression",
        "context",
        "memory-tools",
        "knowledge-tools",
        "agent-tools",
      ].includes(route))
  );
}

function staysInAgentEditor(state: SuperstringState, pending: PendingNavigation): boolean {
  return (
    pending.kind === "page" &&
    pending.page === "settings" &&
    state.page === "settings" &&
    isAgentEditor(state.settingsView, state.settingsRoute) &&
    isAgentEditor(pending.settingsView, pending.settingsRoute ?? state.settingsRoute)
  );
}

// 保留的 Agent 草稿不是当前资料内容弹窗的提交范围；只有真正离开编辑所有者才处理它。
function leavesConfigurationDrafts(state: SuperstringState, pending: PendingNavigation): boolean {
  if (pending.kind === "knowledge" || pending.kind === "scheme") return false;
  if (pending.kind !== "page") return true;
  if (pending.page !== "settings") return true;
  if (staysInAgentEditor(state, pending)) return false;
  const returningToAgent = isAgentEditor(
    pending.settingsView,
    pending.settingsRoute ?? state.settingsRoute,
  );
  const leavingContent =
    state.settingsView === "knowledge" ||
    (state.settingsView === "workspace" && state.settingsRoute === "long-memory");
  return !(returningToAgent && leavingContent && state.pageEditor !== null);
}

async function performNavigation(
  get: () => SuperstringState,
  set: (patch: Partial<SuperstringState>) => void,
  pending: PendingNavigation,
  discard: boolean,
  markLanded: () => void,
): Promise<void> {
  if (pending.kind === "workspace-target") {
    const api = get().apiClient;
    if (discard) {
      get().discardSettingsPages();
      get().discardKnowledgeRead();
      get().discardKnowledgeModel();
      get().discardKnowledgeEditor();
      get().discardOrganization();
      get().discardPermissionSettings();
      get().discardWebAccessDraft();
      get().discardQqDrafts();
      get().discardMemoryCorrection();
      get().discardMemoryVisibilityDraft();
      get().discardConversationMemoryReadMode();
    }
    if (
      pending.returning &&
      pending.agentId &&
      !get().agents.some((agent) => agent.id === pending.agentId)
    ) {
      set({
        page: "settings",
        settingsView: "workspace",
        settingsRoute: "basic",
        workspaceReturns: get().workspaceReturns.slice(0, -1),
        pendingNavigation: null,
        navigationConfirmOpen: false,
      });
      markLanded();
      return;
    }
    if (pending.agentId && (pending.agentId !== get().editorAgentId || !get().pageEditor)) {
      if (
        !get().agents.some((agent) => agent.id === pending.agentId) ||
        !(await get().editAgent(pending.agentId))
      ) {
        if (get().apiClient === api)
          set({ pendingNavigation: pending, navigationConfirmOpen: true });
        return;
      }
    }
    if (get().apiClient !== api) return;
    const returns = pending.returning
      ? get().workspaceReturns.slice(0, -1)
      : pending.origin
        ? [...get().workspaceReturns, pending.origin]
        : get().workspaceReturns;
    set({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: pending.route,
      componentTarget: pending.componentTarget ?? null,
      workspaceReturns: returns,
      ...(pending.allocation ? { contextAllocationTarget: pending.allocation } : {}),
      pendingNavigation: null,
      navigationConfirmOpen: false,
      navigationConfirmMessage: "",
      error: null,
      feedback: "",
    });
    markLanded();
    if (pending.returning && pending.origin) restoreWorkspacePosition(pending.origin);
    return;
  }
  if (pending.kind === "context-allocation") {
    const requested = pending.target;
    if (!pending.returning && requested.purpose === "qq") {
      const api = get().apiClient;
      const [schemesReady] = await Promise.all([
        get().qqSchemesLoaded ? true : get().loadQqSchemes({ editor: false }),
        get().qqBindingsLoaded ? undefined : get().loadQqBindings(),
      ]);
      if (get().apiClient !== api || !schemesReady || !get().qqBindingsLoaded) return;
    }
    const isQq = requested.purpose === "qq";
    // 非 QQ 目的不读取 QQ 绑定实体；仅在 QQ 目的下解析 binding
    const binding =
      isQq && requested.bindingId
        ? get().qqBindings.find((item) => item.id === requested.bindingId)
        : undefined;
    // 全局意图判定严格限定于 reading / aux 目的，且明确 requested.agentId === null 或未指定 agentId；
    // QQ 目的绝不误判为全局意图，严格遵循绑定/默认助手水合契约
    const isGlobalIntent =
      !isQq &&
      (requested.purpose === "reading" || requested.purpose === "aux") &&
      (requested.agentId === null || requested.agentId === undefined);
    const resolvedAgentId = isGlobalIntent
      ? null
      : (binding?.agent_id ??
        requested.agentId ??
        (get().editorAgentId !== "__new__" ? get().editorAgentId : get().agents[0]?.id));
    const target = pending.returning
      ? requested
      : {
          ...requested,
          agentId: resolvedAgentId,
          schemeId: isQq
            ? (binding?.scheme_id ??
              requested.schemeId ??
              get().qqSchemeEditor?.source.id ??
              get().qqSchemes[0]?.id)
            : null,
          bindingId: isQq ? (requested.bindingId ?? null) : null,
        };
    if (discard) {
      get().discardSettingsPages();
      get().discardKnowledgeRead();
      get().discardKnowledgeModel();
      get().discardKnowledgeEditor();
      get().discardOrganization();
      get().discardPermissionSettings();
      get().discardWebAccessDraft();
      get().discardQqDrafts();
      get().discardMemoryCorrection();
      get().discardMemoryVisibilityDraft();
      get().discardConversationMemoryReadMode();
    }
    if (
      !pending.returning &&
      target.agentId &&
      (target.agentId !== get().editorAgentId || !get().pageEditor) &&
      !(await get().editAgent(target.agentId))
    ) {
      set({ pendingNavigation: pending, navigationConfirmOpen: true });
      return;
    }
    // 仅在 QQ 目的下选择 scheme 与 binding，非 QQ 目的绝不引入 QQ 实体状态与副作用
    if (
      !pending.returning &&
      isQq &&
      target.schemeId &&
      target.schemeId !== get().qqSchemeEditor?.source.id
    )
      get().selectQqScheme(target.schemeId);
    if (
      !pending.returning &&
      isQq &&
      target.bindingId &&
      !(await get().selectQqGroupConfig(target.bindingId))
    )
      return;
    set({
      contextAllocationTarget: pending.returning ? { ...emptyContextAllocationTarget } : target,
    });
    // 着陆路由判定：根据目的和目标精细分流，不使用 returnRoute 猜测目的
    // - 助手主目的 (assistant) 或带 Agent 的辅助用途 (aux): 着陆于 "context" (CapabilityEditor)
    // - 带 Agent 的读取目的 (reading): 统一着陆于 "memory-tools" (AssistantWorkspace access 标签页，同屏呈现 MemoryReadingRules 与 KnowledgeToolSettings)
    // - QQ 目的: 根据是否有 bindingId 精确着陆于 "qq-group-config" 或 "qq-scheme-config"，不落目录丢编辑，不绕 guard
    // - 全局 reading / aux: 着陆于 "context-allocation" (ModelPurposes)
    let landingRoute = pending.route;
    if (!landingRoute) {
      if (target.purpose === "assistant" || (target.purpose === "aux" && target.agentId)) {
        landingRoute = "context";
      } else if (target.purpose === "reading" && target.agentId) {
        landingRoute = "memory-tools";
      } else if (target.purpose === "qq") {
        landingRoute = target.bindingId ? "qq-group-config" : "qq-scheme-config";
      } else {
        landingRoute = "context-allocation";
      }
    }
    set({
      page: "settings",
      settingsView: "workspace",
      modelCapacityTarget:
        pending.route === "external-api"
          ? (target.capacityModel ?? null)
          : get().modelCapacityTarget,
      settingsRoute: landingRoute,
      pendingNavigation: null,
      navigationConfirmOpen: false,
      navigationConfirmMessage: "",
      error: null,
    });
    markLanded();
    return;
  }
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
      settingsRoute: pending.settingsRoute ?? "qq-scheme-config",
      qqSchemeView: pending.view ?? "settings",
      feedback: "",
    });
    markLanded();
    return;
  }
  if (pending.kind === "group-config") {
    // 目标绑定已不在目录里（别处解绑/被删）：显式报错并把确认框留在原地，草稿不丢。
    if (get().qqBindingsLoaded && !get().qqBindings.some((row) => row.id === pending.bindingId)) {
      set({
        pendingNavigation: pending,
        navigationConfirmOpen: true,
        error: msg("操作失败，请重试。"),
      });
      return;
    }
    if (discard) get().discardQqDrafts();
    set({
      pendingNavigation: null,
      navigationConfirmOpen: false,
      navigationConfirmMessage: "",
      error: null,
      page: "settings",
      settingsView: "workspace",
      settingsRoute: pending.settingsRoute ?? "qq-group-config",
      qqGroupConfigOrigin: pending.origin ?? { kind: "bindings" },
      feedback: "",
    });
    markLanded();
    // 同 id 但目录里的绑定已换 agent：先清指针，避免 select 的「同群短路」把旧 agent 的编辑器当已打开。
    // 只有显式打开才发生重读；读取放在路由落地之后，失败时页面按「绑定 id + error」呈现并原位重试。
    const landed = get();
    const landedEditor = landed.qqGroupConfigEditor;
    const catalogAgent = landed.qqBindingsLoaded
      ? landed.qqBindings.find((row) => row.id === pending.bindingId)?.agent_id
      : undefined;
    if (
      catalogAgent !== undefined &&
      landedEditor !== null &&
      landedEditor.source.binding.id === pending.bindingId &&
      landedEditor.source.binding.agent_id !== catalogAgent
    )
      set({ qqGroupConfigBindingId: null });
    await get().selectQqGroupConfig(pending.bindingId);
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
    dirty:
      pending.kind === "page" && !leavesConfigurationDrafts(get(), pending) ? dirtyBefore : false,
    error: null,
  });
  if (pending.kind === "page") {
    const patch: Partial<SuperstringState> = {
      page: pending.page,
      settingsView: pending.settingsView,
      ...(pending.settingsRoute ? { settingsRoute: pending.settingsRoute } : {}),
      componentTarget: pending.componentTarget ?? null,
      ...(pending.conversationView ? { conversationView: pending.conversationView } : {}),
      ...(pending.conversationScope ? { conversationScope: pending.conversationScope } : {}),
      feedback: "",
    };
    // 放弃修改并离开 agents 页时清除草稿，使再次进入按默认规则读取而非显示已放弃改动；
    // 普通导航（保存后或取消）保留草稿。
    if (discard && leavesConfigurationDrafts(get(), pending)) {
      discardEditorInvalidInputs(get, set);
      get().discardSettingsPages();
      get().discardOrganization();
      get().discardKnowledgeModel();
      get().discardKnowledgeRead();
      get().discardKnowledgeEditor();
      get().discardPermissionSettings();
      get().discardWebAccessDraft();
      get().discardQqDrafts();
      if (
        pending.page !== "settings" ||
        (dirtyBefore && (get().settingsView === "agents" || get().editorAgentId === "__new__"))
      ) {
        patch.pageEditor = null;
        patch.editorDraft = null;
        patch.editorAgentId = "__new__";
      }
    }
    get().discardMemoryCorrection();
    if (discard || pending.page !== "settings") get().discardKnowledgeEditor();
    set(patch);
    markLanded();
    if (pending.conversationId) await get().selectConversation(pending.conversationId);
    return;
  }
  if (pending.kind === "agent") {
    const api = get().apiClient;
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
      memoryReadSelection: get().memoryReadSelection,
      memoryReadableOffset: get().memoryReadableOffset,
      memorySourceOffset: get().memorySourceOffset,
      memorySourcePosition: get().memorySourcePosition,
      memoryJobs: get().memoryJobs,
    };
    const permissionScope = agentPermissionScope(get().permissionEditor, get().editorAgentId);
    const changed = await get().editAgent(pending.id);
    if (get().apiClient !== api) return;
    if (changed && discard) {
      get().discardQqDrafts();
      get().discardPermissionSettings(permissionScope);
    }
    if (changed && pending.settingsRoute && get().settingsRoute !== pending.settingsRoute) {
      get().openSettingsRoute(pending.settingsRoute);
    }
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
}

export function createNavigationActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  SuperstringState,
  | "openWorkspaceTarget"
  | "returnWorkspaceTarget"
  | "openContextAllocation"
  | "returnFromContextAllocation"
  | "requestConversationNavigation"
  | "requestConversationView"
  | "openSettingsRoute"
  | "syncSettingsRoute"
  | "requestContextAllocation"
  | "openSystemComponent"
  | "openChat"
  | "openSettings"
  | "openAgentSettings"
  | "closeAgentSettings"
  | "requestPageNavigation"
  | "requestAgentNavigation"
  | "requestQqSchemeNavigation"
  | "openQqGroupConfig"
  | "returnQqGroupConfig"
  | "confirmSaveAndContinue"
  | "confirmDiscardAndContinue"
  | "cancelPendingNavigation"
> {
  // 导航落地序号：每次有效落地递增，晚到的会话选择完成不得覆盖更新的视图/位置。
  let navigationSequence = 0;
  const markLanded = () => {
    navigationSequence += 1;
    if (
      get().page !== "settings" ||
      get().settingsView !== "workspace" ||
      !["context-allocation", "context", "memory-tools", "knowledge-tools"].includes(
        get().settingsRoute,
      )
    ) {
      set({ contextAllocationTarget: { ...emptyContextAllocationTarget } });
    }
  };
  const origin = () => ({
    route: get().settingsRoute,
    agentId: get().editorAgentId !== "__new__" ? get().editorAgentId : null,
    componentTarget: get().componentTarget,
    allocation: { ...get().contextAllocationTarget },
    ...captureWorkspacePosition(),
  });
  const routeOwner = (route: SuperstringState["settingsRoute"]) => {
    switch (route) {
      case "management":
      case "knowledge-model":
      case "external-api":
        return "models";
      case "qq-app-schemes":
        return "scheme-library";
      case "qq-app-groups":
        return "scheme-bindings";
      case "knowledge-tools":
        return "memory-tools";
      case "expression":
        return "identity";
      default:
        return route;
    }
  };
  const requestPage = (pending: Extract<PendingNavigation, { kind: "page" }>) => {
    const state = get();
    if (navigationBusy(state)) return;
    // 旧资料容器与资料正文路由是同一落点；只规范地址，不关闭编辑器或处理草稿。
    if (
      state.page === "settings" &&
      state.settingsView === "knowledge" &&
      pending.page === "settings" &&
      pending.settingsView === "workspace" &&
      pending.settingsRoute === "knowledge-config"
    ) {
      set({ settingsView: "workspace", settingsRoute: "knowledge-config", feedback: "" });
      markLanded();
      return;
    }
    if (
      state.page === pending.page &&
      state.settingsView === pending.settingsView &&
      (!pending.settingsRoute ||
        (routeOwner(state.settingsRoute) === routeOwner(pending.settingsRoute) &&
          state.componentTarget === null))
    )
      return;
    const leavingConfiguration = leavesConfigurationDrafts(state, pending);
    const unsaved = leavingConfiguration
      ? hasUnsavedDrafts(state)
      : state.memoryCorrectionDirty ||
        state.memoryVisibilityDirty ||
        state.knowledgeDirty ||
        (state.settingsRoute === "long-memory" &&
          Object.keys(state.qqMemoryBatchDrafts).length > 0);
    if (unsaved) {
      set({
        pendingNavigation: pending,
        navigationConfirmOpen: true,
        navigationConfirmMessage:
          state.dirty && (state.settingsView === "agents" || state.editorAgentId === "__new__")
            ? msg("当前 Agent 有未保存修改，是否先保存再离开？")
            : state.knowledgeDirty
              ? msg("知识库有未保存修改，是否先保存再继续？")
              : msg("设置中有未保存页面，是否全部保存再继续？"),
      });
      return;
    }
    void performNavigation(get, set, pending, false, markLanded);
  };
  const workspaceTarget = (pending: Extract<PendingNavigation, { kind: "workspace-target" }>) => {
    const state = get();
    if (navigationBusy(state)) return;
    if (
      !pending.returning &&
      state.page === "settings" &&
      state.settingsView === "workspace" &&
      routeOwner(state.settingsRoute) === routeOwner(pending.route) &&
      (!pending.agentId || pending.agentId === state.editorAgentId) &&
      (pending.componentTarget?.kind ?? null) === (state.componentTarget?.kind ?? null) &&
      (pending.componentTarget?.id ?? null) === (state.componentTarget?.id ?? null) &&
      (!pending.allocation ||
        JSON.stringify(pending.allocation) === JSON.stringify(state.contextAllocationTarget))
    )
      return;
    if (hasUnsavedDrafts(state)) {
      set({
        pendingNavigation: pending,
        navigationConfirmOpen: true,
        navigationConfirmMessage: msg("设置中有未保存页面，是否全部保存再继续？"),
      });
    } else void performNavigation(get, set, pending, false, markLanded);
  };
  const returnTarget = () => {
    const previous = get().workspaceReturns.at(-1);
    if (!previous) return;
    const agentRoute = [
      "memory-tools",
      "knowledge-tools",
      "agent-tools",
      "context",
      "identity",
      "expression",
      "long-memory",
    ].includes(previous.route);
    workspaceTarget({
      kind: "workspace-target",
      route: previous.route,
      agentId: agentRoute ? previous.agentId : null,
      componentTarget: previous.componentTarget,
      allocation: previous.allocation,
      origin: previous,
      returning: true,
    });
  };
  return {
    openWorkspaceTarget: (route, agentId) => {
      workspaceTarget({ kind: "workspace-target", route, agentId, origin: origin() });
    },
    returnWorkspaceTarget: returnTarget,
    openContextAllocation: (target = {}) => {
      const merged = mergeContextAllocationTarget(get().contextAllocationTarget, target);
      const route =
        merged.purpose === "qq"
          ? merged.bindingId
            ? "qq-group-config"
            : "qq-scheme-config"
          : merged.agentId
            ? merged.purpose === "reading"
              ? "memory-tools"
              : "context"
            : "context-allocation";
      if (merged.purpose === "qq") get().requestContextAllocation(merged);
      else
        workspaceTarget({
          kind: "workspace-target",
          route,
          agentId: merged.agentId,
          allocation: merged,
          origin: origin(),
        });
    },
    returnFromContextAllocation: () => {
      if (get().workspaceReturns.length) returnTarget();
      else
        get().requestContextAllocation(
          get().contextAllocationTarget,
          get().contextAllocationTarget.returnRoute ?? "scheme-library",
          true,
        );
    },
    requestContextAllocation: (target, route, returning = false) => {
      if (navigationBusy(get())) return;
      const pending: PendingNavigation = { kind: "context-allocation", target, route, returning };
      if (hasUnsavedDrafts(get())) {
        set({
          pendingNavigation: pending,
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("设置中有未保存页面，是否全部保存再继续？"),
        });
        return;
      }
      void performNavigation(get, set, pending, false, markLanded);
    },
    requestConversationNavigation: async (id) => {
      if (navigationBusy(get())) return;
      if (
        (get().page !== "chat" ||
          get().currentConversationId !== id ||
          get().conversationView !== "messages" ||
          get().conversationScope !== "current") &&
        hasUnsavedDrafts(get())
      ) {
        set({
          pendingNavigation: {
            kind: "page",
            page: "chat",
            settingsView: "hub",
            conversationId: id,
            conversationView: "messages",
            conversationScope: "current",
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
      if (navigationBusy(get())) return;
      // 目标真正变化时统一走草稿聚合守卫：同页视图切换不得绕过 permission/pageEditor/knowledge 草稿。
      if (
        (get().conversationView !== view || get().conversationScope !== scope) &&
        hasUnsavedDrafts(get())
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
      if (settingsRoute === "context-allocation") {
        get().requestContextAllocation(get().contextAllocationTarget);
        return;
      }
      if (settingsRoute === "execution-ledger" || settingsRoute === "task-ledger") {
        get().requestConversationView(
          settingsRoute === "execution-ledger" ? "activity" : "tasks",
          "global",
        );
        return;
      }
      if (settingsRoute === "knowledge-model" || settingsRoute === "management")
        settingsRoute = "models";
      if (navigationBusy(get())) return;
      if (settingsRoute === "basic") {
        get().openAgentSettings();
        return;
      }
      requestPage({ kind: "page", page: "settings", settingsView: "workspace", settingsRoute });
    },
    syncSettingsRoute: (settingsRoute) => {
      // 已落地工作区内的子路由同步：标签页是本地视图，只记录落点。
      // 真正的页面/Agent 切换仍走 requestPageNavigation/requestAgentNavigation，离开守卫不变。
      if (get().page !== "settings" || get().settingsView !== "workspace") return;
      set({ settingsRoute, componentTarget: null, feedback: "" });
      markLanded();
    },
    openSystemComponent: (target) => {
      const route =
        target.kind === "tool"
          ? "tool-grants"
          : target.kind === "skill"
            ? "skill-catalog"
            : "mcp-servers";
      workspaceTarget({
        kind: "workspace-target",
        route,
        componentTarget: target,
        origin: origin(),
      });
    },
    openChat: () => get().requestConversationView("messages", "current"),
    openSettings: () => get().requestPageNavigation("settings", "hub"),
    openAgentSettings: () => {
      if (navigationBusy(get())) return;
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
      requestPage({ kind: "page", page, settingsView });
    },
    // 返回「请求的编辑身份是否已落地」：true＝当前编辑器已代表目标（含同身份短路），
    // false＝被在途写入、离开守卫或读取失败拦下；守卫确认后的落地由既有 continuation 完成。
    requestAgentNavigation: async (id, settingsRoute) => {
      if (navigationBusy(get())) return false;
      // 保存会清空 pageEditor，但保留 editorDraft；既有助手须重建编辑器。
      if (
        id === get().editorAgentId &&
        (id === "__new__" ? get().editorDraft !== null : get().pageEditor !== null)
      ) {
        if (settingsRoute && get().settingsRoute !== settingsRoute) {
          get().openSettingsRoute(settingsRoute);
          return (
            get().pendingNavigation === null &&
            routeOwner(get().settingsRoute) === routeOwner(settingsRoute)
          );
        }
        return true;
      }
      if (
        get().dirty ||
        get().memoryCorrectionDirty ||
        get().memoryVisibilityDirty ||
        Object.keys(get().qqMemoryBatchDrafts).length > 0 ||
        dirtyPages(get().pageEditor).length ||
        knowledgeReadDirty(get().knowledgeReadEditor) ||
        permissionSettingsDirty(
          get().permissionEditor,
          agentPermissionScope(get().permissionEditor, get().editorAgentId),
        )
      ) {
        set({
          pendingNavigation: {
            kind: "agent",
            id,
            ...(settingsRoute ? { settingsRoute } : {}),
          },
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("当前 Agent 有未保存修改，是否先保存再切换？"),
        });
        return false;
      }
      const landed = await get().editAgent(id);
      if (landed && settingsRoute && get().settingsRoute !== settingsRoute) {
        get().openSettingsRoute(settingsRoute);
      }
      return landed;
    },
    requestQqSchemeNavigation: (id, view = "settings", settingsRoute) => {
      if (navigationBusy(get())) return;
      if (!get().qqSchemes.some((row) => row.id === id)) {
        // 目标不存在（含已删的脏方案）：显式报错，不改路由也不切视图，草稿原样保留。
        set({ error: msg("操作失败，请重试。") });
        return;
      }
      const sameDetail =
        get().qqSchemeEditor?.source.id === id &&
        get().page === "settings" &&
        get().settingsView === "workspace" &&
        get().settingsRoute === (settingsRoute ?? "qq-scheme-config");
      if (sameDetail) {
        if (get().qqSchemeView !== view) set({ qqSchemeView: view });
        return;
      }
      const pending: PendingNavigation = {
        kind: "scheme",
        id,
        ...(view !== "settings" ? { view } : {}),
        ...(settingsRoute ? { settingsRoute } : {}),
      };
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
    openQqGroupConfig: (bindingId, settingsRoute) => {
      if (navigationBusy(get())) return;
      const state = get();
      // 目录已载入时先确认真实存在，避免丢弃草稿后进入空页；未载入则让页面读取如实报失败。
      if (state.qqBindingsLoaded && !state.qqBindings.some((row) => row.id === bindingId)) {
        set({ error: msg("操作失败，请重试。") });
        return;
      }
      const editor = state.qqGroupConfigEditor;
      const catalogRow = state.qqBindingsLoaded
        ? state.qqBindings.find((row) => row.id === bindingId)
        : undefined;
      // 「同一目标」按稳定编辑身份判断：binding id + 目录里的 agent；同 id 换了 agent 视为新目标，
      // 走守卫重读（只有显式打开才发生）。目录未载入时退回同 id，避免入口被挡住。
      const sameTarget =
        state.qqGroupConfigBindingId === bindingId &&
        editor !== null &&
        editor.source.binding.id === bindingId &&
        (!state.qqBindingsLoaded || catalogRow?.agent_id === editor.source.binding.agent_id) &&
        state.page === "settings" &&
        state.settingsView === "workspace" &&
        state.settingsRoute === (settingsRoute ?? "qq-group-config");
      // 同一身份已打开：不重读（重读会推进脏基线），也不改路由。
      if (sameTarget) return;
      const pending: PendingNavigation = {
        kind: "group-config",
        bindingId,
        origin:
          state.settingsRoute === "qq-group-config" && state.page === "settings"
            ? (state.qqGroupConfigOrigin ?? { kind: "bindings" })
            : state.page === "chat"
              ? { kind: "conversation", conversationId: state.currentConversationId }
              : state.settingsRoute === "qq-scheme-config" &&
                  state.qqSchemeView === "bindings" &&
                  state.qqSchemeEditor
                ? { kind: "scheme-usage", schemeId: state.qqSchemeEditor.source.id }
                : { kind: "bindings" },
        ...(settingsRoute ? { settingsRoute } : {}),
      };
      // 同 route 换群同样走统一守卫：草稿未决前不换编辑器。
      if (qqDraftChanges(state).length) {
        set({
          pendingNavigation: pending,
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("设置中有未保存页面，是否全部保存再继续？"),
        });
        return;
      }
      void performNavigation(get, set, pending, false, markLanded);
    },
    returnQqGroupConfig: () => {
      const state = get();
      const origin = state.qqGroupConfigOrigin;
      if (
        origin?.kind === "scheme-usage" &&
        state.qqSchemes.some((row) => row.id === origin.schemeId)
      ) {
        state.requestQqSchemeNavigation(origin.schemeId, "bindings");
      } else if (origin?.kind === "conversation") {
        if (origin.conversationId) state.requestConversationNavigation(origin.conversationId);
        else state.openChat();
      } else state.openSettingsRoute("scheme-bindings");
    },
    confirmSaveAndContinue: async () => {
      const pending = get().pendingNavigation;
      const state = get();
      const stillPending = () =>
        get().apiClient === state.apiClient && get().pendingNavigation === pending;
      if (pending?.kind === "knowledge" && state.knowledgeEditor?.kind === "settings") {
        if (navigationBusy(state) || state.knowledgeModelLoading || state.organizationLoading)
          return;
        const invalid = Object.keys(state.allocationInvalidInputs).some(
          (key) => key === "global:knowledge" || key.startsWith("global:aux:knowledge_organize_"),
        );
        if (invalid) {
          set({
            navigationConfirmOpen: true,
            navigationConfirmMessage: msg("请先修正方案中的无效数字，再保存。"),
          });
          return;
        }
        if (
          !(await get().saveKnowledgeModel("model")) ||
          !stillPending() ||
          !(await get().saveKnowledgeModel("budget")) ||
          !stillPending() ||
          !(await get().saveOrganization("allocation", ["knowledge_organize"])) ||
          !stillPending() ||
          (get().knowledgeDirty && !(await get().saveKnowledgeEditor()))
        ) {
          if (!stillPending()) return;
          set({
            navigationConfirmOpen: true,
            navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
          });
          return;
        }
        if (!stillPending()) return;
        await performNavigation(get, set, pending, false, markLanded);
        return;
      }
      if (pending?.kind === "knowledge") {
        if (navigationBusy(state)) return;
        if (state.knowledgeDirty && !(await get().saveKnowledgeEditor())) {
          if (!stillPending()) return;
          set({
            navigationConfirmOpen: true,
            navigationConfirmMessage: msg("保存失败：{0}", get().error ?? msg("未知错误")),
          });
          return;
        }
        if (!stillPending()) return;
        await performNavigation(get, set, pending, false, markLanded);
        return;
      }
      if (pending?.kind === "page" && !leavesConfigurationDrafts(state, pending)) {
        if (navigationBusy(state)) return;
        if (state.memoryVisibilityDirty) {
          set({
            navigationConfirmOpen: true,
            navigationConfirmMessage: msg(
              "记忆共享设置需要单独确认发布，请在记忆详情中完成或放弃后再继续。",
            ),
          });
          return;
        }
        if (
          (state.knowledgeDirty && !(await get().saveKnowledgeEditor())) ||
          !stillPending() ||
          (get().memoryCorrectionDirty && !(await get().saveMemoryCorrection())) ||
          !stillPending() ||
          (state.settingsRoute === "long-memory" && !(await get().saveQqMemoryBatchDrafts()))
        ) {
          if (!stillPending()) return;
          set({
            navigationConfirmOpen: true,
            navigationConfirmMessage: msg("保存失败：{0}", get().error ?? msg("未知错误")),
          });
          return;
        }
        if (!stillPending()) return;
        await performNavigation(get, set, pending, false, markLanded);
        return;
      }
      if (pending && Object.keys(state.allocationInvalidInputs).length) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("请先修正方案中的无效数字，再保存。"),
        });
        return;
      }
      // Saving needs settled editor baselines; ordinary read-only navigation does not.
      if (
        !pending ||
        navigationBusy(state) ||
        state.editorLoading ||
        state.knowledgeReadLoading ||
        state.knowledgeModelLoading
      )
        return;
      if (pending.kind === "scheme") {
        if (!(await get().saveQqDrafts())) {
          if (!stillPending()) return;
          set({
            navigationConfirmOpen: true,
            navigationConfirmMessage: get().qqInputs.bindingSchemeConfirmationId
              ? get().navigationConfirmMessage
              : msg("保存失败：{0}", get().error ?? msg("未知错误")),
          });
          return;
        }
        if (!stillPending()) return;
        await performNavigation(get, set, pending, false, markLanded);
        return;
      }
      if (!(await get().saveQqDrafts())) {
        if (!stillPending()) return;
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: get().qqInputs.bindingSchemeConfirmationId
            ? get().navigationConfirmMessage
            : msg("保存失败：{0}", get().error ?? msg("未知错误")),
        });
        return;
      }
      if (!stillPending()) return;
      if (!(await get().saveQqMemoryBatchDrafts())) {
        if (!stillPending()) return;
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存失败：{0}", get().error ?? msg("未知错误")),
        });
        return;
      }
      if (!stillPending()) return;
      const leavingWorkspace = leavesConfigurationDrafts(state, pending);
      const permissionScope =
        pending.kind === "agent"
          ? agentPermissionScope(get().permissionEditor, get().editorAgentId)
          : "all";
      if (
        leavingWorkspace &&
        permissionSettingsDirty(get().permissionEditor, permissionScope) &&
        !(await get().savePermissionSettings(permissionScope))
      ) {
        if (!stillPending()) return;
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
        return;
      }
      if (!stillPending()) return;
      if (
        leavingWorkspace &&
        pending.kind !== "agent" &&
        webAccessDraftDirty(get().webAccessSnapshot, get().webAccessDraft) &&
        !(await get().saveWebAccessDraft())
      ) {
        if (!stillPending()) return;
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
        return;
      }
      if (!stillPending()) return;
      if (
        leavingWorkspace &&
        dirtyPages(get().pageEditor).length &&
        !(await get().saveAllSettingsPages())
      ) {
        if (!stillPending()) return;
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
        return;
      }
      if (!stillPending()) return;
      if (
        leavingWorkspace &&
        knowledgeReadDirty(get().knowledgeReadEditor) &&
        !(await get().saveKnowledgeRead())
      ) {
        if (!stillPending()) return;
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
        return;
      }
      if (!stillPending()) return;
      if (
        leavingWorkspace &&
        knowledgeModelDirty(get().knowledgeModelEditor) &&
        !(await get().saveKnowledgeModel())
      ) {
        if (!stillPending()) return;
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
        return;
      }
      if (!stillPending()) return;
      if (
        leavingWorkspace &&
        organizationDirty(get().organizationEditor, "all") &&
        !(await get().saveOrganization("all"))
      ) {
        if (!stillPending()) return;
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
        return;
      }
      if (!stillPending()) return;
      if (
        pending.kind !== "agent" &&
        get().knowledgeDirty &&
        !(await get().saveKnowledgeEditor())
      ) {
        if (!stillPending()) return;
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存失败：{0}", get().error ?? msg("未知错误")),
        });
        return;
      }
      if (!stillPending()) return;
      if (get().memoryVisibilityDirty) {
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg(
            "记忆共享设置需要单独确认发布，请在记忆详情中完成或放弃后再继续。",
          ),
        });
        return;
      }
      if (get().memoryCorrectionDirty && !(await get().saveMemoryCorrection())) {
        if (!stillPending()) return;
        set({
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("保存失败：{0}", get().error ?? msg("未知错误")),
        });
        return;
      }
      if (!stillPending()) return;
      if (conversationModeDirty(get())) {
        const convId = get().currentConversationId;
        if (convId && !(await get().saveConversationMemoryReadMode(convId))) {
          if (!stillPending()) return;
          set({
            navigationConfirmOpen: true,
            navigationConfirmMessage: msg("保存失败：{0}", get().error ?? msg("未知错误")),
          });
          return;
        }
        if (!stillPending()) return;
      }
      const saved =
        !leavingWorkspace ||
        get().editorAgentId !== "__new__" ||
        !get().dirty ||
        (await get().createAgent());
      if (!stillPending()) return;
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
      if (!pending || navigationBusy(get())) return;
      if (pending.kind === "knowledge" && get().knowledgeEditor?.kind === "settings") {
        get().discardOrganization("allocation", ["knowledge_organize"]);
        get().discardKnowledgeModel("budget");
        get().discardKnowledgeModel("model");
        await performNavigation(get, set, pending, true, markLanded);
        return;
      }
      if (pending.kind === "knowledge") {
        await performNavigation(get, set, pending, true, markLanded);
        return;
      }
      if (pending.kind === "page" && !leavesConfigurationDrafts(get(), pending)) {
        if (get().memoryVisibilityDirty) {
          get().discardMemoryVisibilityDraft();
          get().clearMemoryMetadata();
        }
        if (get().settingsRoute === "long-memory") get().discardQqMemoryBatchDrafts();
        await performNavigation(get, set, pending, true, markLanded);
        return;
      }
      if (conversationModeDirty(get())) {
        get().discardConversationMemoryReadMode();
      }
      if (get().memoryVisibilityDirty) {
        get().discardMemoryVisibilityDraft();
        get().clearMemoryMetadata();
      }
      await performNavigation(get, set, pending, true, markLanded);
      // 切换方案不能顺带丢弃其他资料草稿。
      if (!get().pendingNavigation && pending.kind !== "scheme") get().discardQqMemoryBatchDrafts();
    },
    cancelPendingNavigation: () => {
      if (!get().pendingNavigation) return;
      set((state) => ({
        pendingNavigation: null,
        navigationConfirmOpen: false,
        navigationConfirmMessage: "",
        qqInputs: { ...state.qqInputs, bindingSchemeConfirmationId: null },
      }));
    },
  };
}
