import { RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolDirectoryEntry } from "../../../shared/contracts/tool-directory";
import { CatalogItem } from "../../components/catalog-item";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import { grantDraftOf } from "../../features/access/permission-draft";
import { useToolDirectoryResource } from "../../services/connection-resources";
import { useSuperstringStore } from "../../store";
import { CAPABILITY_CATALOG, TOOL_HUMAN_LABELS } from "../../workspace/capability-catalog";
import { ToolGrantsPanel } from "./tool-grants-panel";

export function ToolDirectoryPanel({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const api = useSuperstringStore((s) => s.apiClient);
  const editor = useSuperstringStore((s) => s.permissionEditor);
  const saving = useSuperstringStore((s) => s.permissionSaving);
  const loadPermissions = useSuperstringStore((s) => s.loadPermissionSettings);
  const target = useSuperstringStore((s) => s.componentTarget);
  const openRoute = useSuperstringStore((s) => s.openSettingsRoute);
  const { data, loading, error: readError, refresh } = useToolDirectoryResource(api, active);
  const tools = data?.tools ?? [];
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState("all");
  const [detail, setDetail] = useState<ToolDirectoryEntry | null>(null);
  const [grantResource, setGrantResource] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (active) void loadPermissions();
  }, [active, loadPermissions]);
  useEffect(() => {
    if (target?.kind !== "tool" || loading) return;
    const entry = tools.find((tool) => tool.name === target.id);
    if (entry) {
      setDetail(entry);
      setError("");
    } else setError(t("connections.tools.unavailable"));
  }, [target, tools, loading, t]);
  const needle = query.trim().toLocaleLowerCase();
  const visible = tools
    .filter((tool) => origin === "all" || origin === tool.origin)
    .filter((tool) => {
      if (!needle) return true;
      const humanKey = TOOL_HUMAN_LABELS[tool.name];
      const labels = humanKey ? t(humanKey) : "";
      const description =
        tool.origin === "system"
          ? t(`connections.components.toolSummary.${tool.name}`, { defaultValue: tool.description })
          : tool.description;
      return `${tool.name} ${tool.description} ${description} ${labels} ${tool.resource ?? ""}`
        .toLocaleLowerCase()
        .includes(needle);
    })
    .slice()
    .sort((a, b) => Number(b.globalEnabled) - Number(a.globalEnabled));
  const authorisation = (tool: ToolDirectoryEntry) => {
    if (!tool.resource) return t("connections.components.scopeBound");
    if (!editor) return t("capabilities.state.unread");
    const draft =
      editor.grants[tool.resource] ??
      grantDraftOf(editor.snapshot.policy, tool.resource, tool.revision ?? undefined);
    if (!draft.enabled) return t("connections.components.noGrant");
    if (tool.approvalRequired && !draft.approved) return t("connections.tools.approvalNeeded");
    return draft.agentIds === null
      ? t("connections.grants.scopeAll")
      : t("connections.grants.scopeSome", { "0": draft.agentIds.length });
  };
  const configure = (tool: ToolDirectoryEntry) => {
    const entry = CAPABILITY_CATALOG.find((capability) => capability.id === tool.functionId);
    if (entry) openRoute(entry.route);
  };
  const closeDetail = () => {
    setDetail(null);
    if (useSuperstringStore.getState().componentTarget?.kind === "tool")
      useSuperstringStore.setState({ componentTarget: null });
  };
  return (
    <div className="w-full space-y-5 px-4 py-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="workspace-section-title">{t("connections.tools.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("connections.tools.description")}</p>
        </div>
        <Button
          variant="outline"
          tooltip={t("hints.extensions.tools.refresh")}
          disabled={loading || saving}
          onClick={() => {
            refresh();
            void loadPermissions(true);
          }}
        >
          <RefreshCw />
          {t("connections.common.refresh")}
        </Button>
      </div>
      <div className="flex items-center gap-3">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-9"
            aria-label={t("connections.tools.search")}
            placeholder={t("connections.tools.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <NativeSelect
          className="w-auto"
          aria-label={t("connections.tools.origin")}
          value={origin}
          onChange={(event) => setOrigin(event.target.value)}
        >
          <option value="all">{t("connections.tools.all")}</option>
          <option value="system">{t("connections.components.system")}</option>
          <option value="mcp">{t("schemes.qq.groupConfig.capability.mcp")}</option>
        </NativeSelect>
      </div>
      {(readError || error) && (
        <p role="alert" className="text-sm text-destructive">
          {readError || error}
        </p>
      )}
      <div className="overflow-hidden rounded-lg border border-border/80 bg-card text-card-foreground">
        <div className="divide-y divide-border/60">
          {visible.map((tool) => {
            const humanKey = TOOL_HUMAN_LABELS[tool.name];
            return (
              <div
                key={tool.name}
                data-tool-name={tool.name}
                data-global-enabled={tool.globalEnabled}
              >
                <CatalogItem
                  muted={!tool.globalEnabled}
                  open={needle ? true : (expanded[tool.name] ?? false)}
                  onOpenChange={(next) =>
                    setExpanded((previous) => ({ ...previous, [tool.name]: next }))
                  }
                  summary={
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        {humanKey && (
                          <span className="text-sm font-medium text-foreground">{t(humanKey)}</span>
                        )}
                        <span className="font-mono text-sm font-medium text-foreground">
                          {tool.name}
                        </span>
                        <Badge variant="outline">
                          {tool.origin === "system" ? t("connections.components.system") : "MCP"}
                        </Badge>
                        <span className="text-xs">
                          {t(
                            tool.effect === "read"
                              ? "connections.grants.effectRead"
                              : "connections.grants.effectWrite",
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t(
                            tool.globalEnabled
                              ? "connections.components.globalOn"
                              : "connections.components.globalOff",
                          )}
                        </span>
                      </div>
                      <p className="max-w-48 whitespace-normal text-xs text-muted-foreground">
                        {authorisation(tool)}
                      </p>
                    </div>
                  }
                  actions={
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        tooltip={t("hints.extensions.tools.details")}
                        onClick={() => setDetail(tool)}
                      >
                        {t("connections.tools.details")}
                      </Button>
                      {tool.functionId && (
                        <Button
                          variant="ghost"
                          size="sm"
                          tooltip={t("hints.extensions.tools.configureFunction")}
                          onClick={() => configure(tool)}
                        >
                          {t("connections.tools.configureFunction")}
                        </Button>
                      )}
                      {tool.resource && (
                        <Button
                          variant="ghost"
                          size="sm"
                          tooltip={t("hints.extensions.tools.manageGrant")}
                          onClick={() => setGrantResource(tool.resource)}
                        >
                          {t("connections.tools.manageGrant")}
                        </Button>
                      )}
                    </>
                  }
                >
                  <p className="whitespace-normal break-words text-sm leading-relaxed">
                    {tool.origin === "system"
                      ? t(`connections.components.toolSummary.${tool.name}`, {
                          defaultValue: tool.description,
                        })
                      : tool.description}
                  </p>
                </CatalogItem>
              </div>
            );
          })}
          {!visible.length && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {t(loading ? "connections.common.loading" : "connections.tools.empty")}
            </div>
          )}
        </div>
      </div>
      {grantResource && (
        <section className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-mono text-sm">{grantResource}</h3>
            <Button
              variant="ghost"
              size="sm"
              tooltip={t("hints.extensions.tools.collapse")}
              onClick={() => setGrantResource(null)}
            >
              {t("connections.grants.collapse")}
            </Button>
          </div>
          <ToolGrantsPanel embedded scope={[grantResource]} active={active} />
        </section>
      )}
      <Sheet
        open={active && detail !== null}
        onOpenChange={(open) => {
          if (!open) closeDetail();
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader className="border-b">
            <SheetTitle>{detail?.name}</SheetTitle>
            <SheetDescription>
              {detail?.origin === "system"
                ? t("connections.components.definitionLocked")
                : t("connections.tools.description")}
            </SheetDescription>
          </SheetHeader>
          {detail && (
            <div className="space-y-5 p-5">
              <Badge variant="outline">
                {detail.origin === "system" ? t("connections.components.system") : "MCP"}
              </Badge>
              <p className="text-sm leading-relaxed">{detail.description}</p>
              <p className="text-xs text-muted-foreground">
                {t(
                  detail.globalEnabled
                    ? "connections.components.globalOn"
                    : "connections.components.globalOff",
                )}
              </p>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <dt>{t("connections.components.capability")}</dt>
                <dd className="font-mono text-xs">{detail.capability}</dd>
                <dt>{t("connections.components.revision")}</dt>
                <dd className="break-all font-mono text-xs">{detail.revision ?? "—"}</dd>
              </dl>
              <h3 className="text-sm font-medium">{t("connections.components.parameters")}</h3>
              <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-xs">
                {JSON.stringify(detail.parameters, null, 2)}
              </pre>
              {detail.functionId && (
                <Button
                  variant="outline"
                  tooltip={t("hints.extensions.tools.configureFunction")}
                  onClick={() => configure(detail)}
                >
                  {t("connections.tools.configureFunction")}
                </Button>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
