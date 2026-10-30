import { ArrowLeft, BookOpen, Wrench } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import type { AllocationPurpose } from "../../features/context-allocation";
import { knowledgeModelDirty, organizationDirty } from "../../features/knowledge/types";
import { translateNotice } from "../../i18n";
import { useForegroundRead } from "../../services/use-foreground-read";
import { useSuperstringStore } from "../../store";
import { AllocationModelCapacity } from "../connections/AllocationModelCapacity";
import { ContextAllocationAuxiliary } from "../connections/ContextAllocationAuxiliary";
import { ContextAllocationReading } from "../connections/ContextAllocationReading";

export function ModelPurposes({
  active = true,
  // Embedded views share the host header.
  embedded = false,
}: {
  active?: boolean;
  embedded?: boolean;
} = {}) {
  const { t } = useTranslation();
  const s = useSuperstringStore(
    useShallow((state) => ({
      allocationInvalidInputs: state.allocationInvalidInputs,
      apiClient: state.apiClient,
      contextAllocationTarget: state.contextAllocationTarget,
      openContextAllocation: state.openContextAllocation,
      returnFromContextAllocation: state.returnFromContextAllocation,
      acquireKnowledgeModelRead: state.acquireKnowledgeModelRead,
      releaseKnowledgeModelRead: state.releaseKnowledgeModelRead,
      acquireOrganizationRead: state.acquireOrganizationRead,
      releaseOrganizationRead: state.releaseOrganizationRead,
      discardKnowledgeModel: state.discardKnowledgeModel,
      discardOrganization: state.discardOrganization,
      error: state.knowledgeModelError.budget,
      sharedError: state.knowledgeModelError.shared,
      organizationError: state.organizationError,
      legacyFeedback: state.feedback,
      feedback: state.knowledgeModelNotice,
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
  const purpose = target.purpose === "aux" ? "aux" : "reading";

  // Subpanel validities
  const [readingValidity, setReadingValidity] = useState({
    knowledgeGlobalValid: true,
  });

  // Synchronize initial target and load domains when becoming active
  const organizationOwner = useMemo(() => ({ api: s.apiClient }), [s.apiClient]);
  const knowledgeOwner = useMemo(() => ({ api: s.apiClient }), [s.apiClient]);
  const readSettings = useCallback(() => {
    if (useSuperstringStore.getState().apiClient !== s.apiClient) return;
    void s.acquireKnowledgeModelRead(knowledgeOwner);
    if (purpose === "aux") void s.acquireOrganizationRead(organizationOwner);
  }, [
    purpose,
    s.apiClient,
    s.acquireKnowledgeModelRead,
    knowledgeOwner,
    s.acquireOrganizationRead,
    organizationOwner,
  ]);
  const suspendSettings = useCallback(() => {
    s.releaseKnowledgeModelRead(knowledgeOwner);
    s.releaseOrganizationRead(organizationOwner);
  }, [s.releaseKnowledgeModelRead, knowledgeOwner, s.releaseOrganizationRead, organizationOwner]);
  useForegroundRead(readSettings, suspendSettings, {
    paused: !active,
    intervalMs: null,
    retainOnHide: true,
    onSuspend: suspendSettings,
  });

  const compare =
    purpose === "aux"
      ? organizationDirty(s.organizationEditor, "allocation", ["knowledge_organize"])
      : knowledgeModelDirty(s.knowledgeModelEditor, "budget");

  const knowledgeModel =
    s.knowledgeModelEditor?.source.model_name || s.organizationEditor?.source.model_name;

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
      className={active ? `flex min-h-0 flex-col ${embedded ? "" : "h-full"}` : "hidden"}
    >
      {!embedded && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            {returnTarget.returnRoute && (
              <Button
                tooltip={<Trans i18nKey="hints.complete.return" />}
                variant="outline"
                size="sm"
                onClick={s.returnFromContextAllocation}
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
            onClick={s.returnFromContextAllocation}
          >
            <ArrowLeft className="size-4" />
            {t("schemes.allocation.returnTo", {
              "0": returnTarget.returnLabel || returnTarget.returnRoute,
            })}
          </Button>
        </div>
      )}
      {(purpose === "reading" || embedded) && s.sharedError && (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {translateNotice(s.sharedError)}
        </p>
      )}
      {(purpose === "aux" ? s.organizationError : s.error) && (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {translateNotice(purpose === "aux" ? s.organizationError! : s.error!)}
        </p>
      )}
      {purpose === "aux" && (s.organizationEditor || s.organizationError) && (
        <div className="px-4 py-2">
          <Button
            variant="outline"
            disabled={s.settingsSaving || s.knowledgeModelLoading || s.organizationLoading}
            tooltip={t("hints.library.knowledge.refreshSettings")}
            onClick={() => {
              if (purpose === "aux") void s.loadOrganization(true);
              else void s.loadKnowledgeModel(true);
            }}
          >
            {t("capabilities.resources.refreshBaseline")}
          </Button>
        </div>
      )}
      {compare && (
        <section
          aria-label={t("materials.savedBaseline")}
          className="space-y-2 border-y bg-muted/20 px-4 py-3 text-sm"
        >
          <h2 className="font-medium">
            {t("materials.savedBaseline")} ·{" "}
            {t("common.revision", {
              "0":
                purpose === "aux"
                  ? s.organizationEditor?.source.revision
                  : s.knowledgeModelEditor?.source.revision,
            })}
          </h2>
          {purpose === "aux" ? (
            (() => {
              const profile = s.organizationEditor?.source.auxiliary_allocation?.knowledge_organize;
              const draft = s.organizationEditor?.auxiliaryAllocation?.knowledge_organize;
              const limit = (value: number | null | undefined) =>
                value === undefined
                  ? t("schemes.allocation.aux.inherit")
                  : value === null
                    ? t("materials.noHardLimit")
                    : String(value);
              return profile ? (
                <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
                  {draft?.mode !== profile.mode && (
                    <>
                      <dt>{t("schemes.allocation.aux.mode")}</dt>
                      <dd>
                        {t(
                          profile.mode === "auto"
                            ? "schemes.allocation.aux.modeAuto"
                            : "schemes.allocation.aux.modeFixed",
                        )}
                      </dd>
                    </>
                  )}
                  {draft?.input_limit !== profile.input_limit && (
                    <>
                      <dt>{t("schemes.allocation.aux.inputLimit")}</dt>
                      <dd>{limit(profile.input_limit)}</dd>
                    </>
                  )}
                  {draft?.output_reserved !== profile.output_reserved && (
                    <>
                      <dt>{t("schemes.allocation.aux.outputReserved")}</dt>
                      <dd>{limit(profile.output_reserved)}</dd>
                    </>
                  )}
                </dl>
              ) : (
                <p>{t("schemes.allocation.aux.inherit")}</p>
              );
            })()
          ) : (
            <p>
              {t("schemes.allocation.reading.defaultBytesLabel")}:{" "}
              {s.knowledgeModelEditor?.source.context_budget} Bytes
            </p>
          )}
        </section>
      )}
      {compare && <h2 className="px-4 pt-3 text-sm font-medium">{t("materials.localDraft")}</h2>}
      {(purpose === "aux" ? s.legacyFeedback : s.feedback) && (
        <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
          {translateNotice(purpose === "aux" ? s.legacyFeedback : s.feedback)}
        </p>
      )}

      <Tabs
        orientation="horizontal"
        value={purpose}
        onValueChange={(val) => {
          if (useSuperstringStore.getState().editorLoading) return;
          s.openContextAllocation({ purpose: val as AllocationPurpose });
        }}
        className={
          embedded ? "flex min-w-0 flex-col gap-0" : "flex min-h-0 min-w-0 flex-1 flex-col gap-0"
        }
      >
        <aside className="shrink-0 pb-[24px]">
          <TabsList
            presentation="workspace"
            flow="scroll"
            className="w-fit max-w-full justify-start"
          >
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
        <div
          className={
            embedded ? "min-w-0 pb-[28px]" : "min-h-0 min-w-0 flex-1 overflow-y-auto pb-[28px]"
          }
          data-workspace-scroll
        >
          {/* PURPOSE: READING BUDGETS (GLOBAL SCOPE) */}
          {purpose === "reading" && (
            <div className="w-full min-w-0 space-y-6">
              <ContextAllocationReading
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
                    model={knowledgeModel}
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
