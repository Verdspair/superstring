import { useEffect } from "react";
import { translateNotice, useI18n } from "../../i18n";
import type { AgentDraft } from "../../store";
import { useSuperstringStore } from "../../store";
import { Accordion } from "../../ui/Accordion";
import { Field, NumberField } from "../../ui/Field";
import { ModelSelect } from "./ModelSelect";

export function SectionC({
  draft,
  patch,
  models,
}: {
  draft: AgentDraft;
  patch: (patch: Partial<AgentDraft>) => void;
  models: string[];
}) {
  const t = useI18n();
  const capacityPreview = useSuperstringStore((state) => state.capacityPreview);
  const refreshCapacityPreview = useSuperstringStore((state) => state.refreshCapacityPreview);
  const p5 = draft.p5_config;
  const actualContextLimit = useSuperstringStore((state) => state.chatContextCapacity) ?? undefined;
  const update = (next: Partial<typeof p5>) => patch({ p5_config: { ...p5, ...next } });
  useEffect(() => {
    // Entering C (or changing any of the three models) must re-probe the real
    // loaded capacity, because the source refreshes its controls on every model
    // change (gradio_app.py:2369-2381) and the custom-budget input is bounded by
    // the probe result. The effect depends on the model names rather than the
    // whole draft so that typing in an unrelated field does not re-probe, and it
    // hands them to the store explicitly so the probe cannot drift from the
    // draft being edited.
    void refreshCapacityPreview([
      draft.model_name,
      draft.memory_retrieval_model_name,
      draft.context_compression_model_name,
    ]);
  }, [
    draft.model_name,
    draft.memory_retrieval_model_name,
    draft.context_compression_model_name,
    refreshCapacityPreview,
  ]);
  return (
    <div className="config-section">
      <h3>{t("G · 上下文")}</h3>
      <p>{t("默认跟随模型加载容量。保存后从下一轮生效，重试沿用原轮预算。")}</p>
      <Accordion title="① 模型与预算" note={t("设置摘要模型、上下文容量与回复预留。")}>
        <Field
          label={t("上下文摘要与压缩功能使用的 LLM 配置")}
          info={t("可跟随当前对话模型，也可选择其他可用模型；不会自动加载或重载模型。")}
        >
          <ModelSelect
            value={draft.context_compression_model_name}
            models={models}
            onChange={(value) => patch({ context_compression_model_name: value })}
          />
        </Field>
        <Field label={t("聊天上下文预算")}>
          <select
            value={p5.context_window === null ? "follow" : "custom"}
            onChange={(event) =>
              update({
                context_window: event.target.value === "follow" ? null : 32768,
              })
            }
          >
            <option value="follow">{t("跟随模型实际容量（推荐）")}</option>
            <option value="custom">{t("自定义预算")}</option>
          </select>
        </Field>
        <Field
          label={t("自定义上下文预算（实际上限：{0}）", actualContextLimit ?? t("未知"))}
          info={t("只有选择自定义预算时可编辑，且不能超过模型实际容量。")}
        >
          <NumberField
            min={1024}
            max={actualContextLimit}
            value={p5.context_window ?? 32768}
            disabled={p5.context_window === null}
            onChange={(value) => update({ context_window: value })}
          />
        </Field>
        <div className="field-grid">
          <Field label={t("回复预留（token）")}>
            <NumberField
              min={1}
              value={p5.max_output_tokens}
              onChange={(value) => update({ max_output_tokens: value })}
            />
          </Field>
          <Field label={t("安全余量比例")}>
            <NumberField
              min={0}
              max={0.99}
              step={0.01}
              value={p5.safety_margin_ratio}
              onChange={(value) => update({ safety_margin_ratio: value })}
            />
          </Field>
        </div>
        <Field label={t("容量预览（只读）")}>
          <textarea
            rows={3}
            readOnly
            value={capacityPreview.split("\n").map(translateNotice).join("\n")}
          />
        </Field>
        <button type="button" onClick={() => void refreshCapacityPreview()}>
          {t("刷新容量预览")}
        </button>
      </Accordion>
      <Accordion title="② 压缩策略" note={t("达到触发比例后，将较早的完整轮次压缩为摘要。")}>
        <label className="check">
          <input
            type="checkbox"
            checked={p5.compression_enabled}
            onChange={(event) => update({ compression_enabled: event.target.checked })}
          />
          <span>
            <strong>{t("启用上下文压缩")}</strong>
            <small>{t("原消息仍保留，并记录摘要来源。")}</small>
          </span>
        </label>
        <div className="field-grid">
          <Field label={t("压缩触发比例")}>
            <NumberField
              min={0.01}
              max={1}
              step={0.01}
              value={p5.compression_trigger_ratio}
              onChange={(value) => update({ compression_trigger_ratio: value })}
            />
          </Field>
          <Field label={t("近期原文目标（轮）")}>
            <NumberField
              min={1}
              value={p5.recent_turns}
              onChange={(value) => update({ recent_turns: value })}
            />
          </Field>
        </div>
        <h4>{t("摘要与原文回查")}</h4>
        <div className="field-grid">
          <Field label={t("摘要目标（token）")}>
            <NumberField
              min={1}
              value={p5.summary_target_tokens}
              onChange={(value) => update({ summary_target_tokens: value })}
            />
          </Field>
          <Field label={t("摘要硬上限（token）")}>
            <NumberField
              min={1}
              value={p5.summary_max_tokens}
              onChange={(value) => update({ summary_max_tokens: value })}
            />
          </Field>
          <Field label={t("单次原文回查（token）")}>
            <NumberField
              min={1}
              value={p5.recall_max_tokens}
              onChange={(value) => update({ recall_max_tokens: value })}
            />
          </Field>
        </div>
      </Accordion>
      <Accordion title="③ 高级设置" note={t("只有全目录检索过慢或辅助任务超时时再调整。")}>
        <div className="field-grid">
          <Field label={t("辅助任务超时（秒）")}>
            <NumberField
              min={0.1}
              max={3600}
              value={p5.auxiliary_timeout_seconds}
              onChange={(value) => update({ auxiliary_timeout_seconds: value })}
            />
          </Field>
          <Field label={t("全目录最大批数")}>
            <NumberField
              min={1}
              value={p5.max_catalog_batches}
              onChange={(value) => update({ max_catalog_batches: value })}
            />
          </Field>
          <Field label={t("每批目录条数")}>
            <NumberField
              min={1}
              value={p5.catalog_batch_size}
              onChange={(value) => update({ catalog_batch_size: value })}
            />
          </Field>
        </div>
      </Accordion>
      <p className="hint">{t("预算采用保守估算；摘要是有损压缩，但会保留原文来源。")}</p>
    </div>
  );
}
