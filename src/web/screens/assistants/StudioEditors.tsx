import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/confirmation";
import { Field } from "@/components/form-field";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { translateNotice } from "@/i18n";
import type { AgentDraft } from "@/state/types";
import { useSuperstringStore } from "@/store";
import { compilePersona } from "../../../shared/contracts/persona-compile";

export function IdentityEditor() {
  const s = useSuperstringStore();
  const t = useTranslation().t;
  const editor = s.pageEditor;
  if (!editor) return null;
  const { draft, personaDraft: persona } = editor;
  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(260px,.6fr)]">
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("library.basic.identity")}</CardTitle>
            <CardDescription>
              {t("library.the.name.identifies.your.agent.personality.shapes.how.it")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field label="library.name">
              <Input
                value={draft.name}
                onChange={(e) => s.patchPageAgent("basic", { name: e.target.value })}
              />
            </Field>
            <Field label="library.description">
              <Textarea
                value={draft.description}
                onChange={(e) => s.patchPageAgent("basic", { description: e.target.value })}
              />
            </Field>
            <Field label="library.enable.agent">
              <Checkbox
                checked={draft.is_active}
                onCheckedChange={(v) => s.patchPageAgent("basic", { is_active: v === true })}
              />
            </Field>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("library.personality.expression")}</CardTitle>
            <CardDescription>
              {t("library.all.fields.are.optional.the.preview.uses.the.actual")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {(
              [
                ["core_identity", "library.core.identity", "identity"],
                ["interaction_boundaries", "library.interaction.boundaries", "identity"],
                ["communication_style", "library.communication.style", "expression"],
                ["example_dialogues", "library.example.dialogues", "expression"],
                ["advanced_instructions", "library.advanced.instructions", "identity"],
              ] as const
            ).map(([key, label, page]) => (
              <Field key={key} label={label}>
                <Textarea
                  rows={key === "example_dialogues" ? 5 : 3}
                  value={persona[key]}
                  onChange={(e) => s.patchPagePersona(page, { [key]: e.target.value })}
                />
              </Field>
            ))}
            <Field
              label="library.personality.strength"
              info="library.only.changes.how.much.communication.style.and.example.dialogue"
            >
              <Slider
                disabled={s.settingsSaving}
                min={0}
                max={100}
                step={1}
                value={[draft.persona_intensity]}
                onValueChange={(v) =>
                  s.patchPageAgent("expression", {
                    persona_intensity: v[0] ?? draft.persona_intensity,
                  })
                }
              />
              <output className="text-sm tabular-nums">{draft.persona_intensity}%</output>
            </Field>
            <Field label="library.additional.instructions">
              <Textarea
                rows={4}
                value={draft.additional_instructions}
                onChange={(e) =>
                  s.patchPageAgent("identity", { additional_instructions: e.target.value })
                }
              />
            </Field>
          </CardContent>
        </Card>
      </div>
      <Card className="xl:sticky xl:top-6">
        <CardHeader>
          <CardTitle>{t("library.personality.preview")}</CardTitle>
          <CardDescription>
            {t("library.actual.compiled.text.no.model.request.is.made")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[65dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-mono text-xs leading-relaxed">
            {compilePersona(persona, draft.persona_intensity) ||
              t("library.no.personality.defined")}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

export function CapabilityEditor() {
  const s = useSuperstringStore();
  const t = useTranslation().t;
  const editor = s.pageEditor;
  const [confirmDefault, setConfirmDefault] = useState(false);
  useEffect(() => {
    void s.loadOrganization();
  }, [s.loadOrganization]);
  const modelName = editor?.draft.model_name;
  const retrievalModel = editor?.draft.memory_retrieval_model_name;
  const compressionModel = editor?.draft.context_compression_model_name;
  useEffect(() => {
    if (s.editorAgentId !== "__new__" && modelName)
      void s.refreshCapacityPreview([modelName, retrievalModel ?? null, compressionModel ?? null]);
  }, [s.editorAgentId, modelName, retrievalModel, compressionModel, s.refreshCapacityPreview]);
  if (!editor) return null;
  const defaultModel = s.organizationEditor?.modelName;
  const alreadyDefault =
    !!defaultModel &&
    [
      editor.draft.model_name,
      editor.draft.memory_retrieval_model_name,
      editor.draft.memory_consolidation_model_name,
      editor.draft.context_compression_model_name,
    ].every((name) => name === defaultModel);
  const d = editor.draft;
  const p5 = d.p5_config;
  const patch = (value: Partial<typeof p5>) =>
    s.patchPageAgent("context", { p5_config: { ...p5, ...value } });
  const modelFields = [
    ["model_name", "library.chat.model"],
    ["memory_retrieval_model_name", "library.memory.reading.model"],
    ["memory_consolidation_model_name", "library.memory.organization.model"],
    ["context_compression_model_name", "library.context.compression.model"],
  ] as const;
  const numberField = (key: keyof typeof p5, label: string, min: number, max: number, step = 1) => (
    <Field key={key} label={label}>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={typeof p5[key] === "number" ? (p5[key] as number) : ""}
        onChange={(e) => patch({ [key]: e.target.value === "" ? null : Number(e.target.value) })}
      />
    </Field>
  );
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("library.model.roles")}</CardTitle>
          <CardDescription>
            {t("library.choose.a.model.for.each.task.manage.connections.in")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {modelFields.map(([key, label]) => (
            <Field key={key} label={label}>
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
          ))}
          <Field label="library.temperature">
            <Input
              type="number"
              min={0}
              max={2}
              step={0.05}
              value={d.temperature}
              onChange={(e) => s.patchPageAgent("models", { temperature: Number(e.target.value) })}
            />
          </Field>
          <Button
            variant="outline"
            disabled={!defaultModel || alreadyDefault || s.settingsSaving}
            onClick={() => setConfirmDefault(true)}
          >
            {t("library.models.apply.default", { "0": defaultModel ?? t("library.unset") })}
          </Button>
          <Button variant="outline" onClick={() => void s.refreshModels()}>
            {t("library.refresh.models")}
          </Button>
          <p className="text-xs text-muted-foreground">{translateNotice(s.modelStatus)}</p>
        </CardContent>
      </Card>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("library.context.capacity")}</CardTitle>
            <CardDescription>
              {translateNotice(s.capacityPreview) || t("library.reading.capacity")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            {numberField(
              "context_window",
              "library.context.window.blank.for.automatic",
              1024,
              1048576,
            )}
            {numberField("max_output_tokens", "library.maximum.output.tokens", 1, 1048576)}
            {numberField("safety_margin_ratio", "library.safety.margin.ratio", 0, 0.99, 0.01)}
            {numberField(
              "auxiliary_timeout_seconds",
              "library.auxiliary.task.timeout.seconds",
              1,
              3600,
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("library.long.conversation.management")}</CardTitle>
            <CardDescription>
              {t("library.keep.recent.turns.and.compress.earlier.content.into.a")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <Field label="library.enable.context.compression">
              <Checkbox
                checked={p5.compression_enabled}
                onCheckedChange={(v) => patch({ compression_enabled: v === true })}
              />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              {numberField(
                "compression_trigger_ratio",
                "library.compression.threshold.ratio",
                0.01,
                1,
                0.01,
              )}
              {numberField("recent_turns", "library.recent.turns.to.retain", 1, 10000)}
            </div>
            <Accordion type="single" collapsible>
              <AccordionItem value="budgets">
                <AccordionTrigger>{t("library.summary.budgets")}</AccordionTrigger>
                <AccordionContent className="grid gap-5 pt-3 sm:grid-cols-2">
                  {numberField(
                    "summary_target_tokens",
                    "library.target.summary.tokens",
                    1,
                    1048576,
                  )}
                  {numberField("summary_max_tokens", "library.maximum.summary.tokens", 1, 1048576)}
                  {numberField(
                    "summary_read_max_tokens",
                    "library.summary.reading.limit.blank.to.inherit",
                    1,
                    1048576,
                  )}
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      </div>
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
