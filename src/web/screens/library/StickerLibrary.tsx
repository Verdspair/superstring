import { FolderPlus, ImagePlus, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { useSuperstringStore } from "@/store";

export function StickerLibrary() {
  const s = useSuperstringStore(),
    t = useTranslation().t;
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
  const [newCollection, setNewCollection] = useQqInput("stickerNewCollection"),
    [renaming, setRenaming] = useQqInput("stickerRenaming"),
    [batchCollection, setBatchCollection] = useQqInput("stickerBatchCollection"),
    [batchTag, setBatchTag] = useQqInput("stickerBatchTag");
  useEffect(() => {
    void s.loadQqStickers();
  }, [s.loadQqStickers]);
  const editor = s.qqStickerEditor,
    dirty = qqStickerEditorDirty(editor);
  const assets = s.qqStickerAssets.filter(
    (asset) =>
      (collection === "all" || asset.collection_ids.includes(collection)) &&
      (enabled === "all" || asset.enabled === (enabled === "enabled")) &&
      (media === "all" || asset.media_type === media) &&
      `${asset.name} ${asset.description ?? ""} ${asset.tags.join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
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
    <section aria-label={t("library.sticker.library.2")} className="space-y-5">
      <div className="flex flex-wrap gap-2">
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
        <Button onClick={() => setImportOpen(true)} disabled={dirty || s.qqStickerSaving}>
          <ImagePlus />
          {t("library.import.a.sticker")}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">
          {assets.length} {t("library.stickers")}
        </Badge>
        <Button variant="ghost" size="sm" onClick={() => setCollectionsOpen(true)}>
          <FolderPlus />
          {t("library.manage.collections")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={s.qqStickerLoading || dirty || s.qqStickerSaving}
          onClick={() => void s.loadQqStickers()}
        >
          <RefreshCw />
          {t("library.refresh")}
        </Button>
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => s.setQqStickerSelection(assets.map((asset) => asset.id))}
          >
            {t("library.select.current.results")}
          </Button>
          {s.qqStickerSelection.length > 0 && (
            <>
              <Button
                size="sm"
                onClick={() => {
                  setBatchOpen(true);
                  void s.loadQqStickerBatchImpact();
                }}
              >
                {t("library.bulk.edit")} · {s.qqStickerSelection.length}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => s.setQqStickerSelection([])}>
                {t("library.clear.selection")}
              </Button>
            </>
          )}
        </div>
      </div>
      {s.qqStickerImportNotice && (
        <p role="status" className="text-sm">
          {s.qqStickerImportNotice.kind === "imported"
            ? t("library.imported.value.review.before.enabling", {
                "0": s.qqStickerImportNotice.name,
              })
            : t("library.import.did.not.complete.value", {
                "0": t(`library.import.${s.qqStickerImportNotice.reason}`),
              })}
        </p>
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {assets.map((asset) => (
          <Card key={asset.id} className="overflow-hidden py-0">
            <CardContent className="p-0">
              <div className="relative bg-muted/50">
                <Button
                  variant="ghost"
                  className="aspect-square h-auto w-full rounded-none p-4"
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
              <div className="space-y-2 border-t p-3">
                <p className="truncate text-sm font-medium">{asset.name}</p>
                <div className="flex flex-wrap gap-1">
                  <Badge variant={asset.enabled ? "secondary" : "outline"}>
                    {t(asset.enabled ? "library.enabled" : "library.disabled")}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {asset.media_type === "animation"
                      ? t("library.animation")
                      : `${asset.width} × ${asset.height}`}
                  </span>
                </div>
                <p className="line-clamp-2 min-h-8 text-xs text-muted-foreground">
                  {asset.description || t("library.needs.a.description")}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {!assets.length && (
        <p className="py-12 text-center text-muted-foreground">
          {t("library.no.matching.assets.import.assets.add.descriptions.and.tags")}
        </p>
      )}
      <Sheet
        open={!!editor}
        onOpenChange={(value) => {
          if (!value) open(null);
        }}
      >
        <SheetContent className="w-full sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>{editor?.name}</SheetTitle>
            <SheetDescription>
              {t("library.saving.descriptions.and.enabling.assets.are.separate.actions.review")}
            </SheetDescription>
          </SheetHeader>
          {editor && (
            <>
              <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6">
                <div className="flex items-center gap-5 rounded-xl bg-muted/40 p-4">
                  <img
                    src={`/qq/stickers/${encodeURIComponent(editor.source.id)}/preview`}
                    alt={editor.name}
                    className="size-36 object-contain"
                  />
                  <div className="space-y-2 text-sm">
                    <Badge variant={editor.source.enabled ? "secondary" : "outline"}>
                      {t(editor.source.enabled ? "library.enabled" : "library.disabled")}
                    </Badge>
                    <p>
                      {editor.source.width} × {editor.source.height} ·{" "}
                      {(editor.source.byte_size / 1024).toFixed(1)} KB
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={s.qqStickerSaving || dirty}
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
                <Field label="library.name">
                  <Input
                    value={editor.name}
                    onChange={(e) => s.patchQqStickerEditor({ name: e.target.value })}
                  />
                </Field>
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold">{t("library.asset.description")}</h3>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={s.qqStickerSaving}
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
                    <Sparkles />
                    {t("library.generate.description.and.tags")}
                  </Button>
                </div>
                {annotation && (
                  <p role="status" className="text-sm text-muted-foreground">
                    {annotation}
                  </p>
                )}
                <Field label="library.description.2">
                  <Textarea
                    rows={4}
                    value={editor.description}
                    onChange={(e) => s.patchQqStickerEditor({ description: e.target.value })}
                  />
                </Field>
                <Field label="library.tags.comma.separated">
                  <Input
                    value={editor.tags}
                    onChange={(e) => s.patchQqStickerEditor({ tags: e.target.value })}
                  />
                </Field>
                {(editor.source.description_draft || editor.source.tags_draft.length > 0) && (
                  <div className="space-y-3 rounded-xl border border-dashed p-4">
                    <p className="text-sm font-medium">{t("library.model.draft")}</p>
                    <p className="whitespace-pre-wrap text-sm">{editor.source.description_draft}</p>
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
                <Field label="library.usage.note">
                  <Textarea
                    rows={3}
                    value={editor.usageNote}
                    onChange={(e) => s.patchQqStickerEditor({ usageNote: e.target.value })}
                  />
                </Field>
                <div className="space-y-2">
                  <p className="text-sm font-medium">{t("library.collections")}</p>
                  {s.qqStickerCollections.map((item) => (
                    <label
                      htmlFor={`sticker-collection-${item.id}`}
                      key={item.id}
                      className="flex items-center gap-3 rounded-lg border p-3"
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
                      <span className="text-sm">{item.name}</span>
                    </label>
                  ))}
                </div>
                <div className="space-y-2 rounded-lg bg-muted p-4">
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
              <SheetFooter className="border-t">
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="outline" disabled={s.qqStickerSaving} onClick={() => open(null)}>
                    {t("library.close")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!dirty || s.qqStickerSaving}
                    onClick={() => s.patchQqStickerEditor(qqStickerEditorFrom(editor.source))}
                  >
                    {t("library.discard.changes")}
                  </Button>
                  <Button disabled={s.qqStickerSaving} onClick={() => void s.saveQqStickerEditor()}>
                    {t("library.save.description")}
                  </Button>
                  {!editor.source.enabled && (
                    <Button
                      disabled={s.qqStickerSaving}
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
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogTitle>{t("library.import.a.sticker")}</DialogTitle>
          <DialogDescription>
            {t("library.supported.images.and.animations.are.imported.disabled.they.can")}
          </DialogDescription>
          <Field label="library.choose.an.image.file">
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
      <Dialog open={collectionsOpen} onOpenChange={setCollectionsOpen}>
        <DialogContent>
          <DialogTitle>{t("library.manage.collections")}</DialogTitle>
          <DialogDescription>
            {t("library.collections.can.be.reused.by.multiple.conversation.schemes")}
          </DialogDescription>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void s.createQqStickerCollection(newCollection.trim()).then((ok) => {
                if (ok) setNewCollection("");
              });
            }}
          >
            <Input
              aria-label={t("library.collection.name")}
              value={newCollection}
              onChange={(e) => setNewCollection(e.target.value)}
            />
            <Button type="submit" disabled={!newCollection.trim() || s.qqStickerSaving}>
              {t("library.create")}
            </Button>
          </form>
          <div className="max-h-80 space-y-2 overflow-auto">
            {s.qqStickerCollections.map((item) => (
              <div key={item.id} className="flex items-center gap-2 rounded-lg border p-3">
                {renaming?.id === item.id ? (
                  <>
                    <Input
                      aria-label={t("library.rename.collection")}
                      value={renaming.name}
                      onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                    />
                    <Button
                      size="sm"
                      disabled={s.qqStickerSaving || !renaming.name.trim()}
                      onClick={() =>
                        void s
                          .renameQqStickerCollection(
                            item.id,
                            renaming.name.trim(),
                            renaming.revision,
                          )
                          .then((ok) => {
                            if (ok) setRenaming(null);
                          })
                      }
                    >
                      {t("library.save")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                      {t("library.cancel")}
                    </Button>
                  </>
                ) : (
                  <>
                    <span className="flex-1 text-sm">{item.name}</span>
                    <Badge variant="outline">{item.asset_count}</Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setRenaming({ id: item.id, name: item.name, revision: item.revision })
                      }
                    >
                      {t("library.rename")}
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent>
          <DialogTitle>
            {t("library.bulk.edit.value.assets", { "0": s.qqStickerSelection.length })}
          </DialogTitle>
          <DialogDescription>
            {t("library.actions.apply.to.the.current.selection.the.selection.remains")}
          </DialogDescription>
          <Field label="library.collections.2">
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
              onClick={() => void s.bulkUpdateQqStickers({ addCollectionIds: [batchCollection] })}
            >
              {t("library.add.to.collection")}
            </Button>
            <Button
              variant="outline"
              disabled={!batchCollection || s.qqStickerSaving}
              onClick={() =>
                void s.bulkUpdateQqStickers({ removeCollectionIds: [batchCollection] })
              }
            >
              {t("library.remove.from.collection")}
            </Button>
          </div>
          <Field label="library.tags.comma.separated">
            <Input value={batchTag} onChange={(e) => setBatchTag(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={!batchTag.trim() || s.qqStickerSaving}
              onClick={() =>
                void s.bulkUpdateQqStickers({ tags: { add: qqStickerEditorTags(batchTag) } })
              }
            >
              {t("library.add.tag")}
            </Button>
            <Button
              variant="outline"
              disabled={!batchTag.trim() || s.qqStickerSaving}
              onClick={() =>
                void s.bulkUpdateQqStickers({ tags: { remove: qqStickerEditorTags(batchTag) } })
              }
            >
              {t("library.remove.tag")}
            </Button>
          </div>
          <div className="rounded-lg bg-muted p-3 text-sm">
            {t("library.affected.schemes.value", {
              "0":
                s.qqStickerBatchImpact?.join(", ") ||
                t("library.impact.information.is.unavailable"),
            })}
          </div>
          <div className="flex gap-2">
            <Button
              disabled={s.qqStickerSaving}
              onClick={() => void s.bulkUpdateQqStickers({ enabled: true })}
            >
              {t("library.enable.selected")}
            </Button>
            <Button
              variant="outline"
              disabled={s.qqStickerSaving}
              onClick={() => setDisableSelected(true)}
            >
              {t("library.disable.selected")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
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
      {switchTo !== undefined && (
        <AlertDialog
          title={t("library.unsaved.asset.changes")}
          onCancel={() => setSwitchTo(undefined)}
          busy={s.qqStickerSaving}
        >
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" data-dialog-cancel onClick={() => setSwitchTo(undefined)}>
              {t("library.cancel")}
            </Button>
            <Button variant="outline" disabled={s.qqStickerSaving} onClick={proceed}>
              {t("library.discard.and.continue")}
            </Button>
            <Button
              disabled={s.qqStickerSaving}
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
