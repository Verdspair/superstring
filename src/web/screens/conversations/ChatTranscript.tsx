import { ArrowDown, Bot, Trash2, UserRound } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import type { ChatItem } from "../../state/types";
import { RecordActions } from "./RecordActions";
export function ChatTranscript({
  messages,
  session,
  onDelete,
}: {
  messages: ChatItem[];
  session: string | null;
  onDelete: (id: string) => void;
}) {
  const { t } = useTranslation();
  const viewport = useRef<HTMLElement>(null);
  const following = useRef(true);
  const previousSession = useRef(session);
  const [away, setAway] = useState(false);
  const last = messages.at(-1);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Message arrivals and streamed deltas are the scroll-follow signal.
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    if (previousSession.current !== session) {
      previousSession.current = session;
      following.current = true;
      setAway(false);
    }
    if (following.current) node.scrollTop = node.scrollHeight;
  }, [session, messages.length, last?.content]);
  const latest = () => {
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
    following.current = true;
    setAway(false);
  };
  return (
    <div className="relative min-h-0 flex-1">
      <section
        ref={viewport}
        className="h-full overflow-y-auto overscroll-contain px-4 py-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-7"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The native scroll region must be keyboard scrollable.
        tabIndex={0}
        aria-label={t("workspace.message_history")}
        onScroll={() => {
          const node = viewport.current;
          if (node) {
            following.current = node.scrollHeight - node.clientHeight - node.scrollTop < 64;
            setAway(!following.current);
          }
        }}
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-7">
          {messages
            .filter((message) => message.role !== "system")
            .map((message) => (
              <TranscriptMessage
                key={message.id}
                message={message}
                onDelete={() => onDelete(message.id)}
              />
            ))}
        </div>
      </section>
      {away && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border shadow-sm"
          onClick={latest}
        >
          <ArrowDown />
          {t("workspace.jump_to_latest")}
        </Button>
      )}
    </div>
  );
}
function TranscriptMessage({ message, onDelete }: { message: ChatItem; onDelete: () => void }) {
  const { t, i18n } = useTranslation();
  const user = message.role === "user";
  const actionable = message.status !== "pending" && !message.id.startsWith("optimistic-");
  return (
    <RecordActions
      label={t("workspace.message_actions")}
      disabled={!actionable}
      actions={[
        { label: t("workspace.delete_message"), icon: Trash2, destructive: true, run: onDelete },
      ]}
    >
      {(trigger) => (
        <article
          className={cn(
            "group flex gap-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
            user && "flex-row-reverse",
          )}
          tabIndex={actionable ? 0 : undefined}
          aria-label={t("workspace.message", {
            "0": t(user ? "workspace.user" : "workspace.model"),
          })}
        >
          <div
            className={cn(
              "mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg",
              user ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
            )}
          >
            {user ? <UserRound className="size-4" /> : <Bot className="size-4" />}
          </div>
          <div className={cn("min-w-0", user ? "max-w-[85%]" : "flex-1")}>
            <div
              className={cn(
                "mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground",
                user && "justify-end",
              )}
            >
              <strong className="font-medium text-foreground">
                {t(user ? "workspace.user" : "workspace.model")}
              </strong>
              <time dateTime={message.completedAt ?? message.createdAt}>
                {new Date(message.completedAt ?? message.createdAt).toLocaleTimeString(
                  i18n.resolvedLanguage,
                  {
                    hour: "2-digit",
                    minute: "2-digit",
                  },
                )}
              </time>
            </div>
            <div
              className={cn(
                "whitespace-pre-wrap break-words text-sm leading-7",
                user && "rounded-2xl rounded-tr-sm bg-muted px-4 py-2.5",
              )}
            >
              {message.content ||
                (message.status === "pending" ? t("workspace.generating_388530") : "")}
            </div>
            {(message.status === "failed" || message.status === "cancelled") && (
              <p role="status" className="mt-2 text-xs text-destructive">
                {t(
                  message.status === "failed"
                    ? "workspace.generation_failed"
                    : "workspace.generation_cancelled",
                )}
                {message.errorCode && ` · ${message.errorCode}`}
              </p>
            )}
            <div className={cn("mt-1 flex", user && "justify-end")}>{trigger}</div>
          </div>
        </article>
      )}
    </RecordActions>
  );
}
