import { useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { type ModelPurpose, resolveModelUse } from "./model-use";

const sources = {
  agent: "助手单独指定",
  global: "全局单独指定",
  shared_default: "已保存的共同默认",
  chat: "跟随助手对话模型",
  bound_chat: "按每间会话绑定的助手决定",
  gateway: "使用网关默认模型",
  unloaded: "共同默认尚未读取",
  unconfigured: "未配置",
};

export function ModelUseHint({
  purpose,
  configured,
  saved,
  chatModel,
  savedChatModel,
}: {
  purpose: ModelPurpose;
  configured: string | null;
  saved: string | null;
  chatModel?: string;
  savedChatModel?: string;
}) {
  const t = useI18n();
  const sharedDefault = useSuperstringStore((state) => state.organizationEditor?.source.model_name);
  const actual = resolveModelUse(purpose, saved, savedChatModel, sharedDefault);
  const preview = resolveModelUse(purpose, configured, chatModel, sharedDefault);
  const scope = ["chat", "retrieval", "compression", "memory_organization"].includes(purpose)
    ? t("当前助手")
    : t("全局共享");
  const describe = (value: typeof actual) =>
    value.model ? t("{0}（{1}）", value.model, t(sources[value.source])) : t(sources[value.source]);
  return (
    <div className="model-use-hint">
      <p>{t("作用域：{0} · 当前生效：{1}", scope, describe(actual))}</p>
      {(configured !== saved || chatModel !== savedChatModel) && (
        <p>{t("未保存预览：{0}", describe(preview))}</p>
      )}
    </div>
  );
}
