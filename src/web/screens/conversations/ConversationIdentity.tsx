import { Info } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { Field } from "@/components/form-field";
import type {
  ConversationMemoryReadMode,
  ConversationSummary,
} from "../../../shared/contracts/conversation";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { NativeSelect } from "../../components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../../components/ui/sheet";
import { conversationModeDirty } from "../../features/conversations/directory-state";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { ConversationAvatarButton } from "./avatar-control";
export function ConversationIdentity({
  conversation,
  agentName,
  model,
  mode,
  actions,
  directory,
}: {
  conversation: ConversationSummary | null;
  agentName?: string;
  model?: string;
  mode?: string;
  actions?: ReactNode;
  directory?: ReactNode;
}) {
  const { t } = useTranslation();
  const s = useSuperstringStore(
    useShallow((state) => ({
      apiClient: state.apiClient,
      baseline: state.memoryReadModeBaseline,
      draft: state.memoryReadModeDraft,
      loading: state.memoryReadModeLoading,
      saving: state.memoryReadModeSaving,
      error: state.memoryReadModeError,
      loadMode: state.loadConversationMemoryReadMode,
      cancelModeRead: state.cancelConversationMemoryReadMode,
      patchDraft: state.patchConversationMemoryReadModeDraft,
      saveMode: state.saveConversationMemoryReadMode,
      discardDraft: state.discardConversationMemoryReadMode,
      refreshMode: state.refreshConversationMemoryReadMode,
    })),
  );
  const isDirty = useSuperstringStore(conversationModeDirty);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const conversationId = conversation?.id;

  useEffect(() => {
    if (conversationId && s.apiClient === useSuperstringStore.getState().apiClient) {
      void s.loadMode(conversationId);
    }
    return () => {
      s.cancelModeRead();
    };
  }, [conversationId, s.apiClient, s.loadMode, s.cancelModeRead]);

  const baseline = s.baseline;
  const isCurrentConvBaseline =
    baseline !== null && baseline.id === conversationId && baseline.api === s.apiClient;
  const hasLoadedMode = isCurrentConvBaseline && baseline !== null;
  const currentEffectiveMode = hasLoadedMode ? baseline.mode : null;
  const effectiveDraftMode = isCurrentConvBaseline && s.draft ? s.draft : currentEffectiveMode;

  return (
    <header className="flex min-h-20 shrink-0 items-center gap-3 border-b bg-background px-4 py-4 md:px-7">
      {directory}
      {conversation && (
        <ConversationAvatarButton key={conversation.id} conversation={conversation} />
      )}
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-base font-semibold tracking-tight">
          {conversation?.title ?? t("workspace.your_next_conversation")}
        </h2>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <Badge variant="outline" className="py-0 text-[10px]">
            {conversation?.channel === "onebot11"
              ? t(
                  conversation.topology === "shared"
                    ? "workspace.onebot_group"
                    : "workspace.onebot_direct",
                )
              : t("workspace.web_direct")}
          </Badge>
          {agentName && <span>{agentName}</span>}
          {conversation?.qqGroup && (
            <span className="font-mono" title={t("workspace.group_number")}>
              {conversation.qqGroup.number}
            </span>
          )}
          {mode && (
            <span>
              {mode === "chat"
                ? t("workspace.chat_mode")
                : mode === "work"
                  ? t("workspace.work_mode")
                  : t("workspace.unknown_mode", { "0": mode })}
            </span>
          )}
          {model && <span className="hidden max-w-56 truncate font-mono lg:inline">{model}</span>}
          {conversation && (
            <Button
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10px] gap-1 font-normal"
              tooltip={t("hints.conversations.memoryReadMode")}
              aria-label={t("conversations.memoryReadMode.label")}
              onClick={() => setDetailsOpen(true)}
            >
              <span>{t("conversations.memoryReadMode.shortTitle")}:</span>
              <span className="font-semibold text-foreground">
                {s.loading && !hasLoadedMode
                  ? t("conversations.memoryReadMode.loading")
                  : s.error && !hasLoadedMode
                    ? t("conversations.memoryReadMode.errorRetry")
                    : currentEffectiveMode === "agent_shared"
                      ? t("conversations.memoryReadMode.agent_shared")
                      : currentEffectiveMode === "current_conversation"
                        ? t("conversations.memoryReadMode.current_conversation")
                        : t("conversations.memoryReadMode.loading")}
              </span>
              {isDirty && (
                <>
                  <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
                  <span className="sr-only">{t("library.unsaved.changes")}</span>
                </>
              )}
            </Button>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {actions}
        {conversation && (
          <Sheet key={conversation.id} open={detailsOpen} onOpenChange={setDetailsOpen}>
            <SheetTrigger asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                tooltip={t("hints.conversation.details")}
                aria-label={t("workspace.conversation_details")}
              >
                <Info />
              </Button>
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>{t("workspace.conversation_details")}</SheetTitle>
                <SheetDescription>{conversation.title}</SheetDescription>
              </SheetHeader>
              <div className="space-y-6 overflow-auto px-5 pb-5 text-sm">
                <ConversationAvatarButton
                  key={conversation.id}
                  conversation={conversation}
                  detailed
                />
                <section className="space-y-3 rounded-lg border p-4 bg-card">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold tracking-tight">
                      {t("conversations.memoryReadMode.title")}
                    </h3>
                    {hasLoadedMode && (
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {t("common.revision", { "0": baseline.revision })}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {!hasLoadedMode
                      ? t("conversations.memoryReadMode.unknown_description")
                      : effectiveDraftMode === "agent_shared"
                        ? t("conversations.memoryReadMode.agent_shared_description")
                        : t("conversations.memoryReadMode.current_conversation_description")}
                  </p>
                  <Field label="conversations.memoryReadMode.selectLabel">
                    <NativeSelect
                      aria-label={t("conversations.memoryReadMode.selectLabel")}
                      disabled={!hasLoadedMode || s.loading || s.saving}
                      value={effectiveDraftMode ?? ""}
                      onChange={(e) => {
                        if (e.target.value) {
                          s.patchDraft(e.target.value as ConversationMemoryReadMode);
                        }
                      }}
                    >
                      {!hasLoadedMode && (
                        <option value="">
                          {s.loading
                            ? t("conversations.memoryReadMode.loading")
                            : t("conversations.memoryReadMode.unknown")}
                        </option>
                      )}
                      <option value="current_conversation">
                        {t("conversations.memoryReadMode.current_conversation")}
                      </option>
                      <option value="agent_shared">
                        {t("conversations.memoryReadMode.agent_shared")}
                      </option>
                    </NativeSelect>
                  </Field>

                  {s.error && (
                    <div
                      role="alert"
                      className="rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive space-y-1"
                    >
                      <p>{translateNotice(s.error)}</p>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px]"
                        disabled={s.loading || s.saving}
                        onClick={() => void s.refreshMode(conversation.id)}
                      >
                        {t("conversations.memoryReadMode.refresh")}
                      </Button>
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!hasLoadedMode || !isDirty || s.saving || s.loading}
                      onClick={s.discardDraft}
                    >
                      {t("conversations.memoryReadMode.discard")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={!hasLoadedMode || !isDirty || s.saving || s.loading}
                      onClick={() => void s.saveMode(conversation.id)}
                    >
                      {s.saving
                        ? t("conversations.memoryReadMode.saving")
                        : t("conversations.memoryReadMode.save")}
                    </Button>
                  </div>
                </section>
                <dl className="space-y-4">
                  {[
                    ["workspace.conversation_id", conversation.id],
                    ...(conversation.qqGroup
                      ? [["workspace.group_number", conversation.qqGroup.number]]
                      : []),
                    ["workspace.source_binding", conversation.sourceId],
                    ["workspace.assistant", conversation.agentId],
                    ["workspace.source_revision", conversation.bindingEpoch],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted-foreground">{t(String(label))}</dt>
                      <dd className="mt-1 break-all font-mono text-xs">{value}</dd>
                    </div>
                  ))}
                </dl>
                <section>
                  <h2 className="mb-3 font-medium">{t("workspace.participants")}</h2>
                  <ul className="divide-y rounded-lg border">
                    {conversation.participants.map((person) => (
                      <li key={person.id} className="p-3">
                        <strong className="text-sm font-medium">{person.label}</strong>
                        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                          {person.id}
                        </p>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </SheetContent>
          </Sheet>
        )}
      </div>
    </header>
  );
}
