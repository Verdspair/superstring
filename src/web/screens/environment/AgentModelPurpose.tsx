import { Cpu, Save, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ConfirmDialog } from "@/components/confirmation";
import { Field } from "@/components/form-field";
import { SettingsGroup } from "@/components/settings-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dirtyPages } from "@/features/agents/page-drafts";
import { translateNotice } from "@/i18n";
import type { AgentDraft } from "@/state/types";
import { useSuperstringStore } from "@/store";

export function AgentModelPurpose({ active = true }: { active?: boolean } = {}) {
  const s = useSuperstringStore(
    useShallow((state) => ({
      pageEditor: state.pageEditor,
      loadOrganization: state.loadOrganization,
      organizationEditor: state.organizationEditor,
      modelNames: state.modelNames,
      loadedModelNames: state.loadedModelNames,
      externalModelNames: state.externalModelNames,
      modelStatus: state.modelStatus,
      settingsSaving: state.settingsSaving,
      patchPageAgent: state.patchPageAgent,
      refreshModels: state.refreshModels,
      applyDefaultModelToAgent: state.applyDefaultModelToAgent,
      saveSettingsPage: state.saveSettingsPage,
      discardSettingsPages: state.discardSettingsPages,
    })),
  );
  const { t } = useTranslation();
  const [confirmDefault, setConfirmDefault] = useState(false);

  useEffect(() => {
    if (active) void s.loadOrganization();
  }, [active, s.loadOrganization]);

  const editor = s.pageEditor;
  if (!editor) return null;

  const defaultModel = s.organizationEditor?.modelName;
  const alreadyDefault =
    !!defaultModel &&
    [
      editor.draft.model_name,
      editor.draft.memory_consolidation_model_name,
      editor.draft.context_compression_model_name,
    ].every((name) => name === defaultModel);

  const d = editor.draft;
  const isDirty = dirtyPages(editor).includes("models");

  const modelFields = [
    ["model_name", "library.chat.model"],
    ["memory_consolidation_model_name", "library.memory.organization.model"],
    ["memory_retrieval_model_name", "library.memory.reading.model"],
    ["context_compression_model_name", "library.context.compression.model"],
  ] as const;

  return (
    <div className="space-y-6">
      <SettingsGroup
        title={t("library.model.roles")}
        description={t("library.choose.a.model.for.each.task.manage.connections.in")}
        icon={Cpu}
      >
        {modelFields.map(([key, label]) => (
          <div key={key} className="p-4 sm:p-5">
            <Field label={label} tooltip={t("hints.agent.fieldModelName")}>
              <Input
                list={`agent-model-${key}`}
                value={d[key] ?? ""}
                placeholder={key === "model_name" ? undefined : t("library.unset")}
                onChange={(e) =>
                  s.patchPageAgent("models", {
                    [key]: key === "model_name" ? e.target.value : e.target.value || null,
                  } as Partial<AgentDraft>)
                }
              />
              <datalist id={`agent-model-${key}`}>
                {[...new Set([d[key], ...s.modelNames])]
                  .filter((name): name is string => !!name)
                  .map((name) => (
                    <option key={name} value={name}>
                      {s.loadedModelNames.includes(name)
                        ? t("library.loaded")
                        : s.externalModelNames.includes(name)
                          ? t("library.external")
                          : name}
                    </option>
                  ))}
              </datalist>
            </Field>
          </div>
        ))}

        <div className="p-4 sm:p-5">
          <Field label="library.temperature" tooltip={t("hints.agent.fieldTemperature")}>
            <Input
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={d.temperature}
              onChange={(e) => s.patchPageAgent("models", { temperature: Number(e.target.value) })}
            />
          </Field>
        </div>

        <div className="space-y-4 bg-muted/15 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="h-auto min-h-9 max-w-full whitespace-normal break-words"
              disabled={!defaultModel || alreadyDefault || s.settingsSaving}
              tooltip={t("hints.agent.defaults")}
              disabledReason={t("hints.agent.defaultsDisabled")}
              onClick={() => setConfirmDefault(true)}
            >
              {t("library.models.apply.default", { "0": defaultModel ?? t("library.unset") })}
            </Button>
            <Button
              variant="outline"
              tooltip={t("hints.agent.refreshModels")}
              onClick={() => void s.refreshModels()}
            >
              {t("library.refresh.models")}
            </Button>
          </div>

          {s.modelStatus && (
            <p className="text-xs text-muted-foreground">{translateNotice(s.modelStatus)}</p>
          )}

          <div className="flex flex-col gap-3 border-t border-border/60 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">{t("models.agentModelSaveScope")}</p>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="outline"
                disabled={!isDirty || s.settingsSaving}
                tooltip={t("hints.agent.discard")}
                disabledReason={t("hints.agent.noModelsDirty")}
                onClick={() => s.discardSettingsPages("models")}
              >
                <Undo2 className="mr-1.5 size-4" />
                {t("workspace.discard")}
              </Button>
              <Button
                disabled={!isDirty || s.settingsSaving}
                tooltip={t("hints.agent.modelsSave")}
                disabledReason={t("hints.agent.modelsSaveDisabled")}
                onClick={() => void s.saveSettingsPage("models")}
              >
                <Save className="mr-1.5 size-4" />
                {t("workspace.save")}
              </Button>
            </div>
          </div>
        </div>
      </SettingsGroup>

      {confirmDefault && defaultModel && (
        <ConfirmDialog
          message={t("library.models.apply.confirm", { "0": editor.agent.name, "1": defaultModel })}
          onCancel={() => setConfirmDefault(false)}
          onConfirm={() => {
            return s.applyDefaultModelToAgent(defaultModel).then((ok) => {
              if (ok) setConfirmDefault(false);
            });
          }}
        />
      )}
    </div>
  );
}
