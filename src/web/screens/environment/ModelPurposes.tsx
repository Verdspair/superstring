import { ArrowLeft, BookOpen, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import {
  type AllocationPurpose,
  openContextAllocation,
  returnFromContextAllocation,
} from "../../features/context-allocation";
import { knowledgeModelDirty, organizationDirty } from "../../features/knowledge/types";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { AllocationModelCapacity } from "../connections/AllocationModelCapacity";
import { ContextAllocationAuxiliary } from "../connections/ContextAllocationAuxiliary";
import { ContextAllocationReading } from "../connections/ContextAllocationReading";

export function ModelPurposes({
  active = true,
  // Embedded views share the host header.
  embedded = false,
  sharedDefaults,
}: {
  active?: boolean;
  embedded?: boolean;
  sharedDefaults?: ReactNode;
} = {}) {
  const { t } = useTranslation();
  const s = useSuperstringStore(
    useShallow((state) => ({
      agents: state.agents,
      allocationInvalidInputs: state.allocationInvalidInputs,
      apiClient: state.apiClient,
      contextAllocationTarget: state.contextAllocationTarget,
      discardKnowledgeModel: state.discardKnowledgeModel,
      discardOrganization: state.discardOrganization,
      editorAgentId: state.editorAgentId,
      editorLoading: state.editorLoading,
      error: state.error,
      feedback: state.feedback,
      knowledgeModelEditor: state.knowledgeModelEditor,
      knowledgeModelLoading: state.knowledgeModelLoading,
      loadKnowledgeModel: state.loadKnowledgeModel,
      loadOrganization: state.loadOrganization,
      organizationEditor: state.organizationEditor,
      organizationLoading: state.organizationLoading,
      patchKnowledgeGlobal: state.patchKnowledgeGlobal,
      patchOrganizationAllocation: state.patchOrganizationAllocation,
      saveKnowledgeModel: state.saveKnowledgeModel,
      saveOrganization: state.saveOrganization,
      settingsSaving: state.settingsSaving,
    })),
  );
  const [auxiliaryValidity, setAuxiliaryValidity] = useState({
    agentValid: true,
    globalValid: true,
  });

  const target = s.contextAllocationTarget;
  const route = useSuperstringStore((state) => state.settingsRoute);
  const purpose = sharedDefaults && route === "models" ? "shared" : target.purpose;
  const [sharedVisited, setSharedVisited] = useState(purpose === "shared");
  useEffect(() => {
    if (purpose === "shared") setSharedVisited(true);
  }, [purpose]);

  // Subpanel validities
  const [readingValidity, setReadingValidity] = useState({
    memoryValid: true,
    knowledgeGlobalValid: true,
    knowledgeAgentValid: true,
  });

  // Synchronize initial target and load domains when becoming active
  useEffect(() => {
    if (!active || purpose === "shared") return;
    void s.loadKnowledgeModel();
    void s.loadOrganization();
  }, [active, purpose, s.loadKnowledgeModel, s.loadOrganization]);

  // Derived active objects strictly from store editors to avoid desync
  const effectiveAgentId =
    s.editorAgentId && s.editorAgentId !== "__new__"
      ? s.editorAgentId
      : (s.agents.find((a) => a.id !== "__new__")?.id ?? "");

  const auxRoleModels = useMemo<Record<string, string | null | undefined>>(
    () => ({
      knowledge_organize:
        s.knowledgeModelEditor?.source.model_name || s.organizationEditor?.source.model_name,
    }),
    [s.organizationEditor?.source.model_name, s.knowledgeModelEditor?.source.model_name],
  );

  const [modelCapacities, setModelCapacities] = useState<Record<string, number | null>>({});

  useEffect(() => {
    if (!active || purpose === "shared") return;
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
        (purpose === "aux" ? [auxRoleModels.knowledge_organize] : []).filter(
          (m): m is string => typeof m === "string" && m.length > 0,
        ),
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
  }, [active, purpose, effectiveAgentId, s.apiClient, auxRoleModels]);

  const invalidInputsFor = (prefix: string) =>
    Object.fromEntries(
      Object.entries(s.allocationInvalidInputs)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value]),
    );
  // 选中角色只剩非法原文、草稿本身不脏时也必须能放弃：放弃会清掉该角色的 raw 与草稿，
  // 未选角色的 dirty/invalid 原样保留（由 discardOrganization 的 scoped 清理保证）。
  const knowledgeAuxInvalid = Object.keys(s.allocationInvalidInputs).some((key) =>
    key.startsWith("global:aux:knowledge_organize_"),
  );
  const patchInvalidInput = (prefix: string, key: string, raw: string | undefined) => {
    useSuperstringStore.setState((state) => {
      const next = { ...state.allocationInvalidInputs };
      if (raw === undefined) delete next[prefix + key];
      else next[prefix + key] = raw;
      return { allocationInvalidInputs: next };
    });
  };
  const returnTarget = target;

  return (
    <section
      data-testid="context-allocation-workspace"
      aria-label={t("schemes.contextAllocation.title")}
      hidden={!active}
      className={active ? "flex h-full min-h-0 flex-col" : "hidden"}
    >
      {!embedded && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            {returnTarget.returnRoute && (
              <Button
                tooltip={<Trans i18nKey="hints.complete.return" />}
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

          <div className="flex items-center gap-2 text-xs">
            <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1">
              <span className="text-muted-foreground">
                {t("schemes.allocation.reading.scopeGlobal")}
              </span>
              <Badge variant="outline" className="bg-background font-medium text-xs">
                {t(
                  purpose === "reading"
                    ? "schemes.allocation.purposeReading"
                    : "schemes.allocation.purposeAux",
                )}
              </Badge>
            </div>
          </div>
        </header>
      )}

      {embedded && returnTarget.returnRoute && (
        <div className="border-b px-4 py-2">
          <Button
            tooltip={<Trans i18nKey="hints.complete.return" />}
            variant="ghost"
            size="sm"
            onClick={returnFromContextAllocation}
          >
            <ArrowLeft className="size-4" />
            {t("schemes.allocation.returnTo", {
              "0": returnTarget.returnLabel || returnTarget.returnRoute,
            })}
          </Button>
        </div>
      )}
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

      <Tabs
        orientation="horizontal"
        value={purpose}
        onValueChange={(val) => {
          if (useSuperstringStore.getState().editorLoading) return;
          if (val === "shared") useSuperstringStore.getState().openSettingsRoute("models");
          else openContextAllocation({ purpose: val as AllocationPurpose });
        }}
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-0"
      >
        <aside className="shrink-0 pb-[24px]">
          <TabsList className="h-[42px] group-data-horizontal/tabs:h-[42px] w-fit max-w-full justify-start gap-[6px] overflow-x-auto rounded-[10px] border border-border bg-muted p-[4px] [&_[role=tab]]:h-[32px] [&_[role=tab]]:flex-none [&_[role=tab]]:px-[14px] [&_[role=tab]]:text-[13px]">
            {sharedDefaults && (
              <TabsTrigger value="shared" className="h-auto min-h-9 whitespace-normal text-left">
                {t("models.sharedDefaults")}
              </TabsTrigger>
            )}
            <TabsTrigger
              value="reading"
              className="flex h-auto min-h-9 w-full min-w-0 shrink-0 items-center justify-start gap-2 whitespace-normal px-3 py-2 text-xs font-medium text-foreground"
            >
              <BookOpen className="size-4 shrink-0" />
              <span className="min-w-0 break-words leading-tight">
                {t("schemes.allocation.purposeReading")}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="aux"
              className="flex h-auto min-h-9 w-full min-w-0 shrink-0 items-center justify-start gap-2 whitespace-normal px-3 py-2 text-xs font-medium text-foreground"
            >
              <Wrench className="size-4 shrink-0" />
              <span className="min-w-0 break-words leading-tight">
                {t("schemes.allocation.purposeAux")}
              </span>
            </TabsTrigger>
          </TabsList>
        </aside>

        {/* Main Content Area */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-[28px]" data-workspace-scroll>
          {sharedDefaults && (sharedVisited || purpose === "shared") && (
            <div hidden={purpose !== "shared"}>{sharedDefaults}</div>
          )}

          {/* PURPOSE: READING BUDGETS (GLOBAL SCOPE) */}
          {purpose === "reading" && (
            <div className="w-full min-w-0 space-y-6">
              <ContextAllocationReading
                scope="global"
                knowledgeGlobalBudget={s.knowledgeModelEditor?.contextBudget}
                invalidInputs={
                  "global:knowledge" in s.allocationInvalidInputs
                    ? { knowledgeGlobal: s.allocationInvalidInputs["global:knowledge"] }
                    : {}
                }
                onInvalidInput={(_, raw) => patchInvalidInput("", "global:knowledge", raw)}
                onKnowledgeGlobalBudget={(val) => s.patchKnowledgeGlobal({ contextBudget: val })}
                onRefreshKnowledgeGlobal={() => void s.loadKnowledgeModel(true)}
                onDiscardKnowledgeGlobal={() => s.discardKnowledgeModel("budget")}
                onSaveKnowledgeGlobal={async () => {
                  if (!("global:knowledge" in s.allocationInvalidInputs))
                    await s.saveKnowledgeModel("budget");
                }}
                savingKnowledgeGlobal={s.settingsSaving}
                canSaveKnowledgeGlobal={
                  !!s.knowledgeModelEditor &&
                  knowledgeModelDirty(s.knowledgeModelEditor, "budget") &&
                  !s.knowledgeModelLoading &&
                  !s.settingsSaving &&
                  readingValidity.knowledgeGlobalValid
                }
                onValidityChange={setReadingValidity}
                readOnly={s.settingsSaving}
                labels={{
                  refreshBaseline: t("capabilities.resources.refreshBaseline"),
                  discardBudget: t("library.discard.knowledge.budget"),
                  ...Object.fromEntries(
                    [
                      "knowledgeGlobalTitle",
                      "knowledgeGlobalDesc",
                      "saveKnowledgeGlobal",
                      "saving",
                      "scopeGlobal",
                      "defaultBytesLabel",
                      "invalidPositiveByte",
                    ].map((key) => [key, t(`schemes.allocation.reading.${key}`)]),
                  ),
                }}
              />
            </div>
          )}

          {/* PURPOSE: AUXILIARY TASKS (GLOBAL SCOPE) */}
          {purpose === "aux" && (
            <ContextAllocationAuxiliary
              scope="global"
              globalProfiles={s.organizationEditor?.auxiliaryAllocation}
              globalRoles={["knowledge_organize"]}
              invalidInputs={invalidInputsFor("global:aux:")}
              onInvalidInput={(key, raw) => patchInvalidInput("global:aux:", key, raw)}
              roleDetails={Object.fromEntries(
                (["knowledge_organize"] as const).map((role) => [
                  role,
                  <AllocationModelCapacity
                    key={role}
                    model={auxRoleModels[role]}
                    capacity={
                      auxRoleModels[role]
                        ? auxRoleModels[role]! in modelCapacities
                          ? modelCapacities[auxRoleModels[role]!]
                          : null
                        : null
                    }
                    active={active && purpose === "aux"}
                  />,
                ]),
              )}
              onGlobalChange={s.patchOrganizationAllocation}
              onSaveGlobal={async () => {
                await s.saveOrganization("allocation", ["knowledge_organize"]);
              }}
              onDiscardGlobal={() => s.discardOrganization("allocation", ["knowledge_organize"])}
              canDiscardGlobal={
                !!s.organizationEditor &&
                (organizationDirty(s.organizationEditor, "allocation", ["knowledge_organize"]) ||
                  knowledgeAuxInvalid) &&
                !s.settingsSaving
              }
              canSaveGlobal={
                !!s.organizationEditor &&
                organizationDirty(s.organizationEditor, "allocation", ["knowledge_organize"]) &&
                !s.organizationLoading &&
                !s.settingsSaving &&
                auxiliaryValidity.globalValid
              }
              savingGlobal={s.settingsSaving}
              onValidityChange={setAuxiliaryValidity}
              readOnly={s.settingsSaving}
              labels={{
                discardGlobal: t("models.discard"),
                ...Object.fromEntries(
                  [
                    ...[
                      "globalSectionTitle",
                      "globalSectionDesc",
                      "globalScopeNotice",
                      "saveGlobal",
                      "inputLimit",
                      "outputReserved",
                      "modeAuto",
                      "modeFixed",
                      "saving",
                      "customToggle",
                      "mode",
                    ],
                    ...["knowledge_organize"].flatMap((role) =>
                      ["name", "desc", "inputDesc", "outputDesc"].map(
                        (field) => `role.${role}.${field}`,
                      ),
                    ),
                  ].map((k) => [k, t(`schemes.allocation.aux.${k}`)]),
                ),
              }}
            />
          )}
        </div>
      </Tabs>
    </section>
  );
}
