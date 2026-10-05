import { RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolDirectoryEntry } from "../../../shared/contracts/tool-directory";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { grantDraftOf } from "../../features/access/permission-draft";
import { useToolDirectoryResource } from "../../services/connection-resources";
import { useSuperstringStore } from "../../store";
import { CAPABILITY_CATALOG } from "../../workspace/capability-catalog";
import { ToolGrantsPanel } from "./tool-grants-panel";

export function ToolDirectoryPanel() {
  const { t } = useTranslation();
  const api = useSuperstringStore((s) => s.apiClient);
  const editor = useSuperstringStore((s) => s.permissionEditor);
  const saving = useSuperstringStore((s) => s.permissionSaving);
  const loadPermissions = useSuperstringStore((s) => s.loadPermissionSettings);
  const target = useSuperstringStore((s) => s.componentTarget);
  const openRoute = useSuperstringStore((s) => s.openSettingsRoute);
  const { data, loading, error: readError, refresh } = useToolDirectoryResource(api);
  const tools = data?.tools ?? [];
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [origin, setOrigin] = useState("all");
  const [detail, setDetail] = useState<ToolDirectoryEntry | null>(null);
  const [grantResource, setGrantResource] = useState<string | null>(null);
  useEffect(() => {
    void loadPermissions();
  }, [loadPermissions]);
  useEffect(() => {
    if (target?.kind !== "tool" || loading) return;
    const entry = tools.find((tool) => tool.name === target.id);
    if (entry) {
      setDetail(entry);
      setError("");
    } else setError(t("connections.tools.unavailable"));
  }, [target, tools, loading, t]);
  const visible = tools.filter(
    (tool) =>
      (origin === "all" || origin === tool.origin) &&
      `${tool.name} ${tool.description}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
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
          <h2 className="font-semibold">{t("connections.tools.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("connections.tools.description")}</p>
        </div>
        <Button
          variant="outline"
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
      <div className="overflow-hidden rounded-lg border">
        <Table aria-label={t("connections.tools.title")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("connections.tools.name")}</TableHead>
              <TableHead>{t("connections.tools.origin")}</TableHead>
              <TableHead>{t("connections.tools.effect")}</TableHead>
              <TableHead>{t("connections.tools.state")}</TableHead>
              <TableHead>{t("connections.tools.authorisation")}</TableHead>
              <TableHead className="text-right">{t("connections.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((tool) => (
              <TableRow
                key={tool.name}
                data-tool-name={tool.name}
                data-global-enabled={tool.globalEnabled}
                className={tool.globalEnabled ? undefined : "text-muted-foreground bg-muted/30"}
              >
                <TableCell className="max-w-md whitespace-normal align-top">
                  <div className="font-mono text-sm">{tool.name}</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {tool.description}
                  </p>
                </TableCell>
                <TableCell className="align-top">
                  <Badge variant="outline">
                    {tool.origin === "system" ? t("connections.components.system") : "MCP"}
                  </Badge>
                </TableCell>
                <TableCell className="align-top text-xs">
                  {t(
                    tool.effect === "read"
                      ? "connections.grants.effectRead"
                      : "connections.grants.effectWrite",
                  )}
                </TableCell>
                <TableCell className="align-top text-xs">
                  {t(
                    tool.globalEnabled
                      ? "connections.components.globalOn"
                      : "connections.components.globalOff",
                  )}
                </TableCell>
                <TableCell className="max-w-48 whitespace-normal align-top text-xs">
                  {authorisation(tool)}
                </TableCell>
                <TableCell className="align-top text-right">
                  <div className="flex flex-col items-end gap-1">
                    <Button variant="ghost" size="sm" onClick={() => setDetail(tool)}>
                      {t("connections.tools.details")}
                    </Button>
                    {tool.functionId && (
                      <Button variant="ghost" size="sm" onClick={() => configure(tool)}>
                        {t("connections.tools.configureFunction")}
                      </Button>
                    )}
                    {tool.resource && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setGrantResource(tool.resource)}
                      >
                        {t("connections.tools.manageGrant")}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {!visible.length && (
              <TableRow>
                <TableCell colSpan={6} className="py-12 text-center text-muted-foreground">
                  {t(loading ? "connections.common.loading" : "connections.tools.empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {grantResource && (
        <section className="space-y-3 rounded-lg border p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-mono text-sm">{grantResource}</h3>
            <Button variant="ghost" size="sm" onClick={() => setGrantResource(null)}>
              {t("connections.grants.collapse")}
            </Button>
          </div>
          <ToolGrantsPanel embedded scope={[grantResource]} />
        </section>
      )}
      <Sheet
        open={detail !== null}
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
                <Button variant="outline" onClick={() => configure(detail)}>
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
