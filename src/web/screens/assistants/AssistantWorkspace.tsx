import { ArrowLeft, Bot, Plus, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ConfirmDialog } from "@/components/confirmation";
import { Field } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { dirtyPages } from "@/features/agents/page-drafts";
import { useSuperstringStore } from "@/store";
import { CapabilityEditor, IdentityEditor } from "./StudioEditors";

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
    })),
  );
  const t = useTranslation().t;
  const [search, setSearch] = useState("");
  const [studio, setStudio] = useState(s.settingsView === "workspace" && !!s.pageEditor);
  const [selection, setSelection] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selection), [selection]);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const initialTab =
    s.settingsRoute === "models" || s.settingsRoute === "context" ? "capabilities" : "identity";
  const [tab, setTab] = useState(initialTab);
  const [visitedTabs, setVisitedTabs] = useState([initialTab]);
  useEffect(() => {
    if (s.settingsRoute === "models" || s.settingsRoute === "context") {
      setTab("capabilities");
      setStudio(true);
    } else if (["basic", "identity", "expression"].includes(s.settingsRoute)) {
      setTab("identity");
    }
  }, [s.settingsRoute]);
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
  const select = (id: string) => {
    if (s.editorLoading || s.settingsSaving) return;
    s.requestAgentNavigation(id);
    setStudio(true);
  };
  const current = s.pageEditor;
  const isNew = s.editorAgentId === "__new__";
  const dirty = dirtyPages(current).length > 0;
  return (
    <div className="mx-auto h-full min-h-0 w-full overflow-y-auto max-w-7xl space-y-7 p-5 md:p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs font-medium tracking-widest text-muted-foreground">
            {t("brand.workspace", { "0": t("library.assistant") })}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            {studio
              ? isNew
                ? t("library.create.assistant")
                : current?.draft.name || t("library.agent.studio")
              : t("library.your.agents")}
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {t("library.define.each.agent.s.identity.model.capabilities.and.resource")}
          </p>
        </div>
        {studio ? (
          <Button variant="outline" onClick={() => setStudio(false)}>
            <ArrowLeft />
            {t("library.all.assistants")}
          </Button>
        ) : (
          <Button disabled={s.editorLoading || s.settingsSaving} onClick={() => select("__new__")}>
            <Plus />
            {t("library.create.assistant")}
          </Button>
        )}
      </header>
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
              onClick={() => setSelection(visible.map((agent) => agent.id))}
            >
              {t("library.select.current.results")}
            </Button>
            {selection.length > 0 && (
              <Button variant="ghost" onClick={() => setSelection([])}>
                {t("library.clear.selection")}
              </Button>
            )}
            {selection.length > 0 && (
              <Button
                variant="destructive"
                disabled={s.editorLoading || s.settingsSaving}
                onClick={() => setDeleteIds(selection)}
              >
                <Trash2 />
                {t("library.delete.selected")} · {selection.length}
              </Button>
            )}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((agent) => (
              <Card key={agent.id} className="group transition-colors hover:border-primary/50">
                <CardContent className="space-y-4">
                  <div className="flex items-start gap-3">
                    <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Bot />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Button
                        variant="link"
                        className="h-auto max-w-full justify-start p-0 text-base font-semibold"
                        data-agent-open={agent.id}
                        onClick={() => select(agent.id)}
                      >
                        {agent.name}
                      </Button>
                      <p className="mt-1 line-clamp-2 min-h-10 text-sm text-muted-foreground">
                        {agent.description || t("library.no.description.yet")}
                      </p>
                    </div>
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
                      variant={s.selectedNewSessionAgentId === agent.id ? "secondary" : "ghost"}
                      disabled={!agent.is_active || s.editorLoading || s.settingsSaving}
                      onClick={() => s.setNewSessionAgent(agent.id)}
                    >
                      {t(
                        s.selectedNewSessionAgentId === agent.id
                          ? "library.default.for.new.conversations"
                          : "library.use.for.new.conversations",
                      )}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => select(agent.id)}>
                      {t("library.open.studio")}
                    </Button>
                  </div>
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
        <Card className="max-w-2xl">
          <CardContent>
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                void s.saveCurrentSection();
              }}
            >
              <Field label="library.name">
                <Input
                  value={s.editorDraft.name}
                  onChange={(e) => s.patchDraft({ name: e.target.value })}
                  required
                  maxLength={100}
                />
              </Field>
              <Field label="library.description">
                <Textarea
                  value={s.editorDraft.description}
                  onChange={(e) => s.patchDraft({ description: e.target.value })}
                />
              </Field>
              <Field label="library.chat.model">
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
              <Field label="library.additional.instructions">
                <Textarea
                  rows={5}
                  value={s.editorDraft.additional_instructions}
                  onChange={(e) => s.patchDraft({ additional_instructions: e.target.value })}
                />
              </Field>
              <p className="text-sm text-muted-foreground">
                {t("library.after.creating.your.agent.configure.its.personality.context.and")}
              </p>
              <Button
                type="submit"
                disabled={s.pendingOperations > 0 || !s.editorDraft.name.trim()}
              >
                {t("library.create.assistant")}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : current ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{current.agent.id.slice(0, 8)}</Badge>
            <Badge variant="secondary">{current.agent.model_name}</Badge>
            {dirty && <Badge>{t("library.unsaved.changes")}</Badge>}
            <div className="ml-auto flex gap-2">
              {/* 资料规则的读取额度已迁到一级“系统能力”页：这里只保留一个明显的跳转入口。 */}
              <Button variant="outline" onClick={() => s.openSettingsRoute("memory-tools")}>
                <SlidersHorizontal />
                {t("capabilities.resources.openMemoryTools")}
              </Button>
              <Button
                variant="outline"
                disabled={!dirty || s.settingsSaving}
                onClick={() => s.discardSettingsPages()}
              >
                {t("library.discard.changes")}
              </Button>
              <Button
                disabled={!dirty || s.settingsSaving}
                onClick={() => void s.saveAllSettingsPages()}
              >
                {t("library.save.agent")}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("library.delete.agent")}
                onClick={() => setDeleteIds([current.agent.id])}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
          <Tabs
            value={tab}
            onValueChange={(next) => {
              setTab(next);
              s.openSettingsRoute(next === "capabilities" ? "context" : "identity");
            }}
            className="gap-6"
          >
            <TabsList className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-7">
              <TabsTrigger value="identity">{t("library.identity.expression")}</TabsTrigger>
              <TabsTrigger value="capabilities">{t("library.models.context")}</TabsTrigger>
            </TabsList>
            {(tab === "identity" || visitedTabs.includes("identity")) && (
              <TabsContent value="identity" forceMount className="data-[state=inactive]:hidden">
                <IdentityEditor />
              </TabsContent>
            )}
            {(tab === "capabilities" || visitedTabs.includes("capabilities")) && (
              <TabsContent value="capabilities" forceMount className="data-[state=inactive]:hidden">
                <CapabilityEditor active={active && tab === "capabilities"} />
              </TabsContent>
            )}
          </Tabs>
        </>
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
