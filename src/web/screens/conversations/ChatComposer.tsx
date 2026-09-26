import { ArrowUp, Bot, LoaderCircle, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupTextarea } from "../../components/ui/input-group";
import { chatBusy, currentChat } from "../../features/chat/conversation-state";
import { currentSessionId } from "../../features/conversations/directory-state";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { ContextMeter } from "./ContextMeter";
export function ChatComposer() {
  const { t } = useTranslation();
  const chat = useSuperstringStore(currentChat);
  const session = useSuperstringStore(currentSessionId);
  const canonical = useSuperstringStore((s) => s.currentConversationId);
  const sending = chatBusy(chat);
  const pendingOperations = useSuperstringStore((s) => s.pendingOperations);
  const resolving = !!session && !canonical;
  const setComposer = useSuperstringStore((s) => s.setComposer);
  const send = useSuperstringStore((s) => s.send);
  const retry = useSuperstringStore((s) => s.retryChat);
  const reconcile = useSuperstringStore((s) => s.reconcileChat);
  const error = useSuperstringStore((s) => chat.error ?? s.error);
  const feedback = useSuperstringStore((s) => chat.feedback || s.feedback);
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-5 pt-3 md:px-7">
      {(error || feedback) && (
        <div
          role={error ? "alert" : "status"}
          className={`mb-3 rounded-lg border px-3 py-2 text-sm ${error ? "border-destructive/30 bg-destructive/5 text-destructive" : "text-muted-foreground"}`}
        >
          {translateNotice(error ?? feedback)}
        </div>
      )}
      {chat.phase === "reconciling" && (
        <Button className="mb-3" variant="outline" onClick={() => void reconcile()}>
          <RotateCcw />
          {t("workspace.check_server_result")}
        </Button>
      )}
      <InputGroup className="overflow-hidden rounded-2xl border-border bg-background shadow-sm focus-within:ring-2 focus-within:ring-primary/15">
        <InputGroupTextarea
          aria-label={t("workspace.enter_a_message")}
          placeholder={
            session
              ? t("workspace.enter_a_message")
              : t("workspace.create_or_select_a_conversation_first")
          }
          className="min-h-24 max-h-60 px-4 pt-4 text-sm leading-6"
          value={chat.composer}
          disabled={sending || resolving}
          onChange={(e) => setComposer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <InputGroupAddon align="block-end" className="flex flex-wrap items-center gap-2 px-3 pb-3">
          <span className="mr-auto inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <Bot className="size-3.5" />
            <span className="max-w-40 truncate">
              {chat.runtimeConfig?.name ?? t("workspace.assistant")}
            </span>
          </span>
          <ContextMeter />
          {chat.failedChat?.sessionId === session && (
            <Button
              variant="outline"
              size="sm"
              disabled={sending || resolving}
              onClick={() => void retry()}
            >
              <RotateCcw />
              {t("workspace.retry_original_request")}
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            className="rounded-xl"
            aria-label={sending ? t("workspace.generating") : t("workspace.send")}
            disabled={sending || resolving}
            onClick={() => void send()}
          >
            {sending ? (
              <LoaderCircle className="animate-spin motion-reduce:animate-none" />
            ) : (
              <ArrowUp />
            )}
          </Button>
        </InputGroupAddon>
      </InputGroup>
      {(sending || pendingOperations > 0) && (
        <span
          role="status"
          aria-label={t("workspace.processing")}
          aria-live="polite"
          aria-atomic="true"
          className="mt-2 flex items-center justify-center gap-2 text-xs text-muted-foreground"
        >
          <LoaderCircle
            className="size-3 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          {t("workspace.processing")}
        </span>
      )}
      <p className="mt-2 text-center text-[10px] text-muted-foreground">
        {t("workspace.enter_to_send_shift_enter_for_a_new_line")}
      </p>
    </div>
  );
}
