import { ChevronLeft, ChevronRight, MessagesSquare, Search, Wrench } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { executionPolicy } from "../../../shared/contracts/permissions";
import { Field } from "../../components/form-field";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import type { PermissionEditor } from "../../features/access/permission-state";
import { dirtyPages } from "../../features/agents/page-drafts";
import { knowledgeReadDirty } from "../../features/knowledge/types";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import {
  CAPABILITY_CATALOG,
  type CapabilityEntry,
  capabilityByRoute,
} from "../../workspace/capability-catalog";
import { KnowledgeToolSettings, MemoryToolSettings } from "../assistants/ResourceRules";
import { ExecutionSettings } from "../runs/execution-settings";
import { CapabilityPolicyPanel } from "./capability-policy-panel";
import { SystemComponents } from "./system-components";
import { WebAccessPanel } from "./web-access-panel";

type CapabilityFact =
  | { kind: "unread" }
  | { kind: "on" }
  | { kind: "off" }
  | { kind: "partial" }
  | { kind: "perAgent" }
  | { kind: "perFunction" }
  | { kind: "followsSession" };

const FACT_KEYS: Record<CapabilityFact["kind"], string> = {
  unread: "capabilities.state.unread",
  on: "capabilities.state.on",
  off: "capabilities.state.off",
  partial: "capabilities.state.partial",
  perAgent: "capabilities.state.perAgent",
  perFunction: "capabilities.state.perFunction",
  followsSession: "capabilities.state.followsSession",
};

function capabilityFact(entry: CapabilityEntry, editor: PermissionEditor | null): CapabilityFact {
  if (entry.detail === "memory" || entry.detail === "knowledge") return { kind: "perAgent" };
  if (entry.detail === "link") return { kind: "followsSession" };
  // 执行按功能配置（研究/代码/任务各有各的限制），不能用单一 tasks 开关冒充整体状态。
  if (entry.detail === "execution") return { kind: "perFunction" };
  if (!editor) return { kind: "unread" };
  const modules = executionPolicy(editor.snapshot.policy).modules;
  const switches = entry.detail === "web" ? [modules.web] : [modules.qqMedia, modules.qqStickers];
  const on = switches.filter(Boolean).length;
  if (on === switches.length) return { kind: "on" };
  return on === 0 ? { kind: "off" } : { kind: "partial" };
}

function CapabilityDirectory({
  active = true,
  hidden = false,
}: {
  active?: boolean;
  hidden?: boolean;
} = {}) {
  const { t, i18n } = useTranslation();
  const s = useSuperstringStore(
    useShallow((state) => ({
      loadPermissionSettings: state.loadPermissionSettings,
      openSettingsRoute: state.openSettingsRoute,
      permissionEditor: state.permissionEditor,
      permissionError: state.permissionError,
    })),
  );
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!active) return;
    void s.loadPermissionSettings();
  }, [active, s.loadPermissionSettings]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(i18n.language);
    if (!needle) return CAPABILITY_CATALOG;
    return CAPABILITY_CATALOG.filter((entry) =>
      [t(entry.nameKey), t(entry.descriptionKey), ...entry.keywordKeys.map((key) => t(key))]
        .join(" ")
        .toLocaleLowerCase(i18n.language)
        .includes(needle),
    );
  }, [query, t, i18n.language]);
  return (
    <section
      hidden={hidden}
      className={hidden ? "hidden" : "flex h-full min-h-0 flex-col"}
      style={hidden ? { display: "none" } : undefined}
      aria-label={t("workspace.capabilities")}
    >
      <header className="space-y-1 border-b px-4 py-5">
        <div className="flex items-center gap-2">
          <Wrench className="size-4 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">{t("workspace.capabilities")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">{t("capabilities.directory.description")}</p>
        <p className="text-xs text-muted-foreground">{t("capabilities.factNote")}</p>
      </header>
      <div className="border-b px-4 py-3">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label={t("capabilities.directory.search")}
            placeholder={t("capabilities.directory.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      {s.permissionError && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <p role="alert" className="text-sm text-destructive">
            {translateNotice(s.permissionError)}
          </p>
          <Button variant="outline" size="sm" onClick={() => void s.loadPermissionSettings(true)}>
            {t("capabilities.retry")}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6" data-workspace-scroll>
        {visible.length > 0 ? (
          <ul className="divide-y overflow-hidden rounded-xl border">
            {visible.map((entry) => {
              const fact = capabilityFact(entry, s.permissionEditor);
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => s.openSettingsRoute(entry.route)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <entry.icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{t(entry.nameKey)}</span>
                        <Badge
                          variant={fact.kind === "on" ? "secondary" : "outline"}
                          className="h-auto max-w-full whitespace-normal break-words text-left"
                        >
                          {t(FACT_KEYS[fact.kind])}
                        </Badge>
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {t(entry.descriptionKey)}
                      </span>
                    </span>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                  <div className="px-4 pb-3">
                    <SystemComponents entry={entry} />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t("capabilities.directory.empty")}
          </p>
        )}
      </div>
    </section>
  );
}

function CapabilityDetailShell({
  entry,
  children,
}: {
  entry: CapabilityEntry;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useSuperstringStore((s) => s.openSettingsRoute);
  const back = () => navigate("system-capabilities");
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={t(entry.nameKey)}>
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Button variant="ghost" size="icon-sm" aria-label={t("capabilities.back")} onClick={back}>
          <ChevronLeft />
        </Button>
        <nav
          aria-label={t("workspace.capabilities")}
          className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground"
        >
          <button
            type="button"
            onClick={back}
            className="rounded-md px-1 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("workspace.capabilities")}
          </button>
          <ChevronRight className="size-3.5 shrink-0" />
          <span className="truncate font-medium text-foreground">{t(entry.nameKey)}</span>
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto" data-workspace-scroll>
        <div className="px-4 pt-5">
          <SystemComponents entry={entry} />
        </div>
        {children}
      </div>
    </section>
  );
}

function capabilityGuards(state: {
  editorLoading: boolean;
  settingsSaving: boolean;
  knowledgeReadLoading: boolean;
  knowledgeBusy: boolean;
  memoryCorrectionSaving: boolean;
  qqMemoryBatchSaving: boolean;
  permissionSaving: boolean;
  webAccessSaving: boolean;
  organizationLoading: boolean;
  knowledgeModelLoading: boolean;
  qqAccessSaving: boolean;
  qqSchemeSaving: boolean;
  qqStickerSaving: boolean;
}): boolean {
  return [
    state.editorLoading,
    state.settingsSaving,
    state.knowledgeReadLoading,
    state.knowledgeBusy,
    state.memoryCorrectionSaving,
    state.qqMemoryBatchSaving,
    state.permissionSaving,
    state.webAccessSaving,
    state.organizationLoading,
    state.knowledgeModelLoading,
    state.qqAccessSaving,
    state.qqSchemeSaving,
    state.qqStickerSaving,
  ].some(Boolean);
}

// 自动读取目标优先级：当前合法的 editorAgentId > 新会话候选 > 列表首个。
// 保存后 pageEditor 已清空但当前助手仍然有效时必须留在它上面，不无故切到第一助手。
function autoLoadTarget(state: {
  agents: { id: string }[];
  editorAgentId: string;
  selectedNewSessionAgentId: string | null;
}): string | null {
  const edited = state.agents.find((item) => item.id === state.editorAgentId);
  if (edited) return edited.id;
  const preferred = state.agents.find((item) => item.id === state.selectedNewSessionAgentId);
  return preferred?.id ?? state.agents[0]?.id ?? null;
}

// 自动读取失败后只接受显式重试，避免形成请求循环。
function useAgentAutoLoad(active = true) {
  const targetId = useSuperstringStore((s) => autoLoadTarget(s));
  const pageEditor = useSuperstringStore((s) => s.pageEditor);
  const editorLoading = useSuperstringStore((s) => s.editorLoading);
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !targetId || attempted.current === targetId || pageEditor || editorLoading)
      return;
    attempted.current = targetId;
    void useSuperstringStore.getState().requestAgentNavigation(targetId);
  }, [active, targetId, pageEditor, editorLoading]);
  return useCallback((id?: string) => {
    const state = useSuperstringStore.getState();
    const next = id ?? autoLoadTarget(state);
    if (next) void state.requestAgentNavigation(next);
  }, []);
}

function AgentScopedDetail({ entry, active = true }: { entry: CapabilityEntry; active?: boolean }) {
  const { t } = useTranslation();
  const s = useSuperstringStore(
    useShallow((state) => ({
      agents: state.agents,
      dirty: state.dirty,
      editorAgentId: state.editorAgentId,
      editorLoading: state.editorLoading,
      error: state.error,
      knowledgeBusy: state.knowledgeBusy,
      knowledgeModelLoading: state.knowledgeModelLoading,
      knowledgeReadEditor: state.knowledgeReadEditor,
      knowledgeReadLoading: state.knowledgeReadLoading,
      memoryCorrectionDirty: state.memoryCorrectionDirty,
      memoryCorrectionSaving: state.memoryCorrectionSaving,
      openAgentSettings: state.openAgentSettings,
      organizationLoading: state.organizationLoading,
      pageEditor: state.pageEditor,
      permissionSaving: state.permissionSaving,
      qqAccessSaving: state.qqAccessSaving,
      qqMemoryBatchDrafts: state.qqMemoryBatchDrafts,
      qqMemoryBatchSaving: state.qqMemoryBatchSaving,
      qqSchemeSaving: state.qqSchemeSaving,
      qqStickerSaving: state.qqStickerSaving,
      requestAgentNavigation: state.requestAgentNavigation,
      settingsSaving: state.settingsSaving,
      webAccessSaving: state.webAccessSaving,
    })),
  );
  const attempt = useAgentAutoLoad(active);
  const busy = capabilityGuards(s);
  const pendingDraft =
    s.dirty ||
    s.memoryCorrectionDirty ||
    Object.keys(s.qqMemoryBatchDrafts).length > 0 ||
    dirtyPages(s.pageEditor).length > 0 ||
    knowledgeReadDirty(s.knowledgeReadEditor);
  const ready = s.editorAgentId !== "__new__" && !!s.pageEditor && !s.editorLoading;
  return (
    <div className="w-full space-y-6 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">{t(entry.nameKey)}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t(entry.descriptionKey)}</p>
        </div>
        {s.agents.length > 0 && (
          <Field label="library.agent.owner">
            <NativeSelect
              aria-label={t("library.select.an.assistant")}
              value={s.editorAgentId}
              disabled={busy}
              onChange={(event) => s.requestAgentNavigation(event.target.value)}
            >
              {s.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {t(
          entry.detail === "memory"
            ? "capabilities.memory.scopeNote"
            : "capabilities.knowledge.scopeNote",
        )}
      </p>
      {s.agents.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
          <p className="text-sm text-muted-foreground">{t("capabilities.memory.noAgent")}</p>
          <Button onClick={() => s.openAgentSettings()}>{t("library.create.assistant")}</Button>
        </div>
      ) : ready ? (
        entry.detail === "memory" ? (
          <MemoryToolSettings />
        ) : (
          <KnowledgeToolSettings active={active} />
        )
      ) : (
        <div className="space-y-3">
          {s.error && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 p-4">
              <p role="alert" className="text-sm text-destructive">
                {translateNotice(s.error)}
              </p>
              <Button variant="outline" size="sm" onClick={() => attempt()}>
                {t("capabilities.retry")}
              </Button>
            </div>
          )}
          {pendingDraft && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
              <p className="text-sm text-muted-foreground">{t("capabilities.pendingDraft")}</p>
              <Button variant="outline" size="sm" onClick={() => attempt()}>
                {t("capabilities.pendingDraftAction")}
              </Button>
            </div>
          )}
          {!s.error && !pendingDraft && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
              <p role="status" className="text-sm text-muted-foreground">
                {t("library.loading")}
              </p>
              {/* 未就绪且无错误/脏稿时保留显式重试兜底，避免停在裸加载态；忙时禁用。 */}
              <Button variant="outline" size="sm" disabled={busy} onClick={() => attempt()}>
                {t("capabilities.retry")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionLinkDetail({ entry, active = true }: { entry: CapabilityEntry; active?: boolean }) {
  const { t } = useTranslation();
  const s = useSuperstringStore(
    useShallow((state) => ({
      agents: state.agents,
      editorAgentId: state.editorAgentId,
      editorLoading: state.editorLoading,
      error: state.error,
      knowledgeBusy: state.knowledgeBusy,
      knowledgeModelLoading: state.knowledgeModelLoading,
      knowledgeReadLoading: state.knowledgeReadLoading,
      memoryCorrectionSaving: state.memoryCorrectionSaving,
      openAgentSettings: state.openAgentSettings,
      openSettingsRoute: state.openSettingsRoute,
      organizationLoading: state.organizationLoading,
      pageEditor: state.pageEditor,
      permissionSaving: state.permissionSaving,
      qqAccessSaving: state.qqAccessSaving,
      qqMemoryBatchSaving: state.qqMemoryBatchSaving,
      qqSchemeSaving: state.qqSchemeSaving,
      qqStickerSaving: state.qqStickerSaving,
      requestAgentNavigation: state.requestAgentNavigation,
      settingsSaving: state.settingsSaving,
      webAccessSaving: state.webAccessSaving,
    })),
  );
  const [selectedId, setSelectedId] = useState(
    () => s.agents.find((agent) => agent.id === s.editorAgentId)?.id ?? s.agents[0]?.id ?? "",
  );
  const busy = capabilityGuards(s);
  const ready =
    selectedId !== "" && s.editorAgentId === selectedId && !!s.pageEditor && !s.editorLoading;
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !selectedId || attempted.current === selectedId || ready || s.editorLoading)
      return;
    attempted.current = selectedId;
    void s.requestAgentNavigation(selectedId);
  }, [active, selectedId, ready, s.editorLoading, s.requestAgentNavigation]);
  return (
    <div className="w-full space-y-6 px-4 py-6">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{t(entry.nameKey)}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t(entry.descriptionKey)}</p>
      </div>
      <p className="text-sm text-muted-foreground">{t("capabilities.session.note")}</p>
      {s.agents.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
          <p className="text-sm text-muted-foreground">{t("capabilities.memory.noAgent")}</p>
          <Button onClick={() => s.openAgentSettings()}>{t("library.create.assistant")}</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3 rounded-xl border p-4">
            <Field label="library.agent.owner">
              <NativeSelect
                aria-label={t("library.select.an.assistant")}
                value={selectedId}
                disabled={busy}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {s.agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Button
              variant="outline"
              className="h-auto min-h-8 max-w-full whitespace-normal break-words"
              disabled={!ready}
              onClick={() => s.openSettingsRoute("context")}
            >
              <MessagesSquare />
              {t("capabilities.session.open")}
            </Button>
          </div>
          {!!s.error && !ready && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 p-4">
              <p role="alert" className="text-sm text-destructive">
                {translateNotice(s.error)}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => s.requestAgentNavigation(selectedId)}
              >
                {t("capabilities.retry")}
              </Button>
            </div>
          )}
          {!ready && !s.error && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4">
              <p role="status" className="text-sm text-muted-foreground">
                {t("library.loading")}
              </p>
              {/* 同一守卫：未就绪且无错误时保留显式重试兜底，忙时禁用。 */}
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => s.requestAgentNavigation(selectedId)}
              >
                {t("capabilities.retry")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CapabilityDetail({ entry, active = true }: { entry: CapabilityEntry; active?: boolean }) {
  const { t } = useTranslation();
  const openSettingsRoute = useSuperstringStore((state) => state.openSettingsRoute);
  if (entry.detail === "memory" || entry.detail === "knowledge")
    return (
      <CapabilityDetailShell entry={entry}>
        <AgentScopedDetail entry={entry} active={active} />
      </CapabilityDetailShell>
    );
  // 面板自带标题与内边距（联网/执行）：壳层只补“允许尝试≠完整可用”的事实行。
  if (entry.detail === "web")
    return (
      <CapabilityDetailShell entry={entry}>
        <p className="border-b px-4 py-3 text-sm text-muted-foreground">
          {t("capabilities.web.scopeNote")}
        </p>
        <WebAccessPanel active={active} />
      </CapabilityDetailShell>
    );
  if (entry.detail === "media")
    return (
      <CapabilityDetailShell entry={entry}>
        <div className="w-full space-y-6 px-4 py-6">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{t(entry.nameKey)}</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              {t(entry.descriptionKey)}
            </p>
          </div>
          <p className="text-sm text-muted-foreground">{t("capabilities.media.scopeNote")}</p>
          <CapabilityPolicyPanel modules={["qqMedia", "qqStickers"]} active={active} />
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button variant="outline" size="sm" onClick={() => openSettingsRoute("qq-stickers")}>
              {t("workspace.sticker_library")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => openSettingsRoute("qq-scheme-config")}
            >
              {t("workspace.chat_schemes")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => openSettingsRoute("models")}>
              {t("library.open.model.services")}
            </Button>
          </div>
        </div>
      </CapabilityDetailShell>
    );
  if (entry.detail === "execution")
    return (
      <CapabilityDetailShell entry={entry}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <p className="text-sm text-muted-foreground">{t("capabilities.execution.scopeNote")}</p>
          <Button variant="outline" size="sm" onClick={() => openSettingsRoute("task-ledger")}>
            {t("capabilities.execution.openTasks")}
          </Button>
        </div>
        <ExecutionSettings active={active} />
      </CapabilityDetailShell>
    );
  return (
    <CapabilityDetailShell entry={entry}>
      <SessionLinkDetail entry={entry} active={active} />
    </CapabilityDetailShell>
  );
}

export function CapabilitiesWorkspace({ active = true }: { active?: boolean } = {}) {
  const route = useSuperstringStore((s) => s.settingsRoute);
  const entry = route === "system-capabilities" ? null : capabilityByRoute(route);
  const isDirectory = !entry;
  const [visitedDirectory, setVisitedDirectory] = useState(isDirectory);

  useEffect(() => {
    if (isDirectory) {
      setVisitedDirectory(true);
    }
  }, [isDirectory]);

  return (
    <>
      {visitedDirectory && (
        <CapabilityDirectory active={active && isDirectory} hidden={!isDirectory} />
      )}
      {entry && <CapabilityDetail entry={entry} active={active} />}
    </>
  );
}
