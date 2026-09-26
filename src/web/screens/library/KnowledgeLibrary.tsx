import { FileText, FolderPlus, Plus, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertDialog } from "@/components/confirmation";
import { Field } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useSuperstringStore } from "@/store";
import type { KnowledgeCategory } from "../../../shared/contracts/knowledge";
import { JobRunLink } from "../runs/RunEntry";

export function KnowledgeLibrary() {
  const s = useSuperstringStore(),
    t = useTranslation().t;
  const [search, setSearch] = useState(""),
    [category, setCategory] = useState("all"),
    [status, setStatus] = useState("all"),
    [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<{
      kind: "document" | "category";
      id: string;
      name: string;
      revision: number;
    } | null>(null),
    [moveTo, setMoveTo] = useState("default");
  useEffect(() => {
    void s.loadKnowledge();
  }, [s.loadKnowledge]);
  const docs = s.knowledgeDocuments.filter(
    (doc) =>
      (category === "all" || doc.category_id === category) &&
      (status === "all" || doc.organization_status === status) &&
      `${doc.name} ${doc.summary} ${doc.tags.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const activeCategory = s.knowledgeCategories.find((item) => item.id === category);
  return (
    <section className="space-y-4" aria-label={t("library.document.library")}>
      <div className="flex flex-wrap gap-2">
        <Input
          className="min-w-48 flex-1"
          aria-label={t("library.search.documents")}
          placeholder={t("library.search.titles.summaries.or.tags")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <NativeSelect
          aria-label={t("library.filter.categories")}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="all">{t("library.all.categories")}</option>
          {s.knowledgeCategories.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} ({item.document_count})
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label={t("library.organization.status")}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="all">{t("library.all.statuses")}</option>
          {["pending", "queued", "running", "succeeded", "failed", "cancelled", "disabled"].map(
            (item) => (
              <option key={item} value={item}>
                {t(`library.status.${item}`)}
              </option>
            ),
          )}
        </NativeSelect>
        <Button
          variant="outline"
          disabled={s.knowledgeLoading || s.knowledgeDirty || s.knowledgeBusy}
          onClick={() => void s.loadKnowledge()}
        >
          <RefreshCw />
          {t("library.refresh")}
        </Button>
        <Button onClick={() => s.requestKnowledgeEditor({ kind: "import" })}>
          <Plus />
          {t("library.import.document")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="secondary">
          {docs.length} {t("library.documents")}
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => s.requestKnowledgeEditor({ kind: "category-new" })}
        >
          <FolderPlus />
          {t("library.new.category")}
        </Button>
        {activeCategory && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => s.requestKnowledgeEditor({ kind: "category", id: activeCategory.id })}
            >
              {t("library.rename.category")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={s.knowledgeCategories.length < 2}
              onClick={() => {
                setMoveTo(
                  s.knowledgeCategories.find((item) => item.id !== activeCategory.id)?.id ?? "",
                );
                setDeleting({ kind: "category", ...activeCategory });
              }}
            >
              {t("library.delete.category")}
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => s.requestKnowledgeEditor({ kind: "settings" })}
        >
          <Settings2 />
          {t("library.organization.workspace.budget")}
        </Button>
      </div>
      {selected.length > 0 && (
        <div className="flex items-center gap-3 rounded-lg bg-primary/5 p-3">
          <span className="text-sm">{t("library.value.selected", { "0": selected.length })}</span>
          <Button
            size="sm"
            onClick={() => s.requestKnowledgeEditor({ kind: "batch", ids: selected })}
          >
            {t("library.batch.access")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected([])}>
            {t("library.clear.selection")}
          </Button>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label={t("library.select.current.results")}
                  checked={docs.length > 0 && docs.every((doc) => selected.includes(doc.id))}
                  onCheckedChange={(v) => setSelected(v === true ? docs.map((doc) => doc.id) : [])}
                />
              </TableHead>
              <TableHead>{t("library.documents")}</TableHead>
              <TableHead>{t("library.reading.version")}</TableHead>
              <TableHead>{t("library.organization.status")}</TableHead>
              <TableHead>{t("library.agent.access")}</TableHead>
              <TableHead className="w-32">{t("library.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {docs.map((doc) => (
              <TableRow key={doc.id}>
                <TableCell>
                  <Checkbox
                    aria-label={t("library.select.value", { "0": doc.name })}
                    checked={selected.includes(doc.id)}
                    onCheckedChange={(v) =>
                      setSelected((ids) =>
                        v === true ? [...ids, doc.id] : ids.filter((id) => id !== doc.id),
                      )
                    }
                  />
                </TableCell>
                <TableCell className="max-w-lg">
                  <Button
                    variant="link"
                    className="h-auto justify-start p-0 font-medium"
                    onClick={() => s.requestKnowledgeEditor({ kind: "document", id: doc.id })}
                  >
                    <FileText />
                    {doc.name}
                  </Button>
                  <p className="mt-1 line-clamp-2 whitespace-normal text-xs text-muted-foreground">
                    {doc.summary}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {doc.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">
                    {t(
                      doc.content_mode === "original"
                        ? "library.original"
                        : "library.organized.draft",
                    )}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className={doc.error_code ? "text-destructive" : "text-muted-foreground"}>
                    {t(`library.status.${doc.organization_status}`)}
                  </span>
                  {doc.error_code && (
                    <p className="max-w-40 whitespace-normal text-xs">{doc.error_code}</p>
                  )}
                  {doc.latest_job_id && (
                    <div>
                      <JobRunLink ownerKind="knowledge_job" ownerId={doc.latest_job_id} />
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => s.requestKnowledgeEditor({ kind: "grants", id: doc.id })}
                  >
                    {doc.agent_ids.length} {t("library.assistant")}
                  </Button>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("library.delete.value", { "0": doc.name })}
                    onClick={() =>
                      setDeleting({
                        kind: "document",
                        id: doc.id,
                        name: doc.name,
                        revision: doc.revision,
                      })
                    }
                  >
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {!docs.length && (
        <p className="py-12 text-center text-muted-foreground">
          {t("library.no.matching.documents.import.text.txt.or.markdown.files")}
        </p>
      )}
      <KnowledgeEditorPanel />
      {deleting && (
        <AlertDialog
          title={t("library.delete.value.2", { "0": deleting.name })}
          onCancel={() => setDeleting(null)}
          busy={s.knowledgeBusy}
        >
          <p className="text-sm text-muted-foreground">
            {t(
              deleting.kind === "category"
                ? "library.documents.in.this.category.will.move.to.the.selected"
                : "library.the.document.and.its.grants.will.be.deleted.this",
            )}
          </p>
          {deleting.kind === "category" && (
            <Field label="library.move.documents.to">
              <NativeSelect value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                {s.knowledgeCategories
                  .filter((c) => c.id !== deleting.id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </NativeSelect>
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-dialog-cancel onClick={() => setDeleting(null)}>
              {t("library.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={s.knowledgeBusy}
              onClick={() => {
                void s
                  .deleteKnowledgeItem(
                    deleting.kind,
                    deleting.id,
                    deleting.revision,
                    deleting.kind === "category" ? moveTo : undefined,
                  )
                  .then((ok) => {
                    if (ok) {
                      setDeleting(null);
                      setSelected((ids) => ids.filter((id) => id !== deleting.id));
                      if (deleting.kind === "category") setCategory("all");
                    }
                  });
              }}
            >
              {t("library.confirm.delete")}
            </Button>
          </div>
        </AlertDialog>
      )}
    </section>
  );
}

function CategorySelect({
  value,
  categories,
  onChange,
}: {
  value: string;
  categories: KnowledgeCategory[];
  onChange: (id: string) => void;
}) {
  return (
    <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
      {categories.map((category) => (
        <option key={category.id} value={category.id}>
          {category.name}
        </option>
      ))}
    </NativeSelect>
  );
}
function KnowledgeEditorPanel() {
  const s = useSuperstringStore(),
    t = useTranslation().t,
    editor = s.knowledgeEditor;
  const titles = {
    import: "library.import.document",
    document: "library.document.workbench",
    grants: "library.agent.access",
    settings: "library.organization.workspace.budget",
    "category-new": "library.new.category",
    category: "library.rename.category",
    batch: "library.batch.access",
  } as const;
  return (
    <Sheet
      open={!!editor}
      onOpenChange={(open) => {
        if (!open) s.requestKnowledgeEditor({ kind: "none" });
      }}
    >
      <SheetContent className="w-full sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{editor ? t(titles[editor.kind]) : ""}</SheetTitle>
          <SheetDescription>
            {t("library.changes.take.effect.when.saved.closing.asks.how.to")}
          </SheetDescription>
        </SheetHeader>
        {editor && (
          <>
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6">
              {(editor.kind === "import" || editor.kind === "document") && (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="library.name">
                      <Input
                        value={editor.name}
                        onChange={(e) =>
                          s.updateKnowledgeEditor({ ...editor, name: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="library.category">
                      <CategorySelect
                        value={editor.category_id}
                        categories={s.knowledgeCategories}
                        onChange={(category_id) =>
                          s.updateKnowledgeEditor({ ...editor, category_id })
                        }
                      />
                    </Field>
                  </div>
                  {editor.kind === "import" ? (
                    <>
                      <Field label="library.upload.txt.markdown">
                        <Input
                          type="file"
                          accept=".txt,.md,text/plain,text/markdown"
                          onChange={(e) => {
                            const file = e.target.files?.[0] ?? null;
                            s.updateKnowledgeEditor({
                              ...editor,
                              file,
                              name: editor.name || file?.name || "",
                            });
                          }}
                        />
                      </Field>
                      {editor.file && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => s.updateKnowledgeEditor({ ...editor, file: null })}
                        >
                          {t("library.remove.file.and.paste.text.instead")}
                        </Button>
                      )}
                      <Field label="library.original.text">
                        <Textarea
                          rows={15}
                          disabled={!!editor.file}
                          value={editor.original_text}
                          onChange={(e) =>
                            s.updateKnowledgeEditor({ ...editor, original_text: e.target.value })
                          }
                        />
                      </Field>
                    </>
                  ) : (
                    <>
                      <Field label="library.version.used.by.models">
                        <NativeSelect
                          value={editor.content_mode}
                          onChange={(e) =>
                            s.updateKnowledgeEditor({
                              ...editor,
                              content_mode: e.target.value as "original" | "draft",
                            })
                          }
                        >
                          <option value="original">{t("library.original")}</option>
                          <option value="draft">{t("library.organized.draft")}</option>
                        </NativeSelect>
                      </Field>
                      <Tabs defaultValue="original">
                        <TabsList>
                          <TabsTrigger value="original">{t("library.edit.original")}</TabsTrigger>
                          <TabsTrigger value="draft">{t("library.organized.draft")}</TabsTrigger>
                          <TabsTrigger value="sources">{t("library.sources")}</TabsTrigger>
                        </TabsList>
                        <TabsContent value="original">
                          <Field
                            label="library.original.text"
                            info="library.changing.the.original.invalidates.the.old.draft.until.it"
                          >
                            <Textarea
                              rows={18}
                              value={editor.original_text}
                              onChange={(e) =>
                                s.updateKnowledgeEditor({
                                  ...editor,
                                  original_text: e.target.value,
                                })
                              }
                            />
                          </Field>
                        </TabsContent>
                        <TabsContent value="draft">
                          <p className="mb-3 text-sm text-muted-foreground">
                            {editor.source.draft?.summary}
                          </p>
                          <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted p-4 text-sm">
                            {editor.source.draft?.body ?? t("library.no.organized.draft.available")}
                          </pre>
                        </TabsContent>
                        <TabsContent value="sources">
                          <pre className="overflow-auto rounded-lg bg-muted p-4 text-xs">
                            {JSON.stringify(editor.source.content.sources, null, 2)}
                          </pre>
                        </TabsContent>
                      </Tabs>
                    </>
                  )}
                </>
              )}
              {editor.kind === "grants" && (
                <>
                  <p className="font-medium">{editor.source.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("library.only.selected.agents.may.access.this.document")}
                  </p>
                  {s.agents.map((agent) => (
                    <label
                      htmlFor={`document-grant-${agent.id}`}
                      key={agent.id}
                      className="flex items-center gap-3 rounded-lg border p-4"
                    >
                      <Checkbox
                        id={`document-grant-${agent.id}`}
                        aria-label={agent.name}
                        checked={editor.agent_ids.includes(agent.id)}
                        onCheckedChange={(v) =>
                          s.updateKnowledgeEditor({
                            ...editor,
                            agent_ids:
                              v === true
                                ? [...editor.agent_ids, agent.id]
                                : editor.agent_ids.filter((id) => id !== agent.id),
                          })
                        }
                      />
                      <span>{agent.name}</span>
                      <Badge variant="outline" className="ml-auto">
                        {agent.model_name}
                      </Badge>
                    </label>
                  ))}
                </>
              )}
              {editor.kind === "batch" && (
                <>
                  <p className="text-sm">
                    {t("library.update.access.to.value.documents", {
                      "0": editor.documents.length,
                    })}
                  </p>
                  <Field label="library.assistant">
                    <NativeSelect
                      value={editor.agent_id}
                      onChange={(e) =>
                        s.updateKnowledgeEditor({ ...editor, agent_id: e.target.value })
                      }
                    >
                      {s.agents.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="library.access.action">
                    <NativeSelect
                      value={String(editor.granted)}
                      onChange={(e) =>
                        s.updateKnowledgeEditor({ ...editor, granted: e.target.value === "true" })
                      }
                    >
                      <option value="true">{t("library.grant.access")}</option>
                      <option value="false">{t("library.revoke.access")}</option>
                    </NativeSelect>
                  </Field>
                  <ul className="space-y-2 text-sm text-muted-foreground">
                    {editor.documents.map((doc) => (
                      <li key={doc.id}>{doc.name}</li>
                    ))}
                  </ul>
                </>
              )}
              {(editor.kind === "category" || editor.kind === "category-new") && (
                <Field label="library.category.name">
                  <Input
                    value={editor.name}
                    onChange={(e) => s.updateKnowledgeEditor({ ...editor, name: e.target.value })}
                  />
                </Field>
              )}
              {editor.kind === "settings" && (
                <>
                  <Field label="library.automatically.organize.new.documents">
                    <Checkbox
                      checked={editor.auto_enabled}
                      onCheckedChange={(v) =>
                        s.updateKnowledgeEditor({ ...editor, auto_enabled: v === true })
                      }
                    />
                  </Field>
                  <Field label="library.workspace.knowledge.budget.tokens">
                    <Input
                      type="number"
                      min={1}
                      value={editor.context_budget}
                      onChange={(e) =>
                        s.updateKnowledgeEditor({
                          ...editor,
                          context_budget: Number(e.target.value),
                        })
                      }
                    />
                  </Field>
                  <p className="text-sm text-muted-foreground">
                    {t("library.organization.model")}:{" "}
                    {editor.source.model_name ?? t("library.unset")}
                  </p>
                  <Button variant="outline" onClick={() => s.openSettingsRoute("knowledge-model")}>
                    {t("library.open.model.services")}
                  </Button>
                </>
              )}
            </div>
            <SheetFooter className="border-t">
              <div className="flex w-full items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {s.knowledgeDirty ? t("library.unsaved.changes") : t("library.saved")}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={s.knowledgeBusy}
                    onClick={() => s.requestKnowledgeEditor({ kind: "none" })}
                  >
                    {t("library.close")}
                  </Button>
                  <Button disabled={s.knowledgeBusy} onClick={() => void s.saveKnowledgeEditor()}>
                    {t("library.save")}
                  </Button>
                </div>
              </div>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
