import { useEffect } from "react";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Field } from "../../ui/Field";
import { organizationDirty } from "./types";

export function OrganizationModelPage() {
  const t = useI18n();
  const editor = useSuperstringStore((s) => s.organizationEditor);
  const busy = useSuperstringStore(
    (s) => s.settingsSaving || s.organizationLoading || s.knowledgeBusy,
  );
  const loading = useSuperstringStore((s) => s.organizationLoading);
  const error = useSuperstringStore((s) => s.organizationError);
  const load = useSuperstringStore((s) => s.loadOrganization);
  const patch = useSuperstringStore((s) => s.patchOrganization);
  const save = useSuperstringStore((s) => s.saveOrganization);
  const models = useSuperstringStore((s) => s.modelNames);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <SettingsGroup
      id="organization-default"
      title="共同整理默认值"
      note="全局默认：记忆整理与知识库整理共用，不随助手切换。"
    >
      <p className="hint">{t("已有明确覆盖优先；对话、记忆检索与上下文压缩仍独立配置。")}</p>
      {error && (
        <p className="error" role="alert">
          {t("共同默认模型读取失败：{0}", translateNotice(error))}
        </p>
      )}
      {!editor ? (
        loading ? (
          <p className="hint" role="status">
            {t("正在读取共同默认模型…")}
          </p>
        ) : (
          <button type="button" disabled={busy} onClick={() => void load()}>
            {t("重试读取共同默认模型")}
          </button>
        )
      ) : (
        <fieldset disabled={busy}>
          <Field
            label={t("共同默认模型")}
            info={t(
              "未指定时，记忆整理跟随助手对话模型，知识库整理跟随网关默认模型。不会自动加载模型。",
            )}
          >
            <select
              aria-label={t("共同默认模型")}
              value={editor.modelName ?? ""}
              onChange={(e) => patch(e.target.value || null)}
            >
              <option value="">{t("未指定（保留原有回退规则）")}</option>
              {[...new Set([...models, ...(editor.modelName ? [editor.modelName] : [])])].map(
                (name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ),
              )}
            </select>
          </Field>
          <div className="workspace-links">
            <button
              className="primary"
              type="button"
              disabled={!organizationDirty(editor)}
              onClick={() => void save()}
            >
              {t("保存默认模型")}
            </button>
            <button type="button" onClick={() => void load(true)}>
              {t("刷新全局基线（保留草稿）")}
            </button>
          </div>
          <p className="hint">
            {t(
              "已保存默认：{0}；修订 {1}。",
              editor.source.model_name ?? t("未指定"),
              editor.source.revision,
            )}
          </p>
          <p className="hint" role="status">
            {t(organizationDirty(editor) ? "当前页有未保存修改" : "当前页已保存")}
          </p>
        </fieldset>
      )}
    </SettingsGroup>
  );
}
