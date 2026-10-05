import { ChevronLeft, ChevronRight, ListTree, Plus, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import {
  SCHEME_CATALOG,
  type SchemeAppEntry,
  schemeAppByRoute,
  schemeRowsOf,
} from "../../workspace/scheme-catalog";
import type { SettingsRoute } from "../../workspace/settings-routes";
import { QqGroupConfigPage } from "./group-config";
import { QqAppManagement, type QqAppView } from "./qq-app-management";
import { SchemeBindingsPage, SchemeBindingsView } from "./scheme-bindings";
import { SchemeStudio } from "./scheme-studio";

function refreshSchemes() {
  const state = useSuperstringStore.getState();
  void state.refreshQqScheme();
  // 显式刷新同时重读绑定，否则计数停在旧值。
  void state.loadQqBindings(true);
}

function openScheme(id: string) {
  useSuperstringStore.getState().requestQqSchemeNavigation(id);
}

/** 应用级目的地只在目录/详情里点击跳转；缺登记的应用没有第二个配置面。 */
function goAppRoute(route: SettingsRoute | undefined) {
  if (route) useSuperstringStore.getState().openSettingsRoute(route);
}

/** 应用目录复用同一份目录组件，只把应用过滤固定在目标应用上。 */
export function SchemeDirectory({
  appId,
  active = true,
}: {
  appId?: string;
  active?: boolean;
} = {}) {
  const { t, i18n } = useTranslation();
  const s = useSuperstringStore();
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
    void loadQqSchemes();
    void loadQqBindings();
  }, [loadQqSchemes, loadQqBindings]);

  useEffect(() => {
    if (!active) return;
    if (dirtyDraft) return;
    const isLibrary = s.settingsRoute === "scheme-library" || !s.settingsRoute;
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
    // 失败保留对话框、名称与旧草稿；成功时才由动作把编辑器换成新方案。
    if (!(await s.createQqScheme(name))) return;
    closeNaming();
    setNewName("");
    const editor = useSuperstringStore.getState().qqSchemeEditor;
    // 编辑器没有换上别的方案（id 未变）时无法确认新方案 id：不导航，也不装作已切换。
    if (editor && editor.source.id !== before) openScheme(editor.source.id);
  };
  const saveThenCreate = async () => {
    if (!(await s.saveQqScheme())) return;
    await createNow();
  };
  const needle = query.trim().toLocaleLowerCase(i18n.language);
  const apps = SCHEME_CATALOG.filter((app) =>
    appId ? app.id === appId : appFilter === "all" || app.id === appFilter,
  );
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
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={appId ? t("schemes.qq.name") : t("workspace.schemes")}
    >
      {!appId && (
        <header className="flex flex-wrap items-start justify-between gap-4 border-b px-4 py-5">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ListTree className="size-4 text-muted-foreground" />
              <h1 className="text-xl font-semibold tracking-tight">{t("workspace.schemes")}</h1>
            </div>
            <p className="text-sm text-muted-foreground">{t("schemes.subtitle")}</p>
          </div>
          <Button disabled={busy} onClick={openNaming}>
            <Plus />
            {t("connections.newScheme")}
          </Button>
        </header>
      )}
      <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <div className="relative min-w-52 max-w-md flex-1">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label={t("schemes.search")}
            placeholder={t("schemes.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {!appId && (
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
        )}
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
        <Button variant="outline" size="sm" disabled={busy} onClick={refreshSchemes}>
          <RefreshCw />
          {t("schemes.refresh")}
        </Button>
        {appId && (
          <Button disabled={busy} onClick={openNaming}>
            <Plus />
            {t("connections.newScheme")}
          </Button>
        )}
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
          <Button variant="outline" size="sm" disabled={busy} onClick={refreshSchemes}>
            {t("schemes.refresh")}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6" data-workspace-scroll>
        {/* 初次操作的发现性：先看说明，再经全局「会话绑定」落到与详情「使用会话」同一视图。 */}
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3">
          <p className="min-w-52 flex-1 text-sm text-muted-foreground">
            {t("schemes.bindings.entryHint")}
          </p>
          <Button
            variant="outline"
            className="h-auto min-h-8 max-w-full whitespace-normal break-words"
            disabled={busy}
            onClick={() => s.openSettingsRoute("scheme-bindings")}
          >
            {t("schemes.bindings.entry")}
          </Button>
        </div>
        {apps.map((app) => {
          const allRows = schemeRowsOf(s, app);
          const visibleRows = visibleOf(app);
          return (
            <section key={app.id} className="mb-6 last:mb-0" aria-label={t(app.nameKey)}>
              {!appId && (
                <div className="mb-2 flex flex-wrap items-center gap-2 px-1">
                  <app.icon className="size-4 text-muted-foreground" />
                  <h2 className="text-sm font-medium">
                    {app.management ? (
                      <Button
                        type="button"
                        variant="outline"
                        data-scheme-app-open={app.id}
                        disabled={busy}
                        onClick={() => goAppRoute(app.management?.schemes)}
                        className="h-auto min-h-8 max-w-full whitespace-normal break-words"
                      >
                        {t(app.nameKey)}
                        <ChevronRight className="size-3.5 shrink-0" />
                      </Button>
                    ) : (
                      t(app.nameKey)
                    )}
                  </h2>
                  <p className="text-xs text-muted-foreground">{t(app.descriptionKey)}</p>
                  {app.management && (
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        className="h-auto min-h-8 max-w-full whitespace-normal break-words"
                        disabled={busy}
                        onClick={() => goAppRoute(app.management?.connection)}
                      >
                        {t("connections.transportPage.tab")}
                      </Button>
                      <Button
                        variant="outline"
                        className="h-auto min-h-8 max-w-full whitespace-normal break-words"
                        disabled={busy}
                        onClick={() => goAppRoute(app.management?.data)}
                      >
                        {t("connections.dataRetention")}
                      </Button>
                    </div>
                  )}
                </div>
              )}
              {visibleRows.length > 0 ? (
                <ul className="divide-y overflow-hidden rounded-xl border">
                  {visibleRows.map((row) => (
                    <li key={row.scheme.id}>
                      <button
                        type="button"
                        data-scheme-open={row.scheme.id}
                        disabled={busy}
                        onClick={() => openScheme(row.scheme.id)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
                      >
                        <span className="min-w-0 flex-1">
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
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {row.scheme.description}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {row.bindings === null
                            ? t("schemes.usageUnknown")
                            : t("schemes.usageCount", { "0": row.bindings })}
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                      </button>
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
                    <Button variant="outline" size="sm" disabled={busy} onClick={openNaming}>
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
                <Button variant="outline" disabled={busy} onClick={closeNaming}>
                  {t("connections.cancel")}
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => void createNow()}>
                  {t("workspace.discard_and_continue")}
                </Button>
                <Button disabled={busy || invalidDraft} onClick={() => void saveThenCreate()}>
                  {t("workspace.save_and_continue")}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <Field label="connections.schemeName">
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
                <Button variant="outline" disabled={busy} onClick={closeNaming}>
                  {t("connections.cancel")}
                </Button>
                <Button
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

function SchemeDetail({ app }: { app: SchemeAppEntry }) {
  const { t } = useTranslation();
  const s = useSuperstringStore();
  const busy = s.qqSchemeSaving || s.qqAccessSaving || s.qqSchemesLoading;
  const view: "settings" | "bindings" = s.qqSchemeView === "bindings" ? "bindings" : "settings";
  const schemeId = s.qqSchemeEditor?.source.id ?? null;
  const back = () => s.openSettingsRoute("scheme-library");
  const switchView = (next: string) => {
    if (!schemeId) return;
    s.requestQqSchemeNavigation(schemeId, next === "bindings" ? "bindings" : "settings");
  };
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t(app.nameKey)}>
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("schemes.backToCatalog")}
          disabled={busy}
          onClick={back}
        >
          <ChevronLeft />
        </Button>
        <nav
          aria-label={t("workspace.schemes")}
          className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground"
        >
          <button
            type="button"
            onClick={back}
            className="rounded-md px-1 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("workspace.schemes")}
          </button>
          <ChevronRight className="size-3.5 shrink-0" />
          {app.management ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => goAppRoute(app.management?.schemes)}
              className="rounded-md px-1 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60"
            >
              {t(app.nameKey)}
            </button>
          ) : (
            <span className="shrink-0">{t(app.nameKey)}</span>
          )}
          <ChevronRight className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words font-medium text-foreground">
            {s.qqSchemeEditor?.name ?? t("schemes.currentScheme")}
          </span>
        </nav>
        {app.management && (
          <Button
            variant="outline"
            className="ml-auto h-auto min-h-8 max-w-full whitespace-normal break-words"
            disabled={busy}
            onClick={() => goAppRoute(app.management?.connection)}
          >
            {t("schemes.appManagement")}
          </Button>
        )}
        <Tabs
          value={view}
          onValueChange={switchView}
          className={app.management ? "min-w-0 max-w-full" : "ml-auto min-w-0 max-w-full"}
        >
          <TabsList className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-auto [&_[role=tab]]:min-h-8 [&_[role=tab]]:max-w-full [&_[role=tab]]:flex-none [&_[role=tab]]:whitespace-normal">
            <TabsTrigger value="settings" disabled={busy}>
              {t("schemes.bindings.viewSettings")}
            </TabsTrigger>
            <TabsTrigger value="bindings" disabled={busy}>
              {t("schemes.bindings.viewBindings")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>
      <div
        hidden={view !== "settings" && !!schemeId}
        className="min-h-0 flex-1 overflow-hidden [&[hidden]]:hidden"
      >
        <SchemeStudio />
      </div>
      {view === "bindings" && schemeId && (
        <div
          className="min-h-0 flex-1 overflow-y-auto px-4 py-6"
          data-workspace-scroll
          data-scheme-view="bindings"
        >
          <SchemeBindingsView schemeId={schemeId} />
        </div>
      )}
    </section>
  );
}

function qqAppView(route: string, settingsView: string): QqAppView | null {
  if (route === "qq-app-schemes") return "schemes";
  if (route === "qq-connection") return "connection";
  if (route === "qq-storage") return "data";
  return settingsView === "operating-mode" ? "connection" : null;
}

export function SchemesWorkspace({ active = true }: { active?: boolean } = {}) {
  const route = useSuperstringStore((s) => s.settingsRoute);
  const settingsView = useSuperstringStore((s) => s.settingsView);
  if (route === "scheme-bindings") return <SchemeBindingsPage />;
  // 本群配置：仅本群作用域（不是基础方案/全局编辑），打开的绑定 id 由导航守卫带入。
  if (route === "qq-group-config") return <QqGroupConfigPage active={active} />;
  const appView = qqAppView(route, settingsView);
  if (appView)
    return (
      <QqAppManagement
        view={appView}
        schemesView={appView === "schemes" ? <SchemeDirectory appId="qq" /> : null}
      />
    );
  const app = route === "scheme-library" ? null : schemeAppByRoute(route);
  return app ? <SchemeDetail app={app} /> : <SchemeDirectory active={active} />;
}
