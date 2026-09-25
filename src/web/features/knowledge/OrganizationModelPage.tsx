import { useEffect, useState } from "react";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Field } from "../../ui/Field";
import { modelOptionLabel } from "../models/model-availability";
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
  const patchPurposes = useSuperstringStore((s) => s.patchOrganizationPurposes);
  const save = useSuperstringStore((s) => s.saveOrganization);
  const models = useSuperstringStore((s) => s.modelNames);
  const availability = {
    loaded: useSuperstringStore((s) => s.loadedModelNames),
    external: useSuperstringStore((s) => s.externalModelNames),
  };
  // 一键覆盖（用户 2026-09-25）作用于"正在配置的助手"，所以它跟着模型页的助手选择器走；正在新建
  // 的助手还没有可覆盖的配置，按钮因此不出现。
  const pageEditor = useSuperstringStore((s) => s.pageEditor);
  const editorAgentId = useSuperstringStore((s) => s.editorAgentId);
  const applyDefaultModel = useSuperstringStore((s) => s.applyDefaultModelToAgent);
  const [confirming, setConfirming] = useState(false);
  const target = pageEditor && editorAgentId !== "__new__" ? pageEditor : null;
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
                    {modelOptionLabel(name, availability, t)}
                  </option>
                ),
              )}
            </select>
          </Field>
          {/* 用户 2026-09-25：这个按钮就在「共同默认模型」旁边，作用是把当前助手的四个文本用途
              一次改成上面这个模型并立即保存；图片理解与语音转写不是助手的字段，不动。 */}
          <div className="model-page-toolbar">
            <button
              type="button"
              disabled={busy || !editor.modelName || !target}
              onClick={() => setConfirming(true)}
            >
              {t("一键覆盖当前助手的模型")}
            </button>
            <span className="hint">
              {!target
                ? t("先选中一个已有助手（上方助手选择器），才能覆盖它的模型。")
                : t(
                    "把当前助手「{0}」的对话、记忆读取、记忆整理与上下文压缩都改成这个默认模型，并立即保存。",
                    target.agent.name,
                  )}
            </span>
          </div>
          {confirming && target && editor.modelName !== null && (
            <ConfirmDialog
              message={t(
                "将把「{0}」的对话、记忆读取、记忆整理与上下文压缩都设为「{1}」并立即保存；图片理解与语音转写保持不变。",
                target.agent.name,
                editor.modelName,
              )}
              confirmLabel={t("覆盖并保存")}
              onCancel={() => setConfirming(false)}
              onConfirm={() => {
                setConfirming(false);
                void applyDefaultModel(editor.modelName ?? "");
              }}
            />
          )}
          {/* §7.1's media purposes: one answer for the whole QQ side. Unset is not "use the
              conversation model" — a text model would describe a picture it cannot see. */}
          <Field
            label={t("图片理解模型")}
            info={t("用于理解收到的图片与表情，以及为素材生成说明；未配置＝不能理解。")}
          >
            <select
              aria-label={t("图片理解模型")}
              value={editor.visionModelName ?? ""}
              onChange={(e) => patchPurposes({ visionModelName: e.target.value || null })}
            >
              <option value="">{t("未配置（不能理解图片）")}</option>
              {[
                ...new Set([
                  ...models,
                  ...(editor.visionModelName ? [editor.visionModelName] : []),
                ]),
              ].map((name) => (
                <option key={name} value={name}>
                  {modelOptionLabel(name, availability, t)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("语音转写模型")} info={t("用于把语音转成文字；未配置＝不能转写。")}>
            <select
              aria-label={t("语音转写模型")}
              value={editor.transcriptionModelName ?? ""}
              onChange={(e) => patchPurposes({ transcriptionModelName: e.target.value || null })}
            >
              <option value="">{t("未配置（不能转写语音）")}</option>
              {[
                ...new Set([
                  ...models,
                  ...(editor.transcriptionModelName ? [editor.transcriptionModelName] : []),
                ]),
              ].map((name) => (
                <option key={name} value={name}>
                  {modelOptionLabel(name, availability, t)}
                </option>
              ))}
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
              "已保存默认：{0}；图片理解：{1}；语音转写：{2}；修订 {3}。",
              editor.source.model_name ?? t("未指定"),
              editor.source.vision_model_name ?? t("未配置"),
              editor.source.transcription_model_name ?? t("未配置"),
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
