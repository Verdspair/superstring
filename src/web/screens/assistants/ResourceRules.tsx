import { BookOpen, Brain, FileText } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "@/components/form-field";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { agentPageDirty } from "@/features/agents/page-drafts";
import { knowledgeModelDirty, knowledgeReadDirty } from "@/features/knowledge/types";
import { translateNotice } from "@/i18n";
import { useSuperstringStore } from "@/store";

const MODES = {
  off: "library.retrieval.off",
  conservative: "library.conservative",
  standard: "library.standard",
  broad: "library.broad",
} as const;
// 三个预设默认全部展开，额度字段直接可见。
const PRESET_MODES = ["conservative", "standard", "broad"] as const;

/** 记忆工具设置：只拥有 retrieval_mode / retrieval_presets，正文在资料库的记忆分区管理。 */
export function MemoryToolSettings() {
  const s = useSuperstringStore();
  const t = useTranslation().t;
  const editor = s.pageEditor;
  if (!editor) return <p role="status">{t("library.loading")}</p>;
  const p5 = editor.draft.p5_config;
  const legacyFull = p5.retrieval_mode === "full_catalog" || p5.retrieval_mode === "full_body";
  const patch = (value: Partial<typeof p5>) =>
    s.patchPageAgent("memory-tools", { p5_config: { ...p5, ...value } });
  const dirty = agentPageDirty(editor, "memory-tools");
  const busy = s.settingsSaving || s.editorLoading || s.knowledgeReadLoading;
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain className="size-4" />
          {t("library.memory.retrieval")}
        </CardTitle>
        <CardDescription>
          {t("library.these.rules.belong.to.this.agent.manage.memory.content")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <Field label="library.memory.tools.mode">
          <NativeSelect
            disabled={busy}
            value={legacyFull ? "broad" : p5.retrieval_mode}
            onChange={(e) => patch({ retrieval_mode: e.target.value as keyof typeof MODES })}
          >
            {Object.entries(MODES).map(([value, name]) => (
              <option key={value} value={value}>
                {t(name)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {legacyFull && (
          <p className="text-sm text-muted-foreground">
            {t("library.memory.tools.legacy.full", { "0": p5.retrieval_mode })}
            <Button
              variant="link"
              size="sm"
              disabled={busy}
              onClick={() => patch({ retrieval_mode: "broad" })}
            >
              {t("library.memory.tools.use.broad")}
            </Button>
          </p>
        )}
        <p className="text-sm text-muted-foreground">{t("library.memory.tools.on.demand")}</p>
        <Accordion type="multiple" defaultValue={[...PRESET_MODES]}>
          {PRESET_MODES.map((mode) => {
            const preset = p5.retrieval_presets[mode];
            return (
              <AccordionItem key={mode} value={mode}>
                <AccordionTrigger>{t(MODES[mode])}</AccordionTrigger>
                <AccordionContent className="space-y-4 pt-2">
                  <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                    {(["candidate_limit", "max_entries", "max_tokens"] as const).map((key) => (
                      <div
                        key={key}
                        className={key === "max_tokens" ? "min-w-0 sm:col-span-2" : "min-w-0"}
                      >
                        <Field
                          label={
                            {
                              candidate_limit: "library.memory.tools.scan.limit",
                              max_entries: "library.memory.tools.page.limit",
                              max_tokens: "library.memory.tools.turn.budget",
                            }[key]
                          }
                        >
                          <Input
                            type="number"
                            disabled={busy}
                            min={1}
                            max={
                              key === "max_tokens"
                                ? 1048576
                                : key === "candidate_limit"
                                  ? 300
                                  : Math.min(100, preset.candidate_limit)
                            }
                            value={preset[key]}
                            onChange={(e) =>
                              patch({
                                retrieval_presets: {
                                  ...p5.retrieval_presets,
                                  [mode]: { ...preset, [key]: Number(e.target.value) },
                                },
                              })
                            }
                          />
                        </Field>
                      </div>
                    ))}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t("library.memory.tools.limits.hint")}
                  </p>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
        {s.error && (
          <p role="alert" className="text-sm text-destructive">
            {translateNotice(s.error)}
          </p>
        )}
        {s.feedback && !s.error && (
          <p role="status" className="text-sm text-muted-foreground">
            {translateNotice(s.feedback)}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
          {/* 草稿安全跳转：不隐式保存，草稿保留。 */}
          <Button
            variant="link"
            size="sm"
            className="mr-auto"
            onClick={() => s.openSettingsRoute("long-memory")}
          >
            {t("connections.goToLongTermMemory")}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void s.refreshSettingsAgent()}>
            {t("capabilities.resources.refreshBaseline")}
          </Button>
          <Button
            variant="outline"
            disabled={!dirty || busy}
            onClick={() => s.discardSettingsPages("memory-tools")}
          >
            {t("library.discard.changes")}
          </Button>
          <Button disabled={!dirty || busy} onClick={() => void s.saveSettingsPage("memory-tools")}>
            {t("library.save.memory.rules")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** 知识工具设置：只读写 knowledgeReadEditor 草稿；资料正文仍归资料库文档分区。
 *  全局默认预算独立成组，与默认模型页共用 knowledgeModelEditor（预算只有一个真源）。 */
export function KnowledgeToolSettings() {
  const s = useSuperstringStore();
  const t = useTranslation().t;
  useEffect(() => {
    if (s.editorAgentId !== "__new__") {
      // 知识读取配置独立于助手页面草稿加载与保存；资料正文仍在资料库的文档分区管理。
      void s.loadKnowledgeRead();
      // 全局默认预算与知识整理模型共用同一编辑器；此处只编辑预算字段。
      void s.loadKnowledgeModel();
    }
  }, [s.editorAgentId, s.loadKnowledgeRead, s.loadKnowledgeModel]);
  const editor = s.pageEditor;
  if (!editor) return <p role="status">{t("library.loading")}</p>;
  const read = s.knowledgeReadEditor?.agentId === editor.agent.id ? s.knowledgeReadEditor : null;
  const global = s.knowledgeModelEditor;
  const busy =
    s.settingsSaving || s.editorLoading || s.knowledgeReadLoading || s.knowledgeModelLoading;
  return (
    <>
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="size-4" />
            {t("library.knowledge.access")}
          </CardTitle>
          <CardDescription>
            {t("library.document.grants.determine.visibility.this.agent.s.reading.rules")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {!read ? (
            !s.knowledgeReadLoading && s.error ? (
              <div className="flex justify-end">
                {/* 首次加载失败保留一个可重试的加载入口，而不是停在加载态。 */}
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void s.loadKnowledgeRead()}
                >
                  {t("library.refresh.grants")}
                </Button>
              </div>
            ) : (
              <p role="status">{t("library.loading")}</p>
            )
          ) : (
            <>
              <Field label="library.enable.knowledge.reading">
                <Checkbox
                  disabled={busy}
                  checked={read.draft.enabled}
                  onCheckedChange={(v) => s.patchKnowledgeRead({ enabled: v === true })}
                />
              </Field>
              <Field
                label="library.knowledge.tools.budget"
                info={t("library.knowledge.tools.budget.hint", { "0": read.globalBudget })}
              >
                <Input
                  type="number"
                  disabled={busy}
                  min={1}
                  value={read.draft.context_budget ?? ""}
                  onChange={(e) =>
                    s.patchKnowledgeRead({
                      context_budget: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
              </Field>
              <Field label="library.reading.scope">
                <NativeSelect
                  disabled={busy}
                  value={read.draft.scope}
                  onChange={(e) =>
                    s.patchKnowledgeRead({
                      scope: e.target.value as "all" | "selected",
                      document_ids: e.target.value === "all" ? [] : read.draft.document_ids,
                    })
                  }
                >
                  <option value="all">{t("library.all.authorized.documents")}</option>
                  <option value="selected">{t("library.selected.documents.only")}</option>
                </NativeSelect>
              </Field>
              {read.draft.scope === "selected" && (
                <div className="space-y-2 rounded-xl border p-3">
                  {read.documents.map((doc) => (
                    <label
                      htmlFor={`knowledge-read-${doc.id}`}
                      key={doc.id}
                      className="flex gap-3 rounded-lg p-2 hover:bg-muted"
                    >
                      <Checkbox
                        id={`knowledge-read-${doc.id}`}
                        aria-label={doc.name}
                        disabled={busy}
                        checked={read.draft.document_ids.includes(doc.id)}
                        onCheckedChange={(v) =>
                          s.patchKnowledgeRead({
                            document_ids:
                              v === true
                                ? [...read.draft.document_ids, doc.id]
                                : read.draft.document_ids.filter((id) => id !== doc.id),
                          })
                        }
                      />
                      <span className="min-w-0 text-sm">
                        {doc.name}
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {doc.summary}
                        </span>
                      </span>
                    </label>
                  ))}
                  {read.draft.document_ids
                    .filter((id) => !read.documents.some((doc) => doc.id === id))
                    .map((id) => (
                      <div key={id} className="flex items-center gap-2">
                        <Badge variant="destructive">{t("library.authorization.expired")}</Badge>
                        <code className="min-w-0 flex-1 truncate text-xs">{id}</code>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            s.patchKnowledgeRead({
                              document_ids: read.draft.document_ids.filter((other) => other !== id),
                            })
                          }
                        >
                          {t("library.remove")}
                        </Button>
                      </div>
                    ))}
                  {read.draft.document_ids.length === 0 && (
                    <p className="p-2 text-sm text-muted-foreground">
                      {t("library.no.documents.selected.this.mode.will.not.read.any")}
                    </p>
                  )}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
                {/* 草稿安全跳转：不隐式保存，草稿保留。 */}
                <Button
                  variant="link"
                  size="sm"
                  className="mr-auto"
                  onClick={() => s.openSettingsRoute("knowledge-config")}
                >
                  <FileText />
                  {t("capabilities.resources.openKnowledgeDocuments")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!knowledgeReadDirty(read) || busy}
                  onClick={() => void s.refreshKnowledgeRead()}
                >
                  {t("library.refresh.grants")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!knowledgeReadDirty(read) || busy}
                  onClick={() => {
                    s.discardKnowledgeRead();
                    void s.loadKnowledgeRead();
                  }}
                >
                  {t("library.discard.changes")}
                </Button>
                <Button
                  disabled={!knowledgeReadDirty(read) || busy}
                  onClick={() => void s.saveKnowledgeRead()}
                >
                  {t("library.save.knowledge.rules")}
                </Button>
              </div>
            </>
          )}
          {s.error && (
            <p role="alert" className="text-sm text-destructive">
              {translateNotice(s.error)}
            </p>
          )}
          {s.feedback && !s.error && (
            <p role="status" className="text-sm text-muted-foreground">
              {translateNotice(s.feedback)}
            </p>
          )}
        </CardContent>
      </Card>
      {/* 全局默认预算：与知识整理模型共用 knowledgeModelEditor 真源，只提交预算字段。 */}
      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="size-4" />
            {t("library.knowledge.global.budget")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {!global ? (
            !s.knowledgeModelLoading && s.error ? (
              <div className="flex justify-end">
                {/* 首次加载失败保留重试入口；上限未知时不渲染输入。 */}
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void s.loadKnowledgeModel(true)}
                >
                  {t("capabilities.resources.refreshBaseline")}
                </Button>
              </div>
            ) : (
              <p role="status">{t("library.loading")}</p>
            )
          ) : (
            <>
              <Field label="library.workspace.knowledge.budget.tokens">
                <Input
                  type="number"
                  disabled={busy}
                  min={1}
                  value={global.contextBudget ?? ""}
                  onChange={(e) =>
                    s.patchKnowledgeGlobal({ contextBudget: Number(e.target.value) })
                  }
                />
              </Field>
              <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void s.loadKnowledgeModel(true)}
                >
                  {t("capabilities.resources.refreshBaseline")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!knowledgeModelDirty(global, "budget") || busy}
                  onClick={() => s.discardKnowledgeModel("budget")}
                >
                  {t("library.discard.knowledge.budget")}
                </Button>
                <Button
                  disabled={!knowledgeModelDirty(global, "budget") || busy}
                  onClick={() => void s.saveKnowledgeModel("budget")}
                >
                  {t("library.save.knowledge.budget")}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </>
  );
}
