import { Copy, FileDiff, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type QqSchemePrompts, qqReplyTaskPrompt } from "../../../shared/contracts/qq";
import { ConfirmDialog } from "../../components/confirmation";
import { Field } from "../../components/form-field";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
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
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Textarea } from "../../components/ui/textarea";
import { invalidSchemeInputs } from "../../features/qq/draft-state";
import { qqSchemeChanges, qqSchemeDirty } from "../../features/qq/types";
import { useQqInput } from "../../features/qq/use-qq-input";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { TRIGGER_LABELS } from "./binding-editor";
import {
  localClock,
  mediaFields,
  type NumericGroup,
  numericGroups,
  participationFields,
  utcMinutes,
} from "./scheme-fields";

function SchemeNumber({
  group,
  name,
  label,
  info,
}: {
  group: NumericGroup;
  name: string;
  label: string;
  info?: string;
}) {
  const { t } = useTranslation();
  const {
    qqSchemeEditor: editor,
    qqSchemeSaving: saving,
    patchQqSchemeGroup: patch,
  } = useSuperstringStore();
  const [texts, setTexts] = useQqInput("schemeTexts");
  const [invalid, setInvalid] = useQqInput("schemeInvalid");
  if (!editor) return null;
  const id = `${group}.${name}`;
  const value = (editor[group] as unknown as Record<string, number>)[name] ?? 0;
  const schema = (
    numericGroups[group].shape as Record<
      string,
      { safeParse: (v: unknown) => { success: boolean } }
    >
  )[name];
  const valid = (raw: string) =>
    raw.trim() !== "" && schema?.safeParse(Number(raw)).success === true;
  const clear = () => {
    setTexts((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    setInvalid((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
  };
  return (
    <Field label={label} info={info}>
      <Input
        type="number"
        disabled={saving}
        value={texts[id] ?? String(value)}
        aria-invalid={!!invalid[id]}
        onChange={(e) => {
          const raw = e.target.value;
          setTexts((old) => ({ ...old, [id]: raw }));
          if (valid(raw)) {
            patch(group, { [name]: Number(raw) });
            setInvalid((old) => {
              const next = { ...old };
              delete next[id];
              return next;
            });
          }
        }}
        onBlur={() => {
          const raw = texts[id];
          if (raw === undefined) return;
          if (valid(raw)) {
            patch(group, { [name]: Number(raw) });
            clear();
          } else
            setInvalid((old) => ({
              ...old,
              [id]: t("connections.enterAValidIntegerWithinTheAllowedRange"),
            }));
        }}
      />
      {invalid[id] && (
        <p className="text-xs text-destructive" role="alert">
          {invalid[id]}
        </p>
      )}
    </Field>
  );
}

function PromptEditor({
  slot,
  titleKey,
  hint,
}: {
  slot: keyof QqSchemePrompts;
  titleKey: string;
  hint: string;
}) {
  const { qqSchemeEditor, qqSchemeSaving, patchQqSchemeGroup } = useSuperstringStore();
  return (
    <Field label={titleKey} info={hint}>
      <Textarea
        className="min-h-36 font-mono text-xs leading-6"
        disabled={qqSchemeSaving}
        value={qqSchemeEditor?.prompts[slot] ?? ""}
        onChange={(e) => patchQqSchemeGroup("prompts", { [slot]: e.target.value })}
      />
    </Field>
  );
}

/** A named policy studio with a shared draft across four task-oriented tabs. */
export function SchemeStudio() {
  const { t } = useTranslation();
  const state = useSuperstringStore();
  const { loadQqSchemes, loadQqStickers, qqSchemeEditor: editor, qqSchemeSaving: saving } = state;
  const [task, setTask] = useState("participation");
  const [naming, setNaming] = useState<"new" | "copy" | null>(null);
  const [newName, setNewName] = useQqInput("schemeNewName");
  const [copyName, setCopyName] = useQqInput("schemeCopyName");
  const [preview, setPreview] = useState(false);
  const [pending, setPending] = useState<{ message: string; action: () => void } | null>(null);
  useEffect(() => {
    void loadQqSchemes();
    void loadQqStickers();
  }, [loadQqSchemes, loadQqStickers]);
  const changes = qqSchemeChanges(editor);
  const invalid =
    Object.keys(state.qqInputs.schemeInvalid).length > 0 || invalidSchemeInputs(state).length > 0;
  const dirty = qqSchemeDirty(editor) || invalid;
  const guard = (action: () => void) => {
    if (dirty)
      setPending({
        message: t("connections.thisSchemeHasUnsavedChangesDiscardAndContinue"),
        action: () => {
          state.discardQqSchemeChanges();
          action();
        },
      });
    else action();
  };
  const selectedUsage =
    state.qqSchemeUsage && state.qqSchemeUsage.schemeId === editor?.source.id
      ? state.qqSchemeUsage.bindings
      : null;
  const effectiveTab = editor ? task : "participation";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b px-6 py-4 lg:px-8">
        <NativeSelect
          className="min-w-48"
          aria-label={t("connections.chooseAChatScheme")}
          value={editor?.source.id ?? ""}
          disabled={saving}
          onChange={(e) => guard(() => state.selectQqScheme(e.target.value))}
        >
          {!state.qqSchemes.length && <option value="">{t("connections.noSchemesYet")}</option>}
          {state.qqSchemes.map((scheme) => (
            <option key={scheme.id} value={scheme.id}>
              {scheme.name}
            </option>
          ))}
        </NativeSelect>
        <Badge variant="outline">
          {selectedUsage === null
            ? t("connections.readingUsage")
            : t("connections.usedByValueConversations", { "0": selectedUsage })}
        </Badge>
        <div className="ml-auto flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => guard(() => setNaming("new"))}
          >
            <Plus />
            {t("connections.create")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!editor || saving || invalid}
            onClick={() => setNaming("copy")}
          >
            <Copy />
            {t("connections.saveAs")}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("connections.deleteScheme")}
            disabled={!editor || saving || selectedUsage === null}
            onClick={() =>
              editor &&
              setPending({
                message: t("connections.deleteSchemeValueItIsUsedByValueConversations", {
                  "0": editor.name,
                  "1": selectedUsage,
                }),
                action: () => void state.deleteQqScheme(editor.source.id),
              })
            }
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {!editor ? (
        <div className="grid flex-1 place-content-center gap-3 p-8 text-center">
          <h2 className="text-lg font-medium">
            {t("connections.defineParticipationInRealConversations")}
          </h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("connections.aSchemeCanBeSharedBySeveralGroupsOr")}
          </p>
          <Button disabled={saving} onClick={() => setNaming("new")}>
            <Plus />
            {t("connections.newScheme")}
          </Button>
        </div>
      ) : (
        <Tabs value={effectiveTab} onValueChange={setTask} className="min-h-0 flex-1 gap-0">
          <div className="overflow-x-auto border-b px-6 py-3 lg:px-8">
            <TabsList>
              <TabsTrigger value="participation">{t("connections.whenToParticipate")}</TabsTrigger>
              <TabsTrigger value="response">{t("connections.howToRespond")}</TabsTrigger>
              <TabsTrigger value="context">{t("connections.whatToRead")}</TabsTrigger>
              <TabsTrigger value="media">{t("connections.mediaAndExpression")}</TabsTrigger>
            </TabsList>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto max-w-5xl px-6 py-7 lg:px-8">
              <TabsContent value="participation" className="m-0 space-y-8">
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="connections.schemeName">
                    <Input
                      value={editor.name}
                      disabled={saving}
                      onChange={(e) => state.patchQqScheme({ name: e.target.value })}
                    />
                  </Field>
                  <Field label="connections.description">
                    <Input
                      value={editor.description}
                      disabled={saving}
                      onChange={(e) => state.patchQqScheme({ description: e.target.value })}
                    />
                  </Field>
                </div>
                <section className="space-y-4">
                  <h2 className="text-base font-semibold">{t("connections.speechTriggers")}</h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {Object.entries(TRIGGER_LABELS).map(([key, label]) => (
                      <Label key={key} className="flex items-start gap-3 rounded-lg border p-4">
                        <Checkbox
                          disabled={saving}
                          checked={editor.triggers[key as keyof typeof TRIGGER_LABELS]}
                          onCheckedChange={(value) =>
                            state.patchQqSchemeGroup("triggers", { [key]: value === true })
                          }
                        />
                        <span className="space-y-1">
                          <span className="block">{t(label)}</span>
                          <span className="block text-xs font-normal leading-5 text-muted-foreground">
                            {t(
                              key === "direct_reply" || key === "follow_up"
                                ? "connections.directRepliesAndOngoingConversationsAreNotSubjectTo"
                                : "connections.subjectToScoreCooldownHourlyLimitsAndActiveHours",
                            )}
                          </span>
                        </span>
                      </Label>
                    ))}
                  </div>
                </section>
                <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
                  {participationFields.map(([name, label, info]) => (
                    <SchemeNumber key={name} group="rhythm" name={name} label={label} info={info} />
                  ))}
                </div>
                <section className="space-y-5 border-t pt-6">
                  <Label>
                    <Checkbox
                      disabled={saving}
                      checked={editor.rhythm.active_hours_enabled}
                      onCheckedChange={(checked) =>
                        state.patchQqSchemeGroup("rhythm", {
                          active_hours_enabled: checked === true,
                        })
                      }
                    />
                    {t("connections.allowedHours")}
                  </Label>
                  <div className="grid grid-cols-2 gap-5">
                    {(["start", "end"] as const).map((side) => {
                      const key = `active_hours_${side}_minutes` as const;
                      return (
                        <Field
                          key={key}
                          label={
                            side === "start"
                              ? "connections.allowedHoursStart"
                              : "connections.allowedHoursEnd"
                          }
                        >
                          <Input
                            type="time"
                            value={localClock(editor.rhythm[key])}
                            disabled={saving || !editor.rhythm.active_hours_enabled}
                            onChange={(e) => {
                              const minutes = utcMinutes(e.target.value);
                              if (minutes !== null)
                                state.patchQqSchemeGroup("rhythm", { [key]: minutes });
                            }}
                          />
                        </Field>
                      );
                    })}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("connections.useLocalTimeEqualStartAndEndMeansAll")}
                  </p>
                </section>
                <PromptEditor
                  slot="judge"
                  titleKey="connections.judgementTask"
                  hint="connections.decideWhetherToSpeak"
                />
              </TabsContent>
              <TabsContent value="response" className="m-0 space-y-8">
                <section className="space-y-4">
                  <Label>
                    <Checkbox
                      checked={editor.reply.split_by_speaker}
                      disabled={saving}
                      onCheckedChange={(value) =>
                        state.patchQqSchemeGroup("reply", { split_by_speaker: value === true })
                      }
                    />
                    {t("connections.answerEachSpeakerSeparately")}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t("connections.whenEnabledGenerateAReplyPerSpeakerAndAdd")}
                  </p>
                  <Field
                    label="connections.effectiveReplyTask"
                    info="connections.readOnlyDeterminedByTheReplyMode"
                  >
                    <Textarea
                      readOnly
                      className="min-h-36 bg-muted font-mono text-xs leading-6"
                      value={qqReplyTaskPrompt(editor.reply.split_by_speaker)}
                    />
                  </Field>
                </section>
                <PromptEditor
                  slot="scene"
                  titleKey="connections.sceneAndBehaviour"
                  hint="connections.howTheAssistantTalksInQqAtAll"
                />
                <PromptEditor
                  slot="review"
                  titleKey="connections.reviewTask"
                  hint="connections.newMessagesArrivedDoesThisReplyStillStand"
                />
              </TabsContent>
              <TabsContent value="context" className="m-0 space-y-8">
                {(["judgement", "reply"] as const).map((part) => (
                  <section key={part} className="space-y-5">
                    <div className="border-b pb-3">
                      <h2 className="text-base font-semibold">
                        {t(
                          part === "judgement"
                            ? "connections.judgementContext"
                            : "connections.replyContext",
                        )}
                      </h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {t("connections.recentMessagesAndOutputReserveHaveSeparateBudgetsValues")}
                      </p>
                    </div>
                    <div className="grid gap-5 sm:grid-cols-2">
                      <SchemeNumber
                        group="context"
                        name={`${part}_message_limit`}
                        label={
                          part === "judgement"
                            ? "connections.judgementRecentMessages"
                            : "connections.replyRecentMessages"
                        }
                      />
                      <SchemeNumber
                        group="context"
                        name={`${part}_window_minutes`}
                        label={
                          part === "judgement"
                            ? "connections.judgementTimeWindowMinutes"
                            : "connections.replyTimeWindowMinutes"
                        }
                      />
                      <SchemeNumber
                        group="context"
                        name={`${part}_token_budget`}
                        label={
                          part === "judgement"
                            ? "connections.judgementBudgetEstimatedBytes"
                            : "connections.replyBudgetEstimatedBytes"
                        }
                      />
                      <SchemeNumber
                        group="outputReserve"
                        name={`${part}_output_reserved`}
                        label={
                          part === "judgement"
                            ? "connections.judgementOutputReserveEstimatedBytes"
                            : "connections.replyOutputReserveEstimatedBytes"
                        }
                      />
                    </div>
                  </section>
                ))}
                <div className="rounded-lg bg-muted p-5 text-sm leading-6">
                  <h3 className="font-medium">
                    {t("connections.bindingsDetermineTheMaterialScope")}
                  </h3>
                  <p className="mt-2 text-muted-foreground">
                    {t("connections.judgementUsesAuthorizedMemoryAndKnowledgeRepliesRetainThe")}
                  </p>
                  <Button
                    className="mt-3"
                    variant="outline"
                    onClick={() => state.openSettingsRoute("knowledge-config")}
                  >
                    {t("connections.manageKnowledge")}
                  </Button>
                </div>
              </TabsContent>
              <TabsContent value="media" className="m-0 space-y-8">
                <div className="grid gap-5 sm:grid-cols-2">
                  {mediaFields.map(([group, name, label]) => (
                    <SchemeNumber key={name} group={group} name={name} label={label} />
                  ))}
                </div>
                <section className="space-y-4 border-t pt-6">
                  <h2 className="font-semibold">{t("connections.authorizedCollections")}</h2>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {state.qqStickerCollections.map((collection) => (
                      <Label key={collection.id} className="rounded-lg border p-3">
                        <Checkbox
                          checked={editor.stickerCollectionIds.includes(collection.id)}
                          disabled={saving}
                          onCheckedChange={(value) =>
                            state.patchQqScheme({
                              stickerCollectionIds:
                                value === true
                                  ? [...editor.stickerCollectionIds, collection.id]
                                  : editor.stickerCollectionIds.filter(
                                      (id) => id !== collection.id,
                                    ),
                            })
                          }
                        />
                        {collection.name}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {collection.asset_count}
                        </span>
                      </Label>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("connections.onlyEnabledAssetsInAuthorizedCollectionsCanBeSelected")}
                  </p>
                  <Button variant="outline" onClick={() => state.openSettingsRoute("qq-stickers")}>
                    {t("connections.manageStickers")}
                  </Button>
                </section>
                <PromptEditor
                  slot="sticker"
                  titleKey="connections.stickerTask"
                  hint="connections.pickOneStickerFromTheCandidatesOutputOnlyIts"
                />
                <PromptEditor
                  slot="media"
                  titleKey="connections.mediaNoteTask"
                  hint="connections.describeWhatThePictureOrVoiceActuallyContains"
                />
              </TabsContent>
            </div>
          </ScrollArea>
        </Tabs>
      )}
      {editor && (
        <footer className="flex flex-wrap items-center gap-2 border-t bg-background px-6 py-3 lg:px-8">
          <p className="mr-auto text-xs text-muted-foreground" role="status">
            {invalid
              ? t("connections.correctInvalidNumbersFirst")
              : t("connections.valueUnsavedChanges", { "0": changes.length })}
          </p>
          <Button variant="ghost" size="sm" onClick={() => setPreview(true)}>
            <FileDiff />
            {t("connections.reviewChanges")}
          </Button>
          <Button
            variant="outline"
            disabled={saving || !dirty}
            onClick={() => state.discardQqSchemeChanges()}
          >
            {t("connections.discardChanges")}
          </Button>
          <Button
            disabled={saving || invalid || !changes.length || !editor.name.trim()}
            onClick={() => void state.saveQqScheme()}
          >
            <Save />
            {t("connections.saveScheme")}
          </Button>
        </footer>
      )}
      {pending && (
        <ConfirmDialog
          message={pending.message}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const action = pending.action;
            setPending(null);
            action();
          }}
        />
      )}
      <Dialog
        open={naming !== null}
        onOpenChange={(open) => {
          if (!open && !saving) setNaming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t(naming === "copy" ? "connections.saveAsANewScheme" : "connections.newScheme")}
            </DialogTitle>
            <DialogDescription>
              {t("connections.aSharedSchemeMayAffectSeveralConversationsReviewIts")}
            </DialogDescription>
          </DialogHeader>
          <Field label="connections.schemeName">
            <Input
              value={naming === "copy" ? copyName : newName}
              disabled={saving}
              onChange={(e) =>
                naming === "copy" ? setCopyName(e.target.value) : setNewName(e.target.value)
              }
            />
          </Field>
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {translateNotice(state.error)}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setNaming(null)}>
              {t("connections.cancel")}
            </Button>
            <Button
              disabled={saving || !(naming === "copy" ? copyName : newName).trim()}
              onClick={() => {
                const request =
                  naming === "copy"
                    ? state.duplicateQqScheme(copyName.trim())
                    : state.createQqScheme(newName.trim());
                void request.then((ok) => {
                  if (ok) {
                    setNaming(null);
                    setNewName("");
                    setCopyName("");
                  }
                });
              }}
            >
              {t("connections.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent className="max-h-[85dvh] overflow-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("connections.reviewChanges")}</DialogTitle>
            <DialogDescription>
              {t("connections.theWholeSchemeIsSavedTogetherOnlyChangedFields")}
            </DialogDescription>
          </DialogHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("connections.field")}</TableHead>
                <TableHead>{t("connections.before")}</TableHead>
                <TableHead>{t("connections.after")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {changes.map((change) => (
                <TableRow key={change.field}>
                  <TableCell className="font-mono text-xs">{change.field}</TableCell>
                  <TableCell className="max-w-64 whitespace-pre-wrap break-words">
                    {change.before}
                  </TableCell>
                  <TableCell className="max-w-64 whitespace-pre-wrap break-words">
                    {change.after}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>
    </div>
  );
}
