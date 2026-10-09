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
import {
  useMcpServersResource,
  useSkillsResource,
  useToolDirectoryResource,
} from "../../services/connection-resources";
import { useSuperstringStore } from "../../store";
import {
  type BuiltInCapabilityEntry,
  CAPABILITY_CATALOG,
  type CapabilityEntry,
  capabilityByRoute,
  FUNCTION_GROUPS,
  isBuiltInCapability,
  SKILL_HUMAN_LABELS,
  TOOL_HUMAN_LABELS,
} from "../../workspace/capability-catalog";
import { KnowledgeToolSettings, MemoryToolSettings } from "../assistants/ResourceRules";
import { ExecutionSettings } from "../runs/execution-settings";
import { CapabilityPolicyPanel } from "./capability-policy-panel";
import { ExternalIntegrationsCard } from "./external-components";
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
  if (isBuiltInCapability(entry)) {
    if (entry.detail === "memory" || entry.detail === "knowledge") return { kind: "perAgent" };
    if (entry.detail === "link") return { kind: "followsSession" };
    if (entry.detail === "execution") return { kind: "perFunction" };
  } else {
    return { kind: "perFunction" };
  }
  if (!editor) return { kind: "unread" };
  const modules = executionPolicy(editor.snapshot.policy).modules;
  const switches =
    entry.detail === "web"
      ? [modules.web]
      : entry.detail === "members"
        ? [modules.qqMembers]
        : [modules.qqMedia, modules.qqStickers];
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
  const apiClient = useSuperstringStore((s) => s.apiClient);
  const s = useSuperstringStore(
    useShallow((state) => ({
      loadPermissionSettings: state.loadPermissionSettings,
      openSettingsRoute: state.openSettingsRoute,
      permissionEditor: state.permissionEditor,
      permissionError: state.permissionError,
    })),
  );
  const [query, setQuery] = useState("");

  const tools = useToolDirectoryResource(apiClient, active && !hidden);
  const skills = useSkillsResource(apiClient, active && !hidden);
  const mcp = useMcpServersResource(apiClient, active && !hidden);
  const toolData = tools.data;
  const skillData = skills.data;
  const mcpData = mcp.data;
  const catalogErrors = [
    { kind: "tool", error: tools.error, refresh: tools.refresh },
    { kind: "skill", error: skills.error, refresh: skills.refresh },
    { kind: "mcp", error: mcp.error || mcpData?.code, refresh: mcp.refresh },
  ].filter((resource) => resource.error);

  useEffect(() => {
    if (!active) return;
    void s.loadPermissionSettings();
  }, [active, s.loadPermissionSettings]);

  const matchingGroups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(i18n.language);
    return FUNCTION_GROUPS.map((group) => {
      const groupEntries = group.entryIds
        .map((id) => CAPABILITY_CATALOG.find((e) => e.id === id))
        .filter((e): e is CapabilityEntry => !!e);

      if (!needle) {
        return { ...group, entries: groupEntries };
      }

      const groupMatches = [t(group.titleKey), t(group.descriptionKey)]
        .join(" ")
        .toLocaleLowerCase(i18n.language)
        .includes(needle);

      const matchingEntries = groupEntries.filter((entry) => {
        if (groupMatches) return true;

        if (entry.id === "external-integrations") {
          const serverNames = (mcpData?.servers ?? []).map((s) => s.config.name).join(" ");
          const customSkills = (skillData?.skills ?? [])
            .filter((s) => s.origin !== "system")
            .map((s) => s.name)
            .join(" ");
          const mcpTools = (toolData?.tools ?? [])
            .filter((t) => t.origin === "mcp")
            .map((t) => t.name)
            .join(" ");
          const fullExternal = [
            t(entry.nameKey),
            t(entry.descriptionKey),
            ...entry.keywordKeys.map((k) => t(k)),
            serverNames,
            customSkills,
            mcpTools,
          ]
            .join(" ")
            .toLocaleLowerCase(i18n.language);
          return fullExternal.includes(needle);
        }

        const baseText = [
          t(entry.nameKey),
          t(entry.descriptionKey),
          ...entry.keywordKeys.map((k) => t(k)),
        ].join(" ");

        const actualTools = (toolData?.tools ?? [])
          .filter((tool) => tool.functionId === entry.id)
          .map(
            (tool) =>
              `${tool.name} ${TOOL_HUMAN_LABELS[tool.name] ? t(TOOL_HUMAN_LABELS[tool.name]) : ""}`,
          )
          .join(" ");

        const actualSkills = (skillData?.skills ?? [])
          .filter((skill) => entry.skills.includes(skill.name) && skill.origin === "system")
          .map(
            (skill) =>
              `${skill.name} ${SKILL_HUMAN_LABELS[skill.name] ? t(SKILL_HUMAN_LABELS[skill.name]) : ""}`,
          )
          .join(" ");

        const fullSearchable = `${baseText} ${actualTools} ${actualSkills}`.toLocaleLowerCase(
          i18n.language,
        );
        return fullSearchable.includes(needle);
      });

      return { ...group, entries: matchingEntries };
    }).filter((g) => g.entries.length > 0);
  }, [query, t, i18n.language, toolData, skillData, mcpData]);

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
        {catalogErrors.length > 0 && (
          <div className="mb-4 space-y-2">
            {catalogErrors.map((resource) => (
              <div
                key={resource.kind}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
              >
                <p role="alert" className="text-sm text-destructive">
                  {resource.error}
                </p>
                <Button variant="outline" size="sm" onClick={resource.refresh}>
                  {t("capabilities.retry")}
                </Button>
              </div>
            ))}
          </div>
        )}
        {matchingGroups.length > 0 ? (
          <div className="space-y-6">
            {matchingGroups.map((group) => (
              <section key={group.id} className="space-y-3">
                <div className="border-b pb-1">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">
                    {t(group.titleKey)}
                  </h2>
                  <p className="text-xs text-muted-foreground">{t(group.descriptionKey)}</p>
                </div>
                <ul className="divide-y overflow-hidden rounded-xl border">
                  {group.entries.map((entry) => {
                    if (entry.id === "external-integrations") {
                      return (
                        <li key={entry.id} className="p-3 bg-card">
                          <ExternalIntegrationsCard active={active && !hidden} />
                        </li>
                      );
                    }
                    const fact = capabilityFact(entry, s.permissionEditor);
                    return (
                      <li key={entry.id} className="bg-card">
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
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                            <span>{t("connections.components.primaryConfig")}</span>
                            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                          </span>
                        </button>
                        <div className="px-4 pb-3">
                          <SystemComponents entry={entry} active={active && !hidden} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : catalogErrors.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {t("capabilities.directory.empty")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function CapabilityDetailShell({
  entry,
  active = true,
  children,
}: {
  entry: BuiltInCapabilityEntry;
  active?: boolean;
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
          <SystemComponents entry={entry} active={active} />
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

function AgentScopedDetail({
  entry,
  active = true,
}: {
  entry: BuiltInCapabilityEntry;
  active?: boolean;
}) {
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

function SessionLinkDetail({
  entry,
  active = true,
}: {
  entry: BuiltInCapabilityEntry;
  active?: boolean;
}) {
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

function CapabilityDetail({
  entry,
  active = true,
}: {
  entry: BuiltInCapabilityEntry;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const openSettingsRoute = useSuperstringStore((state) => state.openSettingsRoute);
  if (entry.detail === "memory" || entry.detail === "knowledge")
    return (
      <CapabilityDetailShell entry={entry} active={active}>
        <AgentScopedDetail entry={entry} active={active} />
      </CapabilityDetailShell>
    );
  if (entry.detail === "web")
    return (
      <CapabilityDetailShell entry={entry} active={active}>
        <p className="border-b px-4 py-3 text-sm text-muted-foreground">
          {t("capabilities.web.scopeNote")}
        </p>
        <WebAccessPanel active={active} />
      </CapabilityDetailShell>
    );
  if (entry.detail === "media")
    return (
      <CapabilityDetailShell entry={entry} active={active}>
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
  if (entry.detail === "members")
    return (
      <CapabilityDetailShell entry={entry} active={active}>
        <div className="w-full space-y-6 px-4 py-6">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">{t(entry.nameKey)}</h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              {t(entry.descriptionKey)}
            </p>
          </div>
          <p className="text-sm text-muted-foreground">{t("capabilities.members.scopeNote")}</p>
          <CapabilityPolicyPanel modules={["qqMembers"]} active={active} />
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button variant="outline" size="sm" onClick={() => openSettingsRoute("qq-app-groups")}>
              {t("schemes.qq.groupConfigTitle")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => openSettingsRoute("qq-connection")}>
              {t("schemes.qq.connectionTitle")}
            </Button>
          </div>
        </div>
      </CapabilityDetailShell>
    );
  if (entry.detail === "execution")
    return (
      <CapabilityDetailShell entry={entry} active={active}>
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
    <CapabilityDetailShell entry={entry} active={active}>
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
