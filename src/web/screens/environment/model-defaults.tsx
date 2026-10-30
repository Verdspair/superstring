import { BookOpen, Bot, Layers } from "lucide-react";
import { useCallback, useEffect, useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { Button } from "../../components/ui/button";
import { InputSuggestions } from "../../components/ui/input-suggestions";
import { NativeSelect } from "../../components/ui/native-select";
import { knowledgeModelDirty, organizationDirty } from "../../features/knowledge/types";
import { translateNotice } from "../../i18n";
import { useForegroundRead } from "../../services/use-foreground-read";
import { useSuperstringStore } from "../../store";

export function ModelDefaults({
  active = true,
  scope = "organization",
  embedded = false,
}: {
  active?: boolean;
  embedded?: boolean;
  scope?: "organization" | "knowledge";
} = {}) {
  const { t } = useTranslation();
  const instanceId = useId();
  const defaultModelId = `${instanceId}-organization-model`;
  const knowledgeModelId = `${instanceId}-knowledge-model`;
  const defaultModelHintId = `${instanceId}-organization-model-hint`;
  const knowledgeModelHintId = `${instanceId}-knowledge-model-hint`;
  const state = useSuperstringStore(
    useShallow((state) => ({
      api: state.apiClient,
      acquireOrganizationRead: state.acquireOrganizationRead,
      releaseOrganizationRead: state.releaseOrganizationRead,
      acquireKnowledgeModelRead: state.acquireKnowledgeModelRead,
      releaseKnowledgeModelRead: state.releaseKnowledgeModelRead,
      discardOrganization: state.discardOrganization,
      knowledgeModelEditor: state.knowledgeModelEditor,
      knowledgeModelLoading: state.knowledgeModelLoading,
      knowledgeModelError: state.knowledgeModelError,
      loadKnowledgeModel: state.loadKnowledgeModel,
      loadOrganization: state.loadOrganization,
      modelNames: state.modelNames,
      organizationEditor: state.organizationEditor,
      organizationError: state.organizationError,
      organizationLoading: state.organizationLoading,
      patchKnowledgeModel: state.patchKnowledgeModel,
      patchOrganization: state.patchOrganization,
      saveKnowledgeModel: state.saveKnowledgeModel,
      saveOrganization: state.saveOrganization,
      settingsSaving: state.settingsSaving,
    })),
  );
  const { loadOrganization, loadKnowledgeModel, organizationEditor: editor } = state;
  const modelSuggestions = state.modelNames.map((name) => ({ value: name }));
  const organizationOwner = useMemo(() => ({ api: state.api }), [state.api]);
  const knowledgeOwner = useMemo(() => ({ api: state.api }), [state.api]);
  const releaseOrganization = useCallback(
    () => state.releaseOrganizationRead(organizationOwner),
    [state.releaseOrganizationRead, organizationOwner],
  );
  const load = useCallback(() => {
    if (useSuperstringStore.getState().apiClient !== state.api) return;
    if (scope === "organization") void state.acquireOrganizationRead(organizationOwner);
    else void state.acquireKnowledgeModelRead(knowledgeOwner);
  }, [
    scope,
    state.api,
    state.acquireOrganizationRead,
    organizationOwner,
    state.acquireKnowledgeModelRead,
    knowledgeOwner,
  ]);
  const releaseKnowledge = useCallback(
    () => state.releaseKnowledgeModelRead(knowledgeOwner),
    [state.releaseKnowledgeModelRead, knowledgeOwner],
  );
  const cancel = useCallback(() => {
    releaseOrganization();
    releaseKnowledge();
  }, [releaseOrganization, releaseKnowledge]);
  useForegroundRead(load, cancel, {
    paused: !active,
    intervalMs: null,
    retainOnHide: true,
    onSuspend: cancel,
  });

  return (
    <div className="w-full space-y-6">
      {scope === "organization" && (
        <SettingsGroup
          title={t("models.sharedDefaults")}
          description={t("models.defaultsHint")}
          icon={Layers}
        >
          {editor && (
            <>
              <SettingsRow
                label={
                  <label
                    htmlFor={defaultModelId}
                    className="cursor-pointer text-sm font-medium text-foreground"
                  >
                    {t("models.purpose.organization")}
                  </label>
                }
                description={t("models.purpose.organization.hint")}
                controlClassName="sm:flex-1"
              >
                <InputSuggestions
                  id={defaultModelId}
                  suggestions={modelSuggestions}
                  value={editor.modelName ?? ""}
                  placeholder={t("library.unset")}
                  aria-describedby={defaultModelHintId}
                  disabled={state.settingsSaving || state.organizationLoading}
                  aria-label={t("models.purpose.organization")}
                  onValueChange={(value) => state.patchOrganization(value || null)}
                  className="w-full sm:w-full sm:min-w-0"
                />
              </SettingsRow>
              <p id={defaultModelHintId} className="px-4 py-2 text-xs text-muted-foreground">
                {t("models.unsetHint")} {t("library.saved")}:{" "}
                {editor.source.model_name ?? t("models.followDefault")}
              </p>

              <div className="flex flex-wrap items-center justify-end gap-2 bg-muted/15 px-4 py-3">
                <Button
                  variant="outline"
                  tooltip={t("hints.system.discard")}
                  disabled={
                    state.settingsSaving || !organizationDirty(editor, "organization-model")
                  }
                  onClick={() => state.discardOrganization("organization-model")}
                >
                  {t("models.discard")}
                </Button>
                <Button
                  tooltip={t("hints.system.saveOrganizationDefault")}
                  disabled={
                    state.settingsSaving || !organizationDirty(editor, "organization-model")
                  }
                  onClick={() => void state.saveOrganization("organization-model")}
                >
                  {t("models.saveDefaults")}
                </Button>
              </div>
            </>
          )}

          {!editor && (
            <div className="settings-content-padding">
              <Button
                variant="outline"
                tooltip={t("hints.system.retryOrganizationDefault")}
                disabled={state.organizationLoading}
                onClick={() => void loadOrganization()}
              >
                {t(state.organizationLoading ? "models.loadingDefaults" : "models.retryDefaults")}
              </Button>
            </div>
          )}

          {state.organizationError && (
            <Button
              variant="outline"
              disabled={state.organizationLoading || state.settingsSaving}
              tooltip={t("hints.library.knowledge.refreshSettings")}
              onClick={() => void loadOrganization(true)}
            >
              {t("capabilities.resources.refreshBaseline")}
            </Button>
          )}
          {state.organizationError && (
            <div
              role="alert"
              className="border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            >
              {translateNotice(state.organizationError)}
            </div>
          )}
        </SettingsGroup>
      )}

      {scope === "knowledge" && (
        <SettingsGroup
          title={t("models.knowledgeOrganization")}
          description={t("models.knowledgeHint")}
          icon={BookOpen}
        >
          <SettingsRow
            label={
              <label
                htmlFor={knowledgeModelId}
                className="cursor-pointer text-sm font-medium text-foreground"
              >
                {t("models.knowledgeModel")}
              </label>
            }
            controlClassName="sm:flex-1"
          >
            <InputSuggestions
              id={knowledgeModelId}
              suggestions={modelSuggestions}
              value={state.knowledgeModelEditor?.modelName ?? ""}
              disabled={
                !state.knowledgeModelEditor || state.knowledgeModelLoading || state.settingsSaving
              }
              placeholder={t("models.inheritPlaceholder")}
              aria-label={t("models.knowledgeModel")}
              aria-describedby={knowledgeModelHintId}
              onValueChange={(value) => state.patchKnowledgeModel(value || null)}
              className="w-full sm:w-full sm:min-w-0"
            />
          </SettingsRow>

          <p id={knowledgeModelHintId} className="px-4 py-2 text-xs text-muted-foreground">
            {t("models.knowledgeInheritHint")}
          </p>
          {state.knowledgeModelEditor && (
            <p className="px-4 py-2 text-xs text-muted-foreground">
              {t("library.saved")}:{" "}
              {state.knowledgeModelEditor.source.model_name ?? t("models.followDefault")}
            </p>
          )}
          {!state.knowledgeModelEditor && (
            <div className="settings-content-padding">
              <Button
                variant="outline"
                tooltip={t("hints.system.retryKnowledgeModel")}
                disabled={state.knowledgeModelLoading}
                onClick={() => void loadKnowledgeModel()}
              >
                {t(
                  state.knowledgeModelLoading ? "models.loadingKnowledge" : "models.retryKnowledge",
                )}
              </Button>
            </div>
          )}

          {!embedded && state.knowledgeModelError.shared && (
            <p role="alert" className="px-4 py-3 text-sm text-destructive">
              {translateNotice(state.knowledgeModelError.shared)}
            </p>
          )}
          {(state.knowledgeModelError.model || (!embedded && state.knowledgeModelError.shared)) && (
            <div className="space-y-2 px-4 py-3">
              {state.knowledgeModelError.model && (
                <p role="alert" className="text-sm text-destructive">
                  {translateNotice(state.knowledgeModelError.model)}
                </p>
              )}
              <Button
                variant="outline"
                disabled={state.knowledgeModelLoading || state.settingsSaving}
                tooltip={t("hints.library.knowledge.refreshSettings")}
                onClick={() => void loadKnowledgeModel(true)}
              >
                {t("capabilities.resources.refreshBaseline")}
              </Button>
            </div>
          )}
          <div className="flex items-center justify-end bg-muted/15 px-4 py-3">
            <Button
              tooltip={t("hints.system.saveKnowledgeModel")}
              disabled={
                state.settingsSaving ||
                state.knowledgeModelLoading ||
                !knowledgeModelDirty(state.knowledgeModelEditor, "model")
              }
              onClick={() => void state.saveKnowledgeModel("model")}
            >
              {t("models.saveKnowledgeModel")}
            </Button>
          </div>
        </SettingsGroup>
      )}
    </div>
  );
}

export function QqJudgementModel({
  active = true,
  managed = false,
}: {
  active?: boolean;
  /** 父面板已统一读取 QQ 设置与报错时置 true：本组不再自读、不重复报错。 */
  managed?: boolean;
} = {}) {
  const { t } = useTranslation();
  const state = useSuperstringStore(
    useShallow((s) => ({
      qqSettings: s.qqSettings,
      qqAccessSaving: s.qqAccessSaving,
      modelNames: s.modelNames,
      saveQqJudgementModel: s.saveQqJudgementModel,
      loadQqSettings: s.loadQqSettings,
      error: s.error,
    })),
  );
  useEffect(() => {
    if (active && !managed) void state.loadQqSettings();
  }, [active, managed, state.loadQqSettings]);

  return (
    <SettingsGroup
      title={t("models.qqJudgement")}
      description={t("models.qqHint")}
      action={
        <span className="text-xs text-muted-foreground">
          {/* i18next-instrument-ignore-next-line */}
          QQ · {t("connections.judgementContext")}
        </span>
      }
      icon={Bot}
    >
      <SettingsRow
        label={
          <label
            htmlFor="qq-judgement-model-select"
            className="cursor-pointer text-sm font-medium text-foreground"
          >
            {t("models.purpose.judgement")}
          </label>
        }
        description={t("models.qqSaveTiming")}
      >
        <NativeSelect
          id="qq-judgement-model-select"
          aria-label={t("models.purpose.judgement")}
          value={state.qqSettings?.judgement_model_name ?? ""}
          disabled={!state.qqSettings || state.qqAccessSaving}
          onChange={(e) => void state.saveQqJudgementModel(e.target.value || null)}
          className="w-full sm:w-64 sm:min-w-56"
        >
          <option value="">{t("models.followBound")}</option>
          {[
            ...new Set([
              ...state.modelNames,
              ...(state.qqSettings?.judgement_model_name
                ? [state.qqSettings.judgement_model_name]
                : []),
            ]),
          ].map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </NativeSelect>
      </SettingsRow>

      {!state.qqSettings && !managed && (
        <div className="settings-content-padding">
          <Button
            variant="outline"
            tooltip={t("hints.system.qqJudgementRetry")}
            onClick={() => void state.loadQqSettings()}
          >
            {t("models.retryQqSettings")}
          </Button>
        </div>
      )}

      {state.qqSettings?.enabled === false && (
        <div className="border-t border-border/60 bg-muted/10 px-4 py-3 text-xs text-muted-foreground">
          {t("models.qqDisabled")}
        </div>
      )}

      {state.error && !managed && (
        <div
          role="alert"
          className="border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {translateNotice(state.error)}
        </div>
      )}
    </SettingsGroup>
  );
}
