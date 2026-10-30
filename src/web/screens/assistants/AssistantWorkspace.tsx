import { ArrowLeft, Bot, Plus, Search, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ConfirmDialog } from "@/components/confirmation";
import { Field } from "@/components/form-field";
import { SettingsGroup } from "@/components/settings-group";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { InputSuggestions } from "@/components/ui/input-suggestions";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { translateNotice } from "@/i18n";
import { useSuperstringStore } from "@/store";
import type { AgentResponse } from "../../../shared/contracts";
import type { AgentWorkspaceTask } from "../../state/types";
import { WorkspacePageHeader } from "../../workspace/WorkspacePageHeader";
import { AgentMaterials } from "./AgentMaterials";
import { AgentToolScope, CapabilityEditor, IdentityEditor } from "./StudioEditors";

/** The directory chooses an object; the studio always edits an explicit assistant. */
export function AssistantWorkspace({ active = true }: { active?: boolean } = {}) {
  const s = useSuperstringStore(
    useShallow((state) => ({
      agents: state.agents,
      deleteAgents: state.deleteAgents,
      discardSettingsPages: state.discardSettingsPages,
      editorAgentId: state.editorAgentId,
      editorDraft: state.editorDraft,
      editorLoading: state.editorLoading,
      api: state.apiClient,
      baselineRefresh: state.editorBaselineRefresh,
      modelNames: state.modelNames,
      pageEditor: state.pageEditor,
      patchNewAgentDraft: state.patchNewAgentDraft,
      refreshModels: state.refreshModels,
      requestAgentNavigation: state.requestAgentNavigation,
      saveAllSettingsPages: state.saveAllSettingsPages,
      saveSettingsTask: state.saveSettingsTask,
      settingsTaskDirty: state.settingsTaskDirty,
      discardSettingsTask: state.discardSettingsTask,
      knowledgeReadEditor: state.knowledgeReadEditor,
      knowledgeReadLoading: state.knowledgeReadLoading,
      createAgent: state.createAgent,
      feedback: state.feedback,
      taskResult: state.agentTaskResult,
      permissionSaving: state.permissionSaving,
      selectedNewSessionAgentId: state.selectedNewSessionAgentId,
      setNewSessionAgent: state.setNewSessionAgent,
      settingsRoute: state.settingsRoute,
      settingsSaving: state.settingsSaving,
      settingsView: state.settingsView,
      syncSettingsRoute: state.syncSettingsRoute,
      contextAllocationTarget: state.contextAllocationTarget,
      returnFromContextAllocation: state.returnFromContextAllocation,
      workspaceReturns: state.workspaceReturns,
      returnWorkspaceTarget: state.returnWorkspaceTarget,
      refreshSettingsAgent: state.refreshSettingsAgent,
      error: state.error,
      dirty: state.dirty,
    })),
  );
  const t = useTranslation().t;
  const [search, setSearch] = useState("");
  const isAgentTaskRoute = [
    "models",
    "context",
    "memory-tools",
    "agent-tools",
    "knowledge-tools",
    "long-memory",
    "knowledge-config",
  ].includes(s.settingsRoute);
  const initialStudio =
    (s.settingsView === "workspace" && !!s.pageEditor) ||
    (isAgentTaskRoute && s.editorAgentId !== "__new__");
  const [studio, setStudio] = useState(initialStudio);
  const [selection, setSelection] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  // 常挂载确认弹窗在关闭动画期间仍会渲染：名称与 id 取最近一次打开时的快照。
  const deleteTarget = useRef<{ ids: string[]; message: string } | null>(null);
  const requestDelete = (ids: string[]) => {
    deleteTarget.current = {
      ids,
      message: t("library.agents.delete.named", {
        "0": ids.map((id) => s.agents.find((agent) => agent.id === id)?.name ?? id).join(", "),
      }),
    };
    setDeleteIds(ids);
  };
  const initialTab =
    s.settingsRoute === "agent-tools"
      ? "tools"
      : s.settingsRoute === "models" || s.settingsRoute === "context"
        ? "capabilities"
        : ["memory-tools", "knowledge-tools", "long-memory", "knowledge-config"].includes(
              s.settingsRoute,
            )
          ? "access"
          : "identity";
  const [tab, setTab] = useState(initialTab);
  const [visitedTabs, setVisitedTabs] = useState([initialTab]);
  const previousRoute = useRef(s.settingsRoute);
  useEffect(() => {
    const prev = previousRoute.current;
    previousRoute.current = s.settingsRoute;
    if (prev === s.settingsRoute) return;
    if (s.settingsRoute === "agent-tools") {
      setTab("tools");
      setStudio(true);
    } else if (s.settingsRoute === "models" || s.settingsRoute === "context") {
      setTab("capabilities");
      setStudio(true);
    } else if (
      ["memory-tools", "knowledge-tools", "long-memory", "knowledge-config"].includes(
        s.settingsRoute,
      )
    ) {
      setTab("access");
      setStudio(true);
    } else if (["basic", "identity", "expression"].includes(s.settingsRoute)) {
      setTab("identity");
    }
  }, [s.settingsRoute]);

  // 目录选择被统一离开守卫延后时，确认后由真正落地的编辑身份打开工作室；取消不改身份，目录保持。
  const landedEditorId = useRef(s.editorAgentId);
  useEffect(() => {
    if (landedEditorId.current === s.editorAgentId) return;
    landedEditorId.current = s.editorAgentId;
    if (active && s.settingsView === "workspace" && s.editorAgentId !== "__new__") setStudio(true);
  }, [active, s.settingsView, s.editorAgentId]);

  // 冷入口目标水合：当直达 context/memory-tools/knowledge-tools 且未就绪时，水合目标助手
  // 严格核验目标 ID 存在于 s.agents 中，尊重新草稿的脏保护，并在目标切换后支持继续水合
  const hydratedTargetRef = useRef<string | null>(null);
  const targetAgent =
    s.editorAgentId && s.editorAgentId !== "__new__"
      ? s.agents.find((a) => a.id === s.editorAgentId)
      : null;
  const targetId = targetAgent?.id;

  useEffect(() => {
    if (!active) return;
    // 若当前为正在编辑中的脏新草稿，严格遵循既有守卫，不自动切离
    if (s.dirty && s.editorAgentId === "__new__") return;
    if (s.pageEditor || s.editorLoading || s.agents.length === 0 || !targetId) return;
    if (isAgentTaskRoute) {
      if (hydratedTargetRef.current !== targetId) {
        hydratedTargetRef.current = targetId;
        void s.requestAgentNavigation(targetId, s.settingsRoute);
        setStudio(true);
      }
    }
  }, [
    active,
    isAgentTaskRoute,
    s.pageEditor,
    s.editorLoading,
    s.agents.length,
    targetId,
    s.dirty,
    s.editorAgentId,
    s.settingsRoute,
    s.requestAgentNavigation,
  ]);
  useEffect(() => {
    setVisitedTabs((previous) => (previous.includes(tab) ? previous : [...previous, tab]));
  }, [tab]);
  // Bootstrap already resolved the model names; a hidden workspace must not fire requests, and a
  // failed/empty bootstrap still triggers one refresh when this workspace becomes visible.
  const modelsRefreshed = useRef(false);
  useEffect(() => {
    if (!active) return;
    if (s.modelNames.length > 0 || modelsRefreshed.current) return;
    modelsRefreshed.current = true;
    void s.refreshModels();
  }, [active, s.refreshModels, s.modelNames]);
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return s.agents;
    return s.agents.filter((a) =>
      `${a.name} ${a.description} ${a.model_name}`.toLowerCase().includes(needle),
    );
  }, [s.agents, search]);
  const directoryRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const grid = directoryRef.current;
    if (!active || studio || !grid || visible.length === 0) return;
    let firstFrame = 0;
    let secondFrame = 0;
    let width: number | undefined;
    const replay = () => {
      grid.dataset.renderReady = "false";
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      if (document.documentElement.dataset.interfaceSize === "compact") return;
      firstFrame = requestAnimationFrame(() => {
        secondFrame = requestAnimationFrame(() => {
          grid.dataset.renderReady = "true";
        });
      });
    };
    // Remember actual row sizes before skipping offscreen layout; never estimate heights.
    replay();
    const resize = new ResizeObserver(([entry]) => {
      const nextWidth = entry?.contentRect.width;
      if (nextWidth === undefined) return;
      if (width !== undefined && nextWidth !== width) replay();
      width = nextWidth;
    });
    resize.observe(grid);
    const appearance = new MutationObserver(replay);
    appearance.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-font", "data-text-size", "data-interface-size", "lang"],
    });
    document.fonts.addEventListener("loadingdone", replay);
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
      resize.disconnect();
      appearance.disconnect();
      document.fonts.removeEventListener("loadingdone", replay);
      delete grid.dataset.renderReady;
    };
  }, [active, studio, visible]);
  // modelNames is already the loaded local + external union; map it once per snapshot.
  const modelSuggestions = useMemo(
    () => s.modelNames.map((name) => ({ value: name })),
    [s.modelNames],
  );
  const select = useCallback(
    (id: string) => {
      if (s.editorLoading || s.settingsSaving) return;
      // 只在导航真正落地（或被守卫延后、随后确认落地）后进入工作室；取消留在目录。
      void s.requestAgentNavigation(id).then((landed) => {
        if (landed) setStudio(true);
      });
    },
    [s.editorLoading, s.settingsSaving, s.requestAgentNavigation],
  );
  // 行勾选只写本组件既有的 selection；稳定回调让行级 memo 在其他提交中保持不动。
  const toggleSelected = useCallback((id: string, checked: boolean) => {
    setSelection((ids) => (checked ? [...ids, id] : ids.filter((value) => value !== id)));
  }, []);
  const current = s.pageEditor;
  const refreshingCurrent =
    !!current &&
    s.baselineRefresh?.api === s.api &&
    s.baselineRefresh.agentId === s.editorAgentId &&
    s.baselineRefresh.token === current.token;
  const isNew = s.editorAgentId === "__new__";
  const currentTask: AgentWorkspaceTask | "tools" =
    tab === "identity"
      ? "identity"
      : tab === "capabilities"
        ? "conversation"
        : tab === "access"
          ? "materials"
          : "tools";
  const isTaskDirty = s.settingsTaskDirty(currentTask);
  const taskResult =
    s.taskResult &&
    s.taskResult.agentId === current?.agent.id &&
    s.taskResult.token === current?.token &&
    s.taskResult.task === currentTask
      ? s.taskResult
      : null;
  const taskNavigation = (
    <TabsList
      presentation="workspace"
      flow="wrap"
      className="mb-[24px] w-fit max-w-full justify-start"
    >
      <TabsTrigger value="identity" tooltip={t("hints.custom.agentTab.identity")}>
        {t("strict.task.identity")}
      </TabsTrigger>
      <TabsTrigger value="capabilities" tooltip={t("hints.custom.agentTab.capabilities")}>
        {t("strict.task.models")}
      </TabsTrigger>
      <TabsTrigger value="tools" tooltip={t("hints.custom.agentTab.tools")}>
        {t("strict.tools.title")}
      </TabsTrigger>
      <TabsTrigger value="access" tooltip={t("hints.custom.agentTab.access")}>
        {t("strict.reading.title")}
      </TabsTrigger>
    </TabsList>
  );
  return (
    <div className="workspace-page h-full min-h-0 overflow-y-auto">
      {!studio ? (
        <WorkspacePageHeader
          location={t("brand.workspace", { "0": t("library.assistant") })}
          title={t("library.your.agents")}
          description={t("library.define.each.agent.s.identity.model.capabilities.and.resource")}
          actions={
            <Button
              disabled={s.editorLoading || s.settingsSaving}
              aria-label={t("library.create.assistant")}
              className="max-[480px]:size-9 max-[480px]:p-0"
              tooltip={t("hints.agent.create")}
              onClick={() => select("__new__")}
            >
              <Plus />
              <span className="max-[480px]:hidden">{t("library.create.assistant")}</span>
            </Button>
          }
        />
      ) : (
        <WorkspacePageHeader
          backAction={
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  className="shrink-0"
                  aria-label={t("library.all.assistants")}
                  onClick={() =>
                    s.workspaceReturns.length ? s.returnWorkspaceTarget() : setStudio(false)
                  }
                >
                  <ArrowLeft className="size-3.5" aria-hidden="true" />
                  <span className="sr-only">{t("library.all.assistants")}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("hints.agent.directory")}</TooltipContent>
            </Tooltip>
          }
          location={`${t("strict.workspace")} › ${t("library.assistant")}${current ? ` › ${current.agent.name}` : ""}`}
          title={
            isNew
              ? t("library.create.assistant")
              : t("agent.configuration.title", { name: current?.agent.name ?? "" })
          }
          description={t(
            !isNew && current
              ? "agent.configuration.hint"
              : "library.define.each.agent.s.identity.model.capabilities.and.resource",
          )}
        />
      )}
      {!studio ? (
        <>
          {s.error && (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {translateNotice(s.error)}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-52 flex-1">
              <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input
                className="pl-9"
                aria-label={t("library.search.agents")}
                placeholder={t("library.search.agents")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Badge variant="secondary">
              {visible.length} {t("library.assistant")}
            </Badge>
            <Button
              variant="outline"
              disabled={s.editorLoading || s.settingsSaving}
              tooltip={t("hints.agent.selectVisible")}
              onClick={() => setSelection(visible.map((agent) => agent.id))}
            >
              {t("library.select.current.results")}
            </Button>
            {selection.length > 0 && (
              <Button
                variant="ghost"
                tooltip={t("hints.agent.clearSelection")}
                onClick={() => setSelection([])}
              >
                {t("library.clear.selection")}
              </Button>
            )}
            {selection.length > 0 && (
              <Button
                variant="destructive"
                disabled={s.editorLoading || s.settingsSaving}
                tooltip={t("hints.agent.deleteSelected")}
                onClick={() => requestDelete(selection)}
              >
                <Trash2 />
                {t("library.delete.selected")} · {selection.length}
              </Button>
            )}
          </div>
          <div
            ref={directoryRef}
            className="mt-[24px] grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-[16px] [&>[data-slot=card]]:[contain-intrinsic-block-size:auto_none] data-[render-ready=true]:[&>[data-slot=card]]:[content-visibility:auto]"
          >
            {visible.map((agent) => (
              <DirectoryRow
                key={agent.id}
                agent={agent}
                checked={selectedSet.has(agent.id)}
                isEditing={s.editorAgentId === agent.id}
                isDefault={s.selectedNewSessionAgentId === agent.id}
                busy={s.editorLoading || s.settingsSaving}
                onOpen={select}
                onToggle={toggleSelected}
                onSetDefault={s.setNewSessionAgent}
              />
            ))}
          </div>
          {visible.length === 0 && (
            <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
              {t("library.no.matching.agents.create.one.or.adjust.your.search")}
            </div>
          )}
        </>
      ) : s.editorLoading && !refreshingCurrent ? (
        <p role="status">{t("library.loading")}</p>
      ) : isNew && s.editorDraft ? (
        <div className="max-w-2xl">
          <SettingsGroup
            title={t("library.create.assistant")}
            description={t(
              "library.after.creating.your.agent.configure.its.personality.context.and",
            )}
            icon={Bot}
          >
            <form
              className="space-y-5 p-5"
              onSubmit={(e) => {
                e.preventDefault();
                void s.createAgent();
              }}
            >
              <Field label="library.name" tooltip={t("hints.agent.fieldName")}>
                <Input
                  value={s.editorDraft.name}
                  onChange={(e) => s.patchNewAgentDraft({ name: e.target.value })}
                  disabled={s.settingsSaving}
                  required
                  maxLength={100}
                />
              </Field>
              <Field label="library.description" tooltip={t("hints.agent.fieldDescription")}>
                <Textarea
                  value={s.editorDraft.description}
                  onChange={(e) => s.patchNewAgentDraft({ description: e.target.value })}
                  disabled={s.settingsSaving}
                />
              </Field>
              <Field label="library.chat.model" tooltip={t("hints.agent.fieldChatModel")}>
                <InputSuggestions
                  suggestions={modelSuggestions}
                  value={s.editorDraft.model_name}
                  onValueChange={(value) => s.patchNewAgentDraft({ model_name: value })}
                  disabled={s.settingsSaving}
                />
              </Field>
              <Field
                label="library.additional.instructions"
                tooltip={t("hints.agent.fieldAdditionalInstructions")}
              >
                <Textarea
                  rows={5}
                  value={s.editorDraft.additional_instructions}
                  onChange={(e) =>
                    s.patchNewAgentDraft({ additional_instructions: e.target.value })
                  }
                  disabled={s.settingsSaving}
                />
              </Field>
              <Button
                type="submit"
                disabled={s.settingsSaving || !s.editorDraft.name.trim()}
                tooltip={t("hints.agent.submitCreate")}
                disabledReason={
                  !s.editorDraft.name.trim() ? t("hints.agent.submitCreateDisabledName") : undefined
                }
              >
                {t("library.create.assistant")}
              </Button>
            </form>
          </SettingsGroup>
        </div>
      ) : current ? (
        <>
          <div
            data-visual="agent-workspace-toolbar"
            className="mb-[16px] grid grid-cols-1 gap-2.5 sm:flex sm:flex-wrap sm:items-center sm:justify-between"
          >
            <div className="flex flex-wrap items-center gap-[8px]">
              <Badge variant="outline">{current.agent.id.slice(0, 8)}</Badge>
              <Badge
                variant="secondary"
                className="max-w-[200px] truncate"
                title={current.agent.model_name}
              >
                {current.agent.model_name}
              </Badge>
              {isTaskDirty && <Badge>{t("library.unsaved.changes")}</Badge>}
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
              {currentTask === "materials" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={s.settingsSaving || s.editorLoading || s.knowledgeReadLoading}
                  onClick={() => void s.refreshSettingsAgent({ materials: true })}
                >
                  {t("capabilities.resources.refreshBaseline")}
                </Button>
              )}
              {
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      !isTaskDirty || s.settingsSaving || s.permissionSaving || s.editorLoading
                    }
                    tooltip={t("hints.agent.discard")}
                    disabledReason={t("hints.agent.noChangesToDiscard")}
                    onClick={() => s.discardSettingsTask(currentTask)}
                  >
                    {t("library.discard.changes")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={
                      !isTaskDirty || s.settingsSaving || s.permissionSaving || s.editorLoading
                    }
                    tooltip={t("hints.agent.saveAll")}
                    disabledReason={t("hints.agent.noChangesToSave")}
                    onClick={() => void s.saveSettingsTask(currentTask)}
                  >
                    {t("library.save.agent")}
                  </Button>
                </>
              }
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("library.delete.agent")}
                tooltip={t("hints.agent.deleteSingle")}
                onClick={() => requestDelete([current.agent.id])}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          {(taskResult?.error || s.error) && (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {translateNotice(taskResult?.error || s.error || "")}
            </p>
          )}
          {taskResult?.feedback && (
            <p role="status" className="mb-3 text-sm text-muted-foreground">
              {translateNotice(taskResult.feedback)}
            </p>
          )}
          <Tabs
            value={tab}
            onValueChange={(next) => {
              setTab(next);
              if (!visitedTabs.includes(next)) setVisitedTabs((prev) => [...prev, next]);
              if (next === "capabilities") {
                s.syncSettingsRoute("context");
              } else if (next === "identity") {
                s.syncSettingsRoute("identity");
              } else if (next === "access") {
                s.syncSettingsRoute("memory-tools");
              } else if (next === "tools") {
                s.syncSettingsRoute("agent-tools");
              }
            }}
            className="agent-workspace-content gap-0"
          >
            {taskNavigation}

            {(tab === "identity" || visitedTabs.includes("identity")) && (
              <TabsContent value="identity" forceMount className="data-[state=inactive]:hidden">
                <IdentityEditor />
              </TabsContent>
            )}
            {(tab === "capabilities" || visitedTabs.includes("capabilities")) && (
              <TabsContent value="capabilities" forceMount className="data-[state=inactive]:hidden">
                <CapabilityEditor active={active && tab === "capabilities"} embedded />
              </TabsContent>
            )}
            {(tab === "tools" || visitedTabs.includes("tools")) && (
              <TabsContent value="tools" forceMount className="data-[state=inactive]:hidden">
                <AgentToolScope agentId={current.agent.id} active={active && tab === "tools"} />
              </TabsContent>
            )}
            {(tab === "access" || visitedTabs.includes("access")) && (
              <TabsContent value="access" forceMount className="data-[state=inactive]:hidden">
                <div className="space-y-6">
                  <AgentMaterials active={active && tab === "access"} />
                </div>
              </TabsContent>
            )}
          </Tabs>
        </>
      ) : s.agents.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
          <p className="text-sm text-muted-foreground">{t("capabilities.memory.noAgent")}</p>
          <Button tooltip={t("hints.agent.create")} onClick={() => select("__new__")}>
            {t("library.create.assistant")}
          </Button>
        </div>
      ) : s.error ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 p-4">
            <p role="alert" className="text-sm text-destructive">
              {translateNotice(s.error)}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={s.editorLoading}
              tooltip={t("hints.agent.retry")}
              onClick={() => targetId && void s.requestAgentNavigation(targetId, s.settingsRoute)}
            >
              {t("capabilities.retry")}
            </Button>
          </div>
        </div>
      ) : (
        <p>{t("library.select.an.agent.to.start.editing")}</p>
      )}
      <ConfirmDialog
        open={active && deleteIds !== null}
        message={deleteTarget.current?.message ?? ""}
        onCancel={() => setDeleteIds(null)}
        onConfirm={() => {
          const ids = deleteTarget.current?.ids;
          if (!ids) return;
          return s.deleteAgents(ids).then(() => {
            const state = useSuperstringStore.getState();
            const surviving = new Set(state.agents.map((agent) => agent.id));
            // 单对象删除只移除被删项，不覆盖目录里已有的多选。
            setSelection((previous) => previous.filter((id) => surviving.has(id)));
            setDeleteIds(null);
            if (!surviving.has(state.editorAgentId)) setStudio(false);
          });
        }}
      />
    </div>
  );
}

const DirectoryIdentity = memo(function DirectoryIdentity({
  agent,
  onOpen,
}: {
  agent: AgentResponse;
  onOpen: (id: string) => void;
}) {
  const t = useTranslation().t;
  return (
    <>
      <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Bot />
      </div>
      <div className="min-w-0 flex-1">
        <Button
          variant="link"
          className="h-auto max-w-full justify-start p-0 text-[16px] font-semibold"
          tooltip={t("hints.agent.openStudio")}
          data-agent-open={agent.id}
          onClick={() => onOpen(agent.id)}
        >
          {agent.name}
        </Button>
        <p className="mt-1 line-clamp-2 min-h-10 text-sm text-muted-foreground">
          {agent.description || t("library.no.description.yet")}
        </p>
      </div>
    </>
  );
});

const DirectoryActions = memo(function DirectoryActions({
  agent,
  isDefault,
  busy,
  onOpen,
  onSetDefault,
}: {
  agent: AgentResponse;
  isDefault: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onSetDefault: (id: string) => void;
}) {
  const t = useTranslation().t;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Badge variant={agent.is_active ? "secondary" : "outline"}>
          {t(agent.is_active ? "library.enabled" : "library.disabled")}
        </Badge>
        <Badge variant="outline" className="max-w-full truncate">
          {agent.model_name}
        </Badge>
      </div>
      <div className="flex items-center justify-between border-t pt-3">
        <Button
          size="sm"
          variant={isDefault ? "secondary" : "ghost"}
          disabled={!agent.is_active || busy}
          tooltip={t("hints.agent.setDefault")}
          disabledReason={
            !agent.is_active ? t("hints.agent.setDefaultDisabledInactive") : undefined
          }
          onClick={() => onSetDefault(agent.id)}
        >
          {t(
            isDefault
              ? "library.default.for.new.conversations"
              : "library.use.for.new.conversations",
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          tooltip={t("hints.agent.openStudio")}
          onClick={() => onOpen(agent.id)}
        >
          {t("library.open.studio")}
        </Button>
      </div>
    </>
  );
});

const DirectoryRow = memo(function DirectoryRow({
  agent,
  checked,
  isDefault,
  isEditing,
  busy,
  onOpen,
  onToggle,
  onSetDefault,
}: {
  agent: AgentResponse;
  checked: boolean;
  isDefault: boolean;
  isEditing: boolean;
  busy: boolean;
  onOpen: (id: string) => void;
  onToggle: (id: string, checked: boolean) => void;
  onSetDefault: (id: string) => void;
}) {
  const t = useTranslation().t;
  return (
    <Card
      className={`group py-[20px] transition-colors ${
        isEditing ? "border-primary bg-primary/5" : "hover:border-primary/50"
      }`}
    >
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3">
          <DirectoryIdentity agent={agent} onOpen={onOpen} />
          <Checkbox
            aria-label={t("library.select.value", { "0": agent.name })}
            disabled={busy}
            checked={checked}
            onCheckedChange={(v) => onToggle(agent.id, v === true)}
          />
        </div>
        <DirectoryActions
          agent={agent}
          isDefault={isDefault}
          busy={busy}
          onOpen={onOpen}
          onSetDefault={onSetDefault}
        />
      </CardContent>
    </Card>
  );
});
