import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { Accordion } from "../../ui/Accordion";
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
    <Card
      role="region"
      className="knowledge-editor gap-5 p-5 [&>h3]:text-base [&>h3]:font-semibold"
      aria-label={t(title)}
    >
      <h3>{t(title)}</h3>
      {editor.kind === "document" && editor.source.latest_job_id && (
        <JobRunLink ownerKind="knowledge_job" ownerId={editor.source.latest_job_id} />
      )}
      <fieldset className="min-w-0 space-y-5" disabled={busy}>
        {"name" in editor && (
          <Field label={t(editor.kind.startsWith("category") ? "分类名称" : "资料名称")}>
            <Input
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
              <NativeSelect
                className="w-full"
                aria-label={t("所属分类")}
                value={editor.category_id}
                onChange={(e) => update({ ...editor, category_id: e.target.value })}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            {editor.kind === "import" && (
              <>
                <Field label={t("上传 txt/md 文件")}>
                  <Input
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
                  <Button
                    variant="outline"
                    type="button"
                    onClick={() => update({ ...editor, file: null })}
                  >
                    {t("改用粘贴文本")}
                  </Button>
                )}
                <p className="hint text-sm leading-relaxed text-muted-foreground">
                  {t("支持 UTF-8 文本，保留完整原文；导入后需另行授权。")}
                </p>
              </>
            )}
            {(editor.kind === "document" || !editor.file) && (
              <Field label={t("完整原文")}>
                <Textarea
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
                  <NativeSelect
                    className="w-full"
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
                  </NativeSelect>
                </Field>
                <p className="hint text-sm leading-relaxed text-muted-foreground">
                  {t("原文修改后旧整理稿失效；内容模式对所有获授权助手生效。")}
                </p>
                <Accordion title={t("查看整理稿与来源")}>
                  {editor.source.draft ? (
                    <>
                      <pre className="knowledge-original whitespace-pre-wrap font-sans text-sm leading-relaxed">
                        {editor.source.draft.body}
                      </pre>
                      {editor.source.draft.sources.map(
                        (source) =>
                          source.type === "document" && (
                            <Accordion
                              key={`${source.document_id}-${source.version}-${source.start}-${source.end}`}
                              title={`${t("原文区间")} [${source.start}, ${source.end})`}
                            >
                              <pre className="knowledge-original whitespace-pre-wrap font-sans text-sm leading-relaxed">
                                {source.version === editor.source.content_version
                                  ? editor.source.original_text.slice(source.start, source.end)
                                  : t("来源版本已失效")}
                              </pre>
                            </Accordion>
                          ),
                      )}
                    </>
                  ) : (
                    <p className="hint text-sm leading-relaxed text-muted-foreground">
                      {t("暂无有效整理稿，使用原文。")}
                    </p>
                  )}
                </Accordion>
                <Accordion title={t("已保存原文（只读）")}>
                  <pre className="knowledge-original whitespace-pre-wrap font-sans text-sm leading-relaxed">
                    {editor.source.original_text}
                  </pre>
                </Accordion>
              </>
            )}
          </>
        )}
        {editor.kind === "grants" && (
          <>
            <p>{editor.source.name}</p>
            <p className="hint text-sm leading-relaxed text-muted-foreground">
              {t("仅授权当前资料，不含同分类其他资料。")}
            </p>
            {agents.map((agent) => (
              <Label
                className="knowledge-check flex min-h-8 items-center gap-3 text-sm"
                key={agent.id}
              >
                <Checkbox
                  aria-label={agent.name}
                  checked={editor.agent_ids.includes(agent.id)}
                  onCheckedChange={(checkedValue) =>
                    update({
                      ...editor,
                      agent_ids:
                        checkedValue === true
                          ? [...editor.agent_ids, agent.id]
                          : editor.agent_ids.filter((id) => id !== agent.id),
                    })
                  }
                />
                {agent.name}
                {!agent.is_active && ` ${t("（停用）")}`}
              </Label>
            ))}
          </>
        )}
        {editor.kind === "batch" && (
          <>
            <p className="hint text-sm leading-relaxed text-muted-foreground">
              {t("仅修改已选资料；以后新增或移入的资料不继承授权。")}
            </p>
            <ul>
              {editor.documents.map((document) => (
                <li key={document.id}>{document.name}</li>
              ))}
            </ul>
            <Field label={t("选择助手")}>
              <NativeSelect
                className="w-full"
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
              </NativeSelect>
            </Field>
            <Label className="knowledge-check flex min-h-8 items-center gap-3 text-sm">
              <Checkbox
                aria-label={t("授予访问权（取消勾选为撤销）")}
                checked={editor.granted}
                onCheckedChange={(checkedValue) =>
                  update({ ...editor, granted: checkedValue === true })
                }
              />
              {t("授予访问权（取消勾选为撤销）")}
            </Label>
          </>
        )}
        {editor.kind === "settings" && (
          <>
            <Label className="knowledge-check flex min-h-8 items-center gap-3 text-sm">
              <Checkbox
                aria-label={t("模型自动整理")}
                checked={editor.auto_enabled}
                onCheckedChange={(checkedValue) =>
                  update({ ...editor, auto_enabled: checkedValue === true })
                }
              />
              {t("模型自动整理")}
            </Label>
            <p className="hint text-sm leading-relaxed text-muted-foreground">
              {t("关闭后保留已有整理稿并使用原文；重新开启不改变手动原文偏好。")}
            </p>
            <Button variant="outline" type="button" onClick={() => openRoute("knowledge-config")}>
              {t("前往默认模型")}
            </Button>
            <Field label={t("知识库上下文预算")}>
              <Input
                aria-label={t("知识库上下文预算")}
                type="number"
                min={1}
                step={1}
                value={editor.context_budget}
                onChange={(e) => update({ ...editor, context_budget: Number(e.target.value) })}
              />
            </Field>
            <p className="hint text-sm leading-relaxed text-muted-foreground">
              {t("按 UTF-8 字节估算，包含资料格式与来源，仍受总上下文预算限制。")}
            </p>
          </>
        )}
        <div className="knowledge-toolbar flex flex-wrap items-center gap-3">
          <Button variant="default" type="button" className="primary" onClick={() => void save()}>
            {t("保存")}
          </Button>
          <Button variant="outline" type="button" onClick={() => requestEditor({ kind: "none" })}>
            {t("关闭编辑")}
          </Button>
        </div>
      </fieldset>
    </Card>
  );
}
