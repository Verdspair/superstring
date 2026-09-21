import { useEffect } from "react";
import { KNOWLEDGE_PLANNED_FIELDS } from "../../app/settings-routes";
import { useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { Field } from "../../ui/Field";
import { knowledgeReadDirty } from "./types";

export function KnowledgeReadPage() {
  const t = useI18n();
  const agentId = useSuperstringStore((s) => s.editorAgentId);
  const loadingAgent = useSuperstringStore((s) => s.editorLoading);
  const editor = useSuperstringStore((s) => s.knowledgeReadEditor);
  const busy = useSuperstringStore(
    (s) => s.settingsSaving || s.knowledgeReadLoading || s.editorLoading || s.knowledgeBusy,
  );
  const load = useSuperstringStore((s) => s.loadKnowledgeRead);
  const refresh = useSuperstringStore((s) => s.refreshKnowledgeRead);
  const patch = useSuperstringStore((s) => s.patchKnowledgeRead);
  const save = useSuperstringStore((s) => s.saveKnowledgeRead);
  useEffect(() => {
    if (!loadingAgent && agentId !== "__new__") void load();
  }, [agentId, loadingAgent, load]);
  const current = editor?.agentId === agentId ? editor : null;
  const draft = current?.draft;
  const invalid =
    current?.draft.document_ids.filter((id) => !current.documents.some((d) => d.id === id)) ?? [];
  return (
    <div className="page-editor knowledge-read-page">
      {agentId === "__new__" ? (
        <p className="hint">{t("选择已有助手，或前往助手管理新建。")}</p>
      ) : !current || !draft ? (
        <button type="button" disabled={busy} onClick={() => void load()}>
          {t("重试读取知识库配置")}
        </button>
      ) : (
        <>
          <fieldset disabled={busy}>
            <section
              id="knowledge-read"
              className="knowledge-read-toggle"
              aria-label={t("知识库读取开关")}
            >
              <label className="check">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => patch({ enabled: e.target.checked })}
                />
                <span>{t("允许当前助手读取知识库")}</span>
              </label>
              <p className="hint">
                {t("关闭仅停止当前助手读取；授权、全局整理、预算与范围不变。")}
              </p>
            </section>
            <div className="knowledge-rule-grid">
              <section
                id="knowledge-budget"
                className="knowledge-subsection"
                aria-label={t("读取预算")}
              >
                <h4>{t("读取预算")}</h4>
                <Field label={t("预算来源")}>
                  <select
                    aria-label={t("预算来源")}
                    value={draft.context_budget === null ? "global" : "assistant"}
                    onChange={(e) =>
                      patch({
                        context_budget: e.target.value === "global" ? null : current.globalBudget,
                      })
                    }
                  >
                    <option value="global">{t("继承全局预算")}</option>
                    <option value="assistant">{t("为当前助手单独设置")}</option>
                  </select>
                </Field>
                {draft.context_budget !== null && (
                  <Field label={t("助手读取预算")}>
                    <input
                      aria-label={t("助手读取预算")}
                      type="number"
                      min={1}
                      step={1}
                      value={Number.isNaN(draft.context_budget) ? "" : draft.context_budget}
                      onChange={(e) => patch({ context_budget: e.target.valueAsNumber })}
                    />
                  </Field>
                )}
                <p className="hint">
                  {t("全局预算：{0}（按 UTF-8 字节近似 token）。", current.globalBudget)}
                </p>
                <p className="hint">{t("可高于全局默认值，但不超过对话剩余上下文。")}</p>
              </section>
              <section
                id="knowledge-scope"
                className="knowledge-subsection"
                aria-label={t("读取范围")}
              >
                <h4>{t("读取范围")}</h4>
                <Field label={t("资料范围")}>
                  <select
                    aria-label={t("资料范围")}
                    value={draft.scope}
                    onChange={(e) =>
                      patch({
                        scope: e.target.value === "all" ? "all" : "selected",
                      })
                    }
                  >
                    <option value="all">{t("全部已授权资料")}</option>
                    <option value="selected">{t("仅指定资料")}</option>
                  </select>
                </Field>
                <p className="hint">
                  {t(
                    draft.scope === "all"
                      ? "全部模式包含以后新增的授权资料；此页不会授予新权限。"
                      : "仅从已授权资料中选择；未选则不读取，不回退全部。",
                  )}
                </p>
                {draft.scope === "selected" && (
                  <>
                    {!current.documents.length && (
                      <p className="hint">{t("当前助手暂无已授权资料。")}</p>
                    )}
                    <div className="knowledge-read-options">
                      {current.documents.map((document) => (
                        <label className="check" key={document.id}>
                          <input
                            type="checkbox"
                            checked={draft.document_ids.includes(document.id)}
                            onChange={(e) =>
                              patch({
                                document_ids: e.target.checked
                                  ? [...draft.document_ids, document.id]
                                  : draft.document_ids.filter((id) => id !== document.id),
                              })
                            }
                          />
                          <span>{document.name}</span>
                        </label>
                      ))}
                    </div>
                    {invalid.length > 0 && (
                      <div role="alert">
                        <p>{t("部分指定资料已失效，请移除后保存；不会自动扩大读取范围。")}</p>
                        {invalid.map((id) => (
                          <label className="check" key={id}>
                            <input
                              type="checkbox"
                              checked
                              onChange={() =>
                                patch({
                                  document_ids: draft.document_ids.filter((item) => item !== id),
                                })
                              }
                            />
                            <span>{t("已失效资料：{0}", id)}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </section>
            </div>
            <div className="workspace-links scope-save-row">
              <button
                className="primary"
                type="button"
                disabled={!knowledgeReadDirty(current)}
                onClick={() => void save()}
              >
                {t(busy ? "正在保存页面…" : "保存助手读取配置")}
              </button>
              <button type="button" onClick={() => void refresh()}>
                {t("刷新基线与授权（保留草稿）")}
              </button>
            </div>
            <p className="hint">{t("刷新不提交草稿；冲突后请核对最新值再保存。")}</p>
            {knowledgeReadDirty(current) && (
              <p className="hint">
                {t(
                  "保存基线：修订 {0}；读取 {1}；预算 {2}；范围 {3}。",
                  current.source.revision,
                  t(current.source.config.enabled ? "读取已启用" : "读取已关闭"),
                  current.source.config.context_budget ?? t("继承全局预算"),
                  current.source.config.scope === "all"
                    ? t("全部已授权资料")
                    : current.source.config.document_ids
                        .map((id) => current.documents.find((d) => d.id === id)?.name ?? id)
                        .join(", ") || t("未选择资料"),
                )}
              </p>
            )}
          </fieldset>
          <p className="hint" role="status">
            {t(knowledgeReadDirty(current) ? "当前页有未保存修改" : "当前页已保存")}
          </p>
        </>
      )}
      <p className="hint knowledge-planned">
        {t("尚未开放的读取策略")}：{KNOWLEDGE_PLANNED_FIELDS.map((label) => t(label)).join(" / ")}
      </p>
    </div>
  );
}
