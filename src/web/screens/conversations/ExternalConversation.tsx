import { ArrowDown, LockKeyhole, RefreshCw } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ConversationSummary } from "../../../shared/contracts/conversation";
import { Button } from "../../components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { useConversationEvents } from "../../features/conversations/use-conversation-events";
import { timelineKey, useTimelineScroll } from "../../features/conversations/use-timeline-scroll";
import { translateNotice } from "../../i18n";
import { useSuperstringStore } from "../../store";
import { ConversationActivity } from "../observability/ConversationActivity";
import { ConversationIdentity } from "./ConversationIdentity";
import { EventRecord } from "./EventRecord";
import { timelineRows } from "./timeline-projection";
export function ExternalConversation({
  conversation,
  directory,
}: {
  conversation: ConversationSummary;
  directory?: ReactNode;
}) {
  const { t } = useTranslation();
  const agent = useSuperstringStore((s) =>
    s.agents.find((item) => item.id === conversation.agentId),
  );
  const [tab, setTab] = useState("messages");
  const scroll = useTimelineScroll();
  const history = useConversationEvents(conversation.id, scroll.beforeChange);
  const rows = timelineRows(history.items);
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      <ConversationIdentity
        conversation={conversation}
        agentName={agent?.name}
        directory={directory}
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
      <Tabs className="relative min-h-0 flex-1 gap-0" value={tab} onValueChange={setTab}>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-7">
          <TabsList aria-label={t("workspace.conversation_view")}>
            <TabsTrigger value="messages">{t("workspace.message_history")}</TabsTrigger>
            <TabsTrigger value="activity">{t("workspace.runtime_observability")}</TabsTrigger>
          </TabsList>
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <LockKeyhole className="size-3" />
            {t("workspace.read_only_conversation_history")}
          </span>
        </div>
        <TabsContent value="messages" forceMount asChild>
          <section
            ref={scroll.viewport}
            hidden={tab !== "messages"}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:px-7 [&[hidden]]:hidden"
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
                    rows={rows}
                    conversation={conversation}
                  />
                ))}
              </ol>
            </div>
          </section>
        </TabsContent>
        <TabsContent value="activity" className="min-h-0 flex-1 overflow-auto p-4 md:p-6">
          <ConversationActivity conversationId={conversation.id} />
        </TabsContent>
        {tab === "messages" && scroll.away && (
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
      </Tabs>
      <footer className="shrink-0 border-t px-5 py-3 text-center text-[11px] text-muted-foreground">
        {t("workspace.messages_arrive_through_the_connected_bot_continue_the_conversation_in_t")}
      </footer>
    </section>
  );
}
