import { useState } from "react";
import type { RetrievalMode } from "../../../shared/contracts";
import { useI18n } from "../../i18n";
import type { AgentDraft } from "../../store";
import { useSuperstringStore } from "../../store";
import { Accordion } from "../../ui/Accordion";
import { Field, NumberField } from "../../ui/Field";
import { localTime } from "../../ui/local-time";
import { ModelSelect } from "../agents/ModelSelect";

const MODE_OPTIONS: Array<[RetrievalMode, string]> = [
  ["off", "关闭（本轮不读取长期记忆）"],
  ["conservative", "保守（只用直接相关记忆）"],
  ["standard", "标准（兼顾直接相关和必要背景）"],
  ["broad", "宽泛（允许有帮助的间接背景）"],
  ["full_catalog", "全目录检索（逐批筛选全部记忆）"],
  ["full_body", "全部正文注入（不做相关性筛选）"],
];

export function SectionB({
  draft,
  patch,
  models,
}: {
  draft: AgentDraft;
  patch: (patch: Partial<AgentDraft>) => void;
  models: string[];
}) {
  const t = useI18n();
  const policy = useSuperstringStore((state) => state.policy);
  const memorySessions = useSuperstringStore((state) => state.memorySessions);
  const memoryTurns = useSuperstringStore((state) => state.memoryTurns);
  const memoryEntries = useSuperstringStore((state) => state.memoryEntries);
  const memoryEntryDetail = useSuperstringStore((state) => state.memoryEntryDetail);
  const feedback = useSuperstringStore((state) => state.feedback);
  const loadMemoryTurns = useSuperstringStore((state) => state.loadMemoryTurns);
  const loadMemoryPage = useSuperstringStore((state) => state.loadMemoryPage);
  const loadMemoryEntryDetail = useSuperstringStore((state) => state.loadMemoryEntryDetail);
  const manualConsolidate = useSuperstringStore((state) => state.manualConsolidate);
  const updatePolicy = useSuperstringStore((state) => state.updatePolicy);
  const editorAgentId = useSuperstringStore((state) => state.editorAgentId);
  const governMemories = useSuperstringStore((state) => state.governMemories);
  const mergeMemories = useSuperstringStore((state) => state.mergeMemories);
  const clearMemoryDetail = useSuperstringStore((state) => state.clearMemoryDetail);
  const clearMemoryTurns = useSuperstringStore((state) => state.clearMemoryTurns);
  const setNotice = useSuperstringStore((state) => state.setNotice);
  const p5 = draft.p5_config;
  const patchP5 = (next: Partial<typeof p5>) => patch({ p5_config: { ...p5, ...next } });
  const [sourceSessionId, setSourceSessionId] = useState("");
  const [recentTurnCount, setRecentTurnCount] = useState(20);
  const [selectedTurns, setSelectedTurns] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [selectedMemories, setSelectedMemories] = useState<string[]>([]);
  const [purgeConfirmed, setPurgeConfirmed] = useState(false);

  const resetMemorySelection = () => {
    setSelectedMemories([]);
    setPurgeConfirmed(false);
    clearMemoryDetail();
  };
  const govern = async (action: "suppress" | "enable" | "purge") => {
    const ok = await governMemories(editorAgentId, selectedMemories, action, purgeConfirmed);
    if (ok) resetMemorySelection();
    else if (editorAgentId !== "__new__" && selectedMemories.length) setPurgeConfirmed(false);
  };
  const merge = async () => {
    const ok = await mergeMemories(editorAgentId, selectedMemories);
    if (ok) resetMemorySelection();
    else if (editorAgentId !== "__new__" && selectedMemories.length) setPurgeConfirmed(false);
  };
  const detailText = memoryEntryDetail
    ? t(
        "{0}\n存储时间：{1}\n{2}\n\n{3}",
        memoryEntryDetail.name,
        localTime(memoryEntryDetail.created_at),
        memoryEntryDetail.summary,
        memoryEntryDetail.body,
      )
    : "";
  const statusLabel = {
    active: t("生效"),
    suppressed: t("已屏蔽"),
    replaced: t("已被替代"),
    invalid: t("来源失效"),
  } as const;

  return (
    <div className="config-section">
      <h3>{t("E · 记忆管理")}</h3>
      <h4 className="config-group-heading">{t("记忆配置")}</h4>
      <Accordion title="① 读取配置" note={t("设置回答时如何查找和使用记忆。")}>
        <Field
          label={t("记忆读取功能使用的 LLM 配置")}
          info={t("可跟随当前对话模型，也可选择 LM Studio 当前可使用的其他模型。")}
        >
          <ModelSelect
            value={draft.memory_retrieval_model_name}
            models={models}
            onChange={(value) => patch({ memory_retrieval_model_name: value })}
          />
        </Field>
        <Field label={t("相关性判断规则")} info={t("告诉模型如何判断一条记忆是否与当前问题相关。")}>
          <textarea
            rows={5}
            value={draft.memory_retrieval_prompt}
            onChange={(event) => patch({ memory_retrieval_prompt: event.target.value })}
          />
        </Field>
        <Field
          label={t("默认读取强度")}
          info={t(
            "关闭：不读取；保守/标准/宽泛：按下方预设筛选；全目录：分批检查全部目录；全部正文：在预算允许时注入全部正文。",
          )}
        >
          <select
            value={p5.retrieval_mode}
            onChange={(event) => patchP5({ retrieval_mode: event.target.value as RetrievalMode })}
          >
            {MODE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {t(label)}
              </option>
            ))}
          </select>
        </Field>
        <p className="hint">
          {t(
            "每档依次设置：候选目录数（先交给模型筛选的目录条数）、最终记忆数（筛选后注入正文的条数）、正文预算（这些正文合计最多占用的 token）和相关性要求。",
          )}
        </p>
        {(["conservative", "standard", "broad"] as const).map((key, index) => {
          const preset = p5.retrieval_presets[key];
          return (
            <Accordion
              key={key}
              title={`${["①", "②", "③"][index]} ${key === "conservative" ? "保守" : key === "standard" ? "标准" : "宽泛"}预设`}
            >
              <div className="field-grid">
                <Field label={t("候选目录数")}>
                  <NumberField
                    min={1}
                    max={10000}
                    value={preset.candidate_limit}
                    onChange={(value) =>
                      patchP5({
                        retrieval_presets: {
                          ...p5.retrieval_presets,
                          [key]: { ...preset, candidate_limit: value },
                        },
                      })
                    }
                  />
                </Field>
                <Field label={t("最终记忆数")}>
                  <NumberField
                    min={1}
                    max={10000}
                    value={preset.max_entries}
                    onChange={(value) =>
                      patchP5({
                        retrieval_presets: {
                          ...p5.retrieval_presets,
                          [key]: { ...preset, max_entries: value },
                        },
                      })
                    }
                  />
                </Field>
                <Field label={t("正文预算（token）")}>
                  <NumberField
                    min={1}
                    max={1048576}
                    value={preset.max_tokens}
                    onChange={(value) =>
                      patchP5({
                        retrieval_presets: {
                          ...p5.retrieval_presets,
                          [key]: { ...preset, max_tokens: value },
                        },
                      })
                    }
                  />
                </Field>
              </div>
              <Field label={t("相关性要求")}>
                <input
                  value={preset.relevance_instruction}
                  onChange={(event) =>
                    patchP5({
                      retrieval_presets: {
                        ...p5.retrieval_presets,
                        [key]: {
                          ...preset,
                          relevance_instruction: event.target.value,
                        },
                      },
                    })
                  }
                />
              </Field>
            </Accordion>
          );
        })}
      </Accordion>
      <Accordion title="② 整理配置" note={t("设置生成记忆使用的模型与规则。")}>
        <Field
          label={t("记忆整理功能使用的 LLM 配置")}
          info={t("负责把选中的完整对话轮次提炼为结构化长期记忆；也可选择其他可用模型。")}
        >
          <ModelSelect
            value={draft.memory_consolidation_model_name}
            models={models}
            onChange={(value) => patch({ memory_consolidation_model_name: value })}
          />
        </Field>
        <Field
          label={t("整理规则")}
          info={t("定义哪些信息值得长期保留，以及如何生成名称、简介、标签和正文。")}
        >
          <textarea
            rows={5}
            value={draft.memory_consolidation_prompt}
            onChange={(event) => patch({ memory_consolidation_prompt: event.target.value })}
          />
        </Field>
        <Field label={t("补充整理要求（可留空）")} info={t("只填写当前 Agent 特有的额外要求。")}>
          <textarea
            rows={4}
            value={draft.memory_consolidation_additional_instructions}
            onChange={(event) =>
              patch({
                memory_consolidation_additional_instructions: event.target.value,
              })
            }
          />
        </Field>
      </Accordion>
      <p className="hint">{t("读取与整理配置修改后，点击底部“保存当前分区配置”。")}</p>
      <h4 className="config-group-heading separated">{t("记忆管理")}</h4>
      <Accordion title="① 自动整理" note={t("按完整对话轮数自动整理；选项修改后立即保存。")}>
        <label className="check">
          <input
            type="checkbox"
            disabled={!policy}
            checked={policy?.auto_enabled ?? false}
            onChange={(event) =>
              policy &&
              void updatePolicy({
                auto_enabled: event.target.checked,
                every_turns: policy.every_turns,
                target_chars: policy.target_chars,
              })
            }
          />
          <span>
            <strong>{t("启用自动整理")}</strong>
            <small>
              {t("每隔指定完整轮数整理一次；以下字段改动后立即保存，不需要再点底部的保存按钮。")}
            </small>
          </span>
        </label>
        <div className="field-grid two">
          <Field label={t("触发间隔（完整轮数）")} info={t("范围 1—200，默认每 20 轮。")}>
            <NumberField
              min={1}
              max={200}
              disabled={!policy}
              value={policy?.every_turns ?? 20}
              onChange={(value) =>
                policy &&
                void updatePolicy({
                  auto_enabled: policy.auto_enabled,
                  every_turns: value,
                  target_chars: policy.target_chars,
                })
              }
            />
          </Field>
          <Field
            label={t("单条记忆正文长度（字符）")}
            info={t("范围 50—4000，控制整理结果正文长度。")}
          >
            <NumberField
              min={50}
              max={4000}
              disabled={!policy}
              value={policy?.target_chars ?? 300}
              onChange={(value) =>
                policy &&
                void updatePolicy({
                  auto_enabled: policy.auto_enabled,
                  every_turns: policy.every_turns,
                  target_chars: value,
                })
              }
            />
          </Field>
        </div>
      </Accordion>
      <Accordion title="② 手动整理" note={t("从某个会话里挑出完整轮次，手动整理成长期记忆。")}>
        <p className="hint">
          {t(
            "记忆统一归属于当前助手，它可以在任意会话中随时调取。已整理过的轮次可以重新选择再次整理，这不会重置自动整理进度。",
          )}
        </p>
        <Field label={t("第 1 步：来源会话")}>
          <select
            value={sourceSessionId}
            onChange={(event) => {
              setSourceSessionId(event.target.value);
              setSelectedTurns([]);
              clearMemoryTurns();
            }}
          >
            <option value="">{t("请选择会话")}</option>
            {memorySessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title}
              </option>
            ))}
          </select>
        </Field>
        <div className="field-grid two">
          <Field label={t("第 2 步：查看最近多少轮")}>
            <NumberField min={1} max={200} value={recentTurnCount} onChange={setRecentTurnCount} />
          </Field>
          <button
            type="button"
            className="align-field"
            onClick={() =>
              sourceSessionId
                ? void loadMemoryTurns(sourceSessionId, recentTurnCount)
                : setNotice({ feedback: t("请选择会话") })
            }
          >
            {t("加载可选择的轮次")}
          </button>
        </div>
        <fieldset className="choice-group">
          <legend>{t("第 3 步：勾选需要整理的完整轮次")}</legend>
          {memoryTurns.map((turn) => (
            <label key={turn.id} className="memory-row">
              <input
                type="checkbox"
                checked={selectedTurns.includes(turn.id)}
                onChange={(event) =>
                  setSelectedTurns((items) =>
                    event.target.checked
                      ? [...items, turn.id]
                      : items.filter((id) => id !== turn.id),
                  )
                }
              />
              <span>
                {t("序号")}
                {turn.sequence_no} · {turn.processed ? t("已整理") : t("未整理")}
                {t("· 用户：")}
                {turn.user.slice(0, 100)}
                {t("/ 回复：")}
                {turn.assistant.slice(0, 100)}
              </span>
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          className="primary"
          onClick={() =>
            sourceSessionId && selectedTurns.length
              ? void manualConsolidate(sourceSessionId, selectedTurns)
              : setNotice({ feedback: t("请选择会话并勾选轮次") })
          }
        >
          {t("第 4 步：开始整理所选轮次")}
        </button>
      </Accordion>
      <Accordion
        title="③ 记忆列表与治理"
        note={t("查看、整合、屏蔽、启用或永久删除已生成的记忆。")}
      >
        <div className="field-grid two">
          <Field label={t("列表页码")} info={t("每页最多 100 条。")}>
            <NumberField min={1} value={page} onChange={setPage} />
          </Field>
          <button
            type="button"
            className="align-field"
            onClick={() => {
              resetMemorySelection();
              void loadMemoryPage(page);
            }}
          >
            {t("加载记忆列表")}
          </button>
        </div>
        <fieldset className="choice-group">
          <legend>{t("勾选需要查看或治理的记忆")}</legend>
          {memoryEntries.map((entry) => (
            <label key={entry.id} className="memory-row">
              <input
                type="checkbox"
                checked={selectedMemories.includes(entry.id)}
                onChange={(event) => {
                  setSelectedMemories((items) =>
                    event.target.checked
                      ? [...items, entry.id]
                      : items.filter((id) => id !== entry.id),
                  );
                  setPurgeConfirmed(false);
                  clearMemoryDetail();
                }}
              />
              <span>
                {statusLabel[entry.status]} · {localTime(entry.created_at)} · {entry.name} —{" "}
                {entry.summary}
              </span>
            </label>
          ))}
        </fieldset>
        <button
          type="button"
          onClick={() =>
            selectedMemories.length
              ? void loadMemoryEntryDetail(selectedMemories[0])
              : setNotice({ feedback: t("请选择记忆") })
          }
        >
          {t("查看第一条已选记忆的详情")}
        </button>
        <Field label={t("记忆详情（只读）")}>
          <textarea rows={10} readOnly value={detailText} />
        </Field>
        <h4>{t("常用治理操作")}</h4>
        <div className="memory-toolbar">
          <button type="button" onClick={() => void merge()}>
            {t("整合为新记忆")}
          </button>
          <button type="button" onClick={() => void govern("suppress")}>
            {t("屏蔽（停止使用）")}
          </button>
          <button type="button" onClick={() => void govern("enable")}>
            {t("重新启用")}
          </button>
        </div>
        <p className="danger-note">
          <strong>{t("危险操作：")}</strong>
          {t("永久删除只删除所选记忆条目且不可恢复；派生记忆、摘要和原聊天保留。")}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={purgeConfirmed}
            onChange={(event) => setPurgeConfirmed(event.target.checked)}
          />
          <span>{t("我确认永久删除当前勾选的记忆条目")}</span>
        </label>
        <button type="button" className="danger" onClick={() => void govern("purge")}>
          {t("永久删除所选条目")}
        </button>
      </Accordion>
      <div className="memory-feedback">
        {feedback ||
          (editorAgentId === "__new__"
            ? t("请先创建或选择一个 Agent，这里会显示它的记忆设置。")
            : "")}
      </div>
    </div>
  );
}
