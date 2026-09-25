import { useEffect } from "react";
import { useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Field } from "../../ui/Field";
import { modelOptionLabel } from "../models/model-availability";
import { knowledgeModelDirty } from "./types";

/** Shared revision, separate model/rule save whitelists. */
export function KnowledgeModelPage({ scope = "rules" }: { scope?: "model" | "rules" }) {
  const t = useI18n();
  const editor = useSuperstringStore((s) => s.knowledgeModelEditor);
  const busy = useSuperstringStore(
    (s) => s.settingsSaving || s.knowledgeModelLoading || s.knowledgeBusy,
  );
  const load = useSuperstringStore((s) => s.loadKnowledgeModel);
  const patchModel = useSuperstringStore((s) => s.patchKnowledgeModel);
  const patch = useSuperstringStore((s) => s.patchKnowledgeGlobal);
  const save = useSuperstringStore((s) => s.saveKnowledgeModel);
  const openRoute = useSuperstringStore((s) => s.openSettingsRoute);
  const models = useSuperstringStore((s) => s.modelNames);
  const availability = {
    loaded: useSuperstringStore((s) => s.loadedModelNames),
    external: useSuperstringStore((s) => s.externalModelNames),
  };
  const model = scope === "model";
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <SettingsGroup
      id={model ? "knowledge-model" : "knowledge-global"}
      title={model ? "知识库整理模型" : "全局整理与预算"}
      note={
        model
          ? "全局共享：不随助手切换，仅保存知识库模型。"
          : "对共享资料生效；助手可覆盖读取预算，不改变资料授权。"
      }
    >
      {!editor ? (
        <button type="button" disabled={busy} onClick={() => void load()}>
          {t("重试读取全局配置")}
        </button>
      ) : (
        <fieldset disabled={busy}>
          {model ? (
            <Field label={t("知识库整理模型")} info={t("未指定则继承共同默认；指定模型优先。")}>
              <select
                aria-label={t("知识库整理模型")}
                value={editor.modelName ?? ""}
                onChange={(e) => patchModel(e.target.value || null)}
              >
                <option value="">{t("继承默认模型")}</option>
                {[...new Set([...models, ...(editor.modelName ? [editor.modelName] : [])])].map(
                  (name) => (
                    <option key={name} value={name}>
                      {modelOptionLabel(name, availability, t)}
                    </option>
                  ),
                )}
              </select>
            </Field>
          ) : (
            <div className="knowledge-rule-grid">
              <div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={editor.autoEnabled ?? editor.source.auto_enabled}
                    onChange={(e) => patch({ autoEnabled: e.target.checked })}
                  />
                  <span>
                    <strong>{t("模型自动整理")}</strong>
                    <small>
                      {t("关闭后保留已有整理稿并使用原文；重新开启不改变手动原文偏好。")}
                    </small>
                  </span>
                </label>
                <button
                  className="model-settings-link"
                  type="button"
                  onClick={() => openRoute("models")}
                >
                  {t("前往默认模型")}
                </button>
              </div>
              <Field
                label={t("知识库上下文预算")}
                info={t("按 UTF-8 字节估算，包含资料格式与来源，仍受总上下文预算限制。")}
              >
                <input
                  aria-label={t("知识库上下文预算")}
                  type="number"
                  min={1}
                  step={1}
                  value={
                    Number.isNaN(editor.contextBudget)
                      ? ""
                      : (editor.contextBudget ?? editor.source.context_budget)
                  }
                  onChange={(e) => patch({ contextBudget: e.target.valueAsNumber })}
                />
              </Field>
            </div>
          )}
          <div className="workspace-links scope-save-row">
            <button
              className="primary"
              type="button"
              disabled={!knowledgeModelDirty(editor, scope)}
              onClick={() => void save(scope)}
            >
              {t(model ? "保存知识库模型" : "保存全局整理规则")}
            </button>
            <button type="button" onClick={() => void load(true)}>
              {t("刷新全局基线（保留草稿）")}
            </button>
            <span className="hint">
              {t(knowledgeModelDirty(editor, scope) ? "本组有未保存修改" : "本组已保存")}
            </span>
          </div>
          {knowledgeModelDirty(editor, scope) && (
            <p className="hint">
              {t(
                "已保存全局设置：整理 {0}；预算 {1}；模型 {2}；修订 {3}。",
                t(editor.source.auto_enabled ? "开启" : "整理已关闭"),
                editor.source.context_budget,
                editor.source.model_name ?? t("继承默认模型"),
                editor.source.revision,
              )}
            </p>
          )}
        </fieldset>
      )}
    </SettingsGroup>
  );
}
