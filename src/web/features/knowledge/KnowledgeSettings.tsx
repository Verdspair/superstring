import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { NavigationConfirm } from "../../app/NavigationConfirm";
import { SettingsHeader } from "../../app/SettingsHeader";
import { SettingsBody } from "../../app/SettingsSidebar";
import { translateNotice, useI18n } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { AlertDialog } from "../../ui/AlertDialog";
import { Icon } from "../../ui/icons";
import { KnowledgeEditor } from "./KnowledgeEditor";

export const knowledgeStatus = {
  pending: "等待整理",
  queued: "已排队",
  running: "正在整理",
  succeeded: "整理完成",
  failed: "整理失败",
  cancelled: "已取消整理",
  disabled: "整理已关闭",
} as const;
function KnowledgeFrame({ embedded, children }: { embedded: boolean; children: ReactNode }) {
  const back = useSuperstringStore((s) => s.openSettings);
  return embedded ? (
    <div className="knowledge-settings knowledge-embedded min-w-0 space-y-5">{children}</div>
  ) : (
    <section className="page settings-page flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <SettingsHeader onBack={back} />
      <SettingsBody>
        <div className="settings-content knowledge-settings min-w-0 space-y-6">{children}</div>
      </SettingsBody>
    </section>
  );
}
export function KnowledgeSettings({ embedded = false }: { embedded?: boolean }) {
  const t = useI18n();
  const categories = useSuperstringStore((s) => s.knowledgeCategories);
  const documents = useSuperstringStore((s) => s.knowledgeDocuments);
  const settings = useSuperstringStore((s) => s.knowledgeSettings);
  const busy = useSuperstringStore((s) => s.knowledgeBusy || s.settingsSaving);
  const loading = useSuperstringStore((s) => s.knowledgeLoading);
  const dirty = useSuperstringStore((s) => s.knowledgeDirty);
  const editor = useSuperstringStore((s) => s.knowledgeEditor);
  const error = useSuperstringStore((s) => s.error);
  const feedback = useSuperstringStore((s) => s.feedback);
  const confirmOpen = useSuperstringStore((s) => s.navigationConfirmOpen);
  const load = useSuperstringStore((s) => s.loadKnowledge);
  const requestEditor = useSuperstringStore((s) => s.requestKnowledgeEditor);
  const remove = useSuperstringStore((s) => s.deleteKnowledgeItem);
  const setMode = useSuperstringStore((s) => s.setKnowledgeMode);
  const [selected, setSelected] = useState<string[]>([]);
  const [menu, setMenu] = useState<string | null>(null);
  const [deletion, setDeletion] = useState<{
    kind: "document" | "category";
    id: string;
    name: string;
    revision: number;
    count: number;
  } | null>(null);
  const [moveTo, setMoveTo] = useState("");
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const unavailable = busy || loading;
  return (
    <KnowledgeFrame embedded={embedded}>
      {!embedded && (
        <>
          <p className="settings-note text-sm leading-relaxed text-muted-foreground">
            {t("集中管理资料、分类与助手授权；资料仅作为参考内容。")}
          </p>
          <p className="hint text-sm leading-relaxed text-muted-foreground">
            {t("按授权与预算读取资料；整理未完成时使用原文片段。")}
          </p>
        </>
      )}
      <div className="knowledge-toolbar flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          type="button"
          disabled={unavailable}
          onClick={() => requestEditor({ kind: "import" })}
        >
          <Icon name="plus" />
          {t("导入资料")}
        </Button>
        <Button
          variant="outline"
          type="button"
          disabled={unavailable}
          onClick={() => requestEditor({ kind: "category-new" })}
        >
          {t("新增分类")}
        </Button>
        {!embedded && (
          <Button
            variant="outline"
            type="button"
            disabled={unavailable || !settings}
            onClick={() => requestEditor({ kind: "settings" })}
          >
            {t("知识库配置")}
          </Button>
        )}
        <Button
          variant="outline"
          type="button"
          disabled={unavailable || dirty}
          onClick={() => void load()}
        >
          {t("刷新")}
        </Button>
        <Button
          variant="outline"
          type="button"
          disabled={unavailable || !documents.some((d) => selected.includes(d.id))}
          onClick={() => requestEditor({ kind: "batch", ids: selected })}
        >
          {t("批量授权")}
        </Button>
        <span className="hint text-sm leading-relaxed text-muted-foreground">
          {t("已选 {0} 条资料", documents.filter((d) => selected.includes(d.id)).length)}
        </span>
      </div>
      {!embedded && settings && (
        <p className="hint text-sm leading-relaxed text-muted-foreground">
          {t("模型自动整理")}：{t(settings.auto_enabled ? "开启" : "整理已关闭")} ·{" "}
          {t("知识库上下文预算")}：{settings.context_budget}
        </p>
      )}
      {loading && <p role="status">{t("正在读取资料…")}</p>}
      {!embedded && error && (
        <p role="alert" className="error text-sm text-destructive">
          {translateNotice(error)}
        </p>
      )}
      {!embedded && feedback && (
        <p role="status" className="hint text-sm leading-relaxed text-muted-foreground">
          {translateNotice(feedback)}
        </p>
      )}
      <KnowledgeEditor />
      {categories.map((category) => {
        const items = documents.filter((d) => d.category_id === category.id);
        const all = items.length > 0 && items.every((d) => selected.includes(d.id));
        return (
          <Card
            role="region"
            key={category.id}
            className="knowledge-category gap-0 overflow-hidden py-0"
            aria-label={category.name}
          >
            <div className="knowledge-category-heading flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 p-4">
              <Label className="knowledge-check flex min-h-8 items-center gap-3 text-sm">
                <Checkbox
                  aria-label={t("选择分类内资料：{0}", category.name)}
                  disabled={unavailable || !items.length}
                  checked={all}
                  onCheckedChange={(checkedValue) =>
                    setSelected(
                      checkedValue === true
                        ? [...new Set([...selected, ...items.map((d) => d.id)])]
                        : selected.filter((id) => !items.some((d) => d.id === id)),
                    )
                  }
                />
                <strong>{category.name}</strong>
                <small>{items.length}</small>
              </Label>
              <div className="knowledge-toolbar flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  type="button"
                  disabled={unavailable}
                  aria-label={t("重命名分类：{0}", category.name)}
                  onClick={() => requestEditor({ kind: "category", id: category.id })}
                >
                  {t("重命名")}
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  disabled={unavailable || dirty || !!editor || categories.length < 2}
                  aria-label={t("删除分类：{0}", category.name)}
                  onClick={() => {
                    setMoveTo("");
                    setDeletion({
                      kind: "category",
                      ...category,
                      count: items.length,
                    });
                  }}
                >
                  {t("删除")}
                </Button>
              </div>
            </div>
            {!items.length && (
              <p className="hint text-sm leading-relaxed text-muted-foreground">
                {t("此分类暂无资料。")}
              </p>
            )}
            {items.map((document) => (
              <div
                key={document.id}
                className="knowledge-row flex min-w-0 flex-wrap items-center gap-3 border-b p-4 last:border-b-0 has-[[data-state=checked]]:bg-accent/50"
              >
                <Label className="knowledge-check flex min-h-8 items-center gap-3 text-sm">
                  <Checkbox
                    aria-label={t("选择资料：{0}", document.name)}
                    disabled={unavailable}
                    checked={selected.includes(document.id)}
                    onCheckedChange={(checkedValue) =>
                      setSelected(
                        checkedValue === true
                          ? [...new Set([...selected, document.id])]
                          : selected.filter((id) => id !== document.id),
                      )
                    }
                  />
                </Label>
                <Button
                  variant="ghost"
                  type="button"
                  className="knowledge-open h-auto min-w-0 flex-1 flex-col items-start justify-start whitespace-normal p-0 text-left [&>strong]:block [&>strong]:font-medium [&>small]:mt-1 [&>small]:block [&>small]:text-xs [&>small]:font-normal [&>small]:text-muted-foreground"
                  disabled={unavailable}
                  onClick={() => requestEditor({ kind: "document", id: document.id })}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu(document.id);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                      e.preventDefault();
                      setMenu(document.id);
                    }
                  }}
                >
                  <strong>{document.name}</strong>
                  <small>
                    {t(knowledgeStatus[document.organization_status])} ·{" "}
                    {t(document.content_mode === "original" ? "使用原文" : "使用整理稿")} ·{" "}
                    {t("已授权 {0} 个助手", document.agent_ids.length)}
                  </small>
                </Button>
                <Button
                  variant="outline"
                  type="button"
                  disabled={unavailable}
                  aria-label={t("资料操作：{0}", document.name)}
                  onClick={() => setMenu(menu === document.id ? null : document.id)}
                >
                  <Icon name="more" />
                </Button>
                {menu === document.id && (
                  <div
                    className="knowledge-row-actions flex w-full flex-wrap items-center gap-2"
                    role="toolbar"
                    aria-label={t("资料操作：{0}", document.name)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setMenu(null);
                    }}
                  >
                    <Button
                      variant="outline"
                      type="button"
                      disabled={unavailable}
                      onClick={() => {
                        setMenu(null);
                        requestEditor({ kind: "grants", id: document.id });
                      }}
                    >
                      {t("资料授权")}
                    </Button>
                    <Button
                      variant="outline"
                      type="button"
                      disabled={unavailable || dirty || !!editor}
                      onClick={() => {
                        setMenu(null);
                        void setMode(
                          document.id,
                          document.content_mode === "draft" ? "original" : "draft",
                        );
                      }}
                    >
                      {t(document.content_mode === "draft" ? "使用原文" : "使用整理稿")}
                    </Button>
                    <Button
                      variant="destructive"
                      type="button"
                      className="danger"
                      disabled={unavailable || dirty || !!editor}
                      onClick={() => {
                        setMenu(null);
                        setDeletion({
                          kind: "document",
                          ...document,
                          count: 0,
                        });
                      }}
                    >
                      {t("删除")}
                    </Button>
                    <Button variant="outline" type="button" onClick={() => setMenu(null)}>
                      {t("关闭")}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </Card>
        );
      })}
      {!documents.length && !loading && (
        <p className="empty-panel rounded-xl border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          {t("还没有资料，先导入文本或 txt/md 文件。")}
        </p>
      )}
      {!embedded && confirmOpen && <NavigationConfirm />}
      {deletion && (
        <AlertDialog
          title={t("确认删除：{0}", deletion.name)}
          busy={busy}
          onCancel={() => {
            if (!busy) setDeletion(null);
          }}
        >
          <p>
            {t(
              deletion.kind === "document"
                ? "删除资料将移除原文、整理稿及授权，不删除已有聊天。"
                : "分类中的资料不会删除，请选择迁入分类。",
            )}
          </p>
          {deletion.kind === "category" && deletion.count > 0 && (
            <NativeSelect
              className="w-full"
              aria-label={t("迁入分类")}
              value={moveTo}
              disabled={busy}
              onChange={(e) => setMoveTo(e.target.value)}
            >
              <option value="">{t("请选择迁入分类")}</option>
              {categories
                .filter((c) => c.id !== deletion.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </NativeSelect>
          )}
          {error && <p role="alert">{translateNotice(error)}</p>}
          <div className="dialog-actions flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              type="button"
              disabled={busy}
              data-dialog-cancel
              onClick={() => setDeletion(null)}
            >
              {t("取消")}
            </Button>
            <Button
              variant="destructive"
              type="button"
              className="danger"
              disabled={busy || (deletion.kind === "category" && deletion.count > 0 && !moveTo)}
              onClick={async () => {
                if (
                  await remove(deletion.kind, deletion.id, deletion.revision, moveTo || undefined)
                )
                  setDeletion(null);
              }}
            >
              {t("确认删除")}
            </Button>
          </div>
        </AlertDialog>
      )}
    </KnowledgeFrame>
  );
}
