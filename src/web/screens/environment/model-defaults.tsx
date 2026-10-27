import { BookOpen, Bot, Layers } from "lucide-react";
import { useEffect, useId } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { Button } from "../../components/ui/button";
import { InputSuggestions } from "../../components/ui/input-suggestions";
import { NativeSelect } from "../../components/ui/native-select";
import { knowledgeModelDirty, organizationDirty } from "../../features/knowledge/types";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";

export function ModelDefaults({
  active = true,
  scope = "organization",
}: {
  active?: boolean;
  scope?: "organization" | "knowledge";
} = {}) {
  const { t } = useTranslation();
  const instanceId = useId();
  const defaultModelId = `${instanceId}-organization-model`;
  const knowledgeModelId = `${instanceId}-knowledge-model`;
  const state = useSuperstringStore(
    useShallow((state) => ({
      discardOrganization: state.discardOrganization,
      knowledgeModelEditor: state.knowledgeModelEditor,
      knowledgeModelLoading: state.knowledgeModelLoading,
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
  useEffect(() => {
    if (!active) return;
    if (scope === "organization") void loadOrganization();
    else void loadKnowledgeModel();
  }, [active, scope, loadOrganization, loadKnowledgeModel]);

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
              >
                <InputSuggestions
                  id={defaultModelId}
                  suggestions={modelSuggestions}
                  value={editor.modelName ?? ""}
                  placeholder={t("models.followDefault")}
                  disabled={state.settingsSaving || state.organizationLoading}
                  aria-label={t("models.purpose.organization")}
                  onValueChange={(value) => state.patchOrganization(value || null)}
                  className="w-full sm:w-64 sm:min-w-56"
                />
              </SettingsRow>

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
            <div className="p-4 sm:p-5">
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
          >
            <InputSuggestions
              id={knowledgeModelId}
              suggestions={modelSuggestions}
              value={state.knowledgeModelEditor?.modelName ?? ""}
              disabled={
                !state.knowledgeModelEditor || state.knowledgeModelLoading || state.settingsSaving
              }
              placeholder={t("models.followDefault")}
              aria-label={t("models.knowledgeModel")}
              onValueChange={(value) => state.patchKnowledgeModel(value || null)}
              className="w-full sm:w-64 sm:min-w-56"
            />
          </SettingsRow>

          {!state.knowledgeModelEditor && (
            <div className="p-4 sm:p-5">
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
        <div className="p-4 sm:p-5">
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
