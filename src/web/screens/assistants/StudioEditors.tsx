import { Layers, Save, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { startRead } from "@/services/read-task";
import { useSuperstringStore } from "@/store";
import { P5ConfigSchema } from "../../../shared/contracts/models";
import { executionPolicy, toolExecutionEnabled } from "../../../shared/contracts/permissions";
import { compilePersona } from "../../../shared/contracts/persona-compile";
import type { SuperstringApi } from "../../api";
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
        <Card>
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
        <Card>
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
      <Card className="xl:sticky xl:top-6">
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

// 此处只投影工具范围，编辑仍归系统能力与扩展授权。
type ToolScope = {
  agentId: string;
  apiClient: SuperstringApi;
  approved: string[];
  pending: number;
  error: string;
};

export function AgentToolScope({ agentId, active }: { agentId: string; active: boolean }) {
  const t = useTranslation().t;
  const s = useSuperstringStore(
    useShallow((state) => ({
      openSettingsRoute: state.openSettingsRoute,
      editorAgentId: state.editorAgentId,
      apiClient: state.apiClient,
    })),
  );
  const open = s.openSettingsRoute;
  const [scope, setScope] = useState<ToolScope | null>(null);
  const current =
    scope &&
    s.editorAgentId === agentId &&
    scope.agentId === agentId &&
    scope.apiClient === s.apiClient
      ? scope
      : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope is the last loaded value, not a trigger; identity deps decide whether a read is needed, and reading it on activation keeps a parked tab from blanking.
  useEffect(() => {
    if (!active || s.editorAgentId === "__new__") return;
    if (
      scope?.agentId === agentId &&
      s.editorAgentId === agentId &&
      scope.apiClient === s.apiClient &&
      !scope.error
    )
      return;
    const task = startRead((signal) => s.apiClient.getPermissions(signal), {
      success: (value) => {
        const execution = executionPolicy(value.policy);
        const grants = new Map<string, (typeof value.policy.grants)[number]>();
        for (const grant of value.policy.grants)
          if (!grants.has(grant.resource)) grants.set(grant.resource, grant);
        const mine = value.resources.flatMap((resource) => {
          const grant = grants.get(resource.resource);
          if (
            !grant ||
            (grant.agentIds && !grant.agentIds.includes(agentId)) ||
            !toolExecutionEnabled(execution, resource.name)
          )
            return [];
          if (grant.revision !== undefined && grant.revision !== resource.revision) return [];
          if (resource.effect === "write" && !execution.modules.tasks) return [];
          return [
            { resource: resource.resource, approved: !resource.approvalRequired || grant.approved },
          ];
        });
        setScope({
          agentId,
          apiClient: s.apiClient,
          approved: mine.filter((grant) => grant.approved).map((grant) => grant.resource),
          pending: mine.filter((grant) => !grant.approved).length,
          error: "",
        });
      },
      failure: (error) =>
        setScope({
          agentId,
          apiClient: s.apiClient,
          approved: [],
          pending: 0,
          error: error instanceof Error ? error.message : String(error),
        }),
    });
    return () => task.cancel();
  }, [active, agentId, s.apiClient, s.editorAgentId]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("library.tools.for.agent")}</CardTitle>
        <CardDescription>{t("library.tools.for.agent.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {current?.approved.length ? (
          <div className="flex flex-wrap gap-2">
            {current.approved.map((resource) => (
              <Badge key={resource} variant="secondary" className="font-mono text-xs">
                {resource}
              </Badge>
            ))}
          </div>
        ) : (
          <p
            role={current?.error ? "alert" : "status"}
            className={
              current?.error ? "text-sm text-destructive" : "text-sm text-muted-foreground"
            }
          >
            {current?.error ||
              t(
                current === null && s.editorAgentId !== "__new__"
                  ? "library.loading"
                  : "library.tools.none",
              )}
          </p>
        )}
        {!!current?.pending && (
          <p className="text-xs text-muted-foreground">
            {t("library.tools.pending", { "0": current.pending })}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            tooltip={t("hints.agent.goToCapabilities")}
            onClick={() => open("system-capabilities")}
          >
            {t("workspace.capabilities")}
          </Button>
          <Button
            variant="outline"
            tooltip={t("hints.agent.goToToolGrants")}
            onClick={() => open("tool-grants")}
          >
            {t("library.tools.manage")}
          </Button>
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

export function CapabilityEditor({ active = true }: { active?: boolean } = {}) {
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
      <AgentModelPurpose active={active} embedded />

      {/* 2. 助手短期上下文预算与模式 */}
      <Card data-testid="agent-context-card">
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
      </Card>

      {/* 3. 助手专有辅助任务分配 (AGENT_ROLES) */}
      <ContextAllocationAuxiliary
        scope="agent"
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
            ...["memory_consolidate", "memory_retrieval_select", "research"].flatMap((role) =>
              ["name", "desc", "inputDesc", "outputDesc"].map((field) => `role.${role}.${field}`),
            ),
          ].map((k) => [k, t(`schemes.allocation.aux.${k}`)]),
        )}
      />
    </div>
  );
}
