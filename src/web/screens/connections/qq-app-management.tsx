import { ImageIcon, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { InputSuggestions } from "../../components/ui/input-suggestions";
import { organizationDirty } from "../../features/knowledge/types";
import { useQqInput } from "../../features/qq/use-qq-input";
import { translateNotice } from "../../i18n";
import { type ReadTask, startRead } from "../../services/read-task";
import { useForegroundRead } from "../../services/use-foreground-read";
import { useSuperstringStore } from "../../store";
import { WorkspaceHelp } from "../../workspace/WorkspaceHelp";
import { QqJudgementModel } from "../environment/model-defaults";
import { AllocationModelCapacity } from "./AllocationModelCapacity";
import { ContextAllocationAuxiliary } from "./ContextAllocationAuxiliary";
import {
  QqManagedComponentCard,
  type QqManagedNetworkApply,
  type QqManagedPhase,
  type QqManagedStatus,
} from "./QqManagedComponentCard";
import { QqManagedMessageStream } from "./QqManagedMessageStream";
import { QqBusinessSwitch, TransportSettings } from "./transport-settings";

const connectionPhaseLabels: Record<string, string> = {
  unavailable: "connections.thisProcessHasNoTransportRuntime",
  idle: "connections.notConnected",
  connecting: "connections.connecting",
  verifying: "connections.verifying",
  ready: "connections.connected",
  closed: "connections.connectionClosed",
};

const QQ_MEDIA_GLOBAL_ROLES = ["qq_sticker_annotate", "qq_media_describe"] as const;

function QqMultimodalSettings({ active = true }: { active?: boolean }) {
  const { t } = useTranslation();
  const modelHintId = useId();
  const s = useSuperstringStore(
    useShallow((state) => ({
      allocationInvalidInputs: state.allocationInvalidInputs,
      apiClient: state.apiClient,
      discardOrganization: state.discardOrganization,
      loadOrganization: state.loadOrganization,
      modelNames: state.modelNames,
      organizationEditor: state.organizationEditor,
      organizationError: state.organizationError,
      organizationLoading: state.organizationLoading,
      patchOrganizationAllocation: state.patchOrganizationAllocation,
      patchOrganizationPurposes: state.patchOrganizationPurposes,
      saveOrganization: state.saveOrganization,
      settingsSaving: state.settingsSaving,
    })),
  );
  const editor = s.organizationEditor;
  const compare =
    organizationDirty(editor, "qq-models") ||
    organizationDirty(editor, "allocation", QQ_MEDIA_GLOBAL_ROLES);
  const [auxiliaryValidity, setAuxiliaryValidity] = useState({
    agentValid: true,
    globalValid: true,
  });
  // QQ 页的 active gate 发起组织读取；容量选择会接管同一次在途读取，不能读取旧 API 的模型。
  const mediaRoles = QQ_MEDIA_GLOBAL_ROLES;
  const modelSuggestions = s.modelNames.map((name) => ({ value: name }));
  // 两个角色共用已存的图片理解模型：容量只读一次。晚到响应按 api/model/active 身份丢弃。
  const savedVisionModel = editor?.source.vision_model_name ?? null;
  const organizationToken = editor?.token;
  const [visionCapacity, setVisionCapacity] = useState<{
    api: typeof s.apiClient;
    model: string;
    token: object;
    capacity: number | null;
  } | null>(null);
  const capacityTask = useRef<ReadTask | null>(null);
  const capacityGeneration = useRef(0);
  const cancelCapacity = useCallback(() => {
    capacityGeneration.current++;
    capacityTask.current?.cancel();
    capacityTask.current = null;
  }, []);
  const readCapacity = useCallback(() => {
    const api = s.apiClient;
    if (!savedVisionModel || !organizationToken) return;
    const generation = ++capacityGeneration.current;
    const matches = () => {
      const state = useSuperstringStore.getState();
      const source = state.organizationEditor;
      return (
        capacityGeneration.current === generation &&
        state.apiClient === api &&
        !!source &&
        source.token === organizationToken &&
        source.source.vision_model_name === savedVisionModel
      );
    };
    void (async () => {
      // Source ownership must settle before capacity is read, including an API
      // replacement whose previous editor happened to use the same model name.
      await s.loadOrganization();
      if (!matches() || useSuperstringStore.getState().organizationError) return;
      capacityTask.current = startRead((signal) => api.getModelCapacity(savedVisionModel, signal), {
        success: (value) => {
          if (matches())
            setVisionCapacity({
              api,
              model: savedVisionModel,
              token: organizationToken,
              capacity: value.context_length,
            });
        },
        failure: () => {
          if (matches())
            setVisionCapacity({
              api,
              model: savedVisionModel,
              token: organizationToken,
              capacity: null,
            });
        },
        settled: () => {
          if (matches()) capacityTask.current = null;
        },
      });
    })();
  }, [savedVisionModel, organizationToken, s.apiClient, s.loadOrganization]);
  useForegroundRead(readCapacity, cancelCapacity, {
    enabled: !!savedVisionModel && !!organizationToken,
    paused: !active,
    intervalMs: null,
    retainOnHide: true,
    onSuspend: cancelCapacity,
  });
  const savedVisionCapacity =
    visionCapacity &&
    visionCapacity.api === s.apiClient &&
    visionCapacity.model === savedVisionModel &&
    visionCapacity.token === organizationToken
      ? visionCapacity.capacity
      : null;
  // 两个 QQ 角色只剩非法原文、草稿本身不脏时也必须能放弃；knowledge_organize 的 raw 不在此清理。
  const mediaAuxInvalid = Object.keys(s.allocationInvalidInputs).some((key) =>
    mediaRoles.some((role) => key.startsWith(`global:aux:${role}_`)),
  );

  return (
    <div className="space-y-6">
      <SettingsGroup
        title={t("qq.models.title")}
        action={<WorkspaceHelp title={t("qq.models.title")} description={t("qq.models.hint")} />}
        icon={ImageIcon}
      >
        {editor && (
          <>
            <p id={modelHintId} className="settings-content-padding text-xs text-muted-foreground">
              {t("models.mediaUnsetHint")}
            </p>
            {compare && (
              <h3 className="px-4 pt-3 text-sm font-medium">{t("materials.localDraft")}</h3>
            )}
            <SettingsRow
              label={
                <label
                  htmlFor="qq-default-vision-model"
                  className="cursor-pointer text-sm font-medium text-foreground"
                >
                  {t("models.purpose.vision")}
                </label>
              }
              description={t("models.purpose.vision.hint")}
            >
              <InputSuggestions
                id="qq-default-vision-model"
                suggestions={modelSuggestions}
                value={editor.visionModelName ?? ""}
                placeholder={t("library.unset")}
                aria-describedby={modelHintId}
                disabled={s.settingsSaving || s.organizationLoading}
                aria-label={t("models.purpose.vision")}
                onValueChange={(value) =>
                  s.patchOrganizationPurposes({ visionModelName: value || null })
                }
                className="w-full sm:w-64 sm:min-w-56"
              />
            </SettingsRow>
            <SettingsRow
              label={
                <label
                  htmlFor="qq-default-transcription-model"
                  className="cursor-pointer text-sm font-medium text-foreground"
                >
                  {t("models.purpose.transcription")}
                </label>
              }
              description={t("models.purpose.transcription.hint")}
            >
              <InputSuggestions
                id="qq-default-transcription-model"
                suggestions={modelSuggestions}
                value={editor.transcriptionModelName ?? ""}
                placeholder={t("library.unset")}
                aria-describedby={modelHintId}
                disabled={s.settingsSaving || s.organizationLoading}
                aria-label={t("models.purpose.transcription")}
                onValueChange={(value) =>
                  s.patchOrganizationPurposes({ transcriptionModelName: value || null })
                }
                className="w-full sm:w-64 sm:min-w-56"
              />
            </SettingsRow>
            {compare && (
              <section
                aria-label={t("materials.savedBaseline")}
                className="space-y-2 border-t bg-muted/20 px-4 py-3 text-sm"
              >
                <h3 className="font-medium">
                  {t("materials.savedBaseline")} ·{" "}
                  {t("common.revision", { "0": editor.source.revision })}
                </h3>
                <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
                  {editor.visionModelName !== editor.source.vision_model_name && (
                    <>
                      <dt>{t("models.purpose.vision")}</dt>
                      <dd>{editor.source.vision_model_name ?? t("library.not.set")}</dd>
                    </>
                  )}
                  {editor.transcriptionModelName !== editor.source.transcription_model_name && (
                    <>
                      <dt>{t("models.purpose.transcription")}</dt>
                      <dd>{editor.source.transcription_model_name ?? t("library.not.set")}</dd>
                    </>
                  )}
                </dl>
                {mediaRoles.map((role) => {
                  const profile = editor.source.auxiliary_allocation?.[role];
                  const draft = editor.auxiliaryAllocation?.[role];
                  if (!organizationDirty(editor, "allocation", [role])) return null;
                  const limit = (value: number | null | undefined) =>
                    value === undefined
                      ? t("schemes.allocation.aux.inherit")
                      : value === null
                        ? t("materials.noHardLimit")
                        : String(value);
                  return (
                    <div key={role} className="space-y-1">
                      <h4 className="font-medium">
                        {t(`schemes.allocation.aux.role.${role}.name`)}
                      </h4>
                      {profile ? (
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
                      )}
                    </div>
                  );
                })}
              </section>
            )}
            <div className="px-4 py-2">
              <Button
                variant="outline"
                disabled={s.settingsSaving || s.organizationLoading}
                tooltip={t("hints.library.knowledge.refreshSettings")}
                onClick={() => void s.loadOrganization(true)}
              >
                <RefreshCw />
                {t("materials.refreshOrganization")}
              </Button>
            </div>
            <p className="border-t border-border/40 bg-muted/10 px-4 py-2.5 text-xs text-muted-foreground">
              {t("qq.models.saveScope")}
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2 bg-muted/15 px-4 py-3">
              <Button
                tooltip={<Trans i18nKey="hints.complete.qqModelsDiscard" />}
                variant="outline"
                disabled={s.settingsSaving || !organizationDirty(editor, "qq-models")}
                onClick={() => s.discardOrganization("qq-models")}
              >
                {t("models.discard")}
              </Button>
              <Button
                tooltip={<Trans i18nKey="hints.complete.qqModelsSave" />}
                disabled={s.settingsSaving || !organizationDirty(editor, "qq-models")}
                onClick={() => void s.saveOrganization("qq-models")}
              >
                {t("library.save")}
              </Button>
            </div>
          </>
        )}
        {!editor && (
          <div className="settings-content-padding">
            <Button
              tooltip={<Trans i18nKey="hints.complete.defaultsRetry" />}
              variant="outline"
              disabled={s.organizationLoading}
              onClick={() => void s.loadOrganization(true)}
            >
              {t(s.organizationLoading ? "models.loadingDefaults" : "models.retryDefaults")}
            </Button>
          </div>
        )}
        {s.organizationError && (
          <div
            role="alert"
            className="border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            {translateNotice(s.organizationError)}
          </div>
        )}
      </SettingsGroup>

      {editor && (
        <ContextAllocationAuxiliary
          scope="global"
          presentation="settings"
          globalProfiles={editor.auxiliaryAllocation}
          globalRoles={mediaRoles}
          roleDetails={Object.fromEntries(
            mediaRoles.map((role) => [
              role,
              <AllocationModelCapacity
                key={role}
                model={savedVisionModel}
                capacity={savedVisionCapacity}
                active={active}
              />,
            ]),
          )}
          invalidInputs={Object.fromEntries(
            Object.entries(s.allocationInvalidInputs)
              .filter(([key]) => mediaRoles.some((role) => key.startsWith(`global:aux:${role}_`)))
              .map(([key, value]) => [key.slice("global:aux:".length), value]),
          )}
          onInvalidInput={(key, raw) => {
            const prefix = "global:aux:";
            useSuperstringStore.setState((state) => {
              const next = { ...state.allocationInvalidInputs };
              if (raw === undefined) delete next[prefix + key];
              else next[prefix + key] = raw;
              return { allocationInvalidInputs: next };
            });
          }}
          onGlobalChange={s.patchOrganizationAllocation}
          onSaveGlobal={() => void s.saveOrganization("allocation", mediaRoles)}
          onDiscardGlobal={() => s.discardOrganization("allocation", mediaRoles)}
          canDiscardGlobal={
            !!editor &&
            (organizationDirty(editor, "allocation", mediaRoles) || mediaAuxInvalid) &&
            !s.settingsSaving
          }
          canSaveGlobal={
            !!editor &&
            organizationDirty(editor, "allocation", mediaRoles) &&
            !s.organizationLoading &&
            !s.settingsSaving &&
            auxiliaryValidity.globalValid
          }
          savingGlobal={s.settingsSaving}
          onValidityChange={setAuxiliaryValidity}
          readOnly={s.settingsSaving}
          labels={{
            discardGlobal: t("models.discard"),
            globalSectionTitle: t("qq.aux.title"),
            globalSectionDesc: t("qq.aux.hint"),
            globalScopeNotice: t("qq.aux.saveScope"),
            saveGlobal: t("library.save"),
            inputLimit: t("schemes.allocation.aux.inputLimit"),
            outputReserved: t("schemes.allocation.aux.outputReserved"),
            modeAuto: t("schemes.allocation.aux.modeAuto"),
            modeFixed: t("schemes.allocation.aux.modeFixed"),
            mode: t("schemes.allocation.aux.mode"),
            saving: t("schemes.allocation.aux.saving"),
            customized: t("schemes.allocation.aux.customized"),
            inherit: t("schemes.allocation.aux.inherit"),
            inheritPlaceholder: t("schemes.allocation.aux.shortPlaceholder"),
            invalidPositiveInt: t("schemes.allocation.aux.invalidPositiveInt"),
            unit: t("schemes.allocation.aux.unit"),
            hardContract: t("schemes.allocation.aux.hardContract"),
            inputLimitDesc: t("schemes.allocation.aux.inputLimitDesc"),
            outputReservedDesc: t("schemes.allocation.aux.outputReservedDesc"),
            unconfiguredNote: t("schemes.allocation.aux.unconfiguredNote"),
            ...Object.fromEntries(
              mediaRoles.flatMap((role) =>
                ["name", "desc", "inputDesc", "outputDesc"].map(
                  (field) =>
                    [
                      `role.${role}.${field}`,
                      t(`schemes.allocation.aux.role.${role}.${field}`),
                    ] as const,
                ),
              ),
            ),
          }}
        />
      )}
    </div>
  );
}

export type QqConnectionTask = "connection" | "events" | "runtime";

export function QqConnectionTab({
  active = true,
  task = "connection",
}: {
  active?: boolean;
  task?: QqConnectionTask;
} = {}) {
  const { t } = useTranslation();
  const s = useSuperstringStore(
    useShallow((state) => ({
      apiClient: state.apiClient,
      qqManagedLifecycleId: state.qqManagedLifecycleId,
      loadQqAccess: state.loadQqAccess,
      loadOrganization: state.loadOrganization,
      acquireOrganizationRead: state.acquireOrganizationRead,
      releaseOrganizationRead: state.releaseOrganizationRead,
      loadQqManaged: state.loadQqManaged,
      loadQqManagedResources: state.loadQqManagedResources,
      loadQqManagedAccounts: state.loadQqManagedAccounts,
      acquireQqManagedAccounts: state.acquireQqManagedAccounts,
      releaseQqManagedAccounts: state.releaseQqManagedAccounts,
      patchQqManagedDraft: state.patchQqManagedDraft,
      patchQqManagedResourceDraft: state.patchQqManagedResourceDraft,
      saveQqManagedResources: state.saveQqManagedResources,
      quickLoginQqManaged: state.quickLoginQqManaged,
      qqAccessLoading: state.qqAccessLoading,
      qqAccessSaving: state.qqAccessSaving,
      qqConnection: state.qqConnection,
      managedDraft: state.qqInputs.managed,
      resourceDraft: state.qqInputs.managedResources,
      qqManagedConfig: state.qqManagedConfig,
      qqManagedError: state.qqManagedError,
      qqManagedLoading: state.qqManagedLoading,
      qqManagedSaving: state.qqManagedSaving,
      qqManagedStatus: state.qqManagedStatus,
      qqManagedResources: state.qqManagedResources,
      qqManagedResourceError: state.qqManagedResourceError,
      qqManagedResourcesLoading: state.qqManagedResourcesLoading,
      qqManagedAccounts: state.qqManagedAccounts,
      qqManagedAccountsLoading: state.qqManagedAccountsLoading,
      qqManagedAccountsLoaded: state.qqManagedAccountsLoaded,
      qqManagedAccountsAvailability: state.qqManagedAccountsAvailability,
      qqManagedAccountsError: state.qqManagedAccountsError,
      qqManagedEventsPage: state.qqManagedEventsPage,
      qqManagedEventsLoading: state.qqManagedEventsLoading,
      qqManagedEventsError: state.qqManagedEventsError,
      loadQqManagedEvents: state.loadQqManagedEvents,
      setQqManagedEventsActive: state.setQqManagedEventsActive,
      clearQqManagedEventsView: state.clearQqManagedEventsView,
      qqManagedQrPayload: state.qqManagedQrPayload,
      retryQqManaged: state.retryQqManaged,
      getQqManagedQr: state.getQqManagedQr,
      refreshQqManagedQr: state.refreshQqManagedQr,
      clearQqManagedQr: state.clearQqManagedQr,
      qqSettings: state.qqSettings,
      refreshQqConnection: state.refreshQqConnection,
      refreshQqManaged: state.refreshQqManaged,
      refreshQqManagedResources: state.refreshQqManagedResources,
      saveQqManagedConfig: state.saveQqManagedConfig,
    })),
  );
  const {
    loadQqAccess,
    loadQqManaged,
    loadQqManagedResources,
    setQqManagedEventsActive,
    clearQqManagedQr,
  } = s;
  const [connectionDraft, setConnectionDraft] = useQqInput("connection");
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (task === "events") await s.loadQqManagedEvents();
      else if (task === "runtime") {
        await Promise.all([s.loadQqAccess(), s.loadOrganization(true)]);
      } else {
        await Promise.all([
          s.refreshQqConnection(),
          s.refreshQqManaged(),
          s.refreshQqManagedResources(),
        ]);
      }
    } finally {
      setRefreshing(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: API and lifecycle changes require a new shared-access read even when the action identity is stable.
  useEffect(() => {
    if (!active) return;
    if (!document.hidden) void loadQqAccess();
    const revalidateVisible = () => {
      if (!document.hidden) void loadQqAccess();
    };
    document.addEventListener("visibilitychange", revalidateVisible);
    return () => document.removeEventListener("visibilitychange", revalidateVisible);
  }, [active, s.apiClient, s.qqManagedLifecycleId, loadQqAccess]);

  const accountsOwner = useMemo(
    () => ({ api: s.apiClient, lifecycleId: s.qqManagedLifecycleId }),
    [s.apiClient, s.qqManagedLifecycleId],
  );
  const releaseAccounts = useCallback(
    () => s.releaseQqManagedAccounts(accountsOwner),
    [s.releaseQqManagedAccounts, accountsOwner],
  );
  const readAccounts = useCallback(() => {
    // Revalidate before registering: retained snapshots cannot authorize a new entry.
    void loadQqManaged();
    void loadQqManagedResources();
    void s.acquireQqManagedAccounts(accountsOwner);
  }, [accountsOwner, s.acquireQqManagedAccounts, loadQqManaged, loadQqManagedResources]);
  useForegroundRead(readAccounts, releaseAccounts, {
    enabled: task === "connection",
    paused: !active,
    intervalMs: null,
    retainOnHide: true,
    onSuspend: releaseAccounts,
  });

  const organizationOwner = useMemo(() => ({ api: s.apiClient }), [s.apiClient]);
  const releaseRuntimeOrganization = useCallback(
    () => s.releaseOrganizationRead(organizationOwner),
    [s.releaseOrganizationRead, organizationOwner],
  );
  const readRuntimeOrganization = useCallback(() => {
    const current = useSuperstringStore.getState();
    if (
      current.apiClient !== s.apiClient ||
      current.qqManagedLifecycleId !== s.qqManagedLifecycleId
    )
      return;
    void s.acquireOrganizationRead(organizationOwner);
  }, [s.apiClient, s.qqManagedLifecycleId, s.acquireOrganizationRead, organizationOwner]);
  useForegroundRead(readRuntimeOrganization, releaseRuntimeOrganization, {
    enabled: task === "runtime",
    paused: !active,
    intervalMs: null,
    retainOnHide: true,
    onSuspend: releaseRuntimeOrganization,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: Rebind the event owner when the API or managed lifecycle changes without switching tasks.
  useEffect(() => {
    setQqManagedEventsActive(active && task === "events");
    return () => setQqManagedEventsActive(false);
  }, [active, task, s.apiClient, s.qqManagedLifecycleId, setQqManagedEventsActive]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Cleanup must invalidate late QR responses from the previous API or managed lifecycle.
  useEffect(() => {
    if (!active || task !== "connection") clearQqManagedQr();
    const handleVisibilityChange = () => {
      if (document.hidden) clearQqManagedQr();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      clearQqManagedQr();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [active, task, s.apiClient, s.qqManagedLifecycleId, clearQqManagedQr]);

  const managedDraft = s.managedDraft;
  const isManagedDirty =
    !!managedDraft && managedDraft.enabled !== managedDraft.source.config.enabled;
  const managedEnabled = isManagedDirty
    ? managedDraft.enabled
    : (s.qqManagedConfig?.config.enabled ?? false);

  const managedStatus = s.qqManagedStatus;
  let phase: QqManagedPhase = "unconfigured";
  let runtimeGatePassed = false;
  let diagnosticCode: string | null = null;
  let ownership: "none" | "external" | "owned" = "none";
  let networkApply: QqManagedNetworkApply | undefined;

  if (managedStatus) {
    if (managedStatus.apply === "ready") {
      runtimeGatePassed = true;
      phase = managedStatus.phase;
      ownership = managedStatus.ownership;
      diagnosticCode = managedStatus.diagnostic_code;
      networkApply = managedStatus.network_apply;
    } else {
      runtimeGatePassed = false;
      phase =
        managedStatus.unavailable_reason === "management_not_configured"
          ? "unconfigured"
          : "stopped";
    }
  }

  if (s.qqConnection?.phase === "ready" && ownership === "none" && phase === "stopped") {
    phase = "transport_ready";
    ownership = "external";
    networkApply = "not_owned";
  }

  const cardStatus: QqManagedStatus = {
    managedEnabled,
    phase,
    accountId: s.qqSettings?.account_id ?? null,
    qrPayload: s.qqManagedQrPayload,
    runtimeGatePassed,
    diagnosticCode,
    ownership,
    process: managedStatus?.apply === "ready" ? managedStatus.process : undefined,
    networkApply,
  };

  const rawEvents = s.qqManagedEventsPage?.status === "ok" ? s.qqManagedEventsPage.events : [];
  // Server returns newest-first; UI purely reverses once to display stable ascending order with newest at bottom
  const streamEvents = useMemo(() => [...rawEvents].reverse(), [rawEvents]);

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto pb-1" data-workspace-scroll>
      {s.qqSettings ? (
        <>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2.5">
              <Badge
                variant={s.qqConnection?.phase === "ready" ? "secondary" : "outline"}
                className="rounded-md px-2 py-0.5 font-medium"
              >
                {s.qqConnection
                  ? t(connectionPhaseLabels[s.qqConnection.phase] ?? "connections.unknown")
                  : t("connections.unknown")}
              </Badge>
            </div>
            {task !== "events" && (
              <Button
                tooltip={<Trans i18nKey="hints.complete.qqRefresh" />}
                variant="outline"
                size="sm"
                disabled={
                  s.qqAccessSaving ||
                  s.qqAccessLoading ||
                  s.qqManagedSaving ||
                  s.qqManagedLoading ||
                  refreshing
                }
                onClick={() => void refresh()}
                className="h-8 rounded-lg"
              >
                <RefreshCw className="size-3.5" />
                {t("connections.refreshState")}
              </Button>
            )}
          </div>
          <QqBusinessSwitch />
          {task === "connection" && (
            <>
              <div className="space-y-3">
                <QqManagedComponentCard
                  status={cardStatus}
                  resources={s.qqManagedResources}
                  resourceError={s.qqManagedResourceError}
                  onRetryResources={() => void s.loadQqManagedResources()}
                  resourceDraftRoot={
                    s.resourceDraft ? s.resourceDraft.root : (s.qqManagedResources?.root ?? "")
                  }
                  accounts={s.qqManagedAccounts}
                  accountsAvailability={s.qqManagedAccountsAvailability}
                  accountsLoaded={s.qqManagedAccountsLoaded}
                  accountsLoading={s.qqManagedAccountsLoading}
                  accountsError={s.qqManagedAccountsError}
                  onRetryAccounts={() => void s.loadQqManagedAccounts()}
                  selectedQuickLoginAccount={
                    connectionDraft ? connectionDraft.accountId : (s.qqSettings?.account_id ?? "")
                  }
                  loading={s.qqManagedLoading || s.qqManagedResourcesLoading}
                  saving={s.qqManagedSaving}
                  onToggleManaged={(enabled) => s.patchQqManagedDraft(enabled)}
                  onRefreshQr={() =>
                    void (s.qqManagedQrPayload ? s.refreshQqManagedQr() : s.getQqManagedQr())
                  }
                  onSelectQuickLoginAccount={(accId) => {
                    const settings = s.qqSettings;
                    if (!settings) return;
                    const base = connectionDraft ?? {
                      source: settings,
                      endpoint: settings.transport.endpoint ?? "",
                      accountId: settings.account_id ?? "",
                      token: "",
                    };
                    setConnectionDraft({ ...base, accountId: accId });
                  }}
                  onExecuteQuickLogin={async () => {
                    const effectiveId = (
                      connectionDraft ? connectionDraft.accountId : (s.qqSettings?.account_id ?? "")
                    ).trim();
                    if (!effectiveId) return;
                    // The existing action saves only a changed account through saveQqSurface before login.
                    await s.quickLoginQqManaged(effectiveId);
                  }}
                  onPatchResourceDraftRoot={(root) => {
                    s.patchQqManagedResourceDraft(root);
                  }}
                  onUpdateResourcePath={(root) => {
                    s.patchQqManagedResourceDraft(root);
                    void s.saveQqManagedResources();
                  }}
                  onRetry={() => void s.retryQqManaged()}
                  footer={
                    <>
                      <Button
                        tooltip={t("models.discard")}
                        variant="outline"
                        size="sm"
                        disabled={!isManagedDirty || s.qqManagedSaving}
                        onClick={() =>
                          useSuperstringStore.setState((state) => ({
                            qqInputs: { ...state.qqInputs, managed: null },
                          }))
                        }
                      >
                        {t("models.discard")}
                      </Button>
                      <Button
                        tooltip={t("library.save")}
                        size="sm"
                        disabled={!isManagedDirty || s.qqManagedSaving}
                        onClick={() => void s.saveQqManagedConfig()}
                      >
                        {t("library.save")}
                      </Button>
                    </>
                  }
                />
                {s.qqManagedError && (
                  <p role="alert" className="text-sm text-destructive">
                    {t("connections.managed.diag.unknown")}
                  </p>
                )}
              </div>
              <TransportSettings active={active} view="connection" />
            </>
          )}
          {task === "events" && (
            <div className="space-y-3">
              <QqManagedMessageStream
                key={s.qqManagedEventsPage?.generation ?? "empty"}
                events={streamEvents}
                connected={s.qqConnection?.phase === "ready"}
                active={active}
                loading={s.qqManagedEventsLoading}
                error={s.qqManagedEventsError}
                onRefresh={() => void s.loadQqManagedEvents()}
                onClear={s.clearQqManagedEventsView}
              />
            </div>
          )}
          {task === "runtime" && (
            <>
              <TransportSettings active={active} view="runtime" />
              <QqJudgementModel active={active} managed />
              <QqMultimodalSettings active={active} />
            </>
          )}
        </>
      ) : s.qqAccessLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("connections.readingTheAccessState")}
        </p>
      ) : (
        // 读取失败不永远停在 loading：给出可重试入口；具体原因由页首统一显示。
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {t("connections.accessStateFailed")}
          </p>
          <Button
            tooltip={<Trans i18nKey="hints.complete.qqRefresh" />}
            variant="outline"
            size="sm"
            onClick={() => void loadQqAccess()}
          >
            {t("capabilities.retry")}
          </Button>
        </div>
      )}
    </div>
  );
}
