import { translateNotice, useI18n } from "../../i18n";
import type { AgentDraft } from "../../store";
import { useSuperstringStore } from "../../store";
import { Accordion } from "../../ui/Accordion";
import { Field } from "../../ui/Field";

export function SectionA({
  draft,
  patch,
  models,
}: {
  draft: AgentDraft;
  patch: (patch: Partial<AgentDraft>) => void;
  models: string[];
}) {
  const t = useI18n();
  const modelStatus = useSuperstringStore((state) => state.modelStatus);
  const refreshModels = useSuperstringStore((state) => state.refreshModels);
  const editorAgentId = useSuperstringStore((state) => state.editorAgentId);
  return (
    <div className="config-section">
      <h3>{t("A · 名称与模型")}</h3>
      <p>{t("模型与指令保存后从下一轮生效，不影响正在生成的回复。")}</p>
      <Accordion
        title="① 基本信息"
        note={t("名称、描述与启用状态。")}
        open={editorAgentId === "__new__"}
      >
        <Field label={t("助手名称")}>
          <input
            aria-label={t("助手名称")}
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>
        <Field label={t("描述")} info={t("仅供识别，不影响回复。")}>
          <textarea
            value={draft.description}
            onChange={(event) => patch({ description: event.target.value })}
            rows={3}
          />
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.is_active}
            onChange={(event) => patch({ is_active: event.target.checked })}
          />
          <span>
            <strong>{t("启用当前 Agent")}</strong>
            <small>{t("取消勾选并保存后，新会话不能再选择该 Agent；已有会话不受影响。")}</small>
          </span>
        </label>
      </Accordion>
      <Accordion title="② 基础指令" note={t("对该助手回复的补充要求。")}>
        <Field label={t("补充指令")} info={t("追加到人设与性格之后，影响该助手的回复。")}>
          <textarea
            rows={5}
            value={draft.additional_instructions}
            onChange={(event) => patch({ additional_instructions: event.target.value })}
          />
        </Field>
      </Accordion>
      <Accordion title="③ 本地模型" note={t("选择对话模型，调整回复随机度。")}>
        <Field label={t("对话模型")} info={t("来自 LM Studio 当前可用的模型。")}>
          <select
            value={draft.model_name}
            onChange={(event) => patch({ model_name: event.target.value })}
          >
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
            {!models.includes(draft.model_name) && (
              <option value={draft.model_name}>{draft.model_name}</option>
            )}
          </select>
        </Field>
        <button type="button" onClick={() => void refreshModels()}>
          {t("刷新模型列表")}
        </button>
        <p className="hint">{translateNotice(modelStatus)}</p>
        <Field
          label={t("回复随机度")}
          info={t("越低越稳定，越高越多样。对应 temperature，默认 0.7。")}
        >
          <div className="range-row">
            <input
              type="range"
              min="0"
              max="2"
              step="0.05"
              value={draft.temperature}
              onChange={(event) => patch({ temperature: Number(event.target.value) })}
            />
            <output>{draft.temperature.toFixed(2)}</output>
          </div>
        </Field>
      </Accordion>
      <Accordion title="④ 外部 API 模型接入">
        <div className="unavailable">
          <strong>{t("状态：暂未开放")}</strong>
          <Field label={t("服务地址")}>
            <input disabled placeholder={t("例如：https://api.example.com/v1")} />
          </Field>
          <Field label="API Key">
            <input disabled type="password" placeholder={t("启用安全存储后再配置")} />
          </Field>
          <Field label={t("模型名称")}>
            <input disabled placeholder={t("例如：provider-model-name")} />
          </Field>
        </div>
      </Accordion>
    </div>
  );
}
