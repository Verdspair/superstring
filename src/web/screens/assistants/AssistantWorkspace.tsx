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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { dirtyPages } from "@/features/agents/page-drafts";
import { returnFromContextAllocation } from "@/features/context-allocation";
import { translateNotice } from "@/i18n";
import { useSuperstringStore } from "@/store";
import type { AgentResponse } from "../../../shared/contracts";
import { KnowledgeToolSettings, MemoryToolSettings } from "./ResourceRules";
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
      modelNames: state.modelNames,
      openSettingsRoute: state.openSettingsRoute,
      pageEditor: state.pageEditor,
      patchDraft: state.patchDraft,
      pendingOperations: state.pendingOperations,
      refreshModels: state.refreshModels,
      requestAgentNavigation: state.requestAgentNavigation,
      saveAllSettingsPages: state.saveAllSettingsPages,
      saveCurrentSection: state.saveCurrentSection,
      selectedNewSessionAgentId: state.selectedNewSessionAgentId,
      setNewSessionAgent: state.setNewSessionAgent,
      settingsRoute: state.settingsRoute,
      settingsSaving: state.settingsSaving,
      settingsView: state.settingsView,
      contextAllocationTarget: state.contextAllocationTarget,
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
  const initialTab =
    s.settingsRoute === "models" || s.settingsRoute === "context"
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
    if (s.settingsRoute === "models" || s.settingsRoute === "context") {
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

  // 冷入口目标水合：当直达 context/memory-tools/knowledge-tools 且未就绪时，水合目标助手
  // 严格核验目标 ID 存在于 s.agents 中，尊重新草稿的脏保护，并在目标切换后支持继续水合
  const hydratedTargetRef = useRef<string | null>(null);
  const targetAgent =
    (s.editorAgentId && s.editorAgentId !== "__new__"
      ? s.agents.find((a) => a.id === s.editorAgentId)
      : null) ??
    s.agents.find((a) => a.id === s.selectedNewSessionAgentId) ??
    s.agents[0];
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
  const select = useCallback(
    (id: string) => {
      if (s.editorLoading || s.settingsSaving) return;
      s.requestAgentNavigation(id);
      setStudio(true);
    },
    [s.editorLoading, s.settingsSaving, s.requestAgentNavigation],
  );
  const current = s.pageEditor;
  const isNew = s.editorAgentId === "__new__";
  const dirty = dirtyPages(current).length > 0;
  const taskNavigation = (
    <TabsList className="mb-[24px] h-auto min-h-[42px] group-data-horizontal/tabs:h-[42px] w-fit max-w-full justify-start flex-nowrap overflow-x-auto gap-[6px] rounded-[10px] border border-border bg-muted p-[4px] [&_[role=tab]]:h-[32px] [&_[role=tab]]:rounded-[6px] [&_[role=tab]]:shrink-0 [&_[role=tab]]:flex-none [&_[role=tab]]:border-0 [&_[role=tab][data-state=active]]:border [&_[role=tab][data-state=active]]:border-border [&_[role=tab][data-state=active]]:bg-card [&_[role=tab][data-state=active]]:font-semibold [&_[role=tab]]:px-[14px] [&_[role=tab]]:text-[13px] [&_[role=tab]]:font-medium">
      <TabsTrigger value="access" tooltip={t("hints.custom.agentTab.access")}>
        {t("strict.reading.title")}
      </TabsTrigger>
      <TabsTrigger value="identity" tooltip={t("hints.custom.agentTab.identity")}>
        {t("strict.task.identity")}
      </TabsTrigger>
      <TabsTrigger value="capabilities" tooltip={t("hints.custom.agentTab.capabilities")}>
        {t("strict.task.models")}
      </TabsTrigger>
      <TabsTrigger value="tools" tooltip={t("hints.custom.agentTab.tools")}>
        {t("strict.tools.title")}
      </TabsTrigger>
    </TabsList>
  );
  const readingTask = studio && !isNew && !!current && tab === "access";
  return (
    <div className="mx-auto h-full min-h-0 w-full max-w-[1160px] overflow-y-auto px-[36px] pt-[28px] pb-[64px] max-[768px]:px-[16px] max-[768px]:pt-[20px] max-[768px]:pb-[48px]">
      {!readingTask && (
        <header className="mb-[24px] flex flex-wrap items-start justify-between gap-[14px] border-b border-border pb-[20px]">
          <div className="min-w-0 flex-1">
            <p className="workspace-page-location">
              {t("strict.workspace")} › {t("library.assistant")}
              {studio && current ? ` › ${current.agent.name}` : ""}
            </p>
            <div className="flex flex-wrap items-center gap-[12px]">
              <h1 className="workspace-page-title">
                {studio
                  ? isNew
                    ? t("library.create.assistant")
                    : t(
                        tab === "tools"
                          ? "strict.tools.title"
                          : tab === "capabilities"
                            ? "strict.task.models"
                            : "strict.task.identity",
                      )
                  : t("library.your.agents")}
              </h1>
              {studio && current && (
                <span className="rounded-[9999px] border border-border bg-muted px-[10px] py-[3px] text-[12px] text-muted-foreground">
                  {t("strict.scope.object")} {current.agent.name}
                </span>
              )}
            </div>
            <p className="workspace-page-description max-w-[680px]">
              {t("library.define.each.agent.s.identity.model.capabilities.and.resource")}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {s.contextAllocationTarget?.returnRoute &&
              s.contextAllocationTarget.returnRoute !== s.settingsRoute && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={returnFromContextAllocation}
                  tooltip={t("hints.agent.returnFromContextAllocation")}
                  className="h-auto min-h-9 flex items-center gap-1.5"
                >
                  <ArrowLeft className="size-4" />
                  {t("schemes.allocation.returnTo", {
                    "0":
                      s.contextAllocationTarget.returnLabel ||
                      s.contextAllocationTarget.returnRoute,
                  })}
                </Button>
              )}
            {studio ? (
              <Button
                variant="outline"
                tooltip={t("hints.agent.directory")}
                onClick={() => setStudio(false)}
              >
                <ArrowLeft />
                {t("library.all.assistants")}
              </Button>
            ) : (
              <Button
                disabled={s.editorLoading || s.settingsSaving}
                tooltip={t("hints.agent.create")}
                onClick={() => select("__new__")}
              >
                <Plus />
                {t("library.create.assistant")}
              </Button>
            )}
          </div>
        </header>
      )}
      {!studio ? (
        <>
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
                onClick={() => setDeleteIds(selection)}
              >
                <Trash2 />
                {t("library.delete.selected")} · {selection.length}
              </Button>
            )}
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-[16px]">
            {visible.map((agent) => (
              <Card
                key={agent.id}
                className={`group border-l-[4px] border-l-primary py-[20px] transition-colors ${
                  s.editorAgentId === agent.id
                    ? "border-primary/60 ring-1 ring-primary/30"
                    : "hover:border-primary/50"
                }`}
              >
                <CardContent className="space-y-4">
                  <div className="flex items-start gap-3">
                    <DirectoryIdentity agent={agent} onOpen={select} />
                    <Checkbox
                      aria-label={t("library.select.value", { "0": agent.name })}
                      disabled={s.editorLoading || s.settingsSaving}
                      checked={selectedSet.has(agent.id)}
                      onCheckedChange={(v) =>
                        setSelection((ids) =>
                          v === true ? [...ids, agent.id] : ids.filter((id) => id !== agent.id),
                        )
                      }
                    />
                  </div>
                  <DirectoryActions
                    agent={agent}
                    isDefault={s.selectedNewSessionAgentId === agent.id}
                    busy={s.editorLoading || s.settingsSaving}
                    onOpen={select}
                    onSetDefault={s.setNewSessionAgent}
                  />
                </CardContent>
              </Card>
            ))}
          </div>
          {visible.length === 0 && (
            <div className="rounded-xl border border-dashed p-12 text-center text-muted-foreground">
              {t("library.no.matching.agents.create.one.or.adjust.your.search")}
            </div>
          )}
        </>
      ) : s.editorLoading ? (
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
                void s.saveCurrentSection();
              }}
            >
              <Field label="library.name" tooltip={t("hints.agent.fieldName")}>
                <Input
                  value={s.editorDraft.name}
                  onChange={(e) => s.patchDraft({ name: e.target.value })}
                  required
                  maxLength={100}
                />
              </Field>
              <Field label="library.description" tooltip={t("hints.agent.fieldDescription")}>
                <Textarea
                  value={s.editorDraft.description}
                  onChange={(e) => s.patchDraft({ description: e.target.value })}
                />
              </Field>
              <Field label="library.chat.model" tooltip={t("hints.agent.fieldChatModel")}>
                <Input
                  list="new-agent-models"
                  value={s.editorDraft.model_name}
                  onChange={(e) => s.patchDraft({ model_name: e.target.value })}
                />
                <datalist id="new-agent-models">
                  {s.modelNames.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
              </Field>
              <Field
                label="library.additional.instructions"
                tooltip={t("hints.agent.fieldAdditionalInstructions")}
              >
                <Textarea
                  rows={5}
                  value={s.editorDraft.additional_instructions}
                  onChange={(e) => s.patchDraft({ additional_instructions: e.target.value })}
                />
              </Field>
              <Button
                type="submit"
                disabled={s.pendingOperations > 0 || !s.editorDraft.name.trim()}
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
          {!readingTask && (
            <div className="mb-[20px] flex flex-wrap items-center gap-[8px]">
              <Badge variant="outline">{current.agent.id.slice(0, 8)}</Badge>
              <Badge variant="secondary">{current.agent.model_name}</Badge>
              {dirty && <Badge>{t("library.unsaved.changes")}</Badge>}
              <div className="ml-auto flex gap-2">
                <Button
                  variant="outline"
                  disabled={!dirty || s.settingsSaving}
                  tooltip={t("hints.agent.discard")}
                  disabledReason={t("hints.agent.noChangesToDiscard")}
                  onClick={() => s.discardSettingsPages()}
                >
                  {t("library.discard.changes")}
                </Button>
                <Button
                  disabled={!dirty || s.settingsSaving}
                  tooltip={t("hints.agent.saveAll")}
                  disabledReason={t("hints.agent.noChangesToSave")}
                  onClick={() => void s.saveAllSettingsPages()}
                >
                  {t("library.save.agent")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("library.delete.agent")}
                  tooltip={t("hints.agent.deleteSingle")}
                  onClick={() => setDeleteIds([current.agent.id])}
                >
                  <Trash2 />
                </Button>
              </div>
            </div>
          )}
          <Tabs
            value={tab}
            onValueChange={(next) => {
              setTab(next);
              if (next === "capabilities") {
                s.openSettingsRoute("context");
              } else if (next === "identity") {
                s.openSettingsRoute("identity");
              }
              // "access" stays in the current agent identity route domain without triggering route jump
            }}
            className="gap-0"
          >
            <MemoryToolSettings
              active={tab === "access"}
              navigation={taskNavigation}
              onDirectory={() => setStudio(false)}
            />
            {(tab === "identity" || visitedTabs.includes("identity")) && (
              <TabsContent value="identity" forceMount className="data-[state=inactive]:hidden">
                <IdentityEditor />
              </TabsContent>
            )}
            {(tab === "access" || visitedTabs.includes("access")) && (
              <TabsContent value="access" forceMount className="data-[state=inactive]:hidden">
                <div className="space-y-6">
                  <KnowledgeToolSettings active={active && tab === "access"} />
                </div>
              </TabsContent>
            )}
            {(tab === "capabilities" || visitedTabs.includes("capabilities")) && (
              <TabsContent value="capabilities" forceMount className="data-[state=inactive]:hidden">
                <CapabilityEditor active={active && tab === "capabilities"} />
              </TabsContent>
            )}
            {(tab === "tools" || visitedTabs.includes("tools")) && (
              <TabsContent value="tools" forceMount className="data-[state=inactive]:hidden">
                <AgentToolScope agentId={current.agent.id} active={active && tab === "tools"} />
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
      {active && deleteIds && (
        <ConfirmDialog
          message={t("library.agents.delete.named", {
            "0": deleteIds
              .map((id) => s.agents.find((agent) => agent.id === id)?.name ?? id)
              .join(", "),
          })}
          onCancel={() => setDeleteIds(null)}
          onConfirm={() => {
            return s.deleteAgents(deleteIds).then(() => {
              const surviving = new Set(
                useSuperstringStore.getState().agents.map((agent) => agent.id),
              );
              setSelection(deleteIds.filter((id) => surviving.has(id)));
              setDeleteIds(null);
              if (!surviving.has(useSuperstringStore.getState().editorAgentId)) setStudio(false);
            });
          }}
        />
      )}
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
