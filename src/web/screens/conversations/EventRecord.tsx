import { Activity, ArrowUpRight, Image, MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../../shared/contracts/conversation";
import type { QqIdentity } from "../../../shared/contracts/qq-message";
import { Badge } from "../../components/ui/badge";
import { timelineKey } from "../../features/conversations/use-timeline-scroll";
import { cn } from "../../lib/utils";
import { neutralWakeReasonLabels } from "../observability/labels";
import { DeliveryDetails, staleReasonLabelKey } from "../runs/DeliveryEvidence";
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
const nameStates = {
  known: "workspace.qq_event_name_state_known",
  unknown: "workspace.qq_event_name_state_unknown",
  legacy: "workspace.qq_event_name_state_legacy",
};

/** 一条身份的双名展示：发送时快照与当前映射分行，legacy 明确"未知"而不冒充。 */
function QqNameLines({ identity }: { identity: QqIdentity }) {
  const { t } = useTranslation();
  const current = identity.currentName;
  return (
    <>
      <p>
        {t("workspace.qq_event_snapshot_names")}:{" "}
        {identity.nameState === "legacy" ? (
          <span className="break-all">{identity.legacyDisplayName ?? "—"}</span>
        ) : identity.groupCard !== null || identity.personalNickname !== null ? (
          <>
            <span className="break-all">{identity.groupCard ?? "—"}</span>
            {" / "}
            <span className="break-all">{identity.personalNickname ?? "—"}</span>
          </>
        ) : (
          t("workspace.qq_event_name_state_unknown")
        )}
        {identity.nameState !== "known" && (
          <span className="ml-1 text-[9px] opacity-75">{t(nameStates[identity.nameState])}</span>
        )}
      </p>
      <p>
        {t("workspace.qq_event_current_names")}:{" "}
        {current ? (
          <>
            <span className="break-all">{current.groupCard ?? "—"}</span>
            {" / "}
            <span className="break-all">{current.personalNickname ?? "—"}</span>
          </>
        ) : (
          <span className="italic opacity-75">
            {t("workspace.qq_event_current_names_unavailable")}
          </span>
        )}
      </p>
    </>
  );
}

/** T13 Step6：`source_record` 折叠区内的 QQ 消息详情组（快照/当前双名、@、reply、平台 ID）。 */
function QqEventFactDetails({
  facts,
}: {
  facts: NonNullable<ConversationEventView["qqMessageFacts"]>;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 space-y-2 border-l-2 border-muted pl-2">
      <p className="font-medium">{t("workspace.qq_event_details")}</p>
      {facts.map((fact) => (
        <div key={fact.id} className="space-y-1">
          <QqNameLines identity={fact.speaker} />
          <p>
            {t("workspace.qq_event_platform_message_id")}:{" "}
            <code className="break-all">{fact.platformMessageId ?? "—"}</code>
          </p>
          {fact.mentions.length > 0 && (
            <p>
              {t("workspace.qq_event_mentions")}:{" "}
              {fact.mentions.map((mention, index) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: Mentions are an immutable ordered snapshot; repeated @ needs the index for a unique key.
                  key={`${mention.qq}:${index}`}
                  className="mr-2 break-all"
                >
                  @{mention.qq === "all" ? t("workspace.qq_event_mention_all") : mention.qq}
                </span>
              ))}
            </p>
          )}
          {fact.replyTo && (
            <p>
              {t("workspace.qq_event_reply_to")}:{" "}
              <code className="break-all">{fact.replyTo.platformMessageId}</code>
            </p>
          )}
          <p>
            {t(
              fact.completeness === "full"
                ? "workspace.qq_event_completeness_full"
                : "workspace.qq_event_completeness_legacy_partial",
            )}
          </p>
        </div>
      ))}
    </div>
  );
}

import { memo } from "react";

function EventRecordComponent({
  event,
  quoted,
  conversation,
}: {
  event: ConversationEventView;
  quoted?: ConversationEventView;
  conversation: ConversationSummary;
}) {
  const { t, i18n } = useTranslation();
  const message =
    event.kind === "inbound" || (event.kind === "outbound" && event.deliveryStatus === "confirmed");
  const source = event.addressing.replyTo;
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
          {event.addressing.mentionIds.map((id, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: Mention IDs are an immutable ordered snapshot; repeated @ needs the index for a unique key.
              key={`${id}:${index}`}
              className="text-[11px] text-primary"
            >
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
              {t("workspace.wake_reason_value", {
                "0": t(causes[event.wake.cause] ?? event.wake.cause),
              })}
            </p>
            {event.wake.status === "pending" && (
              <p>
                {t("workspace.scheduled_processing_time")}:{" "}
                <time dateTime={event.wake.readyAt}>
                  {new Date(event.wake.readyAt).toLocaleString(i18n.resolvedLanguage)}
                </time>
              </p>
            )}
            {event.wake.errorCode &&
              (neutralWakeReasonLabels[event.wake.errorCode] ? (
                <p className="text-muted-foreground">
                  {t(neutralWakeReasonLabels[event.wake.errorCode])}
                </p>
              ) : (
                <p className="text-destructive">{event.wake.errorCode}</p>
              ))}
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
              {event.deliveryStatus === "stale"
                ? t(staleReasonLabelKey(event.deliveryStaleReason))
                : t(deliveryLabels[event.deliveryStatus])}
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
          <p>{t("workspace.event_revision", { "0": event.seq, "1": event.source.revision })}</p>
          {event.qqMessageFacts && event.qqMessageFacts.length > 0 && (
            <QqEventFactDetails facts={event.qqMessageFacts} />
          )}
        </details>
      </article>
    </li>
  );
}

export const EventRecord = memo(EventRecordComponent);
