import { useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { Field } from "../../ui/Field";
import { JobRunLink } from "../runs/RunInspector";

export function KnowledgeEditor() {
  const t = useI18n();
  const editor = useSuperstringStore((s) => s.knowledgeEditor);
  const categories = useSuperstringStore((s) => s.knowledgeCategories);
  const agents = useSuperstringStore((s) => s.agents);
  const openRoute = useSuperstringStore((s) => s.openSettingsRoute);
  const busy = useSuperstringStore(
    (s) => s.knowledgeBusy || s.knowledgeLoading || s.settingsSaving,
  );
  const update = useSuperstringStore((s) => s.updateKnowledgeEditor);
  const save = useSuperstringStore((s) => s.saveKnowledgeEditor);
  const requestEditor = useSuperstringStore((s) => s.requestKnowledgeEditor);
  if (!editor) return null;
  const title = {
    import: "导入资料",
    document: "查看与编辑资料",
    grants: "资料授权",
    settings: "知识库配置",
    "category-new": "新增分类",
    category: "重命名分类",
    batch: "批量授权",
  }[editor.kind];
  return (
    <section className="knowledge-editor" aria-label={t(title)}>
      <h3>{t(title)}</h3>
      {editor.kind === "document" && editor.source.latest_job_id && (
        <JobRunLink ownerKind="knowledge_job" ownerId={editor.source.latest_job_id} />
      )}
      <fieldset disabled={busy}>
        {"name" in editor && (
          <Field label={t(editor.kind.startsWith("category") ? "分类名称" : "资料名称")}>
            <input
              aria-label={t(editor.kind.startsWith("category") ? "分类名称" : "资料名称")}
              value={editor.name}
              maxLength={200}
              onChange={(e) => update({ ...editor, name: e.target.value })}
            />
          </Field>
        )}
        {(editor.kind === "import" || editor.kind === "document") && (
          <>
            <Field label={t("所属分类")}>
              <select
                aria-label={t("所属分类")}
                value={editor.category_id}
                onChange={(e) => update({ ...editor, category_id: e.target.value })}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            {editor.kind === "import" && (
              <>
                <Field label={t("上传 txt/md 文件")}>
                  <input
                    aria-label={t("上传 txt/md 文件")}
                    type="file"
                    accept=".txt,.md"
                    onChange={(e) => {
                      const file = e.target.files?.[0] ?? null;
                      update({
                        ...editor,
                        file,
                        name: editor.name || file?.name || "",
                      });
                    }}
                  />
                </Field>
                {editor.file && (
                  <button type="button" onClick={() => update({ ...editor, file: null })}>
                    {t("改用粘贴文本")}
                  </button>
                )}
                <p className="hint">{t("支持 UTF-8 文本，保留完整原文；导入后需另行授权。")}</p>
              </>
            )}
            {(editor.kind === "document" || !editor.file) && (
              <Field label={t("完整原文")}>
                <textarea
                  aria-label={t("完整原文")}
                  rows={12}
                  value={editor.original_text}
                  onChange={(e) => update({ ...editor, original_text: e.target.value })}
                />
              </Field>
            )}
            {editor.kind === "document" && (
              <>
                <Field label={t("内容模式")}>
                  <select
                    aria-label={t("内容模式")}
                    value={editor.content_mode}
                    onChange={(e) =>
                      update({
                        ...editor,
                        content_mode: e.target.value as "draft" | "original",
                      })
                    }
                  >
                    <option value="draft">{t("使用整理稿")}</option>
                    <option value="original">{t("使用原文")}</option>
                  </select>
                </Field>
                <p className="hint">
                  {t("原文修改后旧整理稿失效；内容模式对所有获授权助手生效。")}
                </p>
                <details className="group">
                  <summary>{t("查看整理稿与来源")}</summary>
                  {editor.source.draft ? (
                    <>
                      <pre className="knowledge-original">{editor.source.draft.body}</pre>
                      {editor.source.draft.sources.map(
                        (source) =>
                          source.type === "document" && (
                            <details
                              key={`${source.document_id}-${source.version}-${source.start}-${source.end}`}
                            >
                              <summary>
                                {t("原文区间")} [{source.start}, {source.end})
                              </summary>
                              <pre className="knowledge-original">
                                {source.version === editor.source.content_version
                                  ? editor.source.original_text.slice(source.start, source.end)
                                  : t("来源版本已失效")}
                              </pre>
                            </details>
                          ),
                      )}
                    </>
                  ) : (
                    <p className="hint">{t("暂无有效整理稿，使用原文。")}</p>
                  )}
                </details>
                <details className="group">
                  <summary>{t("已保存原文（只读）")}</summary>
                  <pre className="knowledge-original">{editor.source.original_text}</pre>
                </details>
              </>
            )}
          </>
        )}
        {editor.kind === "grants" && (
          <>
            <p>{editor.source.name}</p>
            <p className="hint">{t("仅授权当前资料，不含同分类其他资料。")}</p>
            {agents.map((agent) => (
              <label className="knowledge-check" key={agent.id}>
                <input
                  type="checkbox"
                  checked={editor.agent_ids.includes(agent.id)}
                  onChange={(e) =>
                    update({
                      ...editor,
                      agent_ids: e.target.checked
                        ? [...editor.agent_ids, agent.id]
                        : editor.agent_ids.filter((id) => id !== agent.id),
                    })
                  }
                />
                {agent.name}
                {!agent.is_active && ` ${t("（停用）")}`}
              </label>
            ))}
          </>
        )}
        {editor.kind === "batch" && (
          <>
            <p className="hint">{t("仅修改已选资料；以后新增或移入的资料不继承授权。")}</p>
            <ul>
              {editor.documents.map((document) => (
                <li key={document.id}>{document.name}</li>
              ))}
            </ul>
            <Field label={t("选择助手")}>
              <select
                aria-label={t("选择助手")}
                value={editor.agent_id}
                onChange={(e) => update({ ...editor, agent_id: e.target.value })}
              >
                <option value="">{t("选择助手")}</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <label className="knowledge-check">
              <input
                type="checkbox"
                checked={editor.granted}
                onChange={(e) => update({ ...editor, granted: e.target.checked })}
              />
              {t("授予访问权（取消勾选为撤销）")}
            </label>
          </>
        )}
        {editor.kind === "settings" && (
          <>
            <label className="knowledge-check">
              <input
                type="checkbox"
                checked={editor.auto_enabled}
                onChange={(e) => update({ ...editor, auto_enabled: e.target.checked })}
              />
              {t("模型自动整理")}
            </label>
            <p className="hint">
              {t("关闭后保留已有整理稿并使用原文；重新开启不改变手动原文偏好。")}
            </p>
            <button type="button" onClick={() => openRoute("knowledge-config")}>
              {t("前往默认模型")}
            </button>
            <Field label={t("知识库上下文预算")}>
              <input
                aria-label={t("知识库上下文预算")}
                type="number"
                min={1}
                step={1}
                value={editor.context_budget}
                onChange={(e) => update({ ...editor, context_budget: Number(e.target.value) })}
              />
            </Field>
            <p className="hint">
              {t("按 UTF-8 字节估算，包含资料格式与来源，仍受总上下文预算限制。")}
            </p>
          </>
        )}
        <div className="knowledge-toolbar">
          <button type="button" className="primary" onClick={() => void save()}>
            {t("保存")}
          </button>
          <button type="button" onClick={() => requestEditor({ kind: "none" })}>
            {t("关闭编辑")}
          </button>
        </div>
      </fieldset>
    </section>
  );
}
