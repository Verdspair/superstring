import { Activity, ArrowUpRight, Image, MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../../shared/contracts/conversation";
import { Badge } from "../../components/ui/badge";
import { timelineKey } from "../../features/conversations/use-timeline-scroll";
import { cn } from "../../lib/utils";
import { DeliveryDetails } from "../runs/DeliveryEvidence";
import { RunLink } from "../runs/RunEntry";

const deliveryLabels = {
  planned: "workspace.waiting_to_send",
  delivering: "workspace.delivering",
  confirmed: "workspace.delivered",
  failed: "workspace.delivery_failed",
  unknown: "workspace.delivery_outcome_unconfirmed",
  stale: "workspace.reply_expired",
};
const wakeLabels = {
  pending: "workspace.waiting",
  leased: "workspace.processing",
  completed: "workspace.processing_completed",
  no_output: "workspace.no_response_this_time",
  failed: "workspace.processing_failed",
};
const causes: Record<string, string> = {
  direct_reply: "workspace.direct_replies",
  follow_up: "workspace.ongoing_conversation",
  chiming_in: "workspace.chiming_in",
  idle_topic: "workspace.opening_a_quiet_room",
  mention: "workspace.assistant_mentioned",
  private: "workspace.private_message",
  reply_to_agent: "workspace.reply_to_assistant",
};
const reasons = {
  request: "workspace.direct_request",
  private: "workspace.private_message",
  mention: "workspace.assistant_mentioned",
  reply_to_agent: "workspace.reply_to_assistant",
  legacy_addressed: "workspace.historical_record_addressed_to_the_assistant",
};
const unavailable = {
  expired: "workspace.original_content_has_expired",
  revoked: "workspace.original_content_was_revoked_or_deleted",
  unavailable: "workspace.original_content_is_unavailable",
};
export function EventRecord({
  event,
  rows,
  conversation,
}: {
  event: ConversationEventView;
  rows: ConversationEventView[];
  conversation: ConversationSummary;
}) {
  const { t, i18n } = useTranslation();
  const message =
    event.kind === "inbound" || (event.kind === "outbound" && event.deliveryStatus === "confirmed");
  const source = event.addressing.replyTo;
  const quoted =
    source &&
    rows.find(
      (row) =>
        row.source.id === source.sourceId || row.sources.some((ref) => ref.id === source.sourceId),
    );
  return (
    <li
      data-timeline-key={timelineKey(event)}
      id={`source-${event.source.kind}-${event.source.id}`}
      className={cn("flex gap-3 scroll-mt-4", !message && "text-muted-foreground")}
    >
      <div
        className={cn(
          "mt-1 flex size-8 shrink-0 items-center justify-center rounded-lg",
          message ? "bg-primary/10 text-primary" : "bg-muted",
        )}
      >
        {message ? <MessageCircle className="size-4" /> : <Activity className="size-4" />}
      </div>
      <article
        className={cn(
          "min-w-0 flex-1 rounded-xl border p-4",
          message ? "bg-card" : "border-dashed bg-muted/20",
        )}
      >
        <header className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <strong className="font-medium text-foreground">
            {event.participant?.label ??
              t(
                event.kind === "wake"
                  ? "workspace.wake_activity"
                  : event.kind === "media_revision"
                    ? "workspace.media_understanding_update"
                    : "workspace.run_activity",
              )}
          </strong>
          <time dateTime={event.occurredAt} className="text-muted-foreground">
            {new Date(event.occurredAt).toLocaleString(i18n.resolvedLanguage)}
          </time>
        </header>
        {event.participant && conversation.topology === "shared" && (
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">{event.participant.id}</p>
        )}
        <div className="my-2 flex flex-wrap items-center gap-1.5">
          {event.addressing.reasons.map((reason) => (
            <Badge variant="secondary" key={reason} className="text-[10px]">
              {t(reasons[reason])}
            </Badge>
          ))}
          {event.addressing.mentionIds.map((id) => (
            <span key={id} className="text-[11px] text-primary">
              @{conversation.participants.find((person) => person.id === id)?.label ?? id}{" "}
              <code>{id}</code>
            </span>
          ))}
        </div>
        {source && (
          <div className="mb-3 rounded-md border-l-2 border-primary bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t("workspace.referenced_message")}:{" "}
            {quoted ? (
              <a
                href={`#source-${quoted.source.kind}-${quoted.source.id}`}
                className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
              >
                {quoted.participant?.label ?? source.sourceId}
                <ArrowUpRight className="size-3" />
              </a>
            ) : (
              <code>{source.sourceId}</code>
            )}
          </div>
        )}
        {event.wake && (
          <div className="my-3 space-y-1 text-xs">
            <strong>{t(wakeLabels[event.wake.status])}</strong>
            <p>
              {t("workspace.wake_reason")}: {t(causes[event.wake.cause] ?? event.wake.cause)}
            </p>
            {event.wake.status === "pending" && (
              <p>
                {t("workspace.scheduled_processing_time")}:{" "}
                <time dateTime={event.wake.readyAt}>
                  {new Date(event.wake.readyAt).toLocaleString(i18n.resolvedLanguage)}
                </time>
              </p>
            )}
            {event.wake.errorCode && <p className="text-destructive">{event.wake.errorCode}</p>}
          </div>
        )}
        {event.kind !== "wake" &&
          (event.contentState !== "active" ? (
            <p className="text-xs text-muted-foreground">{t(unavailable[event.contentState])}</p>
          ) : (
            event.kind !== "media_revision" &&
            event.text && (
              <p className="whitespace-pre-wrap break-words text-sm leading-7">{event.text}</p>
            )
          ))}
        {event.kind === "media_revision" && (
          <p className="text-xs text-muted-foreground">
            {t(
              "workspace.the_related_message_is_not_loaded_this_record_is_a_media_understanding_u",
            )}{" "}
            <code>{event.sources.find((ref) => ref.kind === "qq_event")?.id}</code>
          </p>
        )}
        {event.media.length > 0 && (
          <ul className="mt-3 space-y-2">
            {event.media.map((media) => (
              <li key={media.id} className="rounded-lg bg-muted/40 p-3 text-xs">
                <div className="flex items-center gap-2">
                  <Image className="size-3.5" />
                  <strong>
                    {t(
                      media.kind === "sticker"
                        ? "workspace.sticker"
                        : media.kind === "image"
                          ? "workspace.image"
                          : "workspace.media",
                    )}
                  </strong>
                  <code className="truncate text-muted-foreground">{media.id}</code>
                </div>
                <p className="mt-2 leading-relaxed">
                  {media.description ??
                    t(
                      media.availability === "expired"
                        ? "workspace.media_has_expired"
                        : "workspace.no_media_description_available",
                    )}
                </p>
              </li>
            ))}
          </ul>
        )}
        {event.messageStatus === "failed" && (
          <p className="mt-2 text-xs text-destructive">{t("workspace.generation_failed")}</p>
        )}
        {event.messageStatus === "cancelled" && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("workspace.generation_cancelled")}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          {event.deliveryStatus && (
            <Badge
              variant="outline"
              className={event.deliveryStatus === "failed" ? "text-destructive" : undefined}
            >
              {t(deliveryLabels[event.deliveryStatus])}
            </Badge>
          )}
          {event.runId && <RunLink runId={event.runId} />}
        </div>
        {event.outputId && (
          <div className="mt-3">
            <DeliveryDetails
              key={`${event.outputId}:${event.deliveryStatus}`}
              outputId={event.outputId}
              conversation={conversation}
            />
          </div>
        )}
        <details className="mt-3 border-t pt-2 text-[10px] text-muted-foreground">
          <summary className="cursor-pointer">{t("workspace.source_record")}</summary>
          <p className="mt-2 break-all font-mono">
            {event.source.kind}:{event.source.id}
          </p>
          <p>
            {t("workspace.event_sequence", { "0": event.seq })} · {t("workspace.source_revision")}:{" "}
            {event.source.revision}
          </p>
        </details>
      </article>
    </li>
  );
}
