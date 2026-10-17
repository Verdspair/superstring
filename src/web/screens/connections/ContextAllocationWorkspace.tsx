import { ArrowLeft, BookOpen, Bot, Layers, MessageCircle, Save, Undo2, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AllocationMode,
  ContextAllocation,
} from "../../../shared/contracts/context-allocation";
import { P5ConfigSchema } from "../../../shared/contracts/models";
import { Field } from "../../components/form-field";

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
  return (
    <Field label={label} info={info}>
      <Input
        type="number"
        disabled={busy}
        step={name.includes("ratio") ? "0.01" : "1"}
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
          {t("schemes.allocation.reading.invalidPositiveByte")}
        </p>
      )}
    </Field>
  );
}

import { useShallow } from "zustand/react/shallow";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { agentPageDirty } from "../../features/agents/page-drafts";
import {
  type AllocationPurpose,
  openContextAllocation,
  returnFromContextAllocation,
} from "../../features/context-allocation";
import {
  knowledgeModelDirty,
  knowledgeReadDirty,
  organizationDirty,
} from "../../features/knowledge/types";
import { qqGroupConfigEffectiveScheme } from "../../features/qq/group-config-state";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { AllocationModelCapacity } from "./AllocationModelCapacity";
import { ContextAllocationAuxiliary } from "./ContextAllocationAuxiliary";
import { ContextAllocationReading } from "./ContextAllocationReading";
import { NumberField } from "./group-config";
import { SchemeNumber, SchemePercent } from "./scheme-studio";

function AllocationQqNumber({
  group,
  name,
  label,
  info,
  binding,
}: {
  group: "context" | "compression" | "outputReserve";
  name: string;
  label: string;
  info?: string;
  binding: boolean;
}) {
  const editor = useSuperstringStore((s) => s.qqGroupConfigEditor);
  if (!binding)
    return name === "headroom_ratio" ? (
      <SchemePercent
        name="headroom_ratio"
        label={label}
        info={info ?? "connections.recentMessagesAndOutputReserveHaveSeparateBudgetsValues"}
      />
    ) : (
      <SchemeNumber group={group} name={name} label={label} info={info} />
    );
  if (!editor) return null;
  const canonical = group === "outputReserve" ? "output_reserve" : group;
  return (
    <NumberField
      editor={editor}
      base={editor.source.base_scheme[canonical]}
      group={canonical}
      name={name}
      labelKey={label}
      infoKey={info}
      percent={name === "headroom_ratio"}
    />
  );
}

export function ContextAllocationWorkspace({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const s = useSuperstringStore(
    useShallow((state) => ({
      agents: state.agents,
      allocationInvalidInputs: state.allocationInvalidInputs,
      apiClient: state.apiClient,
      contextAllocationTarget: state.contextAllocationTarget,
      discardKnowledgeModel: state.discardKnowledgeModel,
      discardKnowledgeRead: state.discardKnowledgeRead,
      discardQqGroupConfigChanges: state.discardQqGroupConfigChanges,
      discardQqSchemeChanges: state.discardQqSchemeChanges,
      discardSettingsPages: state.discardSettingsPages,
      editorAgentId: state.editorAgentId,
      editorLoading: state.editorLoading,
      error: state.error,
      feedback: state.feedback,
      knowledgeModelEditor: state.knowledgeModelEditor,
      knowledgeReadEditor: state.knowledgeReadEditor,
      knowledgeReadLoading: state.knowledgeReadLoading,
      loadKnowledgeModel: state.loadKnowledgeModel,
      loadKnowledgeRead: state.loadKnowledgeRead,
      loadOrganization: state.loadOrganization,
      organizationEditor: state.organizationEditor,
      organizationLoading: state.organizationLoading,
      pageEditor: state.pageEditor,
      patchKnowledgeGlobal: state.patchKnowledgeGlobal,
      patchKnowledgeRead: state.patchKnowledgeRead,
      patchOrganizationAllocation: state.patchOrganizationAllocation,
      patchPageAgent: state.patchPageAgent,
      patchQqGroupOverride: state.patchQqGroupOverride,
      patchQqScheme: state.patchQqScheme,
      qqBindings: state.qqBindings,
      qqGroupConfigEditor: state.qqGroupConfigEditor,
      qqGroupConfigSaving: state.qqGroupConfigSaving,
      qqSchemeEditor: state.qqSchemeEditor,
      qqSchemeSaving: state.qqSchemeSaving,
      qqSchemes: state.qqSchemes,
      refreshKnowledgeRead: state.refreshKnowledgeRead,
      refreshSettingsAgent: state.refreshSettingsAgent,
      saveKnowledgeModel: state.saveKnowledgeModel,
      saveKnowledgeRead: state.saveKnowledgeRead,
      saveOrganization: state.saveOrganization,
      saveQqGroupConfig: state.saveQqGroupConfig,
      saveQqScheme: state.saveQqScheme,
      saveSettingsPage: state.saveSettingsPage,
      settingsSaving: state.settingsSaving,
    })),
  );
  const [auxiliaryValidity, setAuxiliaryValidity] = useState({
    agentValid: true,
    globalValid: true,
  });

  const target = s.contextAllocationTarget;
  const purpose = target.purpose;
  const qqScope = target.bindingId ? "binding" : "scheme";
  const selectedBindingId =
    target.bindingId ?? s.qqGroupConfigEditor?.source.binding.id ?? s.qqBindings[0]?.id ?? "";
  // Subpanel validities
  const [readingValidity, setReadingValidity] = useState({
    memoryValid: true,
    knowledgeGlobalValid: true,
    knowledgeAgentValid: true,
  });

  // Synchronize initial target and load domains when becoming active
  useEffect(() => {
    if (!active) return;
    void s.loadKnowledgeModel();
    void s.loadOrganization();
    if (s.editorAgentId && s.editorAgentId !== "__new__") {
      void s.loadKnowledgeRead();
    }
  }, [active, s.editorAgentId, s.loadKnowledgeModel, s.loadOrganization, s.loadKnowledgeRead]);

  // Derived active objects strictly from store editors to avoid desync
  const effectiveAgentId =
    s.editorAgentId && s.editorAgentId !== "__new__"
      ? s.editorAgentId
      : (s.agents.find((a) => a.id !== "__new__")?.id ?? "");

  const effectiveSchemeId = s.qqSchemeEditor?.source.id ?? s.qqSchemes[0]?.id ?? "";

  // Guarded object transitions via store actions (never direct local ID mutation)
  const handleSelectAgent = (nextId: string) => {
    if (!nextId || nextId === "__new__" || nextId === effectiveAgentId) return;
    openContextAllocation({ purpose, agentId: nextId, schemeId: null, bindingId: null });
  };

  const handleSelectScheme = (nextId: string) => {
    if (!nextId || nextId === effectiveSchemeId) return;
    openContextAllocation({ purpose: "qq", schemeId: nextId, bindingId: null });
  };

  const agent = s.agents.find((a) => a.id === effectiveAgentId);
  const editor = s.pageEditor?.agent.id === effectiveAgentId ? s.pageEditor : null;
  const p5 = editor ? editor.draft.p5_config : agent?.p5_config;
  const agentAllocation: ContextAllocation = p5?.allocation ?? { mode: "fixed" };

  const groupEditor =
    s.qqGroupConfigEditor?.source.binding.id === selectedBindingId ? s.qqGroupConfigEditor : null;
  const groupScheme = qqGroupConfigEffectiveScheme(groupEditor);
  const scheme =
    qqScope === "binding"
      ? (groupScheme ?? undefined)
      : s.qqSchemes.find((sc) => sc.id === effectiveSchemeId);
  const schemeEditor =
    qqScope === "scheme" && s.qqSchemeEditor?.source.id === effectiveSchemeId
      ? s.qqSchemeEditor
      : null;
  const qqAllocation = schemeEditor
    ? schemeEditor.allocation
    : (scheme?.allocation ?? { judgement: { mode: "fixed" }, reply: { mode: "fixed" } });

  const modelName = editor?.agent.model_name ?? agent?.model_name;
  const qqModel =
    qqScope === "binding"
      ? s.agents.find((item) => item.id === groupEditor?.source.binding.agent_id)?.model_name
      : null;

  const auxRoleModels = useMemo<Record<string, string | null | undefined>>(
    () => ({
      memory_consolidate:
        agent?.memory_consolidation_model_name ||
        s.organizationEditor?.source.model_name ||
        modelName,
      memory_retrieval_select: agent?.memory_retrieval_model_name || modelName,
      research: modelName,
      knowledge_organize:
        s.knowledgeModelEditor?.source.model_name || s.organizationEditor?.source.model_name,
      qq_sticker_annotate: s.organizationEditor?.source.vision_model_name,
      qq_media_describe: s.organizationEditor?.source.vision_model_name,
    }),
    [
      agent?.memory_consolidation_model_name,
      agent?.memory_retrieval_model_name,
      s.organizationEditor?.source.model_name,
      s.organizationEditor?.source.vision_model_name,
      s.knowledgeModelEditor?.source.model_name,
      modelName,
    ],
  );

  const [modelCapacities, setModelCapacities] = useState<Record<string, number | null>>({});

  useEffect(() => {
    if (!active) return;
    let current = true;
    const isCurrent = () => {
      const state = useSuperstringStore.getState();
      const agentId =
        state.editorAgentId && state.editorAgentId !== "__new__"
          ? state.editorAgentId
          : (state.agents.find((item) => item.id !== "__new__")?.id ?? "");
      return current && agentId === effectiveAgentId;
    };
    const targetModels = Array.from(
      new Set(
        (purpose === "aux"
          ? Object.values(auxRoleModels)
          : purpose === "assistant"
            ? [modelName]
            : [qqModel]
        ).filter((m): m is string => typeof m === "string" && m.length > 0),
      ),
    );

    for (const m of targetModels) {
      void s.apiClient
        .getModelCapacity(m)
        .then((val) => {
          if (isCurrent()) {
            setModelCapacities((prev) => ({ ...prev, [m]: val.context_length }));
          }
        })
        .catch(() => {
          if (isCurrent()) {
            setModelCapacities((prev) => ({ ...prev, [m]: null }));
          }
        });
    }
    return () => {
      current = false;
    };
  }, [active, purpose, effectiveAgentId, s.apiClient, modelName, qqModel, auxRoleModels]);

  const agentInputPrefix = `agent:${effectiveAgentId}:`;
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
  const returnTarget = target;
  if (!active) return null;

  return (
    <section
      data-testid="context-allocation-workspace"
      aria-label={t("schemes.contextAllocation.title")}
      className="flex h-full min-h-0 flex-col"
    >
      {/* Top Header & Return Navigation */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          {returnTarget.returnRoute && (
            <Button
              variant="outline"
              size="sm"
              onClick={returnFromContextAllocation}
              className="h-auto min-h-8 whitespace-normal text-foreground flex items-center gap-1.5"
            >
              <ArrowLeft className="size-4" />
              {t("schemes.allocation.returnTo", {
                "0": returnTarget.returnLabel || returnTarget.returnRoute,
              })}
            </Button>
          )}
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              {t("schemes.contextAllocation.title")}
            </h1>
            <p className="text-xs text-muted-foreground">{t("schemes.contextAllocation.note")}</p>
          </div>
        </div>

        <Tabs
          value={purpose}
          onValueChange={(val) => {
            openContextAllocation({ purpose: val as AllocationPurpose });
          }}
          className="max-w-full"
        >
          <TabsList className="grid h-auto w-full grid-cols-2 gap-1 group-data-horizontal/tabs:h-auto sm:flex sm:w-auto">
            <TabsTrigger
              value="assistant"
              className="h-auto min-h-8 whitespace-normal text-foreground flex items-center gap-1.5"
            >
              <Bot className="size-4" />
              {t("schemes.allocation.purposeAssistant")}
            </TabsTrigger>
            <TabsTrigger
              value="qq"
              className="h-auto min-h-8 whitespace-normal text-foreground flex items-center gap-1.5"
            >
              <MessageCircle className="size-4" />
              {t("schemes.allocation.purposeQq")}
            </TabsTrigger>
            <TabsTrigger
              value="reading"
              className="h-auto min-h-8 whitespace-normal text-foreground flex items-center gap-1.5"
            >
              <BookOpen className="size-4" />
              {t("schemes.allocation.purposeReading")}
            </TabsTrigger>
            <TabsTrigger
              value="aux"
              className="h-auto min-h-8 whitespace-normal text-foreground flex items-center gap-1.5"
            >
              <Wrench className="size-4" />
              {t("schemes.allocation.purposeAux")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      {s.error && (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {translateNotice(s.error)}
        </p>
      )}
      {s.feedback && (
        <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
          {translateNotice(s.feedback)}
        </p>
      )}
      {/* Main Content Area */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6" data-workspace-scroll>
        {(purpose === "reading" || purpose === "aux") && (
          <div className="mb-4">
            <Field label="schemes.allocation.selectAgent">
              <NativeSelect
                value={effectiveAgentId}
                onChange={(e) => handleSelectAgent(e.target.value)}
                disabled={s.editorLoading || s.settingsSaving}
              >
                {s.agents
                  .filter((item) => item.id !== "__new__")
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          </div>
        )}
        {/* PURPOSE: ASSISTANT */}
        {purpose === "assistant" && (
          <div className="w-full min-w-0 space-y-6">
            {/* Object Selection */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{t("schemes.allocation.selectAgent")}</CardTitle>
                <CardDescription>{t("schemes.allocation.purposeAssistantDesc")}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <Field label="schemes.allocation.selectAgent">
                  <NativeSelect
                    value={effectiveAgentId}
                    onChange={(e) => handleSelectAgent(e.target.value)}
                  >
                    {s.agents
                      .filter((a) => a.id !== "__new__")
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </NativeSelect>
                </Field>

                <AllocationModelCapacity
                  model={modelName}
                  capacity={
                    modelName
                      ? modelName in modelCapacities
                        ? modelCapacities[modelName]
                        : null
                      : null
                  }
                  active={active && purpose === "assistant"}
                />
              </CardContent>
            </Card>

            {/* Mode & Allocation Parameters */}
            {agent && (
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">
                      {agent.name} - {t("workspace.short_term_context")}
                    </CardTitle>
                    <Badge variant={agentAllocation.mode === "auto" ? "default" : "secondary"}>
                      {agentAllocation.mode === "auto"
                        ? t("schemes.allocation.modeAuto")
                        : t("schemes.allocation.modeFixed")}
                    </Badge>
                  </div>
                  <CardDescription>
                    {agentAllocation.mode === "auto"
                      ? t("schemes.allocation.modeAutoDesc")
                      : t("schemes.allocation.modeFixedDesc")}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  {/* Mode Selector */}
                  <Field label="schemes.allocation.aux.mode">
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 text-sm font-medium">
                        <input
                          type="radio"
                          name="agent-alloc-mode"
                          value="fixed"
                          checked={agentAllocation.mode !== "auto"}
                          onChange={() => {
                            if (!editor) return;
                            s.patchPageAgent("context", {
                              p5_config: {
                                ...editor.draft.p5_config,
                                allocation: { mode: "fixed" },
                              },
                            });
                          }}
                        />
                        {t("schemes.allocation.modeFixed")}
                      </label>
                      <label className="flex items-center gap-2 text-sm font-medium">
                        <input
                          type="radio"
                          name="agent-alloc-mode"
                          value="auto"
                          checked={agentAllocation.mode === "auto"}
                          onChange={() => {
                            if (!editor) return;
                            s.patchPageAgent("context", {
                              p5_config: {
                                ...editor.draft.p5_config,
                                allocation: { mode: "auto" },
                              },
                            });
                          }}
                        />
                        {t("schemes.allocation.modeAuto")}
                      </label>
                    </div>
                  </Field>

                  {/* Core Parameters */}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <AllocationAgentNumber
                      name="context_window"
                      label="schemes.allocation.requestLimit"
                      info="schemes.allocation.requestLimitHint"
                    />

                    <AllocationAgentNumber
                      name="max_output_tokens"
                      label="library.maximum.output.tokens"
                    />

                    <AllocationAgentNumber
                      name="safety_margin_ratio"
                      label="library.safety.margin.ratio"
                    />

                    <AllocationAgentNumber
                      name="recent_turns"
                      label="library.recent.turns.to.retain"
                    />
                  </div>

                  {/* Restored Long Conversation & Summary Settings */}
                  <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
                    <div className="flex items-center gap-2">
                      <Layers className="size-4 text-muted-foreground" />
                      <h4 className="text-sm font-medium">
                        {t("library.long.conversation.management")}
                      </h4>
                    </div>

                    <Field label="library.enable.context.compression">
                      <Checkbox
                        checked={p5?.compression_enabled ?? true}
                        onCheckedChange={(v) => {
                          if (!editor) return;
                          s.patchPageAgent("context", {
                            p5_config: {
                              ...editor.draft.p5_config,
                              compression_enabled: v === true,
                            },
                          });
                        }}
                      />
                    </Field>

                    <div className="grid gap-4 sm:grid-cols-2">
                      <AllocationAgentNumber
                        name="compression_trigger_ratio"
                        label="library.compression.threshold.ratio"
                      />

                      <AllocationAgentNumber
                        name="summary_target_tokens"
                        label="library.target.summary.tokens"
                      />

                      <AllocationAgentNumber
                        name="summary_max_tokens"
                        label="library.maximum.summary.tokens"
                      />

                      <AllocationAgentNumber
                        name="summary_read_max_tokens"
                        label="library.summary.reading.limit.blank.to.inherit"
                      />

                      <AllocationAgentNumber
                        name="auxiliary_timeout_seconds"
                        label="library.auxiliary.task.timeout.seconds"
                      />
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="flex justify-end gap-2 border-t pt-4">
                  <Button
                    variant="outline"
                    disabled={!editor || s.settingsSaving}
                    onClick={() => s.discardSettingsPages("context")}
                  >
                    <Undo2 className="mr-1.5 size-4" />
                    {t("workspace.discard")}
                  </Button>
                  <Button
                    disabled={
                      !editor ||
                      !agentInputsValid ||
                      s.settingsSaving ||
                      !readingValidity.memoryValid ||
                      !auxiliaryValidity.agentValid
                    }
                    onClick={() => void s.saveSettingsPage("context")}
                  >
                    <Save className="mr-1.5 size-4" />
                    {t("workspace.save")}
                  </Button>
                </CardFooter>
              </Card>
            )}
          </div>
        )}

        {/* PURPOSE: QQ */}
        {purpose === "qq" && (
          <div className="w-full min-w-0 space-y-6">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">{t("schemes.allocation.purposeQq")}</CardTitle>
                <CardDescription>{t("schemes.allocation.purposeQqDesc")}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <Field label="schemes.allocation.scopeType">
                  <NativeSelect
                    value={qqScope}
                    onChange={(e) =>
                      openContextAllocation(
                        e.target.value === "binding"
                          ? { purpose: "qq", bindingId: selectedBindingId || null, schemeId: null }
                          : { purpose: "qq", bindingId: null, schemeId: effectiveSchemeId },
                      )
                    }
                  >
                    <option value="scheme">{t("schemes.allocation.scopeScheme")}</option>
                    <option value="binding">{t("schemes.allocation.scopeGroup")}</option>
                  </NativeSelect>
                </Field>

                {qqScope === "scheme" ? (
                  <Field label="schemes.allocation.selectScheme">
                    <NativeSelect
                      value={effectiveSchemeId}
                      onChange={(e) => handleSelectScheme(e.target.value)}
                    >
                      {s.qqSchemes.map((sc) => (
                        <option key={sc.id} value={sc.id}>
                          {sc.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                ) : (
                  <Field label="schemes.allocation.selectBinding">
                    <NativeSelect
                      value={selectedBindingId}
                      onChange={(e) => {
                        openContextAllocation({ purpose: "qq", bindingId: e.target.value });
                      }}
                    >
                      {s.qqBindings.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.peer_id} ({b.kind === "group" ? "群聊" : "私聊"})
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                )}
              </CardContent>
            </Card>

            <AllocationModelCapacity
              model={qqModel}
              capacity={
                qqModel ? (qqModel in modelCapacities ? modelCapacities[qqModel] : null) : null
              }
              active={active && purpose === "qq"}
            />
            {/* Judgement & Reply Dual Cards */}
            <div className="grid gap-6 md:grid-cols-2">
              {/* Judgement Request Card */}
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">
                      {t("schemes.allocation.qqJudgementContext")}
                    </CardTitle>
                    <Badge
                      variant={qqAllocation.judgement.mode === "auto" ? "default" : "secondary"}
                    >
                      {qqAllocation.judgement.mode === "auto"
                        ? t("schemes.allocation.modeAuto")
                        : t("schemes.allocation.modeFixed")}
                    </Badge>
                  </div>
                  <CardDescription>{t("schemes.allocation.judgementMode")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Field label="schemes.allocation.judgementMode">
                    <NativeSelect
                      data-testid="qq-judgement-mode"
                      value={
                        qqScope === "binding"
                          ? (groupEditor?.overrides.allocation?.judgement?.mode ?? "")
                          : qqAllocation.judgement.mode
                      }
                      disabled={s.qqSchemeSaving}
                      onChange={(e) => {
                        if (qqScope === "binding")
                          s.patchQqGroupOverride(
                            "allocation",
                            "judgement.mode",
                            e.target.value || undefined,
                          );
                        else if (schemeEditor)
                          s.patchQqScheme({
                            allocation: {
                              ...schemeEditor.allocation,
                              judgement: { mode: e.target.value as AllocationMode },
                            },
                          });
                      }}
                    >
                      {qqScope === "binding" && (
                        <option value="">
                          {t("schemes.allocation.inheritScheme", { "0": scheme?.name ?? "" })}
                        </option>
                      )}
                      <option value="fixed">{t("schemes.allocation.modeFixed")}</option>
                      <option value="auto">{t("schemes.allocation.modeAuto")}</option>
                    </NativeSelect>
                  </Field>

                  <AllocationQqNumber
                    group="context"
                    name="judgement_message_limit"
                    label="connections.judgementRecentMessages"
                    binding={qqScope === "binding"}
                  />

                  <AllocationQqNumber
                    group="context"
                    name="judgement_window_minutes"
                    label="connections.judgementTimeWindowMinutes"
                    binding={qqScope === "binding"}
                  />

                  <AllocationQqNumber
                    group="context"
                    name="judgement_token_budget"
                    label="connections.judgementBudgetEstimatedBytes"
                    info="schemes.allocation.budgetBytesHint"
                    binding={qqScope === "binding"}
                  />

                  <AllocationQqNumber
                    group="outputReserve"
                    name="judgement_output_reserved"
                    label="connections.judgementOutputReserveEstimatedBytes"
                    binding={qqScope === "binding"}
                  />
                </CardContent>
              </Card>

              {/* Reply Request Card */}
              <Card>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">
                      {t("schemes.allocation.qqReplyContext")}
                    </CardTitle>
                    <Badge variant={qqAllocation.reply.mode === "auto" ? "default" : "secondary"}>
                      {qqAllocation.reply.mode === "auto"
                        ? t("schemes.allocation.modeAuto")
                        : t("schemes.allocation.modeFixed")}
                    </Badge>
                  </div>
                  <CardDescription>{t("schemes.allocation.replyMode")}</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Field label="schemes.allocation.replyMode">
                    <NativeSelect
                      data-testid="qq-reply-mode"
                      value={
                        qqScope === "binding"
                          ? (groupEditor?.overrides.allocation?.reply?.mode ?? "")
                          : qqAllocation.reply.mode
                      }
                      disabled={s.qqSchemeSaving}
                      onChange={(e) => {
                        if (qqScope === "binding")
                          s.patchQqGroupOverride(
                            "allocation",
                            "reply.mode",
                            e.target.value || undefined,
                          );
                        else if (schemeEditor)
                          s.patchQqScheme({
                            allocation: {
                              ...schemeEditor.allocation,
                              reply: { mode: e.target.value as AllocationMode },
                            },
                          });
                      }}
                    >
                      {qqScope === "binding" && (
                        <option value="">
                          {t("schemes.allocation.inheritScheme", { "0": scheme?.name ?? "" })}
                        </option>
                      )}
                      <option value="fixed">{t("schemes.allocation.modeFixed")}</option>
                      <option value="auto">{t("schemes.allocation.modeAuto")}</option>
                    </NativeSelect>
                  </Field>

                  <div className="rounded-md border bg-muted/30 p-2.5 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {t("connections.replyRecentMessages")}：
                    </span>
                    {t("schemes.allocation.qqReplyRecentTurnsFollowAgent")}
                  </div>

                  <AllocationQqNumber
                    group="context"
                    name="reply_window_minutes"
                    label="connections.replyTimeWindowMinutes"
                    binding={qqScope === "binding"}
                  />

                  <AllocationQqNumber
                    group="context"
                    name="reply_token_budget"
                    label="connections.replyBudgetEstimatedBytes"
                    info="schemes.allocation.budgetBytesHint"
                    binding={qqScope === "binding"}
                  />

                  <AllocationQqNumber
                    group="outputReserve"
                    name="reply_output_reserved"
                    label="connections.replyOutputReserveEstimatedBytes"
                    binding={qqScope === "binding"}
                  />
                </CardContent>
              </Card>
            </div>

            {/* Restored QQ History Compression Settings */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  {t("connections.compressionAndAssembly")}
                </CardTitle>
                <CardDescription>
                  {t("connections.recentMessagesAndOutputReserveHaveSeparateBudgetsValues")}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-3">
                <AllocationQqNumber
                  group="compression"
                  name="watermark_trigger"
                  label="connections.watermarkTriggerMessages"
                  binding={qqScope === "binding"}
                />

                <AllocationQqNumber
                  group="compression"
                  name="package_limit"
                  label="connections.watermarkPackageLimit"
                  binding={qqScope === "binding"}
                />

                <AllocationQqNumber
                  group="compression"
                  name="headroom_ratio"
                  label="connections.assemblyHeadroomPercent"
                  binding={qqScope === "binding"}
                />
              </CardContent>
            </Card>

            {qqScope === "binding" && groupEditor && (
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={s.qqGroupConfigSaving}
                  onClick={s.discardQqGroupConfigChanges}
                >
                  {t("workspace.discard")}
                </Button>
                <Button
                  disabled={s.qqGroupConfigSaving || Object.keys(groupEditor.rawTexts).length > 0}
                  onClick={() => void s.saveQqGroupConfig()}
                >
                  {t("workspace.save")}
                </Button>
              </div>
            )}
            {/* Scheme Save / Discard */}
            {qqScope === "scheme" && schemeEditor && (
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={s.qqSchemeSaving}
                  onClick={() => s.discardQqSchemeChanges()}
                >
                  <Undo2 className="mr-1.5 size-4" />
                  {t("workspace.discard")}
                </Button>
                <Button disabled={s.qqSchemeSaving} onClick={() => void s.saveQqScheme()}>
                  <Save className="mr-1.5 size-4" />
                  {t("workspace.save")}
                </Button>
              </div>
            )}
          </div>
        )}

        {/* PURPOSE: READING BUDGETS */}
        {purpose === "reading" && (
          <div className="w-full min-w-0 space-y-6">
            <ContextAllocationReading
              key={effectiveAgentId || "reading"}
              agentName={agent?.name}
              invalidInputs={{
                ...invalidInputsFor(`${agentInputPrefix}reading:`),
                ...("global:knowledge" in s.allocationInvalidInputs
                  ? { knowledgeGlobal: s.allocationInvalidInputs["global:knowledge"] }
                  : {}),
              }}
              onInvalidInput={(key, raw) =>
                key === "knowledgeGlobal"
                  ? patchInvalidInput("", "global:knowledge", raw)
                  : patchInvalidInput(`${agentInputPrefix}reading:`, key, raw)
              }
              presets={p5?.retrieval_presets}
              knowledgeGlobalBudget={s.knowledgeModelEditor?.contextBudget}
              knowledgeAgentBudget={s.knowledgeReadEditor?.draft.context_budget}
              onPresetBudget={(mode, value) => {
                if (!editor || !p5?.retrieval_presets) return;
                const currentPreset = p5.retrieval_presets[mode];
                s.patchPageAgent("context", {
                  p5_config: {
                    ...editor.draft.p5_config,
                    retrieval_presets: {
                      ...p5.retrieval_presets,
                      [mode]: { ...currentPreset, max_tokens: value },
                    },
                  },
                });
              }}
              onKnowledgeGlobalBudget={(val) => s.patchKnowledgeGlobal({ contextBudget: val })}
              onKnowledgeAgentBudget={(val) => s.patchKnowledgeRead({ context_budget: val })}
              onRefreshMemory={() => void s.refreshSettingsAgent()}
              onRefreshKnowledgeGlobal={() => void s.loadKnowledgeModel(true)}
              onRefreshKnowledgeAgent={() => void s.refreshKnowledgeRead()}
              onDiscardMemory={() => s.discardSettingsPages("context")}
              onDiscardKnowledgeGlobal={() => s.discardKnowledgeModel("budget")}
              onDiscardKnowledgeAgent={s.discardKnowledgeRead}
              onSaveMemory={async () => {
                if (agentInputsValid) await s.saveSettingsPage("context");
              }}
              onSaveKnowledgeGlobal={async () => {
                if (!("global:knowledge" in s.allocationInvalidInputs))
                  await s.saveKnowledgeModel("budget");
              }}
              onSaveKnowledgeAgent={async () => {
                if (!(`${agentInputPrefix}reading:knowledgeAgent` in s.allocationInvalidInputs))
                  await s.saveKnowledgeRead();
              }}
              savingMemory={s.settingsSaving}
              savingKnowledgeGlobal={s.settingsSaving}
              savingKnowledgeAgent={s.knowledgeReadLoading}
              canSaveMemory={
                !!editor &&
                agentPageDirty(editor, "context") &&
                !s.settingsSaving &&
                agentInputsValid &&
                readingValidity.memoryValid
              }
              canSaveKnowledgeGlobal={
                !!s.knowledgeModelEditor &&
                knowledgeModelDirty(s.knowledgeModelEditor, "budget") &&
                !s.settingsSaving &&
                readingValidity.knowledgeGlobalValid
              }
              canSaveKnowledgeAgent={
                s.knowledgeReadEditor?.agentId === effectiveAgentId &&
                knowledgeReadDirty(s.knowledgeReadEditor) &&
                !s.knowledgeReadLoading &&
                readingValidity.knowledgeAgentValid
              }
              onValidityChange={setReadingValidity}
              labels={{
                refreshBaseline: t("capabilities.resources.refreshBaseline"),
                discardBudget: t("library.discard.knowledge.budget"),
                ...Object.fromEntries(
                  [
                    "memoryTitle",
                    "memoryDesc",
                    "knowledgeGlobalTitle",
                    "knowledgeGlobalDesc",
                    "knowledgeAgentTitle",
                    "knowledgeAgentDesc",
                    "saveMemory",
                    "saveKnowledgeGlobal",
                    "saveKnowledgeAgent",
                    "saving",
                    "modeConservative",
                    "modeConservativeDesc",
                    "modeStandard",
                    "modeStandardDesc",
                    "modeBroad",
                    "modeBroadDesc",
                    "scopeAgent",
                    "scopeGlobal",
                    "scopeAgentOverride",
                    "maxBytesLabel",
                    "defaultBytesLabel",
                    "overrideBytesLabel",
                    "invalidByteRange",
                    "invalidPositiveByte",
                    "followGlobalDefault",
                    "effectiveSourceLabel",
                    "bytesInherited",
                    "bytesAgentOverride",
                    "entriesKeep",
                  ].map((k) => [k, t(`schemes.allocation.reading.${k}`)]),
                ),
              }}
            />
          </div>
        )}

        {/* PURPOSE: AUXILIARY TASKS */}
        {purpose === "aux" && (
          <ContextAllocationAuxiliary
            key={effectiveAgentId}
            agentName={agent?.name}
            invalidInputs={{
              ...invalidInputsFor(`${agentInputPrefix}aux:`),
              ...invalidInputsFor("global:aux:"),
            }}
            onInvalidInput={(key, raw) =>
              patchInvalidInput(
                key.startsWith("knowledge_organize_") || key.startsWith("qq_")
                  ? "global:aux:"
                  : `${agentInputPrefix}aux:`,
                key,
                raw,
              )
            }
            roleDetails={Object.fromEntries(
              Object.entries(auxRoleModels).map(([role, model]) => [
                role,
                <AllocationModelCapacity
                  key={role}
                  model={model}
                  capacity={
                    model ? (model in modelCapacities ? modelCapacities[model] : null) : null
                  }
                  active={active && purpose === "aux"}
                />,
              ]),
            )}
            agentProfiles={p5?.auxiliary_allocation}
            globalProfiles={s.organizationEditor?.auxiliaryAllocation}
            onAgentChange={(next) => {
              if (editor)
                s.patchPageAgent("context", {
                  p5_config: { ...editor.draft.p5_config, auxiliary_allocation: next },
                });
            }}
            onGlobalChange={s.patchOrganizationAllocation}
            onSaveAgent={async () => {
              if (agentInputsValid) await s.saveSettingsPage("context");
            }}
            onSaveGlobal={async () => {
              if (
                !Object.keys(s.allocationInvalidInputs).some((key) => key.startsWith("global:aux:"))
              )
                await s.saveOrganization("allocation");
            }}
            canSaveAgent={
              !!editor &&
              agentPageDirty(editor, "context") &&
              !s.settingsSaving &&
              agentInputsValid &&
              auxiliaryValidity.agentValid
            }
            canSaveGlobal={
              !!s.organizationEditor &&
              organizationDirty(s.organizationEditor, "allocation") &&
              !s.organizationLoading &&
              !s.settingsSaving &&
              auxiliaryValidity.globalValid
            }
            savingAgent={s.settingsSaving}
            savingGlobal={s.settingsSaving}
            onValidityChange={setAuxiliaryValidity}
            labels={Object.fromEntries(
              [
                ...[
                  "agentSectionTitle",
                  "agentSectionDesc",
                  "agentScopeNotice",
                  "globalSectionTitle",
                  "globalSectionDesc",
                  "globalScopeNotice",
                  "saveAgent",
                  "saveGlobal",
                  "saving",
                  "inherit",
                  "customized",
                  "mode",
                  "modeFixed",
                  "modeAuto",
                  "inputLimit",
                  "outputReserved",
                  "inheritPlaceholder",
                  "invalidPositiveInt",
                  "unit",
                  "hardContract",
                  "inputLimitDesc",
                  "outputReservedDesc",
                  "unconfiguredNote",
                ],
                ...[
                  "memory_consolidate",
                  "memory_retrieval_select",
                  "research",
                  "knowledge_organize",
                  "qq_sticker_annotate",
                  "qq_media_describe",
                ].flatMap((role) =>
                  ["name", "desc", "inputDesc", "outputDesc"].map(
                    (field) => `role.${role}.${field}`,
                  ),
                ),
              ].map((k) => [k, t(`schemes.allocation.aux.${k}`)]),
            )}
          />
        )}
      </div>
    </section>
  );
}
