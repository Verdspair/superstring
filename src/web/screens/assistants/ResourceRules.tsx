import { ArrowLeft, BookOpen, Check, FileText, Layers, RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Field } from "@/components/form-field";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { agentPageDirty } from "@/features/agents/page-drafts";
import { knowledgeReadDirty } from "@/features/knowledge/types";
import { translateNotice } from "@/i18n";
import { useSuperstringStore } from "@/store";
import { P5ConfigSchema, RetrievalPresetSchema } from "../../../shared/contracts/models";
import { openContextAllocation } from "../../features/context-allocation";

const MODES = {
  off: "library.retrieval.off",
  conservative: "library.conservative",
  standard: "library.standard",
  broad: "library.broad",
} as const;
// 三个预设默认全部展开，额度字段直接可见。
const PRESET_MODES = ["conservative", "standard", "broad"] as const;

/** 记忆工具设置：只拥有 retrieval_mode / retrieval_presets 与全量档目录批次两项（max_catalog_batches / catalog_batch_size），正文在资料库的记忆分区管理。 */
type CatalogKey = "max_catalog_batches" | "catalog_batch_size";

/** 契约叶子校验（P5ConfigSchema 现读，不自抄边界）：空/非整数/越界都非法。 */
function catalogValid(key: CatalogKey, raw: string): boolean {
  const leaf = P5ConfigSchema.shape[key] as { safeParse: (v: unknown) => { success: boolean } };
  const n = Number(raw);
  return raw.trim() !== "" && Number.isFinite(n) && leaf.safeParse(n).success;
}

/**
 * 目录批次两输入（仅全量档挂载）：原文留底属本组件生命周期。
 * - 组件按外层 key 随 Agent/编辑会话/config_version 重挂载，切目标即拿到新原文；
 * - 草稿值外部变化（放弃/刷新/别处保存推进）按值复位原文；本组件自己输入的合法值与草稿一致，
 *   复位是同串写回，不丢正在输入的内容；
 * - 非法原文只在本组件提示，不写入草稿，也不 clamp。
 */
function CatalogBatchFields({
  batches,
  batch,
  disabled,
  onPatch,
  onInvalidChange,
}: {
  batches: number;
  batch: number;
  disabled: boolean;
  onPatch: (key: CatalogKey, value: number) => void;
  onInvalidChange: (invalid: boolean) => void;
}) {
  const { t } = useTranslation();
  const [raws, setRaws] = useState<Record<CatalogKey, string>>({
    max_catalog_batches: String(batches),
    catalog_batch_size: String(batch),
  });
  // 外部草稿变化（放弃/刷新/别处保存）按值复位原文。
  useEffect(() => {
    setRaws({ max_catalog_batches: String(batches), catalog_batch_size: String(batch) });
  }, [batches, batch]);
  const invalid =
    !catalogValid("max_catalog_batches", raws.max_catalog_batches) ||
    !catalogValid("catalog_batch_size", raws.catalog_batch_size);
  useEffect(() => {
    onInvalidChange(invalid);
  }, [invalid, onInvalidChange]);
  return (
    <div className="grid min-w-0 gap-4 sm:grid-cols-2">
      {(
        [
          ["library.maximum.catalog.batches", "max_catalog_batches"],
          ["library.catalog.entries.per.batch", "catalog_batch_size"],
        ] as const
      ).map(([labelKey, key]) => {
        const fieldInvalid = !catalogValid(key, raws[key]);
        return (
          <Field
            key={key}
            label={labelKey}
            tooltip={t(
              key === "max_catalog_batches"
                ? "hints.fieldExtra.catalogBatches"
                : "hints.fieldExtra.catalogSize",
            )}
          >
            <Input
              type="number"
              disabled={disabled}
              min={1}
              max={10000}
              value={raws[key]}
              aria-invalid={fieldInvalid || undefined}
              aria-describedby={fieldInvalid ? `catalog-${key}-error` : undefined}
              onChange={(e) => {
                const raw = e.target.value;
                setRaws((old) => ({ ...old, [key]: raw }));
                // 非法原文不写入草稿：保留原文与错误提示，不把空/0/越界洗成数字。
                if (raw.trim() !== "" && catalogValid(key, raw)) onPatch(key, Number(raw));
              }}
            />
            {fieldInvalid && (
              <p id={`catalog-${key}-error`} role="alert" className="mt-1 text-xs text-destructive">
                {t("connections.enterAValidIntegerWithinTheAllowedRange")}
              </p>
            )}
          </Field>
        );
      })}
    </div>
  );
}

export function MemoryReadingRules({
  navigation,
  onDirectory,
  active = true,
  renderWorkspace,
}: {
  navigation?: ReactNode;
  onDirectory?: () => void;
  active?: boolean;
  renderWorkspace?: (parts: {
    actions: ReactNode;
    content: ReactNode;
    status?: ReactNode;
  }) => ReactNode;
} = {}) {
  const s = useSuperstringStore(
    useShallow((state) => ({
      discardSettingsPages: state.discardSettingsPages,
      editorLoading: state.editorLoading,
      error: state.error,
      feedback: state.feedback,
      knowledgeReadLoading: state.knowledgeReadLoading,
      openSettingsRoute: state.openSettingsRoute,
      pageEditor: state.pageEditor,
      patchPageAgent: state.patchPageAgent,
      refreshSettingsAgent: state.refreshSettingsAgent,
      saveSettingsPage: state.saveSettingsPage,
      settingsSaving: state.settingsSaving,
      allocationInvalidInputs: state.allocationInvalidInputs,
    })),
  );
  const t = useTranslation().t;
  const editor = s.pageEditor;
  const isWorkspace = Boolean(renderWorkspace);
  // 目录批次非法原文只存在于全量档子组件：普通档不挂载，不拦普通档保存。
  const [catalogInvalid, setCatalogInvalid] = useState(false);
  // 放弃时递增：强制子组件重挂载，清掉非法原文。
  const [catalogResetSeq, setCatalogResetSeq] = useState(0);

  if (!editor) return null;
  const p5 = editor.draft.p5_config;
  const legacyFull = p5.retrieval_mode === "full_catalog" || p5.retrieval_mode === "full_body";
  const patchMemoryRules = (value: Partial<typeof p5>) =>
    s.patchPageAgent("memory-tools", { p5_config: { ...p5, ...value } });

  const isMemoryDirty = agentPageDirty(editor, "memory-tools");
  const isContextDirty = agentPageDirty(editor, "context");
  const busy = s.settingsSaving || s.editorLoading || s.knowledgeReadLoading;

  const agentId = editor.agent.id;
  const isByteValid = (val: string): boolean => {
    if (!val || val.trim() === "") return false;
    const n = Number(val);
    return Number.isInteger(n) && n >= 1 && n <= 1048576;
  };

  const byteInvalidFor = (mode: (typeof PRESET_MODES)[number]): string | undefined =>
    s.allocationInvalidInputs[`agent:${agentId}:reading:memory:${mode}`];

  const handleByteChange = (mode: (typeof PRESET_MODES)[number], raw: string) => {
    const key = `agent:${agentId}:reading:memory:${mode}`;
    const valid = isByteValid(raw);
    useSuperstringStore.setState((state) => {
      const next = { ...state.allocationInvalidInputs };
      if (valid) delete next[key];
      else next[key] = raw;
      return { allocationInvalidInputs: next };
    });
    if (valid) {
      s.patchPageAgent("context", {
        p5_config: {
          ...p5,
          retrieval_presets: {
            ...p5.retrieval_presets,
            [mode]: { ...p5.retrieval_presets[mode], max_tokens: Number(raw) },
          },
        },
      });
    }
  };

  const hasPresetBytesInvalid = PRESET_MODES.some((mode) => byteInvalidFor(mode) !== undefined);
  const isAllBytesValid = PRESET_MODES.every(
    (mode) =>
      byteInvalidFor(mode) === undefined &&
      isByteValid(String(p5.retrieval_presets[mode].max_tokens)),
  );

  const canDiscardMemory = (isMemoryDirty || (legacyFull && catalogInvalid)) && !busy;
  const canDiscardContext = (isContextDirty || hasPresetBytesInvalid) && !busy;

  const handleDiscardContext = () => {
    s.discardSettingsPages("context");
  };

  const statusBadge = (
    <span
      role="status"
      className={`rounded-[9999px] border px-[12px] py-[4px] text-[12px] font-semibold whitespace-nowrap ${isMemoryDirty || isContextDirty || hasPresetBytesInvalid || catalogInvalid ? "border-[var(--warning-border)] bg-[var(--warning-bg)] text-[var(--warning)]" : "border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success)]"}`}
    >
      {t(
        isMemoryDirty || isContextDirty || hasPresetBytesInvalid || catalogInvalid
          ? "strict.reading.dirty"
          : "strict.reading.clean",
      )}
    </span>
  );

  const actionButtons = (
    <div
      className={
        isWorkspace
          ? "flex flex-wrap items-center justify-end gap-[8px]"
          : "flex flex-wrap items-center gap-[8px] max-[480px]:w-full max-[480px]:[&>span]:w-full max-[480px]:[&_button]:w-full"
      }
    >
      <Button
        size="sm"
        variant="secondary"
        aria-label={isWorkspace ? t("library.discard.changes") : undefined}
        className={isWorkspace ? "gap-[8px] max-sm:size-8 max-sm:p-0" : "gap-[8px]"}
        disabled={!(canDiscardMemory || canDiscardContext)}
        tooltip={t("strict.reading.resetHint")}
        onClick={() => {
          s.discardSettingsPages("memory-tools");
          s.discardSettingsPages("context");
          if (legacyFull) setCatalogResetSeq((n) => n + 1);
        }}
      >
        <RotateCcw className="size-[15px]" />
        <span className={isWorkspace ? "max-sm:hidden" : undefined}>
          {t("library.discard.changes")}
        </span>
      </Button>
      <Button
        data-visual="reading-save-rules"
        data-testid="reading-save-rules-btn"
        className={isWorkspace ? "max-sm:size-8 max-sm:p-0" : undefined}
        aria-label={t("library.save.memory.rules")}
        disabled={!isMemoryDirty || (legacyFull && catalogInvalid) || busy}
        tooltip={t("hints.agent.rulesSave")}
        disabledReason={t("hints.agent.rulesSaveDisabled")}
        onClick={() => void s.saveSettingsPage("memory-tools")}
      >
        <Check className="size-[15px]" />
        <span className={isWorkspace ? "max-sm:hidden" : undefined}>
          {t("strict.reading.rulesSave")}
        </span>
      </Button>
      <Button
        data-testid="reading-save-memory-btn"
        aria-label={isWorkspace ? t("strict.reading.contextSave") : undefined}
        className={isWorkspace ? "max-sm:size-8 max-sm:p-0" : undefined}
        variant="accent"
        disabled={!isContextDirty || !isAllBytesValid || busy}
        tooltip={t("hints.agent.contextSave")}
        disabledReason={t("hints.agent.contextSaveDisabled")}
        onClick={() => void s.saveSettingsPage("context")}
      >
        <Layers className="size-[15px]" />
        <span className={isWorkspace ? "max-sm:hidden" : undefined}>
          {s.settingsSaving ? t("workspace.saving") : t("strict.reading.contextSave")}
        </span>
      </Button>
    </div>
  );

  const actions = isWorkspace ? (
    actionButtons
  ) : (
    <div
      data-visual="reading-task-actions"
      className="flex shrink-0 flex-col items-start gap-[10px] min-[768px]:items-end"
    >
      {statusBadge}
      {actionButtons}
    </div>
  );
  const content = (
    <div hidden={!active} data-testid="reading-section-memory">
      {s.error && (
        <p
          role="alert"
          className="mb-[20px] rounded-[10px] border border-[var(--danger-border)] bg-[var(--danger-bg)] px-[16px] py-[12px] text-[13px] text-destructive"
        >
          {translateNotice(s.error)}
        </p>
      )}
      {s.feedback && !s.error && (
        <p
          role="status"
          className="mb-[20px] rounded-[10px] border border-[var(--success-border)] bg-[var(--success-bg)] px-[16px] py-[12px] text-[13px] text-[var(--success)]"
        >
          {translateNotice(s.feedback)}
        </p>
      )}
      <div className={isWorkspace ? "mb-[24px]" : "mb-[52px]"}>
        <div className="mb-[14px] flex flex-wrap items-baseline justify-between gap-[8px]">
          <h2 className="workspace-section-title">{t("strict.reading.generalTitle")}</h2>
          <span className="text-[12.5px] text-[var(--text-tertiary)]">
            {t("strict.reading.agentScope")}
          </span>
        </div>
        <div className="grid gap-[16px]">
          <Field label="strict.reading.mode" tooltip={t("hints.agent.fieldMemoryMode")}>
            <NativeSelect
              aria-label={t("library.memory.tools.mode")}
              disabled={busy}
              value={p5.retrieval_mode}
              onChange={(e) =>
                patchMemoryRules({
                  retrieval_mode: e.target.value as typeof p5.retrieval_mode,
                })
              }
            >
              {legacyFull && (
                <option value={p5.retrieval_mode}>
                  {t(
                    p5.retrieval_mode === "full_catalog"
                      ? "library.full.catalog"
                      : "library.full.body",
                  )}
                </option>
              )}
              {Object.keys(MODES).map((value) => (
                <option key={value} value={value}>
                  {t(`strict.mode.${value}`)}
                </option>
              ))}
            </NativeSelect>
          </Field>

          {legacyFull && (
            <>
              <p className="text-sm text-muted-foreground">
                {t("library.memory.tools.legacy.full", { "0": p5.retrieval_mode })}
                <Button
                  variant="link"
                  size="sm"
                  disabled={busy}
                  tooltip={t("hints.agent.useBroad")}
                  onClick={() => patchMemoryRules({ retrieval_mode: "broad" })}
                >
                  {t("library.memory.tools.use.broad")}
                </Button>
              </p>
              <CatalogBatchFields
                key={`${editor.agent.id}:${editor.agent.config_version}:${catalogResetSeq}`}
                batches={p5.max_catalog_batches}
                batch={p5.catalog_batch_size}
                disabled={busy}
                onPatch={(key, value) => patchMemoryRules({ [key]: value })}
                onInvalidChange={setCatalogInvalid}
              />
            </>
          )}

          <Field
            label="strict.reading.prompt"
            tooltip={t("strict.reading.promptHelp")}
            labelAside={t("strict.reading.promptBounds")}
          >
            <Textarea
              aria-label={t("library.memory.tools.retrieval.prompt")}
              disabled={busy}
              maxLength={16000}
              className="min-h-[76px] px-[12px] py-[10px] text-[13.5px] leading-[1.5]"
              value={editor.draft.memory_retrieval_prompt}
              onChange={(event) =>
                s.patchPageAgent("memory-tools", { memory_retrieval_prompt: event.target.value })
              }
            />
          </Field>
        </div>
      </div>
      <div className="mb-[28px]">
        <div className="mb-[14px] flex flex-wrap items-baseline justify-between gap-[8px]">
          <h2 className="workspace-section-title">{t("strict.reading.presetsTitle")}</h2>
          <span className="text-[12.5px] text-[var(--text-tertiary)]">
            {t("strict.reading.presetsHint")}
          </span>
        </div>
        <Accordion
          type="multiple"
          defaultValue={[...PRESET_MODES]}
          className="flex flex-col gap-[12px]"
        >
          {PRESET_MODES.map((mode) => {
            const preset = p5.retrieval_presets[mode];
            const rawByteVal = byteInvalidFor(mode);
            const currentByteVal = rawByteVal ?? String(preset.max_tokens);
            const byteValid = byteInvalidFor(mode) === undefined && isByteValid(currentByteVal);

            return (
              <AccordionItem
                key={mode}
                value={mode}
                data-visual={`reading-preset-${mode}`}
                className="overflow-hidden rounded-[10px] border border-border bg-card last:border-b"
              >
                <AccordionTrigger className="min-h-[52px] items-center leading-[normal] rounded-none border-0 px-[18px] py-[14px] text-[13px] hover:no-underline">
                  <div className="flex min-w-0 flex-wrap items-center gap-[12px] text-left">
                    <span
                      className={`inline-flex rounded-[6px] border px-[10px] py-[3px] text-[12px] leading-[normal] font-bold ${mode === "standard" ? "border-primary bg-[var(--primary-tint)] text-primary" : mode === "broad" ? "border-accent bg-[var(--accent-tint)] text-accent" : "border-border bg-muted text-foreground"}`}
                    >
                      {t(`strict.tier.${mode}`)}
                    </span>
                    <span className="text-[13px] font-medium text-muted-foreground tabular-nums">
                      {t("strict.reading.presetSummary", {
                        "0": preset.candidate_limit,
                        "1": preset.max_entries,
                        "2": preset.max_tokens.toLocaleString(),
                      })}
                    </span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="h-auto border-t border-border bg-muted p-[18px] text-[13.5px] leading-[1.5] [&_p:not(:last-child)]:mb-0">
                  <div className="flex flex-col gap-[16px]">
                    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-[16px]">
                      <Field
                        label="strict.reading.scan"
                        labelAside="[1 – 10000]"
                        unit={t("strict.reading.entriesUnit")}
                        tooltip={t("hints.agent.fieldScanLimit")}
                      >
                        <Input
                          type="number"
                          disabled={busy}
                          aria-label={t("library.memory.tools.scan.limit")}
                          min={RetrievalPresetSchema.shape.candidate_limit.minValue ?? undefined}
                          max={RetrievalPresetSchema.shape.candidate_limit.maxValue ?? undefined}
                          value={preset.candidate_limit}
                          onChange={(e) =>
                            patchMemoryRules({
                              retrieval_presets: {
                                ...p5.retrieval_presets,
                                [mode]: { ...preset, candidate_limit: Number(e.target.value) },
                              },
                            })
                          }
                        />
                      </Field>

                      <Field
                        label="strict.reading.return"
                        labelAside={t("strict.reading.returnBounds")}
                        unit={t("strict.reading.entriesUnit")}
                        tooltip={t("hints.agent.fieldPageLimit")}
                      >
                        <Input
                          type="number"
                          disabled={busy}
                          aria-label={t("library.memory.tools.page.limit")}
                          min={RetrievalPresetSchema.shape.max_entries.minValue ?? undefined}
                          max={Math.min(
                            RetrievalPresetSchema.shape.max_entries.maxValue!,
                            preset.candidate_limit,
                          )}
                          value={preset.max_entries}
                          onChange={(e) =>
                            patchMemoryRules({
                              retrieval_presets: {
                                ...p5.retrieval_presets,
                                [mode]: { ...preset, max_entries: Number(e.target.value) },
                              },
                            })
                          }
                        />
                      </Field>

                      <Field
                        label="strict.reading.capacity"
                        tooltip={t("hints.agent.fieldMaxBytes")}
                        labelAside={t("strict.reading.contextQuota")}
                        unit="Bytes"
                      >
                        <Input
                          id={`reading-memory-${mode}`}
                          data-testid={`reading-preset-max-tokens-${mode}`}
                          aria-label={t("schemes.allocation.reading.maxBytesLabel")}
                          aria-invalid={!byteValid || undefined}
                          type="text"
                          inputMode="numeric"
                          disabled={busy}
                          value={currentByteVal}
                          onChange={(e) => handleByteChange(mode, e.target.value)}
                          className={`h-[38px] px-[12px] text-[13.5px] leading-[1.5] ${!byteValid ? "border-destructive! bg-[var(--danger-bg)]!" : ""}`}
                          placeholder="Bytes"
                        />
                        {!byteValid && (
                          <p className="text-[11px] text-destructive mt-1">
                            {t("schemes.allocation.reading.invalidByteRange", {
                              defaultValue: "必须为 1 到 1,048,576 之间的整数",
                            })}
                          </p>
                        )}
                      </Field>
                    </div>

                    <Field
                      label="strict.reading.instruction"
                      labelAside={t("strict.reading.instructionBounds")}
                      tooltip={t("hints.fieldExtra.relevance")}
                    >
                      <Textarea
                        aria-label={t("library.memory.tools.relevance.instruction")}
                        disabled={busy}
                        maxLength={16000}
                        value={preset.relevance_instruction}
                        className="min-h-[38px] px-[12px] py-[8px] text-[13.5px] leading-[20px]"
                        rows={1}
                        onChange={(event) =>
                          patchMemoryRules({
                            retrieval_presets: {
                              ...p5.retrieval_presets,
                              [mode]: { ...preset, relevance_instruction: event.target.value },
                            },
                          })
                        }
                      />
                    </Field>
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </div>
      <p className="mb-[12px] text-[12.5px] leading-[1.5] text-muted-foreground">
        {t("models.contextSaveScope")}
      </p>
      <div className="mb-[16px] flex flex-wrap items-center gap-[8px]">
        <Button
          variant="outline"
          tooltip={t("hints.agent.goToLongMemory")}
          onClick={() => s.openSettingsRoute("long-memory")}
        >
          <BookOpen className="size-[15px]" />
          {t("connections.goToLongTermMemory")}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          tooltip={t("hints.agent.refreshBaseline")}
          onClick={() => void s.refreshSettingsAgent()}
        >
          {t("capabilities.resources.refreshBaseline")}
        </Button>
        <Button
          variant="ghost"
          disabled={!canDiscardMemory}
          tooltip={t("hints.agent.discardMemoryRules")}
          onClick={() => {
            s.discardSettingsPages("memory-tools");
            if (legacyFull) setCatalogResetSeq((n) => n + 1);
          }}
        >
          {t("strict.reading.discardRules")}
        </Button>
        <Button
          data-testid="reading-discard-memory-btn"
          variant="ghost"
          disabled={!canDiscardContext}
          tooltip={t("hints.agent.discardContextBudget")}
          onClick={handleDiscardContext}
        >
          {t("schemes.allocation.reading.discardBudget")}
        </Button>
      </div>
      <details className="mb-[28px] overflow-hidden rounded-[10px] border border-border bg-card">
        <summary className="cursor-pointer px-[16px] py-[12px] text-[13px] font-semibold text-muted-foreground">
          {t("strict.reading.technical")}
        </summary>
        <div className="space-y-[10px] border-t border-border bg-muted px-[18px] py-[14px] text-[12.5px] leading-[1.7] text-muted-foreground">
          <p>{t("library.memory.tools.on.demand")}</p>
          <p>{t("library.memory.tools.limits.hint")}</p>
        </div>
      </details>
    </div>
  );
  if (renderWorkspace) return renderWorkspace({ actions, content, status: statusBadge });
  return (
    <section className="min-w-0 text-[14px] leading-[1.5]">
      <header
        hidden={!active}
        data-visual="reading-task-header"
        className={`${active ? "flex" : "hidden"} mb-[24px] flex-col gap-[14px] border-b border-border pb-[20px] min-[768px]:flex-row min-[768px]:items-start min-[768px]:justify-between`}
      >
        <div className="min-w-0 flex-1">
          {onDirectory && (
            <Button
              variant="ghost"
              size="sm"
              className="mb-2 -ml-2 w-fit"
              onClick={onDirectory}
              tooltip={t("hints.agent.directory")}
            >
              <ArrowLeft />
              {t("library.all.assistants")}
            </Button>
          )}
          <nav
            aria-label={t("strict.reading.breadcrumb")}
            className="workspace-page-location flex flex-wrap items-center gap-[6px]"
          >
            <span>{t("strict.workspace")}</span>
            <span aria-hidden="true">›</span>
            <span>{t("library.assistant")}</span>
            <span aria-hidden="true">›</span>
            {onDirectory ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onDirectory}
                    className="rounded-[4px] px-[4px] py-[2px] font-medium leading-[normal] text-muted-foreground hover:text-primary"
                  >
                    {t("strict.directory")}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t("hints.agent.directory")}</TooltipContent>
              </Tooltip>
            ) : (
              <span>{t("strict.directory")}</span>
            )}
            <span aria-hidden="true">›</span>
            <strong className="font-semibold">{editor.agent.name}</strong>
          </nav>
          <div className="flex flex-wrap items-center gap-[12px]">
            <h1 data-visual="reading-task-title" className="workspace-page-title">
              {onDirectory
                ? t("agent.configuration.title", { name: editor.agent.name })
                : t("strict.reading.title")}
            </h1>
            <span className="inline-flex items-center gap-[6px] rounded-[9999px] border border-border bg-muted px-[10px] py-[3px] text-[12px] font-medium text-muted-foreground">
              {onDirectory ? (
                t("strict.reading.title")
              ) : (
                <>
                  {t("strict.scope.object")}
                  <strong className="font-semibold text-primary">{editor.agent.name}</strong>
                </>
              )}
            </span>
          </div>
          <p className="mt-[6px] max-w-[680px] text-[13.5px] leading-[1.55] text-muted-foreground">
            {t("strict.reading.description")}
          </p>
        </div>
        {actions}
      </header>
      {navigation}
      {content}
    </section>
  );
}

/** 记忆工具入口摘要组件：直接呈现包含各档规则与配额的统一记忆配置 */
export function MemoryToolSettings(
  props: {
    navigation?: ReactNode;
    onDirectory?: () => void;
    active?: boolean;
    renderWorkspace?: (parts: {
      actions: ReactNode;
      content: ReactNode;
      status?: ReactNode;
    }) => ReactNode;
  } = {},
) {
  return <MemoryReadingRules {...props} />;
}

/** 知识工具设置：直接内联完整的 4 字段知识读取配置（enabled, context_budget, scope, document_ids），
 *  杜绝跨域跳转，资料读取独立整份保存至 PUT /agents/{id}/knowledge-read-settings。 */
export function KnowledgeToolSettings({ active = true }: { active?: boolean } = {}) {
  const s = useSuperstringStore(
    useShallow((state) => ({
      discardKnowledgeRead: state.discardKnowledgeRead,
      editorAgentId: state.editorAgentId,
      editorLoading: state.editorLoading,
      error: state.error,
      feedback: state.feedback,
      knowledgeModelEditor: state.knowledgeModelEditor,
      knowledgeModelLoading: state.knowledgeModelLoading,
      knowledgeReadEditor: state.knowledgeReadEditor,
      knowledgeReadLoading: state.knowledgeReadLoading,
      loadKnowledgeModel: state.loadKnowledgeModel,
      loadKnowledgeRead: state.loadKnowledgeRead,
      openSettingsRoute: state.openSettingsRoute,
      pageEditor: state.pageEditor,
      patchKnowledgeRead: state.patchKnowledgeRead,
      refreshKnowledgeRead: state.refreshKnowledgeRead,
      saveKnowledgeRead: state.saveKnowledgeRead,
      settingsSaving: state.settingsSaving,
      allocationInvalidInputs: state.allocationInvalidInputs,
    })),
  );
  const t = useTranslation().t;

  useEffect(() => {
    if (active && s.editorAgentId !== "__new__") {
      void s.loadKnowledgeRead();
      void s.loadKnowledgeModel();
    }
  }, [active, s.editorAgentId, s.loadKnowledgeRead, s.loadKnowledgeModel]);

  const editor = s.pageEditor;
  if (!editor) return <p role="status">{t("library.loading")}</p>;
  const read = s.knowledgeReadEditor?.agentId === editor.agent.id ? s.knowledgeReadEditor : null;
  const global = s.knowledgeModelEditor;
  const busy =
    s.settingsSaving || s.editorLoading || s.knowledgeReadLoading || s.knowledgeModelLoading;

  const agentId = editor.agent.id;
  const invalidKey = `agent:${agentId}:reading:knowledgeAgent`;
  const isByteValid = (val: string): boolean => {
    if (!val || val.trim() === "") return false;
    const n = Number(val);
    return Number.isInteger(n) && n >= 1 && n <= 1048576;
  };

  const rawBudgetInput = s.allocationInvalidInputs[invalidKey];
  // 严格遵循 ContextAllocationReading 原契约：仅在 draft 为 null 且无无效输入时才视作正在继承；
  // 当取消继承且全局预算未知时，rawBudgetInput 置为 ""，此时 isInheriting 变为 false，复选框取消勾选，显示空白输入框
  const isInheriting = read?.draft.context_budget === null && rawBudgetInput === undefined;
  const isBudgetValid =
    rawBudgetInput === undefined &&
    (isInheriting || (read?.draft.context_budget != null && read.draft.context_budget > 0));

  const handleToggleInherit = (inherit: boolean) => {
    if (inherit) {
      useSuperstringStore.setState((state) => {
        const next = { ...state.allocationInvalidInputs };
        delete next[invalidKey];
        return { allocationInvalidInputs: next };
      });
      s.patchKnowledgeRead({ context_budget: null });
    } else {
      const inherited = global?.contextBudget != null ? global.contextBudget : null;
      if (inherited != null) {
        useSuperstringStore.setState((state) => {
          const next = { ...state.allocationInvalidInputs };
          delete next[invalidKey];
          return { allocationInvalidInputs: next };
        });
        s.patchKnowledgeRead({ context_budget: inherited });
      } else {
        // 全局预算未知时保持空白并设为 invalid 状态，此时 isInheriting 变为 false，显示输入框且阻止保存
        useSuperstringStore.setState((state) => ({
          allocationInvalidInputs: { ...state.allocationInvalidInputs, [invalidKey]: "" },
        }));
        s.patchKnowledgeRead({ context_budget: null });
      }
    }
  };

  const handleBudgetChange = (raw: string) => {
    const valid = isByteValid(raw);
    useSuperstringStore.setState((state) => {
      const next = { ...state.allocationInvalidInputs };
      if (valid) delete next[invalidKey];
      else next[invalidKey] = raw;
      return { allocationInvalidInputs: next };
    });
    if (valid) {
      s.patchKnowledgeRead({ context_budget: Number(raw) });
    }
  };

  const isKnowledgeDirty = !!read && knowledgeReadDirty(read);
  const hasKnowledgeInvalid = rawBudgetInput !== undefined;
  const canDiscardKnowledge = (isKnowledgeDirty || hasKnowledgeInvalid) && !busy;

  const handleDiscardKnowledge = () => {
    s.discardKnowledgeRead();
    void s.loadKnowledgeRead();
  };

  return (
    <div className="space-y-6">
      <Card className="min-w-0" data-testid="reading-section-knowledge-agent">
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="size-4" />
                {t("library.knowledge.access")}
              </CardTitle>
              <CardDescription className="mt-1">
                {t("library.document.grants.determine.visibility.this.agent.s.reading.rules")}
              </CardDescription>
            </div>
            <span className="inline-flex items-center rounded border border-border/60 bg-muted/60 px-2 py-0.5 text-xs font-medium text-muted-foreground self-start sm:self-auto shrink-0">
              {t("schemes.allocation.reading.scopeAgentOverride", { defaultValue: "助手专属" })}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {!read ? (
            !s.knowledgeReadLoading && s.error ? (
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  disabled={busy}
                  tooltip={t("hints.agent.retryKnowledgeRead")}
                  onClick={() => void s.loadKnowledgeRead()}
                >
                  {t("library.refresh.grants")}
                </Button>
              </div>
            ) : (
              <p role="status">{t("library.loading")}</p>
            )
          ) : (
            <>
              {/* 1. enabled 开关 */}
              <Field
                label="library.enable.knowledge.reading"
                tooltip={t("hints.agent.fieldKnowledgeEnabled")}
              >
                <Checkbox
                  disabled={busy}
                  checked={read.draft.enabled}
                  onCheckedChange={(v) => s.patchKnowledgeRead({ enabled: v === true })}
                />
              </Field>

              {/* 2. context_budget 额度 (内联完整配置，无外跳按钮) */}
              <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="knowledge-agent-inherit"
                    data-testid="reading-knowledge-agent-inherit-checkbox"
                    disabled={busy}
                    checked={isInheriting}
                    onCheckedChange={(value) => handleToggleInherit(value === true)}
                  />
                  <label
                    htmlFor="knowledge-agent-inherit"
                    className="text-xs font-medium leading-none cursor-pointer text-foreground"
                  >
                    {t("schemes.allocation.reading.followGlobalDefault", {
                      defaultValue: "跟随全局默认额度 (继承)",
                    })}
                  </label>
                </div>

                <div className="rounded-md border bg-background/60 p-3 text-xs">
                  <div
                    data-testid="reading-knowledge-agent-effective-source"
                    className="flex items-center justify-between"
                  >
                    <span className="text-muted-foreground">
                      {t("schemes.allocation.reading.effectiveSourceLabel", {
                        defaultValue: "当前生效额度与来源：",
                      })}
                    </span>
                    <span className="font-medium font-mono text-foreground">
                      {isInheriting
                        ? `${global?.contextBudget ?? "?"} Bytes ${t("schemes.allocation.reading.bytesInherited", { defaultValue: "(继承全局)" })}`
                        : `${read.draft.context_budget ?? 0} Bytes ${t("schemes.allocation.reading.bytesAgentOverride", { defaultValue: "(助手独立覆盖)" })}`}
                    </span>
                  </div>
                </div>

                {!isInheriting && (
                  <div className="ml-1 pl-4 border-l-2 border-primary/20 space-y-1.5 pt-1 max-w-md">
                    <label
                      htmlFor="knowledge-agent-budget-input"
                      className="text-xs font-medium text-muted-foreground block"
                    >
                      {t("schemes.allocation.reading.overrideBytesLabel", {
                        defaultValue: "独立覆盖读取额度 (Bytes, 1..1,048,576)",
                      })}
                    </label>
                    <Input
                      id="knowledge-agent-budget-input"
                      data-testid="reading-knowledge-agent-budget-input"
                      type="text"
                      inputMode="numeric"
                      disabled={busy}
                      value={
                        rawBudgetInput ??
                        (read.draft.context_budget != null ? String(read.draft.context_budget) : "")
                      }
                      onChange={(e) => handleBudgetChange(e.target.value)}
                      className={`h-8 text-xs font-mono ${rawBudgetInput !== undefined ? "border-destructive focus-visible:ring-destructive" : ""}`}
                      placeholder="Bytes"
                    />
                    {rawBudgetInput !== undefined && (
                      <p className="text-[11px] text-destructive">
                        {t("schemes.allocation.reading.invalidPositiveByte", {
                          defaultValue: "必须为 1 到 1,048,576 之间的正整数",
                        })}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* 3. scope 模式 */}
              <Field label="library.reading.scope" tooltip={t("hints.agent.fieldKnowledgeScope")}>
                <NativeSelect
                  disabled={busy}
                  value={read.draft.scope}
                  onChange={(e) =>
                    s.patchKnowledgeRead({
                      scope: e.target.value as "all" | "selected",
                      document_ids: e.target.value === "all" ? [] : read.draft.document_ids,
                    })
                  }
                >
                  <option value="all">{t("library.all.authorized.documents")}</option>
                  <option value="selected">{t("library.selected.documents.only")}</option>
                </NativeSelect>
              </Field>

              {/* 4. document_ids 清单 */}
              {read.draft.scope === "selected" && (
                <div className="space-y-4 rounded-xl border p-4">
                  {read.documents.map((doc) => (
                    <label
                      htmlFor={`knowledge-read-${doc.id}`}
                      key={doc.id}
                      className="flex gap-3 rounded-lg p-3 hover:bg-muted"
                    >
                      <Checkbox
                        id={`knowledge-read-${doc.id}`}
                        aria-label={doc.name}
                        disabled={busy}
                        checked={read.draft.document_ids.includes(doc.id)}
                        onCheckedChange={(v) =>
                          s.patchKnowledgeRead({
                            document_ids:
                              v === true
                                ? [...read.draft.document_ids, doc.id]
                                : read.draft.document_ids.filter((id) => id !== doc.id),
                          })
                        }
                      />
                      <span className="min-w-0 text-sm">
                        {doc.name}
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {doc.summary}
                        </span>
                      </span>
                    </label>
                  ))}
                  {read.draft.document_ids
                    .filter((id) => !read.documents.some((doc) => doc.id === id))
                    .map((id) => (
                      <div key={id} className="flex items-center gap-2">
                        <Badge variant="destructive">{t("library.authorization.expired")}</Badge>
                        <code className="min-w-0 flex-1 truncate text-xs">{id}</code>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          tooltip={t("hints.agent.removeExpiredDoc")}
                          onClick={() =>
                            s.patchKnowledgeRead({
                              document_ids: read.draft.document_ids.filter((other) => other !== id),
                            })
                          }
                        >
                          {t("library.remove")}
                        </Button>
                      </div>
                    ))}
                  {read.draft.document_ids.length === 0 && (
                    <p className="p-2 text-sm text-muted-foreground">
                      {t("library.no.documents.selected.this.mode.will.not.read.any")}
                    </p>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
                <Button
                  variant="outline"
                  className="mr-auto h-auto min-h-8 max-w-full whitespace-normal break-words"
                  tooltip={t("hints.agent.goToKnowledgeDocs")}
                  onClick={() => s.openSettingsRoute("knowledge-config")}
                >
                  <FileText />
                  {t("capabilities.resources.openKnowledgeDocuments")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!isKnowledgeDirty || busy}
                  tooltip={t("hints.agent.refreshKnowledgeRead")}
                  onClick={() => void s.refreshKnowledgeRead()}
                >
                  {t("library.refresh.grants")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!canDiscardKnowledge}
                  tooltip={t("hints.agent.discardKnowledge")}
                  disabledReason={t("hints.agent.noKnowledgeDirty")}
                  onClick={handleDiscardKnowledge}
                >
                  {t("library.discard.changes")}
                </Button>
                <Button
                  data-testid="reading-save-knowledge-agent-btn"
                  disabled={!isKnowledgeDirty || !isBudgetValid || busy}
                  tooltip={t("hints.agent.knowledgeSave")}
                  disabledReason={t("hints.agent.knowledgeSaveDisabled")}
                  onClick={() => void s.saveKnowledgeRead()}
                >
                  {t("library.save.knowledge.rules")}
                </Button>
              </div>
            </>
          )}
          {s.error && (
            <p role="alert" className="text-sm text-destructive">
              {translateNotice(s.error)}
            </p>
          )}
          {s.feedback && !s.error && (
            <p role="status" className="text-sm text-muted-foreground">
              {translateNotice(s.feedback)}
            </p>
          )}
        </CardContent>
      </Card>

      {/* 全局默认预算展示 (纯只读/刷新基线，唯一编辑在模型服务) */}
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="size-4" />
            {t("library.knowledge.global.budget")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {!global ? (
            !s.knowledgeModelLoading && s.error ? (
              <div className="flex justify-end">
                <Button
                  variant="outline"
                  disabled={busy}
                  tooltip={t("hints.agent.refreshGlobalKnowledge")}
                  onClick={() => void s.loadKnowledgeModel(true)}
                >
                  {t("capabilities.resources.refreshBaseline")}
                </Button>
              </div>
            ) : (
              <p role="status">{t("library.loading")}</p>
            )
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
              <div>
                <span className="text-muted-foreground">
                  {t("library.workspace.knowledge.budget.tokens")}：
                </span>
                <span className="font-medium">{global.contextBudget} Bytes</span>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={busy}
                  tooltip={t("hints.agent.goToCentralAllocation")}
                  onClick={() =>
                    openContextAllocation({
                      purpose: "reading",
                      agentId: null,
                      returnRoute: "knowledge-tools",
                      returnLabel: t("capabilities.knowledge.name"),
                    })
                  }
                >
                  {t("schemes.allocation.goToCentralAllocation")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  tooltip={t("hints.agent.refreshGlobalKnowledge")}
                  onClick={() => void s.loadKnowledgeModel(true)}
                >
                  {t("capabilities.resources.refreshBaseline")}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
