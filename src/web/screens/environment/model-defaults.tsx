import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "../../components/form-field";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import { knowledgeModelDirty, organizationDirty } from "../../features/knowledge/types";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";

export function ModelDefaults() {
  const { t } = useTranslation();
  const state = useSuperstringStore();
  const {
    loadOrganization,
    loadQqSettings,
    loadKnowledgeModel,
    organizationEditor: editor,
  } = state;
  useEffect(() => {
    void loadOrganization();
    void loadQqSettings();
    void loadKnowledgeModel();
  }, [loadOrganization, loadQqSettings, loadKnowledgeModel]);
  return (
    <div className="mx-auto max-w-4xl space-y-8 px-6 py-7">
      <section className="space-y-6">
        <div>
          <h2 className="font-semibold">{t("models.sharedDefaults")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("models.defaultsHint")}</p>
        </div>
        <datalist id="workspace-model-catalog">
          {state.modelNames.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {editor && (
          <>
            <div className="grid gap-6 sm:grid-cols-2">
              {(
                [
                  ["modelName", "organization"],
                  ["visionModelName", "vision"],
                  ["transcriptionModelName", "transcription"],
                ] as const
              ).map(([field, label]) => (
                <Field
                  key={field}
                  label={`models.purpose.${label}`}
                  info={`models.purpose.${label}.hint`}
                >
                  <Input
                    list="workspace-model-catalog"
                    value={editor[field] ?? ""}
                    placeholder={t("models.followDefault")}
                    disabled={state.settingsSaving || state.organizationLoading}
                    onChange={(e) =>
                      state.patchOrganizationPurposes({ [field]: e.target.value || null })
                    }
                  />
                </Field>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={state.settingsSaving || !organizationDirty(editor)}
                onClick={() => {
                  state.discardOrganization();
                  void state.loadOrganization();
                }}
              >
                {t("models.discard")}
              </Button>
              <Button
                disabled={state.settingsSaving || !organizationDirty(editor)}
                onClick={() => void state.saveOrganization()}
              >
                {t("models.saveDefaults")}
              </Button>
            </div>
          </>
        )}
        {!editor && (
          <Button
            variant="outline"
            disabled={state.organizationLoading}
            onClick={() => void loadOrganization()}
          >
            {t(state.organizationLoading ? "models.loadingDefaults" : "models.retryDefaults")}
          </Button>
        )}
        {state.organizationError && (
          <p role="alert" className="text-sm text-destructive">
            {translateNotice(state.organizationError)}
          </p>
        )}
      </section>
      <section className="space-y-5 border-t pt-6">
        <h2 className="font-semibold">{t("models.knowledgeOrganization")}</h2>
        <Field label="models.knowledgeModel" info="models.knowledgeHint">
          <Input
            list="workspace-model-catalog"
            value={state.knowledgeModelEditor?.modelName ?? ""}
            disabled={
              !state.knowledgeModelEditor || state.knowledgeModelLoading || state.settingsSaving
            }
            placeholder={t("models.followDefault")}
            onChange={(event) => state.patchKnowledgeModel(event.target.value || null)}
          />
        </Field>
        {!state.knowledgeModelEditor && (
          <Button
            variant="outline"
            disabled={state.knowledgeModelLoading}
            onClick={() => void loadKnowledgeModel()}
          >
            {t(state.knowledgeModelLoading ? "models.loadingKnowledge" : "models.retryKnowledge")}
          </Button>
        )}
        <div className="flex justify-end">
          <Button
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
      </section>
      <section className="space-y-5 border-t pt-6">
        <div>
          <h2 className="font-semibold">{t("models.qqJudgement")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("models.qqHint")}</p>
        </div>
        <Field label="models.purpose.judgement">
          <NativeSelect
            value={state.qqSettings?.judgement_model_name ?? ""}
            disabled={!state.qqSettings || state.qqAccessSaving}
            onChange={(e) => void state.saveQqJudgementModel(e.target.value || null)}
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
        </Field>
        {!state.qqSettings && (
          <Button variant="outline" onClick={() => void state.loadQqSettings()}>
            {t("models.retryQqSettings")}
          </Button>
        )}
        {state.qqSettings?.enabled === false && (
          <p className="text-xs text-muted-foreground">{t("models.qqDisabled")}</p>
        )}
        {state.error && (
          <p role="alert" className="text-sm text-destructive">
            {translateNotice(state.error)}
          </p>
        )}
      </section>
      <section className="space-y-3 border-t pt-6">
        <h2 className="font-semibold">{t("models.agentModels")}</h2>
        <p className="text-sm text-muted-foreground">{t("models.agentModelsHint")}</p>
        <Button variant="outline" onClick={state.openAgentSettings}>
          {t("models.openAgents")}
        </Button>
      </section>
    </div>
  );
}
