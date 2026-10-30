import { Layers, RefreshCw, Save, Search, Undo2 } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Field } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { agentPageDirty } from "@/features/agents/page-drafts";
import { translateNotice } from "@/i18n";
import { useSuperstringStore } from "@/store";
import { P5ConfigSchema } from "../../../shared/contracts/models";
import { compilePersona } from "../../../shared/contracts/persona-compile";
import { projectAgentPermissionEdits } from "../../features/access/permission-state";
import { useToolDirectoryResource } from "../../services/connection-resources";
import { TOOL_HUMAN_LABELS } from "../../workspace/capability-catalog";
import { WorkspaceHelp } from "../../workspace/WorkspaceHelp";
import { AllocationModelCapacity } from "../connections/AllocationModelCapacity";
import { ContextAllocationAuxiliary } from "../connections/ContextAllocationAuxiliary";
import { AgentModelPurpose } from "../environment/AgentModelPurpose";

export function IdentityEditor() {
  const s = useSuperstringStore(
    useShallow((state) => ({
      pageEditor: state.pageEditor,
      settingsSaving: state.settingsSaving,
      patchPageAgent: state.patchPageAgent,
      patchPagePersona: state.patchPagePersona,
    })),
  );
  const t = useTranslation().t;
  const editor = s.pageEditor;
  const previewPersona = editor?.personaDraft;
  const previewIntensity = editor?.draft.persona_intensity;
  const compiledPersona = useMemo(
    () =>
      previewPersona && previewIntensity !== undefined
        ? compilePersona(previewPersona, previewIntensity)
        : "",
    [previewPersona, previewIntensity],
  );
  if (!editor) return null;
  const { draft, personaDraft: persona } = editor;
  return (
    <div className="grid items-start gap-[28px] xl:grid-cols-[minmax(0,1fr)_minmax(260px,.6fr)]">
      <div className="space-y-6">
        <Card presentation="plain">
          <CardHeader>
            <CardTitle>{t("library.basic.identity")}</CardTitle>
            <CardDescription>
              {t("library.the.name.identifies.your.agent.personality.shapes.how.it")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field label="library.name" tooltip={t("hints.agent.fieldName")}>
              <Input
                value={draft.name}
                onChange={(e) => s.patchPageAgent("basic", { name: e.target.value })}
              />
            </Field>
            <Field label="library.description" tooltip={t("hints.agent.fieldDescription")}>
              <Textarea
                value={draft.description}
                onChange={(e) => s.patchPageAgent("basic", { description: e.target.value })}
              />
            </Field>
            <Field label="library.enable.agent" tooltip={t("hints.agent.fieldActive")}>
              <Checkbox
                checked={draft.is_active}
                onCheckedChange={(v) => s.patchPageAgent("basic", { is_active: v === true })}
              />
            </Field>
          </CardContent>
        </Card>
        <Card presentation="plain">
          <CardHeader>
            <CardTitle>{t("library.personality.expression")}</CardTitle>
            <CardDescription>
              {t("library.all.fields.are.optional.the.preview.uses.the.actual")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {(
              [
                ["core_identity", "library.core.identity", "identity"],
                ["interaction_boundaries", "library.interaction.boundaries", "identity"],
                ["communication_style", "library.communication.style", "expression"],
                ["example_dialogues", "library.example.dialogues", "expression"],
                ["advanced_instructions", "library.advanced.instructions", "identity"],
              ] as const
            ).map(([key, label, page]) => (
              <Field key={key} label={label} tooltip={t(`strict.persona.${key}`)}>
                <Textarea
                  rows={key === "example_dialogues" ? 5 : 3}
                  value={persona[key]}
                  onChange={(e) => s.patchPagePersona(page, { [key]: e.target.value })}
                />
              </Field>
            ))}
            <Field
              label="library.personality.strength"
              info="library.only.changes.how.much.communication.style.and.example.dialogue"
              tooltip={t("hints.agent.fieldPersonalityStrength")}
            >
              <Slider
                disabled={s.settingsSaving}
                min={0}
                max={100}
                step={1}
                value={[draft.persona_intensity]}
                onValueChange={(v) =>
                  s.patchPageAgent("expression", {
                    persona_intensity: v[0] ?? draft.persona_intensity,
                  })
                }
              />
              <output className="text-sm tabular-nums">{draft.persona_intensity}%</output>
            </Field>
            <Field
              label="library.additional.instructions"
              tooltip={t("hints.agent.fieldAdditionalInstructions")}
            >
              <Textarea
                rows={4}
                value={draft.additional_instructions}
                onChange={(e) =>
                  s.patchPageAgent("identity", { additional_instructions: e.target.value })
                }
              />
            </Field>
          </CardContent>
        </Card>
      </div>
      <Card presentation="plain" className="xl:sticky xl:top-6">
        <CardHeader>
          <CardTitle>{t("library.personality.preview")}</CardTitle>
          <CardDescription>
            {t("library.actual.compiled.text.no.model.request.is.made")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[65dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">
            {compiledPersona || t("library.no.personality.defined")}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

export function AgentToolScope({ agentId, active }: { agentId: string; active: boolean }) {
  const { t } = useTranslation();
  const scopeId = useId();
  const searchHelpId = useId();
  const s = useSuperstringStore(
    useShallow((state) => ({
      apiClient: state.apiClient,
      editorAgentId: state.editorAgentId,
      permissionEditor: state.permissionEditor,
      permissionLoading: state.permissionLoading,
      permissionSaving: state.permissionSaving,
      permissionError: state.permissionError,
      taskResult: state.agentTaskResult,
      loadPermissionSettings: state.loadPermissionSettings,
      patchToolGrant: state.patchToolGrant,
      savePermissionSettings: state.savePermissionSettings,
      agents: state.agents,
    })),
  );

  const currentAgent = s.agents.find((a) => a.id === agentId);
  const {
    data,
    loading: directoryLoading,
    error: directoryError,
    refresh,
  } = useToolDirectoryResource(s.apiClient, active);
  const tools = data?.tools ?? [];

  const [query, setQuery] = useState("");

  useEffect(() => {
    if (
      active &&
      agentId !== "__new__" &&
      s.editorAgentId !== "__new__" &&
      useSuperstringStore.getState().apiClient === s.apiClient
    ) {
      void s.loadPermissionSettings();
    }
  }, [active, agentId, s.editorAgentId, s.apiClient, s.loadPermissionSettings]);

  const needle = query.trim().toLowerCase();
  const visible = tools.filter((tool) => {
    if (!needle) return true;
    const humanKey = TOOL_HUMAN_LABELS[tool.name];
    const label = humanKey ? t(humanKey) : "";
    return (
      tool.name.toLowerCase().includes(needle) ||
      label.toLowerCase().includes(needle) ||
      tool.description.toLowerCase().includes(needle)
    );
  });

  const builtinTools = visible.filter((tool) => tool.resource === null);
  const resourceGroups = useMemo(() => {
    const map = new Map<string, typeof tools>();
    for (const tool of visible) {
      if (tool.resource !== null) {
        const list = map.get(tool.resource) ?? [];
        list.push(tool);
        map.set(tool.resource, list);
      }
    }
    return Array.from(map.entries());
  }, [visible]);

  const grantViews = useMemo(
    () => projectAgentPermissionEdits(s.permissionEditor, agentId),
    [s.permissionEditor, agentId],
  );

  return (
    <Card
      presentation="plain"
      role="region"
      aria-label={t("library.tools.for.agent")}
      aria-describedby={scopeId}
    >
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{t("library.tools.for.agent")}</CardTitle>
              <WorkspaceHelp
                title={t("library.tools.for.agent")}
                description={t("library.tools.for.agent.hint")}
              />
            </div>
            <CardDescription id={scopeId}>{t("library.tools.for.agent.scope")}</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            tooltip={t("hints.extensions.tools.refresh")}
            disabled={directoryLoading || s.permissionLoading || s.permissionSaving}
            onClick={() => {
              refresh();
              void s.loadPermissionSettings(true);
            }}
          >
            <RefreshCw className="size-3.5" />
            {t("connections.common.refresh", { defaultValue: "刷新" })}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-52 flex-1">
            <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
            <Input
              className="pl-9"
              aria-label={t("connections.tools.search")}
              aria-describedby={searchHelpId}
              placeholder={t("connections.tools.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <WorkspaceHelp
            title={t("connections.tools.searchPlaceholder")}
            description={t("connections.tools.agentSearchHelp")}
          />
          <span id={searchHelpId} className="sr-only">
            {t("connections.tools.agentSearchHelp")}
          </span>
        </div>

        {directoryError && (
          <p role="alert" className="text-sm text-destructive">
            {directoryError}
          </p>
        )}

        {s.permissionError && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {!(
              s.taskResult?.agentId === agentId &&
              s.taskResult.task === "tools" &&
              s.taskResult.error
            ) && <p role="alert">{translateNotice(s.permissionError)}</p>}
            <Button
              variant="outline"
              size="sm"
              disabled={s.permissionLoading}
              onClick={() => void s.loadPermissionSettings(true)}
            >
              {t("capabilities.retry")}
            </Button>
          </div>
        )}

        <div className="divide-y divide-border/60 rounded-lg border border-border/80 bg-card">
          {visible.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {directoryLoading ? t("library.loading") : t("connections.tools.empty")}
            </p>
          ) : (
            <>
              {builtinTools.map((tool) => {
                const humanKey = TOOL_HUMAN_LABELS[tool.name];
                return (
                  <div
                    key={tool.name}
                    className="flex flex-wrap items-center justify-between gap-3 p-3.5 sm:p-4"
                  >
                    <div className="min-w-0 max-w-full flex-1 basis-60 space-y-1">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        {humanKey && <span className="text-sm font-medium">{t(humanKey)}</span>}
                        <span className="font-mono text-sm text-muted-foreground">{tool.name}</span>
                        <Badge variant="outline">{t("connections.grants.group.builtin")}</Badge>
                        <span className="text-xs text-muted-foreground">
                          {tool.effect === "read"
                            ? t("connections.grants.effectRead")
                            : t("connections.grants.effectWrite")}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t(`connections.tools.scope.${tool.scope}`)}
                        </span>
                        {tool.invocation === "host-terminal" && (
                          <span className="text-xs text-muted-foreground">
                            {t("connections.tools.hostTerminal")}
                          </span>
                        )}
                        {!tool.globalEnabled && (
                          <Badge
                            variant="outline"
                            wrap
                            className="text-[10px] border-destructive/60 text-destructive"
                          >
                            {t("connections.grants.modulePaused")}
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {tool.origin === "system"
                          ? t(`connections.components.toolSummary.${tool.name}`, {
                              defaultValue: tool.description,
                            })
                          : tool.description}
                      </p>
                    </div>
                    {!tool.globalEnabled ? (
                      <Badge
                        variant="outline"
                        wrap
                        className="text-xs border-destructive/60 text-destructive"
                      >
                        {t("connections.grants.modulePaused")}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        {t(
                          tool.invocation === "host-terminal"
                            ? "connections.tools.hostTerminalHint"
                            : "connections.components.scopeBound",
                        )}
                      </span>
                    )}
                  </div>
                );
              })}

              {resourceGroups.map(([resource, groupTools]) => {
                const isEditorReady = s.permissionEditor !== null;
                const grantDraft = s.permissionEditor?.grants[resource];
                const overrideDraft = grantDraft?.agentOverrides?.[agentId];
                const hasOverride = overrideDraft !== undefined;

                const view = grantViews.get(resource);
                const savedOverride = view?.saved?.agentOverrides?.[agentId];
                const isSavedDisabled = savedOverride?.enabled === false;
                const hasSavedOverride = savedOverride !== undefined;
                const draftEffectiveEnabled = view?.enabled ?? false;
                const anyApprovalRequired = groupTools.some((tool) => tool.approvalRequired);
                const draftEffectiveApproved = view?.approved ?? false;

                const isDirty = view?.dirty ?? false;
                const declaredDirectories = view?.declaredDirectories ?? [];

                const baseOverride = view?.base ?? {
                  enabled: false,
                  approved: false,
                  revision: groupTools[0]?.revision ?? undefined,
                  directories: [],
                };
                const currentDirectories = view?.directories ?? [];

                const historicalDirectories = Array.from(
                  new Set(currentDirectories.filter((d) => !declaredDirectories.includes(d))),
                );

                return (
                  <div
                    key={resource}
                    data-resource={resource}
                    className="flex flex-wrap items-start justify-between gap-4 p-3.5 sm:p-4"
                  >
                    <div className="min-w-0 max-w-full flex-1 basis-60 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm font-semibold text-foreground">
                          {resource}
                        </span>
                        {hasSavedOverride ? (
                          <Badge variant={isSavedDisabled ? "destructive" : "secondary"}>
                            {t(
                              isSavedDisabled
                                ? "connections.grants.agentOverrideDisabled"
                                : "connections.grants.agentOverrideExplicit",
                            )}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {t("connections.grants.agentOverrideInherited")}
                          </span>
                        )}
                        {isDirty && (
                          <Badge variant="outline" className="border-warning text-warning">
                            {t("strict.reading.dirty", { defaultValue: "未保存" })}
                          </Badge>
                        )}
                      </div>

                      <div className="space-y-1 pl-2 border-l-2 border-border/60">
                        {groupTools.map((tool) => {
                          const humanKey = TOOL_HUMAN_LABELS[tool.name];
                          const isDuplicateName = groupTools.length === 1 && tool.name === resource;
                          return (
                            <div
                              key={tool.name}
                              className="flex flex-wrap items-center gap-2 text-xs"
                            >
                              {humanKey && (
                                <span className="font-medium text-foreground">{t(humanKey)}</span>
                              )}
                              {!isDuplicateName && (
                                <span className="font-mono text-muted-foreground">{tool.name}</span>
                              )}
                              <Badge variant="outline" className="text-[10px] h-4">
                                {tool.origin === "system"
                                  ? t("connections.components.system")
                                  : "MCP"}
                              </Badge>
                              <span className="text-[11px] text-muted-foreground">
                                {tool.effect === "read"
                                  ? t("connections.grants.effectRead")
                                  : t("connections.grants.effectWrite")}
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                {t(`connections.tools.scope.${tool.scope}`)}
                              </span>
                              {!tool.globalEnabled ? (
                                <Badge
                                  variant="outline"
                                  wrap
                                  className="text-[10px] border-destructive/60 text-destructive"
                                >
                                  {t("connections.grants.modulePaused")}
                                </Badge>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>

                      <fieldset
                        data-testid={`agent-directories-${resource}`}
                        className="space-y-2 pt-2 border-t border-border/40"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <legend className="text-xs font-medium text-foreground">
                            {t("connections.grants.directories")}
                          </legend>
                          <span className="text-[11px] text-muted-foreground">
                            {hasOverride
                              ? t("connections.grants.agentOverrideExplicit")
                              : t("connections.grants.agentOverrideInherited")}
                          </span>
                        </div>

                        {declaredDirectories.length > 0 || historicalDirectories.length > 0 ? (
                          <div className="space-y-1.5">
                            {declaredDirectories.map((directory) => (
                              <label
                                key={directory}
                                htmlFor={`agent-dir-${resource}-${directory}`}
                                className="flex items-center gap-2 text-xs cursor-pointer"
                              >
                                <Checkbox
                                  id={`agent-dir-${resource}-${directory}`}
                                  data-testid={`agent-dir-${resource}-${directory}`}
                                  checked={currentDirectories.includes(directory)}
                                  disabled={
                                    !isEditorReady || s.permissionSaving || s.permissionLoading
                                  }
                                  onCheckedChange={(checked) => {
                                    const willCheck = checked === true;
                                    const base = overrideDraft ?? baseOverride;
                                    const nextDirs = willCheck
                                      ? Array.from(new Set([...base.directories, directory]))
                                      : base.directories.filter((d) => d !== directory);
                                    const nextOverrides = {
                                      ...grantDraft?.agentOverrides,
                                      [agentId]: {
                                        ...base,
                                        directories: nextDirs,
                                      },
                                    };
                                    s.patchToolGrant(resource, { agentOverrides: nextOverrides });
                                  }}
                                />
                                <span className="font-mono text-xs break-all">{directory}</span>
                              </label>
                            ))}
                            {historicalDirectories.map((directory) => (
                              <label
                                key={`hist-${directory}`}
                                htmlFor={`agent-dir-hist-${resource}-${directory}`}
                                className="flex items-center gap-2 text-xs cursor-pointer"
                              >
                                <Checkbox
                                  id={`agent-dir-hist-${resource}-${directory}`}
                                  data-testid={`agent-dir-hist-${resource}-${directory}`}
                                  checked={currentDirectories.includes(directory)}
                                  disabled={
                                    !isEditorReady || s.permissionSaving || s.permissionLoading
                                  }
                                  onCheckedChange={(checked) => {
                                    const willCheck = checked === true;
                                    const base = overrideDraft ?? baseOverride;
                                    const nextDirs = willCheck
                                      ? Array.from(new Set([...base.directories, directory]))
                                      : base.directories.filter((d) => d !== directory);
                                    const nextOverrides = {
                                      ...grantDraft?.agentOverrides,
                                      [agentId]: {
                                        ...base,
                                        directories: nextDirs,
                                      },
                                    };
                                    s.patchToolGrant(resource, { agentOverrides: nextOverrides });
                                  }}
                                />
                                <span className="font-mono text-xs text-muted-foreground break-all">
                                  {directory}
                                </span>
                                <Badge
                                  variant="outline"
                                  className="text-[10px] h-4 text-muted-foreground"
                                >
                                  {t("connections.grants.historicalDirectory", {
                                    defaultValue: t("connections.grants.offline", {
                                      defaultValue: "已存历史授权",
                                    }),
                                  })}
                                </Badge>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            {t("connections.grants.noDirectories")}
                          </p>
                        )}
                      </fieldset>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      <div className="flex items-center gap-1.5">
                        <Checkbox
                          id={`agent-tool-enable-${resource}`}
                          data-testid={`agent-tool-enable-${resource}`}
                          checked={draftEffectiveEnabled}
                          disabled={!isEditorReady || s.permissionSaving || s.permissionLoading}
                          aria-label={t("connections.grants.agentOverrideEnabledFor", {
                            "0": currentAgent?.name ?? agentId,
                          })}
                          onCheckedChange={(checked) => {
                            const nextEnabled = checked === true;
                            const base = overrideDraft ?? baseOverride;
                            const nextOverrides = {
                              ...grantDraft?.agentOverrides,
                              [agentId]: {
                                ...base,
                                enabled: nextEnabled,
                              },
                            };
                            s.patchToolGrant(resource, { agentOverrides: nextOverrides });
                          }}
                        />
                        <label
                          htmlFor={`agent-tool-enable-${resource}`}
                          className="text-xs cursor-pointer"
                        >
                          {t("connections.grants.enabled")}
                        </label>
                      </div>

                      {anyApprovalRequired ? (
                        <div className="flex items-center gap-1.5">
                          <Checkbox
                            id={`agent-tool-approve-${resource}`}
                            data-testid={`agent-tool-approve-${resource}`}
                            checked={draftEffectiveApproved}
                            disabled={!isEditorReady || s.permissionSaving || s.permissionLoading}
                            aria-label={t("connections.grants.agentOverrideApprovedFor", {
                              "0": currentAgent?.name ?? agentId,
                            })}
                            onCheckedChange={(checked) => {
                              const nextApproved = checked === true;
                              const base = overrideDraft ?? baseOverride;
                              const nextOverrides = {
                                ...grantDraft?.agentOverrides,
                                [agentId]: {
                                  ...base,
                                  approved: nextApproved,
                                },
                              };
                              s.patchToolGrant(resource, { agentOverrides: nextOverrides });
                            }}
                          />
                          <label
                            htmlFor={`agent-tool-approve-${resource}`}
                            className="text-xs cursor-pointer"
                          >
                            {t("connections.grants.approved")}
                          </label>
                        </div>
                      ) : null}
                      {hasOverride && (
                        <Button
                          variant="ghost"
                          size="sm"
                          data-testid={`agent-tool-revert-${resource}`}
                          tooltip={t("connections.grants.agentOverrideRevertHint")}
                          disabled={!isEditorReady || s.permissionSaving || s.permissionLoading}
                          onClick={() => {
                            const nextOverrides = { ...grantDraft?.agentOverrides };
                            delete nextOverrides[agentId];
                            s.patchToolGrant(resource, {
                              agentOverrides:
                                Object.keys(nextOverrides).length > 0 ? nextOverrides : undefined,
                            });
                          }}
                        >
                          {t("connections.grants.agentOverrideRevert")}
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
type AllocationNumberKey =
  | "context_window"
  | "max_output_tokens"
  | "safety_margin_ratio"
  | "recent_turns"
  | "compression_trigger_ratio"
  | "summary_target_tokens"
  | "summary_max_tokens"
  | "summary_read_max_tokens"
  | "auxiliary_timeout_seconds";

function AllocationAgentNumber({
  name,
  label,
  info,
}: {
  name: AllocationNumberKey;
  label: string;
  info?: string;
}) {
  const { t } = useTranslation();
  const editor = useSuperstringStore((s) => s.pageEditor);
  const rawInputs = useSuperstringStore((s) => s.allocationInvalidInputs);
  const busy = useSuperstringStore((s) => s.settingsSaving || s.editorLoading);
  if (!editor) return null;
  const key = `agent:${editor.agent.id}:context:${name}`;
  const raw = rawInputs[key];
  const schema = P5ConfigSchema.shape[name];
  const nullable = name === "context_window" || name === "summary_read_max_tokens";
  const step = name.includes("ratio") ? "0.01" : name === "auxiliary_timeout_seconds" ? "0.1" : "1";

  const getErrorMessage = () => {
    if (name === "safety_margin_ratio")
      return t("schemes.allocation.reading.invalidRatioSafety", {
        defaultValue: "必须在 0 <= x < 1 范围内",
      });
    if (name === "compression_trigger_ratio")
      return t("schemes.allocation.reading.invalidRatioCompression", {
        defaultValue: "必须在 0 < x <= 1 范围内",
      });
    if (name === "auxiliary_timeout_seconds")
      return t("schemes.allocation.reading.invalidTimeout", {
        defaultValue: "必须为 0 到 3600 秒之间的正数",
      });
    if (name === "context_window")
      return t("schemes.allocation.reading.invalidContextWindow", {
        defaultValue: "必须为 1024 到 1,048,576 之间的整数，或留空",
      });
    if (name === "recent_turns")
      return t("schemes.allocation.reading.invalidRecentTurns", {
        defaultValue: "必须为 1 到 10,000 之间的整数",
      });
    return t("schemes.allocation.reading.invalidPositiveByte", {
      defaultValue: "必须为 1 到 1,048,576 之间的正整数",
    });
  };

  return (
    <Field label={label} info={info} tooltip={info ? undefined : t(`hints.contextNumber.${name}`)}>
      <Input
        type="number"
        disabled={busy}
        step={step}
        value={raw ?? editor.draft.p5_config[name] ?? ""}
        aria-invalid={raw !== undefined || undefined}
        onChange={(e) => {
          const text = e.target.value;
          const value = text.trim() === "" && nullable ? null : Number(text);
          const valid = (text.trim() !== "" || nullable) && schema.safeParse(value).success;
          useSuperstringStore.setState((s) => {
            const next = { ...s.allocationInvalidInputs };
            if (valid) delete next[key];
            else next[key] = text;
            return { allocationInvalidInputs: next };
          });
          if (valid)
            useSuperstringStore.getState().patchPageAgent("context", {
              p5_config: { ...editor.draft.p5_config, [name]: value },
            });
        }}
      />
      {raw !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {getErrorMessage()}
        </p>
      )}
    </Field>
  );
}

export function CapabilityEditor({
  active = true,
  embedded = true,
}: {
  active?: boolean;
  embedded?: boolean;
} = {}) {
  const s = useSuperstringStore(
    useShallow((state) => ({
      pageEditor: state.pageEditor,
      editorAgentId: state.editorAgentId,
      refreshCapacityPreview: state.refreshCapacityPreview,
      capacityPreview: state.capacityPreview,
      settingsSaving: state.settingsSaving,
      editorLoading: state.editorLoading,
      patchPageAgent: state.patchPageAgent,
      saveSettingsPage: state.saveSettingsPage,
      discardSettingsPages: state.discardSettingsPages,
      allocationInvalidInputs: state.allocationInvalidInputs,
      chatContextCapacity: state.chatContextCapacity,
      apiClient: state.apiClient,
    })),
  );
  const t = useTranslation().t;
  const editor = s.pageEditor;

  const modelName = editor?.draft.model_name;
  const compressionModel = editor?.draft.context_compression_model_name;
  const editorToken = editor?.token;

  // biome-ignore lint/correctness/useExhaustiveDependencies: A new API client or edit-session token must revalidate capacity even when the model name is unchanged.
  useEffect(() => {
    if (active && s.editorAgentId !== "__new__" && modelName)
      void s.refreshCapacityPreview([modelName, modelName, compressionModel ?? null]);
  }, [
    active,
    s.editorAgentId,
    modelName,
    compressionModel,
    s.apiClient,
    editorToken,
    s.refreshCapacityPreview,
  ]);

  const [auxiliaryValidity, setAuxiliaryValidity] = useState({
    agentValid: true,
    globalValid: true,
  });

  if (!editor) return null;

  const p5 = editor.draft.p5_config;
  const agentAllocation = p5.allocation ?? { mode: "fixed" };

  const agentInputPrefix = `agent:${editor.agent.id}:`;
  const invalidInputsFor = (prefix: string) =>
    Object.fromEntries(
      Object.entries(s.allocationInvalidInputs)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value]),
    );
  const patchInvalidInput = (prefix: string, key: string, raw: string | undefined) => {
    useSuperstringStore.setState((state) => {
      const next = { ...state.allocationInvalidInputs };
      if (raw === undefined) delete next[prefix + key];
      else next[prefix + key] = raw;
      return { allocationInvalidInputs: next };
    });
  };

  const agentInputsValid = !Object.keys(s.allocationInvalidInputs).some((key) =>
    key.startsWith(agentInputPrefix),
  );
  const isContextDirty = agentPageDirty(editor, "context");
  const hasContextInvalid = Object.keys(s.allocationInvalidInputs).some((key) =>
    key.startsWith(`${agentInputPrefix}context:`),
  );
  const canDiscard = (isContextDirty || hasContextInvalid) && !s.settingsSaving;

  return (
    <div className="space-y-[28px]">
      {/* 1. 助手模型配置 (唯一 Canonical Host，内联复用 AgentModelPurpose) */}
      <AgentModelPurpose active={active} embedded={embedded} />

      {/* 2. 助手短期上下文预算与模式 */}
      <Card presentation="plain" data-testid="agent-context-card">
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <CardTitle>
                {editor.agent.name} - {t("workspace.short_term_context")}
              </CardTitle>
              <CardDescription className="text-xs text-muted-foreground mt-1 whitespace-pre-line">
                {s.capacityPreview
                  ? s.capacityPreview.split("\n").map(translateNotice).join("\n")
                  : agentAllocation.mode === "auto"
                    ? t("schemes.allocation.modeAutoDesc")
                    : t("schemes.allocation.modeFixedDesc")}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={agentAllocation.mode === "auto" ? "default" : "secondary"}>
                {agentAllocation.mode === "auto"
                  ? t("schemes.allocation.modeAuto")
                  : t("schemes.allocation.modeFixed")}
              </Badge>
              <AllocationModelCapacity
                model={modelName}
                capacity={s.chatContextCapacity}
                active={active}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Mode Selector */}
          <Field label="schemes.allocation.aux.mode" tooltip={t("hints.agent.fieldAllocMode")}>
            <RadioGroup
              className="flex flex-row items-center gap-4"
              value={agentAllocation.mode === "auto" ? "auto" : "fixed"}
              onValueChange={(value) => {
                if (value !== "fixed" && value !== "auto") return;
                s.patchPageAgent("context", {
                  p5_config: {
                    ...editor.draft.p5_config,
                    allocation: { mode: value },
                  },
                });
              }}
            >
              <label
                htmlFor="agent-alloc-mode-fixed"
                className="flex items-center gap-2 text-sm font-medium cursor-pointer"
              >
                <RadioGroupItem
                  id="agent-alloc-mode-fixed"
                  value="fixed"
                  aria-label={t("schemes.allocation.modeFixed")}
                />
                {t("schemes.allocation.modeFixed")}
              </label>
              <label
                htmlFor="agent-alloc-mode-auto"
                className="flex items-center gap-2 text-sm font-medium cursor-pointer"
              >
                <RadioGroupItem
                  id="agent-alloc-mode-auto"
                  value="auto"
                  aria-label={t("schemes.allocation.modeAuto")}
                />
                {t("schemes.allocation.modeAuto")}
              </label>
            </RadioGroup>
          </Field>

          {/* Core Parameters */}
          <div className="grid gap-4 sm:grid-cols-2">
            <AllocationAgentNumber
              name="context_window"
              label={t("schemes.allocation.requestLimit")}
              info={t("schemes.allocation.requestLimitHint")}
            />
            <AllocationAgentNumber
              name="max_output_tokens"
              label={t("library.maximum.output.tokens")}
            />
            <AllocationAgentNumber
              name="safety_margin_ratio"
              label={t("library.safety.margin.ratio")}
            />
            <AllocationAgentNumber
              name="recent_turns"
              label={t("library.recent.turns.to.retain")}
            />
          </div>

          <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
            <div className="flex items-center gap-2">
              <Layers className="size-4 text-muted-foreground" />
              <h4 className="text-sm font-medium">{t("library.long.conversation.management")}</h4>
            </div>

            <Field
              label="library.enable.context.compression"
              tooltip={t("hints.fieldExtra.compression")}
            >
              <Checkbox
                checked={p5.compression_enabled ?? true}
                onCheckedChange={(v) => {
                  s.patchPageAgent("context", {
                    p5_config: {
                      ...editor.draft.p5_config,
                      compression_enabled: v === true,
                    },
                  });
                }}
              />
            </Field>

            <div className="ml-2 border-l-2 border-border/60 pl-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <AllocationAgentNumber
                  name="compression_trigger_ratio"
                  label={t("library.compression.threshold.ratio")}
                />
                <AllocationAgentNumber
                  name="summary_target_tokens"
                  label={t("library.target.summary.tokens")}
                />
                <AllocationAgentNumber
                  name="summary_max_tokens"
                  label={t("library.maximum.summary.tokens")}
                />
                <AllocationAgentNumber
                  name="summary_read_max_tokens"
                  label={t("library.summary.reading.limit.blank.to.inherit")}
                />
                <AllocationAgentNumber
                  name="auxiliary_timeout_seconds"
                  label={t("library.auxiliary.task.timeout.seconds")}
                />
              </div>
            </div>
          </div>
        </CardContent>
        {!embedded && (
          <CardFooter className="flex justify-end gap-2 border-t pt-4">
            <Button
              variant="outline"
              disabled={!canDiscard}
              tooltip={t("hints.agent.discard")}
              disabledReason={t("hints.agent.noContextDirty")}
              onClick={() => s.discardSettingsPages("context")}
            >
              <Undo2 className="mr-1.5 size-4" />
              {t("workspace.discard")}
            </Button>
            <Button
              data-testid="agent-context-save-btn"
              disabled={
                !isContextDirty ||
                !agentInputsValid ||
                s.settingsSaving ||
                !auxiliaryValidity.agentValid
              }
              tooltip={t("hints.agent.contextSave")}
              disabledReason={t("hints.agent.contextSaveDisabled")}
              onClick={() => void s.saveSettingsPage("context")}
            >
              <Save className="mr-1.5 size-4" />
              {t("workspace.save")}
            </Button>
          </CardFooter>
        )}
      </Card>

      {/* 3. 助手专有辅助任务分配 (AGENT_ROLES) */}
      <ContextAllocationAuxiliary
        scope="agent"
        embedded={embedded}
        agentName={editor.agent.name}
        agentProfiles={p5.auxiliary_allocation}
        invalidInputs={invalidInputsFor(`${agentInputPrefix}aux:`)}
        onInvalidInput={(key, raw) => patchInvalidInput(`${agentInputPrefix}aux:`, key, raw)}
        onAgentChange={(next) => {
          s.patchPageAgent("context", {
            p5_config: { ...editor.draft.p5_config, auxiliary_allocation: next },
          });
        }}
        onSaveAgent={async () => {
          if (agentInputsValid) await s.saveSettingsPage("context");
        }}
        canSaveAgent={isContextDirty && agentInputsValid && auxiliaryValidity.agentValid}
        savingAgent={s.settingsSaving}
        onValidityChange={setAuxiliaryValidity}
        labels={Object.fromEntries(
          [
            ...[
              "agentSectionTitle",
              "agentSectionDesc",
              "agentScopeNotice",
              "saveAgent",
              "inputLimit",
              "outputReserved",
              "modeAuto",
              "modeFixed",
              "saving",
              "customToggle",
              "mode",
            ],
            ...["memory_consolidate", "research"].flatMap((role) =>
              ["name", "desc", "inputDesc", "outputDesc"].map((field) => `role.${role}.${field}`),
            ),
          ].map((k) => [k, t(`schemes.allocation.aux.${k}`)]),
        )}
      />
    </div>
  );
}
