import {
  ArrowLeft,
  ChevronRight,
  Database,
  MessagesSquare,
  Plug,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Field } from "../../components/form-field";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { invalidSchemeInputs } from "../../features/qq/draft-state";
import { qqSchemeDirty } from "../../features/qq/types";
import { useQqInput } from "../../features/qq/use-qq-input";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SCHEME_CATALOG, type SchemeAppEntry, schemeRowsOf } from "../../workspace/scheme-catalog";
import type { SettingsRoute } from "../../workspace/settings-routes";
import { WorkspaceHelp } from "../../workspace/WorkspaceHelp";
import { WorkspacePageHeader } from "../../workspace/WorkspacePageHeader";
import { QqGroupConfigPage } from "./group-config";
import { QqConnectionTab, type QqConnectionTask } from "./qq-app-management";
import { SchemeBindingsView } from "./scheme-bindings";
import { SchemeStudio } from "./scheme-studio";
import { StorageInventory } from "./storage-inventory";

function refreshSchemes() {
  const state = useSuperstringStore.getState();
  void state.refreshQqScheme();
  void state.loadQqBindings(true);
}

function openScheme(id: string) {
  useSuperstringStore.getState().requestQqSchemeNavigation(id);
}

export function SchemeDirectory({ active = true }: { active?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const s = useSuperstringStore(
    useShallow((state) => ({
      qqSchemeSaving: state.qqSchemeSaving,
      qqSchemesLoading: state.qqSchemesLoading,
      qqInputs: state.qqInputs,
      qqSchemeEditor: state.qqSchemeEditor,
      loadQqSchemes: state.loadQqSchemes,
      loadQqBindings: state.loadQqBindings,
      selectQqScheme: state.selectQqScheme,
      settingsRoute: state.settingsRoute,
      qqSchemesLoaded: state.qqSchemesLoaded,
      qqSchemes: state.qqSchemes,
      createQqScheme: state.createQqScheme,
      saveQqScheme: state.saveQqScheme,
      qqBindingsLoaded: state.qqBindingsLoaded,
      qqBindings: state.qqBindings,
      openSettingsRoute: state.openSettingsRoute,
      error: state.error,
      qqBindingsError: state.qqBindingsError,
    })),
  );
  const [query, setQuery] = useState("");
  const [appFilter, setAppFilter] = useState("all");
  const [usageFilter, setUsageFilter] = useState("all");
  const [naming, setNaming] = useState(false);
  const [draftStep, setDraftStep] = useState(false);
  const [newName, setNewName] = useQqInput("schemeNewName");
  const { loadQqSchemes, loadQqBindings, selectQqScheme } = s;
  const busy = s.qqSchemeSaving || s.qqSchemesLoading;
  const invalidDraft =
    Object.keys(s.qqInputs.schemeInvalid).length > 0 || invalidSchemeInputs(s).length > 0;
  const dirtyDraft = qqSchemeDirty(s.qqSchemeEditor) || invalidDraft;

  useEffect(() => {
    if (!active) return;
    void loadQqSchemes();
    void loadQqBindings();
  }, [active, loadQqSchemes, loadQqBindings]);

  useEffect(() => {
    if (!active) return;
    if (dirtyDraft) return;
    const isLibrary =
      s.settingsRoute === "scheme-library" ||
      s.settingsRoute === "qq-app-schemes" ||
      !s.settingsRoute;
    if (isLibrary && !s.qqSchemeEditor && s.qqSchemesLoaded && s.qqSchemes.length > 0) {
      selectQqScheme(s.qqSchemes[0].id);
    }
  }, [
    active,
    dirtyDraft,
    s.settingsRoute,
    s.qqSchemeEditor,
    s.qqSchemesLoaded,
    s.qqSchemes,
    selectQqScheme,
  ]);
  const openNaming = () => {
    setDraftStep(false);
    setNaming(true);
  };
  const closeNaming = () => {
    setNaming(false);
    setDraftStep(false);
  };
  const createNow = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    const before = useSuperstringStore.getState().qqSchemeEditor?.source.id ?? null;
    if (!(await s.createQqScheme(name))) return;
    closeNaming();
    setNewName("");
    const editor = useSuperstringStore.getState().qqSchemeEditor;
    if (editor && editor.source.id !== before) openScheme(editor.source.id);
  };
  const saveThenCreate = async () => {
    if (!(await s.saveQqScheme())) return;
    await createNow();
  };
  const needle = query.trim().toLocaleLowerCase(i18n.language);
  const apps = SCHEME_CATALOG.filter((app) => appFilter === "all" || app.id === appFilter);
  const visibleOf = (app: SchemeAppEntry) =>
    schemeRowsOf(s, app).filter((row) => {
      if (s.qqBindingsLoaded) {
        if (usageFilter === "used" && !(row.bindings !== null && row.bindings > 0)) return false;
        if (usageFilter === "unused" && row.bindings !== 0) return false;
      }
      if (!needle) return true;
      return `${row.scheme.name} ${row.scheme.description ?? ""}`
        .toLocaleLowerCase(i18n.language)
        .includes(needle);
    });

  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t("workspace.schemes")}>
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-4 sm:gap-4">
        <div className="relative min-w-0 basis-full sm:basis-64 sm:flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label={t("schemes.search")}
            placeholder={t("schemes.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <NativeSelect
          aria-label={t("schemes.appFilter")}
          value={appFilter}
          onChange={(event) => setAppFilter(event.target.value)}
        >
          <option value="all">{t("schemes.filterAll")}</option>
          {SCHEME_CATALOG.map((app) => (
            <option key={app.id} value={app.id}>
              {t(app.nameKey)}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label={t("schemes.usageFilter")}
          value={usageFilter}
          disabled={!s.qqBindingsLoaded}
          onChange={(event) => setUsageFilter(event.target.value)}
        >
          <option value="all">{t("schemes.filterAll")}</option>
          <option value="used">{t("schemes.usageUsed")}</option>
          <option value="unused">{t("schemes.usageUnused")}</option>
        </NativeSelect>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          tooltip={t("hints.qq.refreshSchemes")}
          onClick={refreshSchemes}
        >
          <RefreshCw />
          {t("schemes.refresh")}
        </Button>
        <Button disabled={busy} tooltip={t("hints.qq.newScheme")} onClick={openNaming}>
          <Plus />
          {t("connections.newScheme")}
        </Button>
      </div>
      {!s.qqBindingsLoaded && (
        <div className="border-b px-4 py-2">
          <p className="text-xs text-muted-foreground">{t("schemes.usageUnavailable")}</p>
        </div>
      )}
      {(s.error || s.qqBindingsError) && !s.qqSchemesLoading && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <p role="alert" className="text-sm text-destructive">
            {translateNotice(s.error ?? s.qqBindingsError ?? "")}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            tooltip={t("hints.qq.refreshSchemes")}
            onClick={refreshSchemes}
          >
            {t("schemes.refresh")}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-[24px]" data-workspace-scroll>
        {apps.map((app) => {
          const allRows = schemeRowsOf(s, app);
          const visibleRows = visibleOf(app);
          return (
            <section
              key={app.id}
              className="mb-8 min-w-0 space-y-4 last:mb-0"
              aria-label={t(app.nameKey)}
            >
              <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 px-1 py-2">
                <app.icon className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-medium">{t(app.nameKey)}</h2>
                <WorkspaceHelp title={t(app.nameKey)} description={t(app.descriptionKey)} />
              </div>
              {visibleRows.length > 0 ? (
                <ul className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-5">
                  {visibleRows.map((row) => (
                    <li key={row.scheme.id}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            data-scheme-open={row.scheme.id}
                            disabled={busy}
                            onClick={() => openScheme(row.scheme.id)}
                            className="grid h-full w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-4 rounded-[10px] border border-border bg-card p-4 text-left transition-colors hover:border-[var(--border-hover)] hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary disabled:pointer-events-none disabled:opacity-60 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:p-6"
                          >
                            <span className="col-span-2 min-w-0 sm:col-span-1">
                              <span className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-medium">{row.scheme.name}</span>
                                <Badge
                                  variant="outline"
                                  className="h-auto max-w-full whitespace-normal break-words text-left"
                                >
                                  {t("schemes.sharedScope")}
                                </Badge>
                                {row.unsavedDraft && (
                                  <Badge
                                    variant="secondary"
                                    className="h-auto max-w-full whitespace-normal break-words text-left"
                                  >
                                    {t("schemes.draftUnsaved")}
                                  </Badge>
                                )}
                              </span>
                              {row.scheme.description && (
                                <span className="mt-2 block text-xs leading-[1.6] text-muted-foreground">
                                  {row.scheme.description}
                                </span>
                              )}
                            </span>
                            <span className="max-w-full shrink-0 whitespace-normal text-xs text-muted-foreground">
                              {row.bindings === null
                                ? t("schemes.usageUnknown")
                                : t("schemes.usageCount", { "0": row.bindings })}
                            </span>
                            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>{t("strict.hints.schemeOpen")}</TooltipContent>
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3">
                  <p role="status" className="text-sm text-muted-foreground">
                    {s.qqSchemesLoading
                      ? t("schemes.loading")
                      : allRows.length
                        ? t("schemes.noMatch")
                        : t("schemes.empty")}
                  </p>
                  {!s.qqSchemesLoading && !allRows.length && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      tooltip={t("hints.qq.newScheme")}
                      onClick={openNaming}
                    >
                      <Plus />
                      {t("connections.newScheme")}
                    </Button>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
      <Dialog
        open={naming}
        onOpenChange={(open) => {
          if (!open && !busy) closeNaming();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("connections.newScheme")}</DialogTitle>
            <DialogDescription>
              {t("connections.aSharedSchemeMayAffectSeveralConversationsReviewIts")}
            </DialogDescription>
          </DialogHeader>
          {draftStep ? (
            <>
              <p className="text-sm">{t("schemes.studio.draftGuardMessage")}</p>
              {s.error && (
                <p role="alert" className="text-sm text-destructive">
                  {translateNotice(s.error)}
                </p>
              )}
              <DialogFooter>
                <Button
                  tooltip={<Trans i18nKey="hints.complete.cancel" />}
                  variant="outline"
                  disabled={busy}
                  onClick={closeNaming}
                >
                  {t("connections.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  tooltip={t("hints.qq.draftDiscardAndContinue")}
                  onClick={() => void createNow()}
                >
                  {t("workspace.discard_and_continue")}
                </Button>
                <Button
                  disabled={busy || invalidDraft}
                  tooltip={t("hints.qq.draftSaveAndContinue")}
                  onClick={() => void saveThenCreate()}
                >
                  {t("workspace.save_and_continue")}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <Field label="connections.schemeName" tooltip={t("hints.fieldExtra.schemeName")}>
                <Input
                  value={newName}
                  disabled={busy}
                  onChange={(event) => setNewName(event.target.value)}
                />
              </Field>
              {s.error && (
                <p role="alert" className="text-sm text-destructive">
                  {translateNotice(s.error)}
                </p>
              )}
              <DialogFooter>
                <Button
                  tooltip={<Trans i18nKey="hints.complete.cancel" />}
                  variant="outline"
                  disabled={busy}
                  onClick={closeNaming}
                >
                  {t("connections.cancel")}
                </Button>
                <Button
                  tooltip={t("hints.qq.newSchemeConfirm")}
                  disabled={busy || !newName.trim()}
                  onClick={() => {
                    if (dirtyDraft) setDraftStep(true);
                    else void createNow();
                  }}
                >
                  {t("connections.confirm")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function SchemeDetail({ app, active }: { app: SchemeAppEntry; active: boolean }) {
  const { t } = useTranslation();
  const s = useSuperstringStore(
    useShallow((state) => ({
      qqSchemeSaving: state.qqSchemeSaving,
      qqAccessSaving: state.qqAccessSaving,
      qqSchemesLoading: state.qqSchemesLoading,
      qqSchemeView: state.qqSchemeView,
      qqSchemeEditor: state.qqSchemeEditor,
      qqSchemeUsage: state.qqSchemeUsage,
      qqBindings: state.qqBindings,
      qqBindingsLoaded: state.qqBindingsLoaded,
      openSettingsRoute: state.openSettingsRoute,
      requestQqSchemeNavigation: state.requestQqSchemeNavigation,
      loadQqSchemes: state.loadQqSchemes,
      qqSchemeUsageError: state.qqSchemeUsageError,
    })),
  );
  const busy = s.qqSchemeSaving || s.qqAccessSaving || s.qqSchemesLoading;
  const view: "settings" | "bindings" = s.qqSchemeView === "bindings" ? "bindings" : "settings";
  const schemeId = s.qqSchemeEditor?.source.id ?? null;
  const usage =
    view === "bindings" && schemeId && s.qqBindingsLoaded
      ? s.qqBindings.filter((binding) => binding.scheme_id === schemeId).length
      : s.qqSchemeUsage && schemeId && s.qqSchemeUsage.schemeId === schemeId
        ? s.qqSchemeUsage.bindings
        : null;
  const back = () => s.openSettingsRoute("scheme-library");
  const switchView = (next: string) => {
    if (!schemeId) return;
    s.requestQqSchemeNavigation(schemeId, next === "bindings" ? "bindings" : "settings");
  };
  return (
    <section className="flex h-full min-h-0 w-full flex-col" aria-label={t(app.nameKey)}>
      <WorkspacePageHeader
        location={t(app.nameKey)}
        title={s.qqSchemeEditor?.name ?? t("schemes.currentScheme")}
        description={t("schemes.qq.detailNote")}
        backAction={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={back}
            disabled={busy}
            aria-label={t("schemes.backToCatalog")}
            tooltip={t("hints.qq.backToCatalog")}
          >
            <ArrowLeft />
          </Button>
        }
      />
      <header className="mb-6 shrink-0 space-y-4">
        <Tabs value={view} onValueChange={switchView} className="min-w-0">
          <TabsList className="w-full justify-start gap-[4px] group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-auto [&_[role=tab]]:min-h-[36px] [&_[role=tab]]:min-w-0 [&_[role=tab]]:flex-1 [&_[role=tab]]:whitespace-normal sm:w-auto sm:[&_[role=tab]]:flex-none">
            <TabsTrigger value="settings" disabled={busy || !schemeId}>
              {t("schemes.bindings.viewSettings")}
            </TabsTrigger>
            <TabsTrigger value="bindings" disabled={busy || !schemeId} data-scheme-usage>
              {t("schemes.bindings.viewBindings")}
              {usage !== null && (
                <span
                  role="status"
                  className="ml-1 tabular-nums"
                  aria-label={t("schemes.usageCount", { "0": usage })}
                >
                  ({usage})
                </span>
              )}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {usage === null && schemeId && (
          <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            {t("schemes.usageUnknown")}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              tooltip={t("hints.qq.usageRetry")}
              onClick={() => void s.loadQqSchemes()}
            >
              {t("capabilities.retry")}
            </Button>
            {s.qqSchemeUsageError && (
              <span role="alert" className="text-destructive">
                {translateNotice(s.qqSchemeUsageError)}
              </span>
            )}
          </span>
        )}
      </header>
      <div
        hidden={view !== "settings" && !!schemeId}
        className="min-h-0 flex-1 overflow-hidden [&[hidden]]:hidden"
      >
        <SchemeStudio active={active && view === "settings"} breadcrumb={false} embedded />
      </div>
      {view === "bindings" && schemeId && (
        <div
          className="min-h-0 flex-1 overflow-y-auto px-4 py-6"
          data-workspace-scroll
          data-scheme-view="bindings"
        >
          <SchemeBindingsView schemeId={schemeId} active={active} />
        </div>
      )}
    </section>
  );
}

const CONNECTION_TASK_ROUTES = [
  { task: "connection", route: "qq-connection", label: "connections.transportPage.tab" },
  { task: "events", route: "qq-events", label: "schemes.qq.eventsTitle" },
  { task: "runtime", route: "qq-runtime", label: "schemes.qq.runtimeTitle" },
] as const;

function QqSettingsPane({ active, route }: { active: boolean; route: SettingsRoute }) {
  const { t } = useTranslation();
  const openSettingsRoute = useSuperstringStore((s) => s.openSettingsRoute);
  const busy = useSuperstringStore((s) => s.qqAccessSaving || s.qqManagedSaving);
  const selected = CONNECTION_TASK_ROUTES.find((entry) => entry.route === route);
  const [lastTask, setLastTask] = useState<QqConnectionTask>(() => selected?.task ?? "connection");
  useEffect(() => {
    if (selected) setLastTask(selected.task);
  }, [selected]);
  const task = selected?.task ?? lastTask;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspacePageHeader
        location={t("schemes.qq.name")}
        title={t("schemes.qq.connectionTitle")}
        description={t("connections.transportPage.hint")}
        backAction={
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={busy}
            aria-label={t("schemes.backToCatalog")}
            tooltip={t("hints.qq.backToCatalog")}
            onClick={() => openSettingsRoute("scheme-library")}
          >
            <ArrowLeft />
          </Button>
        }
      />
      <Tabs
        value={task}
        onValueChange={(next) => {
          const target = CONNECTION_TASK_ROUTES.find((entry) => entry.task === next);
          if (target && !busy) openSettingsRoute(target.route);
        }}
        className="mb-4 min-w-0"
      >
        <TabsList className="w-full max-w-full justify-start gap-1 rounded-[10px] border border-border bg-muted p-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:min-h-8 [&_[role=tab]]:h-auto [&_[role=tab]]:min-w-0 [&_[role=tab]]:flex-1 [&_[role=tab]]:whitespace-normal [&_[role=tab]]:px-3 [&_[role=tab]]:text-[13px] sm:w-auto sm:[&_[role=tab]]:flex-none">
          {CONNECTION_TASK_ROUTES.map((entry) => (
            <TabsTrigger key={entry.task} value={entry.task} disabled={busy}>
              {t(entry.label)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <QqConnectionTab active={active} task={task} />
    </div>
  );
}

type PaneKind = "list" | "object" | "bindings" | "group" | "connection" | "storage";

export function SchemesWorkspace({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const route = useSuperstringStore((s) =>
    s.settingsView === "operating-mode" ? "qq-connection" : s.settingsRoute,
  );
  const openSettingsRoute = useSuperstringStore((s) => s.openSettingsRoute);
  const s = useSuperstringStore(
    useShallow((state) => ({
      qqSchemeSaving: state.qqSchemeSaving,
      qqAccessSaving: state.qqAccessSaving,
      qqStorageSaving: state.qqStorageSaving,
      qqSchemesLoading: state.qqSchemesLoading,
      qqGroupConfigSaving: state.qqGroupConfigSaving,
      qqManagedSaving: state.qqManagedSaving,
      error: state.error,
      feedback: state.feedback,
    })),
  );
  const busy =
    s.qqSchemeSaving ||
    s.qqAccessSaving ||
    s.qqStorageSaving ||
    s.qqSchemesLoading ||
    s.qqGroupConfigSaving ||
    s.qqManagedSaving;
  const activePane: PaneKind =
    route === "qq-scheme-config"
      ? "object"
      : route === "qq-group-config"
        ? "group"
        : route === "qq-storage"
          ? "storage"
          : CONNECTION_TASK_ROUTES.some((entry) => entry.route === route)
            ? "connection"
            : route === "scheme-bindings" || route === "qq-app-groups"
              ? "bindings"
              : "list";
  const [visitedPanes, setVisitedPanes] = useState<Set<PaneKind>>(() => new Set([activePane]));
  useEffect(() => {
    setVisitedPanes((prev) => (prev.has(activePane) ? prev : new Set(prev).add(activePane)));
  }, [activePane]);
  const renderedPanes = new Set(visitedPanes).add(activePane);
  const app = SCHEME_CATALOG[0];
  return (
    <section
      className="mx-auto flex h-full min-h-0 w-full max-w-[1160px] flex-col px-[36px] pt-[28px] pb-[64px] max-[768px]:px-[16px] max-[768px]:pt-[20px] max-[768px]:pb-[48px]"
      aria-label={t("workspace.schemes")}
    >
      {activePane === "list" && (
        <>
          <WorkspacePageHeader
            location={t("brand.workspace", { "0": t("workspace.schemes") })}
            title={t("workspace.schemes")}
            description={t("schemes.subtitle")}
          />
          <fieldset className="mb-6 flex min-w-0 flex-wrap items-center gap-2">
            <legend className="mb-2 text-sm font-medium">{t("schemes.qq.name")}</legend>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => openSettingsRoute("scheme-bindings")}
            >
              <MessagesSquare />
              {t("schemes.workspace.bindings")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => openSettingsRoute("qq-connection")}
            >
              <Plug />
              {t("schemes.qq.connectionTitle")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => openSettingsRoute("qq-storage")}
            >
              <Database />
              {t("connections.dataRetention")}
            </Button>
            <WorkspaceHelp title={t("schemes.qq.name")} description={t("schemes.qq.scopeNote")} />
          </fieldset>
        </>
      )}
      {activePane === "bindings" && (
        <WorkspacePageHeader
          location={t("schemes.qq.name")}
          title={t("schemes.workspace.bindings")}
          description={t("schemes.bindings.boardHint")}
          backAction={
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              aria-label={t("schemes.backToCatalog")}
              tooltip={t("hints.qq.backToCatalog")}
              onClick={() => openSettingsRoute("scheme-library")}
            >
              <ArrowLeft />
            </Button>
          }
        />
      )}
      {(s.error || s.feedback) &&
        activePane !== "storage" &&
        activePane !== "group" &&
        activePane !== "list" && (
          <p
            role={s.error ? "alert" : "status"}
            className={`mb-3 text-sm ${s.error ? "text-destructive" : "text-muted-foreground"}`}
          >
            {translateNotice(s.error ?? s.feedback)}
          </p>
        )}

      {renderedPanes.has("list") && (
        <div
          hidden={activePane !== "list"}
          className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
          data-qq-retained-scroll="schemes"
        >
          <SchemeDirectory active={active && activePane === "list"} />
        </div>
      )}

      {renderedPanes.has("object") && (
        <div
          hidden={activePane !== "object"}
          className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
        >
          <SchemeDetail app={app} active={active && activePane === "object"} />
        </div>
      )}

      {renderedPanes.has("bindings") && (
        <div
          hidden={activePane !== "bindings"}
          className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
          data-qq-retained-scroll="groups"
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6" data-workspace-scroll>
            <SchemeBindingsView picker active={active && activePane === "bindings"} />
          </div>
        </div>
      )}

      {renderedPanes.has("group") && (
        <div
          hidden={activePane !== "group"}
          className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
        >
          <QqGroupConfigPage active={active && activePane === "group"} />
        </div>
      )}

      {renderedPanes.has("connection") && (
        <div
          hidden={activePane !== "connection"}
          className="flex min-h-0 flex-1 flex-col [&[hidden]]:hidden"
        >
          <QqSettingsPane active={active && activePane === "connection"} route={route} />
        </div>
      )}
      {renderedPanes.has("storage") && (
        <div
          hidden={activePane !== "storage"}
          className="min-h-0 flex-1 overflow-y-auto [&[hidden]]:hidden"
          data-workspace-scroll
          data-qq-retained-scroll="data"
        >
          <StorageInventory active={active && activePane === "storage"} />
        </div>
      )}
    </section>
  );
}
