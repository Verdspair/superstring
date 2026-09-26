import { BookOpen, Brain } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { knowledgeReadDirty } from "@/features/knowledge/types";
import { useSuperstringStore } from "@/store";

const MODES = {
  off: "library.retrieval.off",
  conservative: "library.conservative",
  standard: "library.standard",
  broad: "library.broad",
  full_catalog: "library.full.catalog",
  full_body: "library.full.body",
} as const;
export function ResourceRules() {
  const s = useSuperstringStore();
  const t = useTranslation().t;
  useEffect(() => {
    if (s.editorAgentId !== "__new__") {
      // 记忆整理策略（自动整理/轮数/目标字符）自 2026-09-26 起在资料库→记忆的网页分区编辑，
      // 这里不再加载它；本页只留读取规则与知识访问。
      void s.loadKnowledgeRead();
    }
  }, [s.editorAgentId, s.loadKnowledgeRead]);
  const editor = s.pageEditor;
  if (!editor) return null;
  const d = editor.draft,
    p5 = d.p5_config;
  const patch = (value: Partial<typeof p5>) =>
    s.patchPageAgent("long-memory", { p5_config: { ...p5, ...value } });
  const read = s.knowledgeReadEditor?.agentId === editor.agent.id ? s.knowledgeReadEditor : null;
  return (
    <div className="grid items-start gap-6 xl:grid-cols-2">
      <div className="space-y-6">
        <Card>
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
            <Field label="library.retrieval.mode">
              <NativeSelect
                value={p5.retrieval_mode}
                onChange={(e) =>
                  patch({ retrieval_mode: e.target.value as typeof p5.retrieval_mode })
                }
              >
                {Object.entries(MODES).map(([value, name]) => (
                  <option key={value} value={value}>
                    {t(name)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <p className="text-sm text-muted-foreground">
              {t("library.conservative.standard.and.broad.modes.use.their.own.candidate")}
            </p>
            <Accordion type="multiple">
              {(["conservative", "standard", "broad"] as const).map((mode) => {
                const preset = p5.retrieval_presets[mode];
                return (
                  <AccordionItem key={mode} value={mode}>
                    <AccordionTrigger>
                      {t(MODES[mode])} · {preset.candidate_limit} / {preset.max_entries} /{" "}
                      {preset.max_tokens}
                    </AccordionTrigger>
                    <AccordionContent className="space-y-4 pt-2">
                      <div className="grid gap-4 sm:grid-cols-3">
                        {(["candidate_limit", "max_entries", "max_tokens"] as const).map((key) => (
                          <Field
                            key={key}
                            label={
                              {
                                candidate_limit: "library.candidate.count",
                                max_entries: "library.entries.to.read",
                                max_tokens: "library.reading.tokens",
                              }[key]
                            }
                          >
                            <Input
                              type="number"
                              min={1}
                              max={key === "max_tokens" ? 1048576 : 10000}
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
                        ))}
                      </div>
                      <Field label="library.relevance.instructions">
                        <Textarea
                          rows={3}
                          value={preset.relevance_instruction}
                          onChange={(e) =>
                            patch({
                              retrieval_presets: {
                                ...p5.retrieval_presets,
                                [mode]: { ...preset, relevance_instruction: e.target.value },
                              },
                            })
                          }
                        />
                      </Field>
                    </AccordionContent>
                  </AccordionItem>
                );
              })}
              <AccordionItem value="catalog">
                <AccordionTrigger>{t("library.catalog.prompts")}</AccordionTrigger>
                <AccordionContent className="space-y-4 pt-2">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="library.maximum.catalog.batches">
                      <Input
                        type="number"
                        min={1}
                        max={10000}
                        value={p5.max_catalog_batches}
                        onChange={(e) => patch({ max_catalog_batches: Number(e.target.value) })}
                      />
                    </Field>
                    <Field label="library.catalog.entries.per.batch">
                      <Input
                        type="number"
                        min={1}
                        max={10000}
                        value={p5.catalog_batch_size}
                        onChange={(e) => patch({ catalog_batch_size: Number(e.target.value) })}
                      />
                    </Field>
                  </div>
                  <Field label="library.memory.retrieval.prompt">
                    <Textarea
                      rows={6}
                      value={d.memory_retrieval_prompt}
                      onChange={(e) =>
                        s.patchPageAgent("long-memory", { memory_retrieval_prompt: e.target.value })
                      }
                    />
                  </Field>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      </div>
      <Card>
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
            <p role="status">{t("library.loading")}</p>
          ) : (
            <>
              <Field label="library.enable.knowledge.reading">
                <Checkbox
                  checked={read.draft.enabled}
                  onCheckedChange={(v) => s.patchKnowledgeRead({ enabled: v === true })}
                />
              </Field>
              <Field
                label="library.knowledge.budget.blank.to.use.workspace.default"
                info={t("library.workspace.budget.value.tokens", { "0": read.globalBudget })}
              >
                <Input
                  type="number"
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
              <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
                <Button variant="outline" onClick={() => void s.refreshKnowledgeRead()}>
                  {t("library.refresh.grants")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!knowledgeReadDirty(read)}
                  onClick={() => {
                    s.discardKnowledgeRead();
                    void s.loadKnowledgeRead();
                  }}
                >
                  {t("library.discard.changes")}
                </Button>
                <Button
                  disabled={!knowledgeReadDirty(read) || s.settingsSaving}
                  onClick={() => void s.saveKnowledgeRead()}
                >
                  {t("library.save.knowledge.rules")}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
