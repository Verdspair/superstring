import { RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { type MouseEvent, useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { EXECUTION_MODULE_KEYS } from "../../../shared/contracts/permissions";
import { Field } from "../../components/form-field";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { permissionSettingsDirty } from "../../features/access/permission-state";
import type { ExecutionDraft, ExecutionDraftKey } from "../../features/runs/execution-draft";
import { useSuperstringStore } from "../../store";

interface NumericField {
  key: ExecutionDraftKey;
  label: string;
  info: string;
}

const taskFields: NumericField[] = [
  {
    key: "tasksConcurrency",
    label: "connections.execution.tasksConcurrency",
    info: "connections.execution.tasksConcurrencyHint",
  },
  {
    key: "tasksRetentionHours",
    label: "connections.execution.tasksRetentionHours",
    info: "connections.execution.tasksRetentionHoursHint",
  },
  {
    key: "tasksLeaseSeconds",
    label: "connections.execution.tasksLeaseSeconds",
    info: "connections.execution.tasksLeaseSecondsHint",
  },
  {
    key: "tasksPollMs",
    label: "connections.execution.tasksPollMs",
    info: "connections.execution.tasksPollMsHint",
  },
];
const researchFields: NumericField[] = [
  {
    key: "researchMaxPerRun",
    label: "connections.execution.researchMaxPerRun",
    info: "connections.execution.researchMaxPerRunHint",
  },
  {
    key: "researchMaxSteps",
    label: "connections.execution.researchMaxSteps",
    info: "connections.execution.researchMaxStepsHint",
  },
  {
    key: "researchDeadlineMs",
    label: "connections.execution.researchDeadlineMs",
    info: "connections.execution.researchDeadlineMsHint",
  },
  {
    key: "researchMaxConclusionChars",
    label: "connections.execution.researchMaxConclusionChars",
    info: "connections.execution.researchMaxConclusionCharsHint",
  },
];
const codeFields: NumericField[] = [
  {
    key: "codeConcurrency",
    label: "connections.execution.codeConcurrency",
    info: "connections.execution.codeConcurrencyHint",
  },
  {
    key: "codeTimeoutMs",
    label: "connections.execution.codeTimeoutMs",
    info: "connections.execution.codeTimeoutMsHint",
  },
  {
    key: "codeMaxCalls",
    label: "connections.execution.codeMaxCalls",
    info: "connections.execution.codeMaxCallsHint",
  },
  {
    key: "codeMemoryMiB",
    label: "connections.execution.codeMemoryMiB",
    info: "connections.execution.codeMemoryMiBHint",
  },
  {
    key: "codeTransferKiB",
    label: "connections.execution.codeTransferKiB",
    info: "connections.execution.codeTransferKiBHint",
  },
  {
    key: "codeMaxConclusionChars",
    label: "connections.execution.codeMaxConclusionChars",
    info: "connections.execution.codeMaxConclusionCharsHint",
  },
];
const loopFields: NumericField[] = [
  {
    key: "loopMaxSteps",
    label: "connections.execution.loopMaxSteps",
    info: "connections.execution.loopMaxStepsHint",
  },
  {
    key: "loopReadBatch",
    label: "connections.execution.loopReadBatch",
    info: "connections.execution.loopReadBatchHint",
  },
  {
    key: "loopNoProgress",
    label: "connections.execution.loopNoProgress",
    info: "connections.execution.loopNoProgressHint",
  },
  {
    key: "loopConcurrency",
    label: "connections.execution.loopConcurrency",
    info: "connections.execution.loopConcurrencyHint",
  },
  {
    key: "loopModelConcurrency",
    label: "connections.execution.loopModelConcurrency",
    info: "connections.execution.loopModelConcurrencyHint",
  },
  {
    key: "loopProviderConcurrency",
    label: "connections.execution.loopProviderConcurrency",
    info: "connections.execution.loopProviderConcurrencyHint",
  },
];
const qqFields: NumericField[] = [
  {
    key: "qqRetryDelayMs",
    label: "connections.execution.qqRetryDelayMs",
    info: "connections.execution.qqRetryDelayMsHint",
  },
  {
    key: "qqMaxAttempts",
    label: "connections.execution.qqMaxAttempts",
    info: "connections.execution.qqMaxAttemptsHint",
  },
  {
    key: "qqDeliveryTtlSeconds",
    label: "connections.execution.qqDeliveryTtlSeconds",
    info: "connections.execution.qqDeliveryTtlSecondsHint",
  },
];

/** 页内锚点与卡片一一对应：标题和导航复用同一份标签，顺序即页面顺序。 */
const SECTIONS = {
  switches: "connections.execution.switches",
  maintenance: "connections.execution.maintenance",
  tasks: "connections.execution.tasks",
  research: "connections.execution.researchGroup",
  code: "connections.execution.codeGroup",
  loop: "connections.execution.loop",
  qq: "connections.execution.qq",
} as const;
type SectionKey = keyof typeof SECTIONS;
const SECTION_ORDER: SectionKey[] = [
  "switches",
  "maintenance",
  "tasks",
  "research",
  "code",
  "loop",
  "qq",
];

export function ExecutionSettings() {
  const { t } = useTranslation();
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const editor = useSuperstringStore((s) => s.permissionEditor);
  const loading = useSuperstringStore((s) => s.permissionLoading);
  const saving = useSuperstringStore((s) => s.permissionSaving);
  const problem = useSuperstringStore((s) => s.permissionProblem);
  const error = useSuperstringStore((s) => s.permissionError);
  const notice = useSuperstringStore((s) =>
    s.permissionNotice === "connections.execution.saved" ? s.permissionNotice : "",
  );
  const load = useSuperstringStore((s) => s.loadPermissionSettings);
  const save = useSuperstringStore((s) => s.savePermissionSettings);
  const discard = useSuperstringStore((s) => s.discardPermissionSettings);
  const update = useSuperstringStore((s) => s.patchExecutionSettings);
  useEffect(() => {
    void load();
  }, [load]);
  const draft = editor?.execution;
  const dirty = permissionSettingsDirty(editor, "execution");
  const patch = (key: keyof ExecutionDraft, value: string | boolean) => update({ [key]: value });
  // 同一屏幕可能被渲染多份：锚点 id 用 useId 派生，实例之间不冲突。
  const panelId = (section: SectionKey) => `${uid}execution-${section}`;
  const jumpToSection = (section: SectionKey, event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const panel = document.getElementById(panelId(section));
    if (!panel) return;
    panel.focus();
    panel.scrollIntoView({ block: "start" });
  };
  const handleSave = async () => {
    if (await save("execution")) return;
    const root = rootRef.current;
    const target =
      root?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
      root?.querySelector<HTMLElement>('[role="alert"]');
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center" });
  };
  const sectionTitle = (section: SectionKey) => (
    <CardTitle id={panelId(section)} tabIndex={-1} role="heading" aria-level={3}>
      {t(SECTIONS[section])}
    </CardTitle>
  );
  const group = (section: SectionKey, fields: NumericField[]) => (
    <Card>
      <CardHeader>{sectionTitle(section)}</CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2">
        {fields.map((field) => (
          <Field key={field.key} label={field.label} info={field.info}>
            <Input
              inputMode="decimal"
              aria-invalid={problem === field.key}
              disabled={saving || !draft}
              value={draft?.[field.key] ?? ""}
              className={
                problem === field.key
                  ? "border-destructive focus-visible:ring-destructive"
                  : undefined
              }
              onChange={(e) => patch(field.key, e.target.value)}
            />
          </Field>
        ))}
      </CardContent>
    </Card>
  );
  return (
    <div ref={rootRef} className="w-full min-w-0 space-y-6 px-6 py-6 lg:px-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <SlidersHorizontal className="size-4 text-muted-foreground" />
            {t("connections.execution.title")}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("connections.execution.description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={loading || saving} onClick={() => void load(true)}>
            <RefreshCw />
            {t("connections.common.refresh")}
          </Button>
          <Button
            variant="outline"
            disabled={!dirty || saving}
            onClick={() => discard("execution")}
          >
            {t("library.discard.changes")}
          </Button>
          <Button disabled={!dirty || saving || loading} onClick={() => void handleSave()}>
            <Save />
            {t("connections.execution.save")}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" tabIndex={-1} className="text-sm text-destructive">
          {t(error)}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {t(notice)}
        </p>
      )}
      {dirty && !notice && (
        <p className="text-xs text-muted-foreground">{t("connections.execution.unsaved")}</p>
      )}
      <nav aria-label={t("connections.execution.title")} className="flex flex-wrap gap-1">
        {SECTION_ORDER.map((section) => (
          <Button key={section} asChild variant="ghost">
            <a href={`#${panelId(section)}`} onClick={(event) => jumpToSection(section, event)}>
              {t(SECTIONS[section])}
            </a>
          </Button>
        ))}
      </nav>
      <div className="grid items-start gap-6 xl:grid-cols-2">
        <Card className="xl:col-span-2">
          <CardHeader>{sectionTitle("switches")}</CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            {EXECUTION_MODULE_KEYS.map((module) => (
              <Field
                key={module}
                label={`connections.execution.modules.${module}`}
                info={`connections.execution.modules.${module}Hint`}
              >
                <Checkbox
                  checked={draft?.modules[module] ?? false}
                  disabled={saving || !draft}
                  onCheckedChange={(checked) =>
                    draft && update({ modules: { ...draft.modules, [module]: checked === true } })
                  }
                />
              </Field>
            ))}
            <Field label="connections.execution.research" info="connections.execution.researchHint">
              <Checkbox
                checked={draft?.research ?? false}
                disabled={saving || !draft}
                onCheckedChange={(checked) => patch("research", checked === true)}
              />
            </Field>
            <Field label="connections.execution.code" info="connections.execution.codeHint">
              <Checkbox
                checked={draft?.code ?? false}
                disabled={saving || !draft}
                onCheckedChange={(checked) => patch("code", checked === true)}
              />
            </Field>
          </CardContent>
        </Card>
        {group("maintenance", [
          {
            key: "memoryTimeoutSeconds",
            label: "connections.execution.memoryTimeoutSeconds",
            info: "connections.execution.memoryTimeoutSecondsHint",
          },
          {
            key: "knowledgeTimeoutSeconds",
            label: "connections.execution.knowledgeTimeoutSeconds",
            info: "connections.execution.knowledgeTimeoutSecondsHint",
          },
        ])}
        {group("tasks", taskFields)}
        {group("research", researchFields)}
        {group("code", codeFields)}
        {group("loop", loopFields)}
        {group("qq", qqFields)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!dirty || saving || loading} onClick={() => void handleSave()}>
          <Save />
          {t("workspace.save")}
        </Button>
        <Button variant="outline" disabled={!dirty || saving} onClick={() => discard("execution")}>
          {t("library.discard.changes")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("connections.execution.timing")}</p>
    </div>
  );
}
