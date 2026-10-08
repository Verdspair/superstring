import { RefreshCw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { executionPolicy, type PermissionResource } from "../../../shared/contracts/permissions";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import type { GrantDraft } from "../../features/access/permission-draft";
import {
  type ExecutionModuleKey,
  type PermissionScope,
  permissionResources,
  permissionSettingsDirty,
} from "../../features/access/permission-state";
import { useSuperstringStore } from "../../store";

const groupOf = (name: string) =>
  name.startsWith("mcp.") ? "mcp" : name.startsWith("skill.") ? "skill" : "builtin";

/** 资源 → 所属执行模块（已保存状态下用于显示"所属模块已暂停"，不读草稿）。 */
const moduleOf = (resource: string): ExecutionModuleKey | undefined => {
  if (resource === "mcp" || resource.startsWith("mcp.")) return "mcp";
  if (resource === "skill" || resource.startsWith("skill.")) return "skills";
  if (resource === "web" || resource.startsWith("web.")) return "web";
  return undefined;
};

export function ToolGrantsPanel({
  scope,
  embedded = false,
  active = true,
}: {
  /** 资源过滤：external＝MCP/技能，builtin＝内置动作，字符串数组按资源名前缀；缺省＝全部。 */
  scope?: "external" | "builtin" | string[];
  /** 嵌入其他页面时去掉自带页容器，仅保留节内间距。 */
  embedded?: boolean;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const agents = useSuperstringStore((s) => s.agents);
  const editor = useSuperstringStore((s) => s.permissionEditor);
  const loading = useSuperstringStore((s) => s.permissionLoading);
  const saving = useSuperstringStore((s) => s.permissionSaving);
  const error = useSuperstringStore((s) => s.permissionError);
  const errorScope = useSuperstringStore((s) => s.permissionErrorScope);
  const notice = useSuperstringStore((s) =>
    s.permissionNotice === "connections.grants.saved" ? s.permissionNotice : "",
  );
  const load = useSuperstringStore((s) => s.loadPermissionSettings);
  const save = useSuperstringStore((s) => s.savePermissionSettings);
  const discard = useSuperstringStore((s) => s.discardPermissionSettings);
  const edit = useSuperstringStore((s) => s.patchToolGrant);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    if (active) void load();
  }, [active, load]);
  const snapshot = editor?.snapshot;
  const drafts = editor?.grants ?? {};
  const resources = snapshot ? permissionResources(snapshot) : [];
  const matchesScope = (resource: PermissionResource) => {
    if (scope === undefined) return true;
    if (scope === "external") return groupOf(resource.name) !== "builtin";
    if (scope === "builtin") return groupOf(resource.name) === "builtin";
    return scope.some(
      (entry) => resource.resource === entry || resource.resource.startsWith(`${entry}.`),
    );
  };
  const rows = resources.filter(matchesScope);
  // 缺省作用域即整域 "grants"；显式过滤时只提交本次可见资源的草稿。
  const editScope: PermissionScope =
    scope === undefined ? "grants" : { resources: rows.map((resource) => resource.resource) };
  const dirty = permissionSettingsDirty(editor, editScope);
  const groups: ("mcp" | "skill" | "builtin")[] = ["mcp", "skill", "builtin"];
  // 数值越界错误由执行设置页就地提示（那里才能修正）；其余可修复错误不因去重被隐藏。
  const showError = !!error && errorScope !== "execution";
  const modulePaused = (resource: PermissionResource) => {
    if (!snapshot) return false;
    const module = moduleOf(resource.resource);
    return module !== undefined && !executionPolicy(snapshot.policy).modules[module];
  };
  return (
    <div className={embedded ? "space-y-6" : "mx-auto max-w-6xl space-y-6 px-6 py-6 lg:px-8"}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold">{t("connections.grants.title")}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("connections.grants.description")}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{t("connections.grants.pauseHint")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={loading || saving} onClick={() => void load(true)}>
            <RefreshCw />
            {t("connections.common.refresh")}
          </Button>
          <Button variant="outline" disabled={!dirty || saving} onClick={() => discard(editScope)}>
            {t("library.discard.changes")}
          </Button>
          <Button
            disabled={!dirty || saving || loading || !snapshot}
            onClick={() => void save(editScope)}
          >
            <Save />
            {t("connections.grants.save")}
          </Button>
        </div>
      </div>
      {showError && (
        <p role="alert" className="text-sm text-destructive">
          {t(error)}
        </p>
      )}
      {dirty && <p className="text-xs text-muted-foreground">{t("connections.grants.unsaved")}</p>}
      {!dirty && notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(notice)}
        </p>
      )}
      {groups.map((group) => {
        const groupRows = rows.filter((resource) => groupOf(resource.name) === group);
        if (!groupRows.length) return null;
        return (
          <section key={group} className="space-y-3">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="size-4 text-muted-foreground" />
              {t(`connections.grants.group.${group}`)}
            </h3>
            <div className="overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("connections.grants.resource")}</TableHead>
                    <TableHead>{t("connections.grants.effect")}</TableHead>
                    <TableHead>{t("connections.grants.enabled")}</TableHead>
                    <TableHead>{t("connections.grants.approved")}</TableHead>
                    <TableHead>{t("connections.grants.scope")}</TableHead>
                    <TableHead className="text-right">{t("connections.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groupRows.map((resource) => (
                    <ResourceRow
                      key={resource.resource}
                      resource={resource}
                      available={
                        !!snapshot?.resources.some((item) => item.resource === resource.resource)
                      }
                      outdated={
                        !!snapshot?.policy.grants.some(
                          (grant) =>
                            grant.resource === resource.resource &&
                            grant.revision !== undefined &&
                            grant.revision !== resource.revision,
                        )
                      }
                      modulePaused={modulePaused(resource)}
                      draft={drafts[resource.resource]}
                      agents={agents}
                      expanded={expanded === resource.resource}
                      disabled={saving}
                      onToggleExpand={() =>
                        setExpanded(expanded === resource.resource ? null : resource.resource)
                      }
                      onEdit={(patch) => edit(resource.resource, patch)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        );
      })}
      {!loading && !rows.length && (
        <p className="text-sm text-muted-foreground">{t("connections.grants.empty")}</p>
      )}
    </div>
  );
}

function ResourceRow({
  resource,
  available,
  outdated,
  modulePaused,
  draft,
  agents,
  expanded,
  disabled,
  onToggleExpand,
  onEdit,
}: {
  resource: PermissionResource;
  available: boolean;
  outdated: boolean;
  modulePaused: boolean;
  draft: GrantDraft | undefined;
  agents: { id: string; name: string }[];
  expanded: boolean;
  disabled: boolean;
  onToggleExpand: () => void;
  onEdit: (patch: Partial<GrantDraft>) => void;
}) {
  const { t } = useTranslation();
  const value: GrantDraft = draft ?? {
    enabled: false,
    approved: false,
    agentIds: null,
    directories: [],
  };
  const required = resource.directories ?? [];
  return (
    <>
      <TableRow>
        <TableCell className="align-top">
          <div className="font-mono text-sm">{resource.resource}</div>
          <div className="text-xs whitespace-normal text-muted-foreground">
            {available ? resource.description : t("connections.grants.offline")}
          </div>
          {outdated && (
            <p className="text-xs text-destructive">{t("connections.grants.revisionChanged")}</p>
          )}
          {modulePaused && (
            <p className="text-xs whitespace-normal text-muted-foreground">
              {t("connections.grants.modulePaused")}
            </p>
          )}
        </TableCell>
        <TableCell className="align-top">
          <Badge variant="outline">
            {t(
              !available
                ? "connections.unknown"
                : resource.effect === "read"
                  ? "connections.grants.effectRead"
                  : "connections.grants.effectWrite",
            )}
          </Badge>
        </TableCell>
        <TableCell className="align-top">
          <Checkbox
            checked={value.enabled}
            disabled={disabled}
            aria-label={t("connections.grants.enabledFor", { "0": resource.resource })}
            onCheckedChange={(checked) => onEdit({ enabled: checked === true })}
          />
        </TableCell>
        <TableCell className="align-top">
          {resource.approvalRequired ? (
            <Checkbox
              checked={value.approved}
              disabled={disabled || (!value.approved && (!available || !value.enabled))}
              aria-label={t("connections.grants.approvedFor", { "0": resource.resource })}
              onCheckedChange={(checked) => onEdit({ approved: checked === true })}
            />
          ) : (
            <span className="text-xs text-muted-foreground">
              {t("connections.grants.approvalNotRequired")}
            </span>
          )}
        </TableCell>
        <TableCell className="align-top text-xs text-muted-foreground">
          {value.agentIds === null
            ? t("connections.grants.scopeAll")
            : value.agentIds.length
              ? t("connections.grants.scopeSome", { "0": value.agentIds.length })
              : t("connections.grants.scopeNone")}
        </TableCell>
        <TableCell className="text-right align-top">
          <Button variant="ghost" size="sm" onClick={onToggleExpand}>
            {t(expanded ? "connections.grants.collapse" : "connections.manage")}
          </Button>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/40">
            <div className="space-y-4 py-1">
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("connections.grants.scope")}</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`scope-${resource.resource}`}
                    checked={value.agentIds === null}
                    disabled={disabled}
                    onChange={() => onEdit({ agentIds: null })}
                  />
                  {t("connections.grants.scopeAll")}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`scope-${resource.resource}`}
                    checked={value.agentIds !== null}
                    disabled={disabled}
                    onChange={() => onEdit({ agentIds: [] })}
                  />
                  {t("connections.grants.scopeSelected")}
                </label>
                {value.agentIds !== null && (
                  <div className="flex flex-wrap gap-4 pl-6">
                    {agents.map((agent) => (
                      <label
                        key={agent.id}
                        htmlFor={`agent-${resource.resource}-${agent.id}`}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          id={`agent-${resource.resource}-${agent.id}`}
                          checked={value.agentIds?.includes(agent.id) ?? false}
                          disabled={disabled}
                          onCheckedChange={(checked) => {
                            const current = value.agentIds ?? [];
                            onEdit({
                              agentIds:
                                checked === true
                                  ? [...current, agent.id]
                                  : current.filter((id) => id !== agent.id),
                            });
                          }}
                        />
                        {agent.name}
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">
                  {t("connections.grants.directories")}
                </legend>
                {required.length ? (
                  required.map((directory) => (
                    <label
                      key={directory}
                      htmlFor={`dir-${resource.resource}-${directory}`}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        id={`dir-${resource.resource}-${directory}`}
                        checked={value.directories.includes(directory)}
                        disabled={disabled}
                        onCheckedChange={(checked) =>
                          onEdit({
                            directories:
                              checked === true
                                ? [...value.directories, directory]
                                : value.directories.filter((item) => item !== directory),
                          })
                        }
                      />
                      <span className="font-mono text-xs">{directory}</span>
                    </label>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("connections.grants.noDirectories")}
                  </p>
                )}
              </fieldset>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
