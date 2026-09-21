import { useI18n } from "../../i18n";
import type { AgentDraft } from "../../store";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Field } from "../../ui/Field";

export function SectionA({
  draft,
  patch,
}: {
  draft: AgentDraft;
  patch: (patch: Partial<AgentDraft>) => void;
}) {
  const t = useI18n();
  const navigate = useSuperstringStore((state) => state.openSettingsRoute);
  return (
    <div className="config-section">
      <SettingsGroup title="基本信息" note="名称、描述与启用状态。">
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
            <small>{t("停用并保存后，新会话不可选；已有会话不受影响。")}</small>
          </span>
        </label>
      </SettingsGroup>
      <SettingsGroup title="基础指令" note={t("对该助手回复的补充要求。")}>
        <Field label={t("补充指令")} info={t("追加到人设与性格之后，影响该助手的回复。")}>
          <textarea
            rows={5}
            value={draft.additional_instructions}
            onChange={(event) => patch({ additional_instructions: event.target.value })}
          />
        </Field>
      </SettingsGroup>
      <button type="button" onClick={() => navigate("models")}>
        {t("设置使用模型")}
      </button>
      <p className="hint">{t("对话模型与回复随机度在默认模型页设置；返回后继续创建助手。")}</p>
      <SettingsGroup title="外部 API 模型接入">
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
      </SettingsGroup>
    </div>
  );
}
