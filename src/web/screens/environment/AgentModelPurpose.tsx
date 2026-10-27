import { Cpu, Save, Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ConfirmDialog } from "@/components/confirmation";
import { Field } from "@/components/form-field";
import { SettingsGroup } from "@/components/settings-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputSuggestions } from "@/components/ui/input-suggestions";
import { dirtyPages } from "@/features/agents/page-drafts";
import { translateNotice } from "@/i18n";
import type { AgentDraft } from "@/state/types";
import { useSuperstringStore } from "@/store";

export function AgentModelPurpose({
  active = true,
  embedded = false,
}: {
  active?: boolean;
  embedded?: boolean;
} = {}) {
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
  const applyTarget = useRef<string | null>(null);

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
    ["context_compression_model_name", "library.context.compression.model"],
  ] as const;

  const modelSuggestions = s.modelNames.map((name) => ({
    value: name,
    label: name,
    description: s.loadedModelNames.includes(name)
      ? t("library.loaded")
      : s.externalModelNames.includes(name)
        ? t("library.external")
        : undefined,
  }));

  return (
    <div className="space-y-6">
      <SettingsGroup
        title={t("library.model.roles")}
        description={t("library.choose.a.model.for.each.task.manage.connections.in")}
        icon={Cpu}
        className={embedded ? "[&>div:first-child]:px-0" : undefined}
        containerClassName={
          embedded ? "bg-transparent border-0 divide-y-0 rounded-none shadow-none" : undefined
        }
      >
        {modelFields.map(([key, label]) => {
          return (
            <div key={key} className={embedded ? "py-2 px-0" : "p-4 sm:p-5"}>
              <Field label={label} tooltip={t("hints.agent.fieldModelName")}>
                <InputSuggestions
                  suggestions={modelSuggestions}
                  value={d[key] ?? ""}
                  placeholder={key === "model_name" ? undefined : t("library.unset")}
                  onValueChange={(value) =>
                    s.patchPageAgent("models", {
                      [key]: key === "model_name" ? value : value || null,
                    } as Partial<AgentDraft>)
                  }
                />
              </Field>
            </div>
          );
        })}

        <div className={embedded ? "py-2 px-0" : "p-4 sm:p-5"}>
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

        <div
          className={
            embedded
              ? "space-y-4 rounded-[10px] border border-border bg-muted/15 p-4 sm:p-5 mt-2"
              : "space-y-4 bg-muted/15 p-4 sm:p-5"
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="h-auto min-h-9 max-w-full whitespace-normal break-words"
              disabled={!defaultModel || alreadyDefault || s.settingsSaving}
              tooltip={t("hints.agent.defaults")}
              disabledReason={t("hints.agent.defaultsDisabled")}
              onClick={() => {
                applyTarget.current = defaultModel ?? null;
                setConfirmDefault(true);
              }}
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

          {!embedded && (
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
          )}
        </div>
      </SettingsGroup>

      <ConfirmDialog
        open={confirmDefault && Boolean(defaultModel)}
        message={t("library.models.apply.confirm", {
          "0": editor.agent.name,
          "1": defaultModel ?? applyTarget.current ?? t("library.unset"),
        })}
        onCancel={() => setConfirmDefault(false)}
        onConfirm={() => {
          const target = defaultModel ?? applyTarget.current;
          if (!target) return;
          return s.applyDefaultModelToAgent(target).then((ok) => {
            if (ok) setConfirmDefault(false);
          });
        }}
      />
    </div>
  );
}
