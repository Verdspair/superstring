import { ImageIcon, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { InputSuggestions } from "../../components/ui/input-suggestions";
import { organizationDirty } from "../../features/knowledge/types";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { QqJudgementModel } from "../environment/model-defaults";
import { AllocationModelCapacity } from "./AllocationModelCapacity";
import { ContextAllocationAuxiliary } from "./ContextAllocationAuxiliary";
import { QqConversationEntry } from "./QqConversationEntry";
import {
  QqManagedComponentCard,
  type QqManagedPhase,
  type QqManagedStatus,
} from "./QqManagedComponentCard";
import { TransportSettings } from "./transport-settings";

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
  const [auxiliaryValidity, setAuxiliaryValidity] = useState({
    agentValid: true,
    globalValid: true,
  });
  // QQ 页挂载时的 loadOrganization 由 QqConnectionTab 的 active gate 统一触发；本组件只读编辑器。
  const mediaRoles = QQ_MEDIA_GLOBAL_ROLES;
  const modelSuggestions = s.modelNames.map((name) => ({ value: name }));
  // 两个角色共用已存的图片理解模型：容量只读一次。晚到响应按 api/model/active 身份丢弃。
  const savedVisionModel = editor?.source.vision_model_name ?? null;
  const [visionCapacity, setVisionCapacity] = useState<{
    api: typeof s.apiClient;
    model: string;
    capacity: number | null;
  } | null>(null);
  useEffect(() => {
    if (!active || !savedVisionModel) return;
    const api = s.apiClient;
    let current = true;
    void api
      .getModelCapacity(savedVisionModel)
      .then((value) => {
        if (current && useSuperstringStore.getState().apiClient === api)
          setVisionCapacity({ api, model: savedVisionModel, capacity: value.context_length });
      })
      .catch(() => {
        if (current && useSuperstringStore.getState().apiClient === api)
          setVisionCapacity({ api, model: savedVisionModel, capacity: null });
      });
    return () => {
      current = false;
    };
  }, [active, savedVisionModel, s.apiClient]);
  const savedVisionCapacity =
    visionCapacity &&
    visionCapacity.api === s.apiClient &&
    visionCapacity.model === savedVisionModel
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
        description={t("qq.models.hint")}
        icon={ImageIcon}
      >
        {editor && (
          <>
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
                placeholder={t("models.followDefault")}
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
                placeholder={t("models.followDefault")}
                disabled={s.settingsSaving || s.organizationLoading}
                aria-label={t("models.purpose.transcription")}
                onValueChange={(value) =>
                  s.patchOrganizationPurposes({ transcriptionModelName: value || null })
                }
                className="w-full sm:w-64 sm:min-w-56"
              />
            </SettingsRow>
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
          <div className="p-4 sm:p-5">
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
            inheritPlaceholder: t("schemes.allocation.aux.inheritPlaceholder"),
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

export function QqConnectionTab({ active = true }: { active?: boolean } = {}) {
  const { t } = useTranslation();
  const s = useSuperstringStore(
    useShallow((state) => ({
      loadQqAccess: state.loadQqAccess,
      loadOrganization: state.loadOrganization,
      loadQqManaged: state.loadQqManaged,
      patchQqManagedDraft: state.patchQqManagedDraft,
      qqAccessLoading: state.qqAccessLoading,
      qqAccessSaving: state.qqAccessSaving,
      qqConnection: state.qqConnection,
      managedDraft: state.qqInputs.managed,
      qqManagedConfig: state.qqManagedConfig,
      qqManagedError: state.qqManagedError,
      qqManagedLoading: state.qqManagedLoading,
      qqManagedSaving: state.qqManagedSaving,
      qqManagedStatus: state.qqManagedStatus,
      qqManagedQrPayload: state.qqManagedQrPayload,
      retryQqManaged: state.retryQqManaged,
      getQqManagedQr: state.getQqManagedQr,
      refreshQqManagedQr: state.refreshQqManagedQr,
      clearQqManagedQr: state.clearQqManagedQr,
      qqSettings: state.qqSettings,
      refreshQqConnection: state.refreshQqConnection,
      refreshQqManaged: state.refreshQqManaged,
      saveQqManagedConfig: state.saveQqManagedConfig,
    })),
  );
  const { loadQqAccess, loadOrganization, loadQqManaged, clearQqManagedQr } = s;
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await Promise.all([s.refreshQqConnection(), s.refreshQqManaged()]);
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    if (!active) {
      clearQqManagedQr();
      return;
    }
    // 整页读取是进入连接页的起载：只读设置与状态，绝不自动推进连接草稿的保存基线。
    void loadQqAccess();
    void loadQqManaged();
    // QQ 多模态模型与辅助额度共用的组织编辑器：加载失败不伪装成「已停用」。
    void loadOrganization();
  }, [active, loadQqAccess, loadOrganization, loadQqManaged, clearQqManagedQr]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearQqManagedQr();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [clearQqManagedQr]);

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

  if (managedStatus) {
    if (managedStatus.apply === "ready") {
      runtimeGatePassed = true;
      phase = managedStatus.phase;
      ownership = managedStatus.ownership;
      diagnosticCode = managedStatus.diagnostic_code;
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
  }

  const cardStatus: QqManagedStatus = {
    managedEnabled,
    phase,
    accountId: s.qqSettings?.account_id ?? null,
    qrPayload: s.qqManagedQrPayload,
    runtimeGatePassed,
    diagnosticCode,
    ownership,
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6" data-workspace-scroll>
      {s.qqSettings ? (
        <>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/80 bg-card/60 p-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2.5">
              <Badge
                variant={s.qqConnection?.phase === "ready" ? "secondary" : "outline"}
                className="rounded-md px-2 py-0.5 font-medium"
              >
                {s.qqConnection
                  ? t(connectionPhaseLabels[s.qqConnection.phase] ?? "connections.unknown")
                  : t("connections.unknown")}
              </Badge>
              <p className="text-xs text-muted-foreground">{t("connections.transportPage.hint")}</p>
            </div>
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
            <QqConversationEntry />
          </div>
          <div className="mb-6 space-y-2">
            <QqManagedComponentCard
              status={cardStatus}
              loading={s.qqManagedLoading}
              saving={s.qqManagedSaving}
              onToggleManaged={(enabled) => s.patchQqManagedDraft(enabled)}
              onRefreshQr={() =>
                void (s.qqManagedQrPayload ? s.refreshQqManagedQr() : s.getQqManagedQr())
              }
              onRetry={() => void s.retryQqManaged()}
            />
            {s.qqManagedError && (
              <p role="alert" className="text-sm text-destructive">
                {t("connections.managed.diag.unknown")}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 px-1">
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
            </div>
          </div>
          <TransportSettings active={active} />
          <div className="mt-6">
            <QqJudgementModel active={active} managed />
          </div>
          <div className="mt-6">
            <QqMultimodalSettings active={active} />
          </div>
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
