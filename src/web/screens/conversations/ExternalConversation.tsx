import { ArrowDown, RefreshCw } from "lucide-react";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../../shared/contracts/conversation";
import { Button } from "../../components/ui/button";
import { useConversationEvents } from "../../features/conversations/use-conversation-events";
import { timelineKey, useTimelineScroll } from "../../features/conversations/use-timeline-scroll";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { ConversationActiveTraces } from "./ConversationActiveTraces";
import { ConversationIdentity } from "./ConversationIdentity";
import { EventRecord } from "./EventRecord";
import { QqGroupControls } from "./QqGroupControls";
import { timelineRows } from "./timeline-projection";

export function ExternalConversation({
  conversation,
  active = true,
}: {
  conversation: ConversationSummary;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const agent = useSuperstringStore((s) =>
    s.agents.find((item) => item.id === conversation.agentId),
  );
  const scroll = useTimelineScroll();
  const history = useConversationEvents(conversation.id, scroll.beforeChange, { enabled: active });
  const rows = useMemo(() => timelineRows(history.items), [history.items]);
  const bySourceMap = useMemo(() => {
    const map = new Map<string, ConversationEventView>();
    for (const row of rows) {
      if (row.source.id && !map.has(row.source.id)) {
        map.set(row.source.id, row);
      }
      for (const ref of row.sources) {
        if (ref.id && !map.has(ref.id)) {
          map.set(ref.id, row);
        }
      }
    }
    return map;
  }, [rows]);
  const parkBeforeHide = scroll.parkBeforeHide;
  const wasActive = useRef(active);
  useLayoutEffect(() => {
    if (wasActive.current && !active) parkBeforeHide();
    wasActive.current = active;
  }, [active, parkBeforeHide]);
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      {/* 消息页签隐藏时身份栏、刷新与底部说明都不参与渲染；消息时间线保持挂载。 */}
      {active && (
        <>
          <ConversationIdentity
            conversation={conversation}
            agentName={agent?.name}
            actions={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={history.loading}
                aria-label={t("workspace.refresh_history")}
                onClick={() => void history.refresh()}
              >
                <RefreshCw />
              </Button>
            }
          />
          {conversation.channel === "onebot11" && conversation.topology === "shared" && (
            <div className="min-w-0 shrink-0 border-b px-4 py-2 md:px-7">
              <QqGroupControls
                bindingId={conversation.sourceId}
                expectedAgentId={conversation.agentId}
                className="w-full min-w-0"
              />
            </div>
          )}
          <ConversationActiveTraces conversationId={conversation.id} active={active} />
        </>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <section
          ref={scroll.viewport}
          hidden={!active}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-7"
          role="tabpanel"
          aria-label={t("workspace.message_history")}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The native history viewport supports Home, End and scrolling.
          tabIndex={0}
          onScroll={scroll.onScroll}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
            if (e.key === "End") {
              e.preventDefault();
              scroll.toLatest();
            } else if (e.key === "Home") {
              e.preventDefault();
              e.currentTarget.scrollTop = 0;
              scroll.onScroll();
            }
          }}
        >
          <div className="mx-auto max-w-3xl">
            {history.error && (
              <p role="alert" className="mb-4 text-sm text-destructive">
                {translateNotice(history.error)}
              </p>
            )}
            {history.loading && (
              <p
                role="status"
                className={rows.length ? "sr-only" : "text-sm text-muted-foreground"}
              >
                {t("workspace.loading_conversation")}
              </p>
            )}
            {!history.loading && !history.error && !rows.length && (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {t("workspace.no_conversation_events_yet")}
              </p>
            )}
            {history.hasMore && (
              <Button
                variant="outline"
                size="sm"
                className="mb-5 w-full"
                disabled={history.loading}
                onClick={() => void history.loadMore()}
              >
                {t("workspace.load_earlier_history")}
              </Button>
            )}
            <ol className="space-y-5">
              {rows.map((event) => (
                <EventRecord
                  key={timelineKey(event)}
                  event={event}
                  quoted={
                    event.addressing.replyTo
                      ? bySourceMap.get(event.addressing.replyTo.sourceId)
                      : undefined
                  }
                  conversation={conversation}
                />
              ))}
            </ol>
          </div>
        </section>
        {active && scroll.away && (
          <Button
            variant="secondary"
            size="sm"
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border shadow-sm"
            onClick={scroll.toLatest}
          >
            <ArrowDown />
            {scroll.unread
              ? t("workspace.new_messages_latest", { "0": scroll.unread })
              : t("workspace.jump_to_latest")}
          </Button>
        )}
        <span className="sr-only" role="status">
          {scroll.unread ? t("workspace.new_messages", { "0": scroll.unread }) : ""}
        </span>
      </div>
      {active && (
        <footer className="shrink-0 border-t px-5 py-3 text-center text-[11px] text-muted-foreground">
          {t("workspace.messages_arrive_through_the_connected_bot_continue_the_conversation_in_t")}
        </footer>
      )}
    </section>
  );
}
