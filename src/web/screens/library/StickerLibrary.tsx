import { cn } from "cn";
import { FolderPlus, ImagePlus, RefreshCw, SlidersHorizontal, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { AlertDialog, ConfirmDialog } from "@/components/confirmation";
import { Field } from "@/components/form-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
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
import { Textarea } from "@/components/ui/textarea";
import {
  qqStickerEditorDirty,
  qqStickerEditorFrom,
  qqStickerEditorTags,
} from "@/features/qq/types";
import { useQqInput } from "@/features/qq/use-qq-input";
import { translateNotice } from "@/i18n";
import { useSuperstringStore } from "@/store";

export function StickerLibrary({ active = true }: { active?: boolean } = {}) {
  const s = useSuperstringStore(
    useShallow((state) => ({
      annotateQqSticker: state.annotateQqSticker,
      bulkUpdateQqStickers: state.bulkUpdateQqStickers,
      closeQqStickerEditor: state.closeQqStickerEditor,
      error: state.error,
      importQqStickerFile: state.importQqStickerFile,
      loadQqStickerBatchImpact: state.loadQqStickerBatchImpact,
      loadQqStickers: state.loadQqStickers,
      openQqStickerEditor: state.openQqStickerEditor,
      openSettingsRoute: state.openSettingsRoute,
      patchQqStickerEditor: state.patchQqStickerEditor,
      qqStickerAssets: state.qqStickerAssets,
      qqStickerBatchImpact: state.qqStickerBatchImpact,
      qqStickerCollections: state.qqStickerCollections,
      qqStickerEditor: state.qqStickerEditor,
      qqStickerImpact: state.qqStickerImpact,
      qqStickerImportNotice: state.qqStickerImportNotice,
      qqStickerLoading: state.qqStickerLoading,
      qqStickerSaving: state.qqStickerSaving,
      createQqStickerCollection: state.createQqStickerCollection,
      qqStickerSelection: state.qqStickerSelection,
      renameQqStickerCollection: state.renameQqStickerCollection,
      saveQqStickerEditor: state.saveQqStickerEditor,
      setQqStickerEnabled: state.setQqStickerEnabled,
      setQqStickerSelection: state.setQqStickerSelection,
    })),
  );
  const { t, i18n } = useTranslation();
  const [search, setSearch] = useState(""),
    [collection, setCollection] = useState("all"),
    [enabled, setEnabled] = useState("all"),
    [media, setMedia] = useState("all"),
    [collectionsOpen, setCollectionsOpen] = useState(false),
    [batchOpen, setBatchOpen] = useState(false),
    [importOpen, setImportOpen] = useState(false),
    [switchTo, setSwitchTo] = useState<string | null | undefined>(undefined),
    [annotation, setAnnotation] = useState("");
  const [disableSelected, setDisableSelected] = useState(false);
  const [newCollectionDescription, setNewCollectionDescription] = useQqInput(
    "stickerNewCollectionDescription",
  );
  const [newCollection, setNewCollection] = useQqInput("stickerNewCollection"),
    [renaming, setRenaming] = useQqInput("stickerRenaming"),
    [batchCollection, setBatchCollection] = useQqInput("stickerBatchCollection"),
    [batchTag, setBatchTag] = useQqInput("stickerBatchTag");

  useEffect(() => {
    if (active) void s.loadQqStickers();
  }, [active, s.loadQqStickers]);

  const editor = s.qqStickerEditor,
    dirty = qqStickerEditorDirty(editor);

  // 预先缓存每项资产的小写检索文本，仅在 qqStickerAssets 变化时重新计算
  const assetSearchIndex = useMemo(() => {
    return s.qqStickerAssets.map((asset) => ({
      asset,
      searchBlob: `${asset.name} ${asset.description ?? ""} ${asset.tags.join(" ")}`.toLowerCase(),
    }));
  }, [s.qqStickerAssets]);

  const assets = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return assetSearchIndex
      .filter(
        ({ asset, searchBlob }) =>
          (collection === "all" || asset.collection_ids.includes(collection)) &&
          (enabled === "all" || asset.enabled === (enabled === "enabled")) &&
          (media === "all" || asset.media_type === media) &&
          (!needle || searchBlob.includes(needle)),
      )
      .map(({ asset }) => asset);
  }, [assetSearchIndex, collection, enabled, media, search]);

  const open = (id: string | null) => {
    if (dirty) setSwitchTo(id);
    else {
      setAnnotation("");
      if (id) s.openQqStickerEditor(id);
      else s.closeQqStickerEditor();
    }
  };

  const proceed = () => {
    if (switchTo) s.openQqStickerEditor(switchTo);
    else s.closeQqStickerEditor();
    setSwitchTo(undefined);
    setAnnotation("");
  };

  return (
    <section aria-label={t("library.sticker.library.2")} className="space-y-6">
      {/* 任务组 1：检索与筛选主工具栏 */}
      <div className="flex flex-wrap items-center gap-2.5">
        <Input
          className="min-w-48 flex-1"
          aria-label={t("library.search.assets")}
          placeholder={t("library.search.names.descriptions.or.tags")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <NativeSelect
          aria-label={t("library.asset.collection")}
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
        >
          <option value="all">{t("library.all.collections")}</option>
          {s.qqStickerCollections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label={t("library.enabled.status")}
          value={enabled}
          onChange={(e) => setEnabled(e.target.value)}
        >
          <option value="all">{t("library.all.statuses")}</option>
          <option value="enabled">{t("library.enabled")}</option>
          <option value="disabled">{t("library.disabled")}</option>
        </NativeSelect>
        <NativeSelect
          aria-label={t("library.media.type")}
          value={media}
          onChange={(e) => setMedia(e.target.value)}
        >
          <option value="all">{t("library.all.types")}</option>
          <option value="image">{t("library.static.image")}</option>
          <option value="animation">{t("library.animation")}</option>
        </NativeSelect>
        <Button
          onClick={() => setImportOpen(true)}
          disabled={dirty || s.qqStickerSaving}
          disabledReason={t("hints.library.sticker.importDisabled")}
          tooltip={t("hints.library.sticker.import")}
        >
          <ImagePlus className="size-4" />
          {t("library.import.a.sticker")}
        </Button>
        {/* 表情内容的媒体能力设置直达（qq-stickers -> media-tools），草稿安全跳转。 */}
        <Button
          variant="outline"
          className="ml-auto h-auto min-h-8 max-w-full whitespace-normal break-words"
          tooltip={t("hints.library.sticker.mediaTools")}
          onClick={() => s.openSettingsRoute("media-tools")}
        >
          <SlidersHorizontal className="size-4" />
          {t("capabilities.resources.openMediaTools")}
        </Button>
      </div>

      {/* 任务组 2：集合管理与批量操作控制行 */}
      <div className="flex flex-wrap items-center gap-2.5">
        <Badge variant="secondary" className="px-2.5 py-1 text-xs font-medium">
          {assets.length} {t("library.stickers")}
        </Badge>
        <Button
          variant="outline"
          tooltip={t("hints.library.sticker.manageCollections")}
          onClick={() => setCollectionsOpen(true)}
        >
          <FolderPlus className="size-4" />
          {t("library.manage.collections")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={s.qqStickerLoading || dirty || s.qqStickerSaving}
          tooltip={t("hints.library.sticker.refresh")}
          onClick={() => void s.loadQqStickers()}
        >
          <RefreshCw className="size-4" />
          {t("library.refresh")}
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            tooltip={t("hints.library.sticker.selectAll")}
            onClick={() => s.setQqStickerSelection(assets.map((asset) => asset.id))}
          >
            {t("library.select.current.results")}
          </Button>
          {s.qqStickerSelection.length > 0 && (
            <>
              <Button
                size="sm"
                tooltip={t("hints.library.sticker.bulkEdit")}
                onClick={() => {
                  setBatchOpen(true);
                  void s.loadQqStickerBatchImpact();
                }}
              >
                {t("library.bulk.edit")} · {s.qqStickerSelection.length}
              </Button>
              <Button
                tooltip={<Trans i18nKey="hints.complete.selectionClear" />}
                size="sm"
                variant="ghost"
                onClick={() => s.setQqStickerSelection([])}
              >
                {t("library.clear.selection")}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* 导入状态提示 */}
      {s.qqStickerImportNotice && (
        <p
          role="status"
          className={cn(
            "rounded-xl border p-3 text-sm",
            s.qqStickerImportNotice.kind === "imported"
              ? "border-primary/20 bg-primary/5 text-foreground"
              : "border-destructive/20 bg-destructive/5 text-destructive",
          )}
        >
          {s.qqStickerImportNotice.kind === "imported"
            ? t("library.imported.value.review.before.enabling", {
                "0": s.qqStickerImportNotice.name,
              })
            : t("library.import.did.not.complete.value", {
                "0": t(`library.import.${s.qqStickerImportNotice.reason}`),
              })}
        </p>
      )}

      {/* 任务组 3：表情资料网格（第一帧静态展示与多选） */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {assets.map((asset) => (
          <Card
            key={asset.id}
            className="overflow-hidden border-border/80 bg-card py-0 transition-all hover:border-border"
          >
            <CardContent className="p-0">
              <div className="relative bg-muted/50 dark:bg-muted/30">
                <Button
                  tooltip={<Trans i18nKey="hints.complete.stickerOpen" />}
                  variant="ghost"
                  className="aspect-square h-auto w-full rounded-none p-4 hover:bg-transparent"
                  aria-label={t("library.open.value", { "0": asset.name })}
                  onClick={() => open(asset.id)}
                >
                  <img
                    src={`/qq/stickers/${encodeURIComponent(asset.id)}/preview?still=1`}
                    alt={asset.name}
                    loading="lazy"
                    className="size-full object-contain"
                  />
                </Button>
                <Checkbox
                  className="absolute left-3 top-3 bg-background"
                  aria-label={t("library.select.value", { "0": asset.name })}
                  checked={s.qqStickerSelection.includes(asset.id)}
                  onCheckedChange={(v) =>
                    s.setQqStickerSelection(
                      v === true
                        ? [...s.qqStickerSelection, asset.id]
                        : s.qqStickerSelection.filter((id) => id !== asset.id),
                    )
                  }
                />
              </div>
              <div className="space-y-2 border-t border-border/60 p-3">
                <p className="truncate text-sm font-medium">{asset.name}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={asset.enabled ? "secondary" : "outline"}>
                    {t(asset.enabled ? "library.enabled" : "library.disabled")}
                  </Badge>
                  <span className="text-xs text-muted-foreground font-mono">
                    {asset.media_type === "animation"
                      ? t("library.animation")
                      : `${asset.width} × ${asset.height}`}
                  </span>
                </div>
                <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground leading-relaxed">
                  {asset.description || t("library.needs.a.description")}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {!assets.length && (
        <div className="rounded-xl border border-dashed border-border/80 p-12 text-center text-muted-foreground">
          <p className="text-sm">
            {t("library.no.matching.assets.import.assets.add.descriptions.and.tags")}
          </p>
        </div>
      )}

      {/* 任务组 4：素材详情与标注工作台（编辑说明/启用状态解耦） */}
      <Sheet
        open={!!editor}
        onOpenChange={(value) => {
          if (!value) open(null);
        }}
      >
        <SheetContent className="flex h-full w-full flex-col p-0 sm:max-w-3xl">
          <SheetHeader className="border-b border-border/60 px-6 py-4">
            <SheetTitle>{editor?.name}</SheetTitle>
            <SheetDescription>
              {t("library.saving.descriptions.and.enabling.assets.are.separate.actions.review")}
            </SheetDescription>
          </SheetHeader>
          {editor && (
            <>
              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-6">
                {/* 预览与即时启用状态 */}
                <div className="flex flex-col sm:flex-row items-center gap-5 rounded-xl border border-border/70 bg-muted/40 p-4">
                  <div className="flex size-36 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background p-2">
                    <img
                      src={`/qq/stickers/${encodeURIComponent(editor.source.id)}/preview`}
                      alt={editor.name}
                      className="size-full object-contain"
                    />
                  </div>
                  <div className="space-y-2.5 text-sm flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant={editor.source.enabled ? "secondary" : "outline"}>
                        {t(editor.source.enabled ? "library.enabled" : "library.disabled")}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {editor.source.media_type === "animation"
                          ? t("library.animation")
                          : t("library.static.image")}
                      </span>
                    </div>
                    <p className="text-sm font-mono text-muted-foreground">
                      {editor.source.width} × {editor.source.height} ·{" "}
                      {new Intl.NumberFormat(i18n.resolvedLanguage, {
                        style: "unit",
                        unit: "kilobyte",
                        minimumFractionDigits: 1,
                        maximumFractionDigits: 1,
                      }).format(editor.source.byte_size / 1024)}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={s.qqStickerSaving || dirty}
                      disabledReason={t("hints.library.sticker.toggleDisabled")}
                      tooltip={t("hints.library.sticker.toggleEnable")}
                      onClick={() => {
                        void s.setQqStickerEnabled(editor.source.id, !editor.source.enabled);
                      }}
                    >
                      {t(
                        editor.source.enabled
                          ? "library.disable.sticker"
                          : "library.enable.sticker",
                      )}
                    </Button>
                  </div>
                </div>

                {/* 元数据：名称 */}
                <div className="space-y-4 rounded-xl border border-border/70 bg-card p-4">
                  <Field label="library.name" tooltip={t("hints.library.sticker.nameField")}>
                    <Input
                      value={editor.name}
                      onChange={(e) => s.patchQqStickerEditor({ name: e.target.value })}
                    />
                  </Field>
                </div>

                {/* 描述与标签标注（含模型辅助生成与草稿采纳） */}
                <div className="space-y-4 rounded-xl border border-border/70 bg-card p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{t("library.asset.description")}</h3>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={s.qqStickerSaving}
                      tooltip={t("hints.library.sticker.generate")}
                      onClick={() => {
                        void s.annotateQqSticker(editor.source.id).then((result) =>
                          setAnnotation(
                            result.kind === "annotated"
                              ? t("library.description.draft.generated.review.it.before.applying")
                              : t("library.generation.did.not.complete.value", {
                                  "0": t(`library.annotation.${result.reason}`, {
                                    defaultValue: result.reason,
                                  }),
                                }),
                          ),
                        );
                      }}
                    >
                      <Sparkles className="size-4" />
                      {t("library.generate.description.and.tags")}
                    </Button>
                  </div>
                  {annotation && (
                    <p role="status" className="text-sm text-muted-foreground">
                      {annotation}
                    </p>
                  )}
                  <Field
                    label="library.description.2"
                    tooltip={t("hints.library.sticker.descriptionField")}
                  >
                    <Textarea
                      rows={4}
                      value={editor.description}
                      onChange={(e) => s.patchQqStickerEditor({ description: e.target.value })}
                    />
                  </Field>
                  <Field
                    label="library.tags.comma.separated"
                    tooltip={t("hints.library.sticker.tagsField")}
                  >
                    <Input
                      value={editor.tags}
                      onChange={(e) => s.patchQqStickerEditor({ tags: e.target.value })}
                    />
                  </Field>
                  {(editor.source.description_draft || editor.source.tags_draft.length > 0) && (
                    <div className="space-y-3 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-4">
                      <p className="text-sm font-medium">{t("library.model.draft")}</p>
                      <p className="whitespace-pre-wrap text-sm">
                        {editor.source.description_draft}
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {editor.source.tags_draft.map((tag) => (
                          <Badge key={tag} variant="secondary">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        tooltip={t("hints.library.sticker.applyDraft")}
                        onClick={() =>
                          s.patchQqStickerEditor({
                            description: editor.source.description_draft ?? editor.description,
                            tags: editor.source.tags_draft.join(", "),
                          })
                        }
                      >
                        {t("library.apply.draft")}
                      </Button>
                    </div>
                  )}
                </div>

                {/* 使用说明与合集归属 */}
                <div className="space-y-4 rounded-xl border border-border/70 bg-card p-4">
                  <Field
                    label="library.usage.note"
                    tooltip={t("hints.library.sticker.usageNoteField")}
                  >
                    <Textarea
                      rows={3}
                      value={editor.usageNote}
                      onChange={(e) => s.patchQqStickerEditor({ usageNote: e.target.value })}
                    />
                  </Field>
                  <div className="space-y-2.5">
                    <p className="text-sm font-medium">{t("library.collections")}</p>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {s.qqStickerCollections.map((item) => (
                        <label
                          htmlFor={`sticker-collection-${item.id}`}
                          key={item.id}
                          className="selection-card flex items-center gap-3 p-3 transition-colors"
                        >
                          <Checkbox
                            id={`sticker-collection-${item.id}`}
                            aria-label={item.name}
                            checked={editor.collectionIds.includes(item.id)}
                            onCheckedChange={(v) =>
                              s.patchQqStickerEditor({
                                collectionIds:
                                  v === true
                                    ? [...editor.collectionIds, item.id]
                                    : editor.collectionIds.filter((id) => id !== item.id),
                              })
                            }
                          />
                          <span className="select-none text-sm">{item.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 资源影响评估 */}
                <div className="space-y-2.5 rounded-xl border border-border/70 bg-muted/30 p-4">
                  <p className="text-sm font-medium">{t("library.affected.resources")}</p>
                  {s.qqStickerImpact ? (
                    <>
                      <p className="text-sm">
                        {t("library.schemes.value", {
                          "0":
                            s.qqStickerImpact.schemes.map((item) => item.name).join(", ") ||
                            t("library.none"),
                        })}
                      </p>
                      {s.qqStickerImpact.bindings.map((binding) => (
                        <p
                          key={`${binding.scheme_id}:${binding.account_id}:${binding.conversation_kind}:${binding.peer_id}`}
                          className="text-xs text-muted-foreground"
                        >
                          {binding.account_id} / {binding.conversation_kind} / {binding.peer_id}{" "}
                          {binding.paused && t("library.paused")}
                        </p>
                      ))}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t("library.impact.information.is.unavailable")}
                    </p>
                  )}
                </div>
              </div>
              <SheetFooter className="border-t border-border/60 px-6 py-4">
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={s.qqStickerSaving}
                    tooltip={t("hints.library.sticker.closeEditor")}
                    onClick={() => open(null)}
                  >
                    {t("library.close")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!dirty || s.qqStickerSaving}
                    disabledReason={t("hints.library.sticker.discardDisabled")}
                    tooltip={t("hints.library.sticker.discard")}
                    onClick={() => s.patchQqStickerEditor(qqStickerEditorFrom(editor.source))}
                  >
                    {t("library.discard.changes")}
                  </Button>
                  <Button
                    disabled={s.qqStickerSaving}
                    tooltip={t("hints.library.sticker.saveDescription")}
                    onClick={() => void s.saveQqStickerEditor()}
                  >
                    {t("library.save.description")}
                  </Button>
                  {!editor.source.enabled && (
                    <Button
                      disabled={s.qqStickerSaving}
                      tooltip={t("hints.library.sticker.saveAndEnable")}
                      onClick={() => void s.saveQqStickerEditor({ enableAfterSave: true })}
                    >
                      {t("library.save.and.enable")}
                    </Button>
                  )}
                </div>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* 导入对话框 */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogTitle>{t("library.import.a.sticker")}</DialogTitle>
          <DialogDescription>
            {t("library.supported.images.and.animations.are.imported.disabled.they.can")}
          </DialogDescription>
          <Field
            label="library.choose.an.image.file"
            tooltip={t("hints.library.sticker.importFileField")}
          >
            <Input
              type="file"
              accept="image/*"
              disabled={s.qqStickerSaving}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  void s.importQqStickerFile(file).then((ok) => {
                    if (ok) setImportOpen(false);
                  });
              }}
            />
          </Field>
        </DialogContent>
      </Dialog>

      {/* 集合管理对话框 */}
      <Dialog open={collectionsOpen} onOpenChange={setCollectionsOpen}>
        <DialogContent>
          <DialogTitle>{t("library.manage.collections")}</DialogTitle>
          <DialogDescription>
            {t("library.collections.can.be.reused.by.multiple.conversation.schemes")}
          </DialogDescription>
          {s.error && (
            <p role="alert" className="text-sm text-destructive">
              {translateNotice(s.error)}
            </p>
          )}
          <form
            className="space-y-4 rounded-xl border border-border/70 bg-card p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void s
                .createQqStickerCollection(newCollection.trim(), newCollectionDescription)
                .then((ok) => {
                  if (ok) {
                    setNewCollection("");
                    setNewCollectionDescription("");
                  }
                });
            }}
          >
            <div className="flex gap-2">
              <Input
                aria-label={t("library.collection.name")}
                placeholder={t("library.collection.name")}
                value={newCollection}
                onChange={(e) => setNewCollection(e.target.value)}
              />
              <Button
                type="submit"
                disabled={!newCollection.trim() || s.qqStickerSaving}
                disabledReason={t("hints.library.sticker.createDisabled")}
                tooltip={t("hints.library.sticker.createCollection")}
              >
                {t("library.create")}
              </Button>
            </div>
            <Field
              label="library.description"
              tooltip={t("hints.library.sticker.collectionDescriptionField")}
            >
              <Textarea
                rows={2}
                maxLength={2000}
                value={newCollectionDescription}
                onChange={(e) => setNewCollectionDescription(e.target.value)}
              />
            </Field>
          </form>
          <div className="max-h-80 space-y-2 overflow-auto">
            {s.qqStickerCollections.map((item) => (
              <div key={item.id} className="rounded-lg border border-border/70 bg-card p-3">
                {renaming?.id === item.id ? (
                  <div className="space-y-2">
                    <Input
                      aria-label={t("library.rename.collection")}
                      value={renaming.name}
                      onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                    />
                    <Textarea
                      rows={2}
                      maxLength={2000}
                      aria-label={t("library.description")}
                      value={renaming.description ?? item.description ?? ""}
                      onChange={(e) => setRenaming({ ...renaming, description: e.target.value })}
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        tooltip={t("hints.library.sticker.renameCancel")}
                        onClick={() => {
                          setRenaming(null);
                        }}
                      >
                        {t("library.cancel")}
                      </Button>
                      <Button
                        size="sm"
                        disabled={s.qqStickerSaving || !renaming.name.trim()}
                        disabledReason={t("hints.library.sticker.renameSaveDisabled")}
                        tooltip={t("hints.library.sticker.renameSave")}
                        onClick={() =>
                          void s
                            .renameQqStickerCollection(
                              item.id,
                              renaming.name.trim(),
                              renaming.revision,
                              renaming.description,
                            )
                            .then((ok) => {
                              if (ok) {
                                setRenaming(null);
                              }
                            })
                        }
                      >
                        {t("library.save")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      {item.description && (
                        <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {item.description}
                        </span>
                      )}
                    </span>
                    <Badge variant="outline">{item.asset_count}</Badge>
                    <Button
                      tooltip={<Trans i18nKey="hints.complete.stickerRename" />}
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setRenaming({
                          id: item.id,
                          name: item.name,
                          revision: item.revision,
                          description: item.description ?? "",
                        });
                      }}
                    >
                      {t("library.rename")}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* 批量编辑对话框 */}
      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent>
          <DialogTitle>
            {t("library.bulk.edit.value.assets", { "0": s.qqStickerSelection.length })}
          </DialogTitle>
          <DialogDescription>
            {t("library.actions.apply.to.the.current.selection.the.selection.remains")}
          </DialogDescription>
          <div className="space-y-4">
            <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
              <Field
                label="library.collections.2"
                tooltip={t("hints.library.sticker.batchCollectionField")}
              >
                <NativeSelect
                  value={batchCollection}
                  onChange={(e) => setBatchCollection(e.target.value)}
                >
                  <option value="">{t("library.choose.a.collection")}</option>
                  {s.qqStickerCollections.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={!batchCollection || s.qqStickerSaving}
                  disabledReason={t("hints.library.sticker.pickCollectionFirst")}
                  tooltip={t("hints.library.sticker.addToCollection")}
                  onClick={() =>
                    void s.bulkUpdateQqStickers({ addCollectionIds: [batchCollection] })
                  }
                >
                  {t("library.add.to.collection")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!batchCollection || s.qqStickerSaving}
                  disabledReason={t("hints.library.sticker.pickCollectionFirst")}
                  tooltip={t("hints.library.sticker.removeFromCollection")}
                  onClick={() =>
                    void s.bulkUpdateQqStickers({ removeCollectionIds: [batchCollection] })
                  }
                >
                  {t("library.remove.from.collection")}
                </Button>
              </div>
            </div>

            <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
              <Field
                label="library.tags.comma.separated"
                tooltip={t("hints.library.sticker.batchTagsField")}
              >
                <Input value={batchTag} onChange={(e) => setBatchTag(e.target.value)} />
              </Field>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  disabled={!batchTag.trim() || s.qqStickerSaving}
                  disabledReason={t("hints.library.sticker.tagFirst")}
                  tooltip={t("hints.library.sticker.addTag")}
                  onClick={() =>
                    void s.bulkUpdateQqStickers({ tags: { add: qqStickerEditorTags(batchTag) } })
                  }
                >
                  {t("library.add.tag")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!batchTag.trim() || s.qqStickerSaving}
                  disabledReason={t("hints.library.sticker.tagFirst")}
                  tooltip={t("hints.library.sticker.removeTag")}
                  onClick={() =>
                    void s.bulkUpdateQqStickers({ tags: { remove: qqStickerEditorTags(batchTag) } })
                  }
                >
                  {t("library.remove.tag")}
                </Button>
              </div>
            </div>

            <div className="rounded-xl border border-border/70 bg-muted/40 p-3 text-sm">
              {t("library.affected.schemes.value", {
                "0":
                  s.qqStickerBatchImpact?.join(", ") ||
                  t("library.impact.information.is.unavailable"),
              })}
            </div>

            <div className="flex gap-2 pt-2">
              <Button
                disabled={s.qqStickerSaving}
                tooltip={t("hints.library.sticker.enableSelected")}
                onClick={() => void s.bulkUpdateQqStickers({ enabled: true })}
              >
                {t("library.enable.selected")}
              </Button>
              <Button
                variant="outline"
                disabled={s.qqStickerSaving}
                tooltip={t("hints.library.sticker.disableSelected")}
                onClick={() => setDisableSelected(true)}
              >
                {t("library.disable.selected")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 批量停用危险操作二次确认 */}
      {disableSelected && (
        <ConfirmDialog
          message={t("library.assets.disable.confirm", { "0": s.qqStickerSelection.length })}
          onCancel={() => setDisableSelected(false)}
          onConfirm={() => {
            return s.bulkUpdateQqStickers({ enabled: false }).then((ok) => {
              if (ok) setDisableSelected(false);
            });
          }}
        />
      )}

      {/* 未保存修改切换/退出警告 */}
      {switchTo !== undefined && (
        <AlertDialog
          title={t("library.unsaved.asset.changes")}
          onCancel={() => setSwitchTo(undefined)}
          busy={s.qqStickerSaving}
        >
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              data-dialog-cancel
              tooltip={t("hints.library.common.cancel")}
              onClick={() => setSwitchTo(undefined)}
            >
              {t("library.cancel")}
            </Button>
            <Button
              variant="outline"
              disabled={s.qqStickerSaving}
              tooltip={t("hints.library.sticker.discardContinue")}
              onClick={proceed}
            >
              {t("library.discard.and.continue")}
            </Button>
            <Button
              disabled={s.qqStickerSaving}
              tooltip={t("hints.library.sticker.saveContinue")}
              onClick={() =>
                void s.saveQqStickerEditor().then((ok) => {
                  if (ok) proceed();
                })
              }
            >
              {t("library.save.and.continue")}
            </Button>
          </div>
        </AlertDialog>
      )}
    </section>
  );
}
