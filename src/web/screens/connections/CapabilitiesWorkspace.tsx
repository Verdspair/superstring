import { ChevronLeft, ChevronRight, MessagesSquare, Search } from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { executionPolicy } from "../../../shared/contracts/permissions";
import { CatalogItem } from "../../components/catalog-item";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import type { PermissionEditor } from "../../features/access/permission-state";
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
import { WorkspaceHelp } from "../../workspace/WorkspaceHelp";
import { WorkspacePageHeader } from "../../workspace/WorkspacePageHeader";
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
  const searchHintId = useId();
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

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
      className={hidden ? "hidden" : "workspace-page flex h-full min-h-0 flex-col"}
      style={hidden ? { display: "none" } : undefined}
      aria-label={t("workspace.capabilities")}
    >
      <WorkspacePageHeader
        location={t("brand.workspace", { "0": t("workspace.capabilities") })}
        title={t("workspace.capabilities")}
        description={t("capabilities.directory.description")}
      />
      <div className="flex flex-wrap items-center gap-2 border-b py-3">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label={t("capabilities.directory.search")}
            placeholder={t("capabilities.directory.searchPlaceholder")}
            aria-describedby={searchHintId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <WorkspaceHelp
          title={t("capabilities.directory.searchPlaceholder")}
          description={t("capabilities.directory.search")}
        />
        <span id={searchHintId} className="sr-only">
          {t("capabilities.directory.search")}
        </span>
      </div>
      <p className="px-4 pt-3 text-xs leading-relaxed text-muted-foreground">
        {t("capabilities.factNote")}
      </p>
      {s.permissionError && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b py-3">
          <p role="alert" className="text-sm text-destructive">
            {translateNotice(s.permissionError)}
          </p>
          <Button
            variant="outline"
            size="sm"
            tooltip={t("hints.system.retryLoad")}
            onClick={() => void s.loadPermissionSettings(true)}
          >
            {t("capabilities.retry")}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-[24px]" data-workspace-scroll>
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
                <Button
                  variant="outline"
                  size="sm"
                  tooltip={t("hints.system.retryCatalog")}
                  onClick={resource.refresh}
                >
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
                  <h2 className="workspace-section-title text-foreground">{t(group.titleKey)}</h2>
                  <p className="text-xs text-muted-foreground">{t(group.descriptionKey)}</p>
                </div>
                <ul className="divide-y divide-border rounded-[10px] border border-border bg-card">
                  {group.entries.map((entry) => {
                    const external = entry.id === "external-integrations";
                    const fact = capabilityFact(entry, s.permissionEditor);
                    return (
                      <li key={entry.id} data-capability-id={entry.id} className="min-w-0 p-3">
                        <CatalogItem
                          open={query.trim() ? true : (expanded[entry.id] ?? false)}
                          onOpenChange={(open) =>
                            setExpanded((previous) => ({ ...previous, [entry.id]: open }))
                          }
                          summary={
                            <span className="flex min-w-0 items-start gap-3">
                              <entry.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                              <span className="min-w-0">
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-medium">{t(entry.nameKey)}</span>
                                  <Badge
                                    variant={fact.kind === "on" ? "secondary" : "outline"}
                                    className="h-auto whitespace-normal"
                                  >
                                    {t(FACT_KEYS[fact.kind])}
                                  </Badge>
                                </span>
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  {t(entry.descriptionKey)}
                                </span>
                              </span>
                            </span>
                          }
                          actions={
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`${t("connections.components.primaryConfig")} · ${t(entry.nameKey)}`}
                              tooltip={t("strict.hints.capabilityOpen")}
                              onClick={() => s.openSettingsRoute(entry.route)}
                            >
                              {t("connections.components.primaryConfig")}
                              <ChevronRight className="size-4" />
                            </Button>
                          }
                        >
                          {external ? (
                            <ExternalIntegrationsCard active={active && !hidden} />
                          ) : (
                            <SystemComponents entry={entry} active={active && !hidden} />
                          )}
                        </CatalogItem>
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
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const navigate = useSuperstringStore((s) => s.openSettingsRoute);
  const returnTarget = useSuperstringStore((s) => s.returnWorkspaceTarget);
  const hasReturn = useSuperstringStore((s) => s.workspaceReturns.length > 0);
  const back = () => (hasReturn ? returnTarget() : navigate("system-capabilities"));
  return (
    <section className="workspace-page flex h-full min-h-0 flex-col" aria-label={t(entry.nameKey)}>
      <WorkspacePageHeader
        location={t("workspace.capabilities")}
        title={t(entry.nameKey)}
        description={t(entry.descriptionKey)}
        backAction={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("capabilities.back")}
            tooltip={t("hints.system.capabilitiesBack")}
            onClick={back}
          >
            <ChevronLeft />
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto" data-workspace-scroll>
        <div className="pt-5">
          <SystemComponents entry={entry} active={active} />
        </div>
        {children}
      </div>
    </section>
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
  const agents = useSuperstringStore((state) => state.agents);
  const openAgent = useSuperstringStore((state) => state.openWorkspaceTarget);
  const [agentId, setAgentId] = useState("");
  const agentSelectId = useId();
  if (entry.detail === "memory" || entry.detail === "knowledge" || entry.detail === "link")
    return (
      <CapabilityDetailShell entry={entry} active={active}>
        <div className="space-y-3 py-5">
          <p className="text-sm text-muted-foreground">{t("agent.materials.globalCapability")}</p>
          <div className="space-y-2 text-sm">
            <label htmlFor={agentSelectId}>{t("agent.materials.chooseAgent")}</label>
            <NativeSelect
              id={agentSelectId}
              value={agentId}
              aria-label={t("agent.materials.chooseAgent")}
              onChange={(event) => setAgentId(event.target.value)}
            >
              <option value="">{t("agent.materials.chooseAgent")}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <Button
            variant="outline"
            className="h-auto min-h-8 max-w-full whitespace-normal break-words"
            disabled={!agents.some((agent) => agent.id === agentId)}
            onClick={() =>
              openAgent(
                entry.detail === "link"
                  ? "context"
                  : entry.detail === "memory"
                    ? "memory-tools"
                    : "knowledge-tools",
                agentId,
              )
            }
          >
            {entry.detail === "link" && <MessagesSquare />}
            {t(
              entry.detail === "link"
                ? "capabilities.session.open"
                : "agent.materials.configureAgent",
            )}
          </Button>
        </div>
      </CapabilityDetailShell>
    );
  if (entry.detail === "web")
    return (
      <CapabilityDetailShell entry={entry} active={active}>
        <p className="border-b py-3 text-sm text-muted-foreground">
          {t("capabilities.web.scopeNote")}
        </p>
        <WebAccessPanel active={active} embedded />
      </CapabilityDetailShell>
    );
  if (entry.detail === "media")
    return (
      <CapabilityDetailShell entry={entry} active={active}>
        <div className="w-full space-y-6 py-6">
          <p className="text-sm text-muted-foreground">{t("capabilities.media.scopeNote")}</p>
          <CapabilityPolicyPanel modules={["qqMedia", "qqStickers"]} active={active} />
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button
              variant="outline"
              size="sm"
              tooltip={t("hints.system.openStickers")}
              onClick={() => openSettingsRoute("qq-stickers")}
            >
              {t("workspace.sticker_library")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              tooltip={t("hints.system.openChatSchemes")}
              onClick={() => openSettingsRoute("qq-scheme-config")}
            >
              {t("workspace.chat_schemes")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              tooltip={t("hints.system.openModelServices")}
              onClick={() => openSettingsRoute("models")}
            >
              {t("models.title")}
            </Button>
          </div>
        </div>
      </CapabilityDetailShell>
    );
  if (entry.detail === "members")
    return (
      <CapabilityDetailShell entry={entry} active={active}>
        <div className="w-full space-y-6 py-6">
          <p className="text-sm text-muted-foreground">{t("capabilities.members.scopeNote")}</p>
          <CapabilityPolicyPanel modules={["qqMembers"]} active={active} />
          <div className="flex flex-wrap gap-2 border-t pt-4">
            <Button
              variant="outline"
              size="sm"
              tooltip={t("hints.system.openGroupConfig")}
              onClick={() => openSettingsRoute("qq-app-groups")}
            >
              {t("schemes.qq.groupConfigTitle")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              tooltip={t("hints.system.openQqConnection")}
              onClick={() => openSettingsRoute("qq-connection")}
            >
              {t("schemes.qq.connectionTitle")}
            </Button>
          </div>
        </div>
      </CapabilityDetailShell>
    );
  if (entry.detail === "execution")
    return (
      <CapabilityDetailShell entry={entry} active={active}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b py-3">
          <p className="text-sm text-muted-foreground">{t("capabilities.execution.scopeNote")}</p>
          <Button
            variant="outline"
            size="sm"
            tooltip={t("hints.system.openTasks")}
            onClick={() => openSettingsRoute("task-ledger")}
          >
            {t("capabilities.execution.openTasks")}
          </Button>
        </div>
        <ExecutionSettings active={active} embedded />
      </CapabilityDetailShell>
    );
  return (
    <CapabilityDetailShell entry={entry} active={active}>
      <p className="py-6 text-sm text-muted-foreground">{t("capabilities.session.note")}</p>
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
