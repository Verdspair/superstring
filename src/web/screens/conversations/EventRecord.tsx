import type { TFunction } from "i18next";
import { Activity, ArrowUpRight, Image, MessageCircle } from "lucide-react";
import { memo } from "react";
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
import type { ConversationTimelineRow } from "./timeline-projection";

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
const taskLabels: Record<string, string> = {
  pending: "workspace.waiting",
  running: "workspace.processing",
  completed: "workspace.task_completed",
  no_output: "workspace.no_response_this_time",
  failed: "workspace.task_processing_failed",
  cancelled: "connections.tasks.status.cancelled",
  expired: "connections.execution.runtimeStorage.statusExpired",
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

type EventMedia = ConversationEventView["media"][number];
type MediaGroup = { kind: string; availability: EventMedia["availability"]; count: number };

const mediaKindLabels: Record<string, string> = {
  sticker: "workspace.sticker",
  image: "workspace.image",
};
const mediaStateLabels = {
  available: "workspace.no_media_description_available",
  expired: "workspace.media_has_expired",
  unavailable: "workspace.media_is_unavailable",
} as const;

function mediaKindLabel(kind: string): string {
  return mediaKindLabels[kind] ?? "workspace.media";
}

/**
 * 媒体摘要：只有“可用且有描述”的媒体展开成完整卡片；其余按 kind + availability 合并成一行。
 * 无描述不推断为未启用/失败；不可用或过期时不展示旧描述。所有媒体 id 仍由来源记录保留。
 */
/** 按“可用且有描述”与 kind+availability 分组：可用描述进完整卡片，其余合并计数。 */
function groupMedia(media: EventMedia[]): { readable: EventMedia[]; groups: MediaGroup[] } {
  const readable: EventMedia[] = [];
  const groupMap = new Map<string, MediaGroup>();
  for (const item of media) {
    if (item.availability === "available" && item.description) {
      readable.push(item);
      continue;
    }
    const key = `${item.kind}:${item.availability}`;
    const group = groupMap.get(key);
    if (group) group.count += 1;
    else groupMap.set(key, { kind: item.kind, availability: item.availability, count: 1 });
  }
  return { readable, groups: [...groupMap.values()] };
}

/**
 * 独立媒体更新行的单行摘要：不可用/过期/无描述媒体按 kind+availability 给状态；
 * 全部可读时只给类型计数，描述仍在来源记录 details 内展开。旧描述不在此推断展示。
 */
function mediaCompactSummary(media: EventMedia[], t: TFunction): string {
  const groups = new Map<
    string,
    { kind: string; availability: EventMedia["availability"] | null; count: number }
  >();
  for (const item of media) {
    const availability =
      item.availability === "available" && item.description ? null : item.availability;
    const key = `${item.kind}:${availability ?? "described"}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { kind: item.kind, availability, count: 1 });
  }
  return [...groups.values()]
    .map((group) => {
      const label = `${t(mediaKindLabel(group.kind))}${group.count > 1 ? ` ×${group.count}` : ""}`;
      return group.availability === null
        ? label
        : `${label} · ${t(mediaStateLabels[group.availability])}`;
    })
    .join(" · ");
}

function MediaRecords({ media, className }: { media: EventMedia[]; className: string }) {
  const { t } = useTranslation();
  const { readable, groups } = groupMedia(media);
  return (
    <ul className={className}>
      {readable.map((item) => (
        <li key={item.id} className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
          <div className="flex items-center gap-2">
            <Image className="size-3.5 shrink-0" />
            <strong>{t(mediaKindLabel(item.kind))}</strong>
          </div>
          <p className="mt-1 leading-relaxed">{item.description}</p>
        </li>
      ))}
      {groups.map((group) => (
        <li
          key={`${group.kind}:${group.availability}`}
          className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground"
        >
          <Image className="size-3.5 shrink-0" />
          <span>
            {t(mediaKindLabel(group.kind))}
            {group.count > 1 ? ` ×${group.count}` : ""}
            {" · "}
            {t(mediaStateLabels[group.availability])}
          </span>
        </li>
      ))}
    </ul>
  );
}

function EventRecordComponent({
  event,
  quoted,
  conversation,
}: {
  event: ConversationTimelineRow;
  quoted?: ConversationEventView;
  conversation: ConversationSummary;
}) {
  const { t, i18n } = useTranslation();

  // Deduplicate nested deliveries from activityEvents by outputId
  const nestedDeliveriesRaw = (event.activityEvents ?? []).filter(
    (e) =>
      e.kind === "delivery" ||
      e.kind === "outbound" ||
      Boolean(e.outputId) ||
      Boolean(e.deliveryStatus),
  );
  const nestedDeliveryMap = new Map<string, ConversationEventView>();
  const nestedDeliveriesWithoutOutput: ConversationEventView[] = [];
  for (const d of nestedDeliveriesRaw) {
    if (d.outputId) {
      nestedDeliveryMap.set(d.outputId, d);
    } else {
      nestedDeliveriesWithoutOutput.push(d);
    }
  }
  const nestedDeliveryItems = [...nestedDeliveryMap.values(), ...nestedDeliveriesWithoutOutput];

  const hasConfirmedDelivery =
    event.deliveryStatus === "confirmed" ||
    nestedDeliveryItems.some((d) => d.deliveryStatus === "confirmed");

  const task = event.task ?? null;
  const wake = event.wake ?? null;
  const runId = event.runId ?? null;
  const showsStatus =
    Boolean(task || wake) &&
    !(
      hasConfirmedDelivery &&
      wake?.status === "no_output" &&
      (!task || task.status === "no_output")
    );
  const standaloneRunId =
    !showsStatus && runId && !nestedDeliveryItems.some((delivery) => delivery.runId === runId)
      ? runId
      : null;
  const statusLabel = (label: string) =>
    runId ? (
      <RunLink runId={runId}>
        <strong>{label}</strong>
      </RunLink>
    ) : (
      <strong>{label}</strong>
    );

  const message =
    event.kind === "inbound" ||
    (event.kind === "outbound" && event.deliveryStatus === "confirmed") ||
    hasConfirmedDelivery;
  const source = event.addressing.replyTo;
  // 独立媒体更新（未并入已加载消息、无任务/送达/输出/寻址上下文）时默认紧凑单行；
  // 任务/唤醒/输出/未知送达/被引用等非纯媒体更新不紧凑，原文与媒体记录照常展示。
  const compactMediaRevision =
    event.kind === "media_revision" &&
    !event.activityId &&
    !event.messageStatus &&
    !event.addressing.replyTo &&
    event.addressing.reasons.length === 0 &&
    event.addressing.mentionIds.length === 0 &&
    !task &&
    !wake &&
    !event.outputId &&
    !event.deliveryStatus;

  return (
    <li
      data-timeline-key={timelineKey(event)}
      id={`source-${event.source.kind}-${event.source.id}`}
      className={cn("flex gap-2.5 scroll-mt-4", !message && "text-muted-foreground")}
    >
      <div
        className={cn(
          "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md",
          message ? "bg-primary/10 text-primary" : "bg-muted",
        )}
      >
        {message ? <MessageCircle className="size-3.5" /> : <Activity className="size-3.5" />}
      </div>
      <article
        className={cn(
          "min-w-0 flex-1 rounded-lg border px-3.5 py-2.5 shadow-xs",
          message ? "bg-card" : "border-dashed bg-muted/20",
        )}
      >
        <header className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-xs">
          <div className="flex min-w-0 flex-wrap items-baseline gap-1.5">
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
            {event.participant &&
              conversation.topology === "shared" &&
              event.participant.id &&
              event.participant.id !== event.participant.label && (
                <span className="font-mono text-[10px] text-muted-foreground">
                  {event.participant.id}
                </span>
              )}
          </div>
          <time dateTime={event.occurredAt} className="text-xs text-muted-foreground">
            {new Date(event.occurredAt).toLocaleString(i18n.resolvedLanguage)}
          </time>
        </header>
        {(event.addressing.reasons.length > 0 || event.addressing.mentionIds.length > 0) && (
          <div className="my-1.5 flex flex-wrap items-center gap-1.5">
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
        )}
        {source && (
          <div className="mb-2 rounded-md border-l-2 border-primary bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
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
        {/* 独立媒体更新默认紧凑行：单行媒体状态摘要；技术细节全部收进下方原生 details。 */}
        {compactMediaRevision && event.media.length > 0 && (
          <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Image className="size-3.5 shrink-0" />
            {mediaCompactSummary(event.media, t)}
          </p>
        )}
        {/* User body: preserved on inbound, never overwritten by assistant reply;
            紧凑媒体更新行只留单行摘要，原文占位与状态说明收进来源记录 details。 */}
        {event.kind !== "wake" &&
          !compactMediaRevision &&
          (event.contentState !== "active" ? (
            <p className="text-xs text-muted-foreground">{t(unavailable[event.contentState])}</p>
          ) : (
            event.kind !== "media_revision" &&
            event.text && (
              <p className="whitespace-pre-wrap break-words text-sm leading-6">{event.text}</p>
            )
          ))}
        {/* 非紧凑媒体更新（已有任务/送达上下文）保留原有展开说明与完整媒体记录。 */}
        {event.kind === "media_revision" && !compactMediaRevision && (
          <p className="text-xs text-muted-foreground">
            {t(
              "workspace.the_related_message_is_not_loaded_this_record_is_a_media_understanding_u",
            )}{" "}
            <code>{event.sources.find((ref) => ref.kind === "qq_event")?.id}</code>
          </p>
        )}
        {event.media.length > 0 && !compactMediaRevision && (
          <MediaRecords media={event.media} className="mt-2 space-y-1.5" />
        )}
        {event.messageStatus === "failed" && (
          <p className="mt-1.5 text-xs text-destructive">{t("workspace.generation_failed")}</p>
        )}
        {event.messageStatus === "cancelled" && (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("workspace.generation_cancelled")}
          </p>
        )}
        {/* Task / Wake section: shows authoritative task status without false '本次未发言' if delivered */}
        {wake && (
          <div className="my-2 space-y-1 text-xs">
            {(() => {
              if (
                hasConfirmedDelivery &&
                wake.status === "no_output" &&
                (!task || task.status === "completed" || task.status === "no_output")
              ) {
                if (task && task.status !== "no_output") {
                  return statusLabel(t(taskLabels[task.status] ?? task.status));
                }
                return null;
              }
              const labelKey = task
                ? (taskLabels[task.status] ?? task.status)
                : wakeLabels[wake.status];
              return statusLabel(t(labelKey));
            })()}
            <p>
              {t("workspace.wake_reason_value", {
                "0": t(causes[wake.cause] ?? wake.cause),
              })}
            </p>
            {wake.status === "pending" && (
              <p>
                {t("workspace.scheduled_processing_time")}:{" "}
                <time dateTime={wake.readyAt}>
                  {new Date(wake.readyAt).toLocaleString(i18n.resolvedLanguage)}
                </time>
              </p>
            )}
            {task
              ? task.errorCode && <p className="text-destructive">{task.errorCode}</p>
              : wake.errorCode &&
                (neutralWakeReasonLabels[wake.errorCode] ? (
                  <p className="text-muted-foreground">
                    {t(neutralWakeReasonLabels[wake.errorCode])}
                  </p>
                ) : (
                  <p className="text-destructive">{wake.errorCode}</p>
                ))}
          </div>
        )}
        {!wake && task && (
          <div className="my-2 space-y-1 text-xs">
            {statusLabel(t(taskLabels[task.status] ?? task.status))}
            {task.errorCode && <p className="text-destructive">{task.errorCode}</p>}
          </div>
        )}
        {/* Delivered reply sections from other events in the activity chain */}
        {nestedDeliveryItems.map((deliv, index) => (
          <div
            key={deliv.outputId ?? `reply-${deliv.seq}-${index}`}
            className="mt-2 space-y-1.5 border-t pt-2"
          >
            {deliv.participant &&
              (conversation.topology === "shared" || nestedDeliveryItems.length > 1) && (
                <p className="text-xs font-medium text-foreground">
                  {deliv.participant.label}
                  {deliv.participant.id && deliv.participant.id !== deliv.participant.label && (
                    <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                      {deliv.participant.id}
                    </span>
                  )}
                </p>
              )}
            {deliv.contentState !== "active" ? (
              <p className="text-xs text-muted-foreground">{t(unavailable[deliv.contentState])}</p>
            ) : (
              deliv.text && (
                <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                  {deliv.text}
                </p>
              )
            )}
            {deliv.media && deliv.media.length > 0 && (
              <MediaRecords media={deliv.media} className="mt-1.5 space-y-1.5" />
            )}
            <div className="flex flex-wrap items-center gap-2">
              {deliv.deliveryStatus && (
                <Badge
                  variant="outline"
                  className={deliv.deliveryStatus === "failed" ? "text-destructive" : undefined}
                >
                  {deliv.deliveryStatus === "stale"
                    ? t(staleReasonLabelKey(deliv.deliveryStaleReason))
                    : t(deliveryLabels[deliv.deliveryStatus])}
                </Badge>
              )}
              {deliv.runId && <RunLink runId={deliv.runId} />}
            </div>
            {deliv.outputId && (
              <div className="mt-2">
                <DeliveryDetails
                  key={`${deliv.outputId}:${deliv.deliveryStatus}`}
                  outputId={deliv.outputId}
                  conversation={conversation}
                />
              </div>
            )}
          </div>
        ))}
        {/* Representative's own delivery status and RunLink */}
        {(event.deliveryStatus || standaloneRunId) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
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
            {standaloneRunId && <RunLink runId={standaloneRunId} />}
          </div>
        )}
        {event.outputId && (
          <div className="mt-2">
            <DeliveryDetails
              key={`${event.outputId}:${event.deliveryStatus}`}
              outputId={event.outputId}
              conversation={conversation}
            />
          </div>
        )}
        {/* Source record details: underlying IDs preserved */}
        <details className="mt-2 border-t pt-1.5 text-[10px] text-muted-foreground">
          <summary className="cursor-pointer">{t("workspace.source_record")}</summary>
          <p className="mt-1.5 break-all font-mono">
            {event.source.kind}:{event.source.id}
          </p>
          <p>{t("workspace.event_revision", { "0": event.seq, "1": event.source.revision })}</p>
          {compactMediaRevision && (
            <>
              {event.contentState !== "active" && <p>{t(unavailable[event.contentState])}</p>}
              <p>
                {t(
                  "workspace.the_related_message_is_not_loaded_this_record_is_a_media_understanding_u",
                )}{" "}
                <code>{event.sources.find((ref) => ref.kind === "qq_event")?.id}</code>
              </p>
              {event.media.length > 0 && (
                <MediaRecords media={event.media} className="mt-1 space-y-1" />
              )}
            </>
          )}
          {event.media.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {event.media.map((media) => (
                <p key={media.id} className="break-all font-mono">
                  {t(media.kind === "sticker" ? "workspace.sticker" : "workspace.media")}:{" "}
                  <code>{media.id}</code>
                </p>
              ))}
            </div>
          )}
          {nestedDeliveryItems.some((d) => d.media && d.media.length > 0) && (
            <div className="mt-1 space-y-0.5">
              {nestedDeliveryItems
                .flatMap((d) => d.media ?? [])
                .map((media) => (
                  <p key={media.id} className="break-all font-mono">
                    {t(media.kind === "sticker" ? "workspace.sticker" : "workspace.media")}:{" "}
                    <code>{media.id}</code>
                  </p>
                ))}
            </div>
          )}
          {event.activityEvents && event.activityEvents.length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {event.activityEvents.map((act) => (
                <p
                  key={`${act.source.kind}:${act.source.id}:${act.seq}`}
                  className="break-all font-mono"
                >
                  {act.source.kind}:{act.source.id}
                  {act.wake ? ` (wake:${act.wake.id})` : ""}
                  {act.outputId ? ` (output:${act.outputId})` : ""}
                </p>
              ))}
            </div>
          )}
          {event.qqMessageFacts && event.qqMessageFacts.length > 0 && (
            <QqEventFactDetails facts={event.qqMessageFacts} />
          )}
        </details>
      </article>
    </li>
  );
}

function areEventRecordPropsEqual(
  prev: {
    event: ConversationTimelineRow;
    quoted?: ConversationEventView;
    conversation: ConversationSummary;
  },
  next: {
    event: ConversationTimelineRow;
    quoted?: ConversationEventView;
    conversation: ConversationSummary;
  },
): boolean {
  if (prev.event !== next.event) return false;
  if (prev.quoted !== next.quoted) return false;
  if (prev.conversation.topology !== next.conversation.topology) return false;
  const prevParts = prev.conversation.participants;
  const nextParts = next.conversation.participants;
  if (prevParts === nextParts) return true;
  if (prevParts.length !== nextParts.length) return false;
  for (let i = 0; i < prevParts.length; i++) {
    const p = prevParts[i];
    const np = nextParts[i];
    if (!np || p.id !== np.id || p.label !== np.label) {
      return false;
    }
  }
  return true;
}

export const EventRecord = memo(EventRecordComponent, areEventRecordPropsEqual);
