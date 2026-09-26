import { ImagePlus, RotateCcw, Shuffle } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AVATAR_MEDIA_TYPES,
  AVATAR_UPLOAD_MAX_BYTES,
  type ConversationAvatar as AvatarAsset,
} from "../../../shared/contracts/conversation-avatar";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { NativeSelect } from "../../components/ui/native-select";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { translateNotice } from "../../i18n";
import { errorText } from "../../state/helpers";
import { ConversationAvatar } from "./avatar";
import {
  AVATAR_STYLES,
  type AvatarIdentity,
  type AvatarSelection,
  type AvatarStyle,
  defaultConversationAvatar,
  type GeneratedAvatar,
} from "./avatar-designs";

type AvatarEditorProps = {
  conversationId: string;
  title: string;
  topology: "direct" | "shared";
  value: AvatarAsset;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (selection: AvatarSelection) => Promise<void>;
};

/** The editor owns a draft only while open; successful persistence is the sole commit point. */
export function AvatarEditor(props: AvatarEditorProps) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
    >
      {props.open && (
        <AvatarEditorForm key={props.conversationId} {...props} onBusyChange={setBusy} />
      )}
    </Dialog>
  );
}
function AvatarEditorForm({
  conversationId,
  title,
  topology,
  value,
  onOpenChange,
  onSave,
  onBusyChange,
}: AvatarEditorProps & { onBusyChange: (value: boolean) => void }) {
  const { t, i18n } = useTranslation();
  const identity: AvatarIdentity = { id: conversationId, title, topology };
  const fallback = defaultConversationAvatar(identity);
  const [initial] = useState(value);
  const [draft, setDraft] = useState<AvatarAsset>(value);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [style, setStyle] = useState<AvatarStyle>(
    value?.kind === "generated" ? value.style : fallback.style,
  );
  const [batch, setBatch] = useState("");
  const [tab, setTab] = useState(value?.kind === "uploaded" ? "upload" : "presets");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imageFailed, setImageFailed] = useState(false);
  const [uploadReady, setUploadReady] = useState(false);
  const saving = useRef(false);
  const inputId = useId();
  const styleId = useId();
  const radioId = useId();
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );
  const choices = useMemo<GeneratedAvatar[]>(
    () =>
      Array.from({ length: 8 }, (_, index) => ({
        kind: "generated",
        style,
        seed:
          !batch && index === 0
            ? initial?.kind === "generated" && initial.style === style
              ? initial.seed
              : conversationId
            : `${batch || conversationId}:${index}`,
      })),
    [style, batch, initial, conversationId],
  );
  const select = (next: GeneratedAvatar) => {
    setDraft(next);
    setFile(null);
    setPreviewUrl(null);
    setError("");
    setImageFailed(false);
  };
  const chooseFile = (selected: File | undefined) => {
    if (!selected) return;
    if (!AVATAR_MEDIA_TYPES.some((type) => type === selected.type)) {
      setError(t("avatar.file_invalid"));
      return;
    }
    if (selected.size > AVATAR_UPLOAD_MAX_BYTES) {
      setError(
        t("avatar.file_too_large", {
          "0": new Intl.NumberFormat(i18n.resolvedLanguage, {
            style: "unit",
            unit: "megabyte",
            unitDisplay: "short",
          }).format(AVATAR_UPLOAD_MAX_BYTES / 1024 / 1024),
        }),
      );
      return;
    }
    const url = URL.createObjectURL(selected);
    setPreviewUrl(url);
    setDraft({ kind: "uploaded", url });
    setFile(selected);
    setUploadReady(false);
    setImageFailed(false);
    setError("");
  };
  const dirty = !!file || JSON.stringify(initial) !== JSON.stringify(draft);
  const save = async () => {
    if (saving.current || !dirty || imageFailed || (file && !uploadReady)) return;
    saving.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      if (draft?.kind === "uploaded" && !file) return;
      await onSave(file ?? (draft?.kind === "generated" ? draft : null));
      onOpenChange(false);
    } catch (cause) {
      setError(t("avatar.save_failed", { "0": translateNotice(errorText(cause)) }));
    } finally {
      saving.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };
  return (
    <DialogContent
      className="max-h-[90svh] overflow-y-auto sm:max-w-xl"
      showCloseButton={!busy}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <DialogHeader>
        <DialogTitle>{t("avatar.edit")}</DialogTitle>
        <DialogDescription>{t("avatar.description")}</DialogDescription>
      </DialogHeader>
      <div className="flex items-center gap-5 rounded-xl bg-muted/50 p-4">
        <ConversationAvatar
          conversation={identity}
          value={draft}
          className="size-20"
          label={t("avatar.preview")}
          onImageStatus={(status) => {
            if (file) setUploadReady(status === "loaded");
          }}
          onImageError={() => {
            if (file) {
              setImageFailed(true);
              setError(t("avatar.image_failed"));
            }
          }}
        />
        <div className="min-w-0 space-y-1">
          <p className="truncate font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">
            {t(draft === null ? "avatar.default" : "avatar.preview")}
          </p>
          {draft === null && initial !== null && (
            <p className="text-xs text-muted-foreground">{t("avatar.reset_pending")}</p>
          )}
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full">
          <TabsTrigger value="presets" disabled={busy}>
            {t("avatar.presets")}
          </TabsTrigger>
          <TabsTrigger value="upload" disabled={busy}>
            {t("avatar.upload")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="presets" className="space-y-4 pt-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-36 flex-1 space-y-2">
              <Label htmlFor={styleId}>{t("avatar.style")}</Label>
              <NativeSelect
                id={styleId}
                value={style}
                disabled={busy}
                className="w-full"
                onChange={(event) => {
                  const nextStyle = event.target.value as AvatarStyle;
                  setStyle(nextStyle);
                  setBatch("");
                  select({ kind: "generated", style: nextStyle, seed: conversationId });
                }}
              >
                {AVATAR_STYLES.map((name) => (
                  <option key={name} value={name}>
                    {t(`avatar.style.${name}`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button variant="outline" disabled={busy} onClick={() => setBatch(crypto.randomUUID())}>
              <Shuffle />
              {t("avatar.more")}
            </Button>
          </div>
          <RadioGroup
            aria-label={t("avatar.presets")}
            value={
              draft?.kind === "generated" && draft.style === style
                ? draft.seed
                : draft === null && fallback.style === style
                  ? fallback.seed
                  : ""
            }
            disabled={busy}
            className="grid-cols-4 gap-3"
            onValueChange={(seed) => select({ kind: "generated", style, seed })}
          >
            {choices.map((choice, index) => (
              <Label
                key={choice.seed}
                htmlFor={`${radioId}-${index}`}
                className="relative flex cursor-pointer items-center justify-center rounded-xl border border-transparent bg-muted/30 p-2 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/10 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
              >
                <RadioGroupItem
                  id={`${radioId}-${index}`}
                  value={choice.seed}
                  aria-label={t("avatar.choose_variant", { "0": index + 1 })}
                  className="absolute right-1.5 top-1.5 z-10 size-3.5 bg-background after:hidden"
                />
                <ConversationAvatar
                  conversation={identity}
                  value={choice}
                  className="size-12 sm:size-16"
                />
              </Label>
            ))}
          </RadioGroup>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t("avatar.generated_locally")}
          </p>
        </TabsContent>
        <TabsContent value="upload" className="space-y-4 pt-3">
          <div className="space-y-3 rounded-xl border border-dashed p-5">
            <ImagePlus className="size-6 text-muted-foreground" />
            <Label htmlFor={inputId}>{t("avatar.pick_file")}</Label>
            <Input
              id={inputId}
              type="file"
              accept={AVATAR_MEDIA_TYPES.join(",")}
              disabled={busy}
              onChange={(event) => {
                chooseFile(event.target.files?.[0]);
                event.target.value = "";
              }}
            />
            <p className="text-xs leading-relaxed text-muted-foreground">{t("avatar.file_hint")}</p>
            {file && (
              <p className="break-all text-xs">{t("avatar.file_selected", { "0": file.name })}</p>
            )}
          </div>
        </TabsContent>
      </Tabs>
      <p className="text-xs text-muted-foreground">{t("avatar.shared")}</p>
      {file && !uploadReady && !imageFailed && (
        <p role="status" className="text-xs text-muted-foreground">
          {t("avatar.decoding")}
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      <DialogFooter className="flex-row flex-wrap items-center sm:justify-between">
        <Button
          variant="ghost"
          disabled={busy || draft === null}
          onClick={() => {
            setDraft(null);
            setFile(null);
            setPreviewUrl(null);
            setStyle(fallback.style);
            setBatch("");
            setError("");
            setImageFailed(false);
            setTab("presets");
          }}
        >
          <RotateCcw />
          {t("avatar.reset")}
        </Button>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("avatar.cancel")}
          </Button>
          <Button
            disabled={busy || !dirty || imageFailed || (!!file && !uploadReady)}
            onClick={() => void save()}
          >
            {t(busy ? "avatar.saving" : "avatar.save")}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  );
}
