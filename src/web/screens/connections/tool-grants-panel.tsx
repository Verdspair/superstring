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
  permissionResources,
  permissionSettingsDirty,
} from "../../features/access/permission-state";
import { useSuperstringStore } from "../../store";

const groupOf = (name: string) =>
  name.startsWith("mcp.") ? "mcp" : name.startsWith("skill.") ? "skill" : "builtin";

export function ToolGrantsPanel() {
  const { t } = useTranslation();
  const agents = useSuperstringStore((s) => s.agents);
  const editor = useSuperstringStore((s) => s.permissionEditor);
  const loading = useSuperstringStore((s) => s.permissionLoading);
  const saving = useSuperstringStore((s) => s.permissionSaving);
  const error = useSuperstringStore((s) => s.permissionError);
  const notice = useSuperstringStore((s) =>
    s.permissionNotice === "connections.grants.saved" ? s.permissionNotice : "",
  );
  const load = useSuperstringStore((s) => s.loadPermissionSettings);
  const save = useSuperstringStore((s) => s.savePermissionSettings);
  const discard = useSuperstringStore((s) => s.discardPermissionSettings);
  const edit = useSuperstringStore((s) => s.patchToolGrant);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => {
    void load();
  }, [load]);
  const snapshot = editor?.snapshot;
  const drafts = editor?.grants ?? {};
  const resources = snapshot ? permissionResources(snapshot) : [];
  const dirty = permissionSettingsDirty(editor, "grants");
  const groups: ("mcp" | "skill" | "builtin")[] = ["mcp", "skill", "builtin"];
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-6 py-6 lg:px-8">
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
          <Button variant="outline" disabled={!dirty || saving} onClick={() => discard("grants")}>
            {t("library.discard.changes")}
          </Button>
          <Button
            disabled={!dirty || saving || loading || !snapshot}
            onClick={() => void save("grants")}
          >
            <Save />
            {t("connections.grants.save")}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t(error)}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(notice)}
        </p>
      )}
      {dirty && !notice && (
        <p className="text-xs text-muted-foreground">{t("connections.grants.unsaved")}</p>
      )}
      {groups.map((group) => {
        const rows = resources.filter((resource) => groupOf(resource.name) === group);
        if (!rows.length) return null;
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
                  {rows.map((resource) => (
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
                      modulePaused={
                        !!snapshot &&
                        ((group === "mcp" && !executionPolicy(snapshot.policy).modules.mcp) ||
                          (group === "skill" && !executionPolicy(snapshot.policy).modules.skills))
                      }
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
      {!loading && !resources.length && (
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
          <div className="text-xs text-muted-foreground">
            {available ? resource.description : t("connections.grants.offline")}
          </div>
          {outdated && (
            <p className="text-xs text-destructive">{t("connections.grants.revisionChanged")}</p>
          )}
          {modulePaused && (
            <p className="text-xs text-muted-foreground">{t("connections.grants.modulePaused")}</p>
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
          <Checkbox
            checked={value.approved}
            disabled={disabled || (!value.approved && (!available || !value.enabled))}
            aria-label={t("connections.grants.approvedFor", { "0": resource.resource })}
            onCheckedChange={(checked) => onEdit({ approved: checked === true })}
          />
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
