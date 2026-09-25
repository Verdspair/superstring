import { useEffect } from "react";
import type { RetrievalMode } from "../../../shared/contracts";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Field } from "../../ui/Field";

export function MemoryPageFields({ page }: { page: "long-memory" | "context" }) {
  const t = useI18n();
  const editor = useSuperstringStore((s) => s.pageEditor);
  const patch = useSuperstringStore((s) => s.patchPageAgent);
  const patchPolicy = useSuperstringStore((s) => s.patchPagePolicy);
  const reload = useSuperstringStore((s) => s.reloadMemory);
  const navigate = useSuperstringStore((s) => s.openSettingsRoute);
  const refresh = useSuperstringStore((s) => s.refreshCapacityPreview);
  const recalculate = useSuperstringStore((s) => s.recalculateCapacityPreview);
  const preview = useSuperstringStore((s) => s.capacityPreview);
  const capacity = useSuperstringStore((s) => s.chatContextCapacity);
  const model = editor?.agent.model_name;
  const retrievalModel = editor?.agent.memory_retrieval_model_name ?? null;
  const compressionModel = editor?.agent.context_compression_model_name ?? null;
  const editorToken = editor?.token;
  // QQ conversations organise their own memory per conversation (2026-09-25), so when the assistant
  // being edited is bound to one, this page owes the reader that fact and a way over there. The
  // bindings are read here only for that sentence; a failed read leaves the hint out.
  const loadQqBindings = useSuperstringStore((s) => s.loadQqBindings);
  const qqBound = useSuperstringStore((s) =>
    s.qqBindings.some((binding) => binding.agent_id === s.editorAgentId),
  );
  useEffect(() => {
    void loadQqBindings();
  }, [loadQqBindings]);
  useEffect(() => {
    if (page === "context" && model && editorToken)
      void refresh([model, retrievalModel, compressionModel]);
  }, [page, model, retrievalModel, compressionModel, editorToken, refresh]);
  const budget = editor?.draft.p5_config;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Recompute cached model capacities when these draft budgets change.
  useEffect(() => {
    if (page === "context") recalculate();
  }, [
    page,
    budget?.context_window,
    budget?.max_output_tokens,
    budget?.safety_margin_ratio,
    recalculate,
  ]);
  if (!editor) return null;
  const draft = editor.draft;
  const p5 = draft.p5_config;
  const update = (next: Partial<typeof p5>) => patch(page, { p5_config: { ...p5, ...next } });
  const number = (
    label: string,
    value: number,
    change: (value: number) => void,
    min = 1,
    max?: number,
    step = 1,
    disabled = false,
  ) => (
    <Field label={t(label)}>
      <input
        aria-label={t(label)}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => change(Number(e.target.value))}
      />
    </Field>
  );
  const numericP5 = (key: keyof typeof p5, label: string, min = 1, max?: number, step = 1) =>
    number(label, p5[key] as number, (value) => update({ [key]: value }), min, max, step);
  return (
    <>
      <button type="button" onClick={() => navigate("models")}>
        {t("前往默认模型")}
      </button>
      {page === "long-memory" ? (
        <>
          <SettingsGroup
            id="settings-retrieval"
            title="读取配置"
            note="当前助手的网页与 QQ 回复共用；只从各自获准的分区选取，QQ 开口判断仍采用轻量读取。"
          >
            <Field label={t("相关性判断规则")} info={t("模型筛选相关记忆的判断依据。")}>
              <textarea
                aria-label={t("相关性判断规则")}
                rows={5}
                value={draft.memory_retrieval_prompt}
                onChange={(e) => patch(page, { memory_retrieval_prompt: e.target.value })}
              />
            </Field>
            <Field label={t("默认读取强度")}>
              <select
                aria-label={t("默认读取强度")}
                value={p5.retrieval_mode}
                onChange={(e) => update({ retrieval_mode: e.target.value as RetrievalMode })}
              >
                {(
                  [
                    ["off", "关闭（本轮不读取长期记忆）"],
                    ["conservative", "保守（只用直接相关记忆）"],
                    ["standard", "标准（兼顾直接相关和必要背景）"],
                    ["broad", "宽泛（允许有帮助的间接背景）"],
                    ["full_catalog", "全目录检索（逐批筛选全部记忆）"],
                    ["full_body", "全部正文注入（不做相关性筛选）"],
                  ] as const
                ).map(([value, label]) => (
                  <option key={value} value={value}>
                    {t(label)}
                  </option>
                ))}
              </select>
            </Field>
            <p className="hint">
              {t(
                "候选目录数：参与筛选的条数；最终记忆数：用于回答的条数；正文预算：所用记忆的总 token 上限。相关性要求按档设置。",
              )}
            </p>
            {(["conservative", "standard", "broad"] as const)
              .filter(
                (key) =>
                  key === p5.retrieval_mode ||
                  (p5.retrieval_mode === "full_catalog" && key === "broad"),
              )
              .map((key) => {
                const preset = p5.retrieval_presets[key];
                const set = (next: Partial<typeof preset>) =>
                  update({
                    retrieval_presets: {
                      ...p5.retrieval_presets,
                      [key]: { ...preset, ...next },
                    },
                  });
                const label = { conservative: "保守预设", standard: "标准预设", broad: "宽泛预设" }[
                  key
                ];
                return (
                  <section key={key} aria-label={t(label)}>
                    <h4>{t(label)}</h4>
                    <div className="field-grid">
                      {number(
                        "候选目录数",
                        preset.candidate_limit,
                        (value) => set({ candidate_limit: value }),
                        1,
                        10000,
                      )}
                      {number(
                        "最终记忆数",
                        preset.max_entries,
                        (value) => set({ max_entries: value }),
                        1,
                        10000,
                      )}
                      {number(
                        "正文预算（token）",
                        preset.max_tokens,
                        (value) => set({ max_tokens: value }),
                        1,
                        1048576,
                      )}
                    </div>
                    <Field label={t("相关性要求")}>
                      <input
                        aria-label={t("相关性要求")}
                        value={preset.relevance_instruction}
                        onChange={(e) => set({ relevance_instruction: e.target.value })}
                      />
                    </Field>
                  </section>
                );
              })}
          </SettingsGroup>
          <SettingsGroup
            id="settings-consolidation"
            title="整理配置"
            note="当前助手的网页与 QQ 共用整理规则和正文长度；触发频率按入口分别设置。"
          >
            <Field
              label={t("整理规则")}
              info={t("需长期保留的信息，以及名称、简介、标签和正文的生成要求。")}
            >
              <textarea
                aria-label={t("整理规则")}
                rows={5}
                value={draft.memory_consolidation_prompt}
                onChange={(e) => patch(page, { memory_consolidation_prompt: e.target.value })}
              />
            </Field>
            <Field label={t("补充整理要求（可留空）")}>
              <textarea
                aria-label={t("补充整理要求（可留空）")}
                rows={4}
                value={draft.memory_consolidation_additional_instructions}
                onChange={(e) =>
                  patch(page, {
                    memory_consolidation_additional_instructions: e.target.value,
                  })
                }
              />
            </Field>
            {editor.policyDraft &&
              number(
                "单条记忆正文长度（字符）",
                editor.policyDraft.target_chars,
                (value) => patchPolicy({ target_chars: value }),
                50,
                4000,
              )}
          </SettingsGroup>
          <SettingsGroup
            id="settings-policy"
            title="自动整理"
            note="这里设置网页会话的触发频率；QQ 每个群或私聊的条数在上方记忆分区内设置。"
          >
            <p className="hint">{t("自动整理选项需保存当前页才生效。")}</p>
            {qqBound && (
              <p className="hint">
                {t(
                  "这个设置仅对网页端会话生效；QQ 里的记忆整理按会话单独设置（攒够多少条自动整理、立即整理）。",
                )}
                <a href="#settings-memory-scopes">{t("前往记忆分区")}</a>
              </p>
            )}
            {editor.policyDraft ? (
              <>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={editor.policyDraft.auto_enabled}
                    onChange={(e) => patchPolicy({ auto_enabled: e.target.checked })}
                  />
                  <span>{t("启用自动整理")}</span>
                </label>
                <div className="field-grid two">
                  {number(
                    "触发间隔（完整轮数）",
                    editor.policyDraft.every_turns,
                    (value) => patchPolicy({ every_turns: value }),
                    1,
                    200,
                  )}
                </div>
              </>
            ) : (
              <button type="button" onClick={() => void reload()}>
                {t("重试读取整理策略")}
              </button>
            )}
          </SettingsGroup>
          {(p5.retrieval_mode === "full_catalog" || p5.retrieval_mode === "full_body") && (
            <section id="settings-catalog-limits" aria-label={t("全量读取细节")}>
              <h4>{t("全量读取细节")}</h4>
              <p className="hint">
                {t("通常无需调整；仅用于全目录或全部正文模式，不影响普通读取与上下文压缩。")}
              </p>
              <div className="field-grid two">
                <div>
                  {numericP5("max_catalog_batches", "最多检查多少批记忆", 1, 10000)}
                  <p className="hint">
                    {t("默认 100 批；达到上限仍未读完会报错，不跳过剩余记忆。")}
                  </p>
                </div>
                <div>
                  {numericP5("catalog_batch_size", "每批检查多少条", 1, 10000)}
                  <p className="hint">{t("默认每批 30 条；限制每次检查量，不是最终使用条数。")}</p>
                </div>
              </div>
            </section>
          )}
        </>
      ) : (
        <>
          <p className="hint">
            {t("默认跟随模型加载容量。保存后从下一轮生效，重试沿用原轮预算。")}
          </p>
          <SettingsGroup id="settings-budget" title="容量与预算">
            <Field label={t("聊天上下文预算")}>
              <select
                aria-label={t("聊天上下文预算")}
                value={p5.context_window === null ? "follow" : "custom"}
                onChange={(e) =>
                  update({
                    context_window: e.target.value === "follow" ? null : 32768,
                  })
                }
              >
                <option value="follow">{t("跟随模型实际容量（推荐）")}</option>
                <option value="custom">{t("自定义预算")}</option>
              </select>
            </Field>
            {number(
              t("自定义上下文预算（实际上限：{0}）", capacity ?? t("未知")),
              p5.context_window ?? 32768,
              (value) => update({ context_window: value }),
              1024,
              capacity ?? undefined,
              1,
              p5.context_window === null,
            )}
            <div className="field-grid two">
              {numericP5("max_output_tokens", "回复预留（token）", 1, 1048576)}
              {numericP5("safety_margin_ratio", "安全余量比例", 0, 0.99, 0.01)}
            </div>
            <Field label={t("容量预览（只读）")}>
              <textarea
                aria-label={t("容量预览（只读）")}
                readOnly
                rows={3}
                value={preview.split("\n").map(translateNotice).join("\n")}
              />
            </Field>
            <button
              type="button"
              onClick={() =>
                void refresh([
                  editor.agent.model_name,
                  editor.agent.memory_retrieval_model_name,
                  editor.agent.context_compression_model_name,
                ])
              }
            >
              {t("刷新容量预览")}
            </button>
          </SettingsGroup>
          <SettingsGroup id="settings-compression" title="压缩与读取摘要策略">
            <label className="check">
              <input
                type="checkbox"
                checked={p5.compression_enabled}
                onChange={(e) => update({ compression_enabled: e.target.checked })}
              />
              <span>{t("启用上下文压缩")}</span>
            </label>
            <p className="hint">{t("原消息仍保留，并记录摘要来源。")}</p>
            <div className="field-grid two">
              {numericP5("compression_trigger_ratio", "压缩触发比例", 0.01, 1, 0.01)}
              {numericP5("recent_turns", "压缩时保留原文轮数", 1, 10000)}
            </div>
            <div className="field-grid">
              {numericP5("summary_target_tokens", "压缩摘要目标(token)", 1, 1048576)}
              {numericP5("summary_max_tokens", "压缩摘要硬上限(token)", 1, 1048576)}
              <Field label={t("单次读取摘要上限(token)")}>
                <input
                  aria-label={t("单次读取摘要上限(token)")}
                  type="number"
                  min={1}
                  max={1048576}
                  value={p5.summary_read_max_tokens ?? ""}
                  placeholder={String(p5.summary_max_tokens)}
                  onChange={(e) =>
                    update({
                      summary_read_max_tokens:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <p className="hint">
              {t(
                "目标与硬上限控制摘要生成；读取上限控制本轮用量，留空继承硬上限。超额时临时再压缩，不截断或覆盖已存摘要。",
              )}
            </p>
            {numericP5("auxiliary_timeout_seconds", "压缩任务超时（秒）", 0.1, 3600, 0.1)}
            <p className="hint">
              {t("默认 300 秒，已有自定义值保留；同时用于压缩、记忆筛选与模型容量核查。")}
            </p>
          </SettingsGroup>
          <p className="hint">{t("预算为保守估算；摘要可能损失细节，原文与来源保留。")}</p>
        </>
      )}
    </>
  );
}
