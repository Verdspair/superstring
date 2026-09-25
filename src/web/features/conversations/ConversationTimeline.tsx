import { useState } from "react";
import type {
  ConversationEventView,
  ConversationSummary,
  Delivery,
} from "../../../shared/contracts/conversation";
import { translateNotice, useI18n } from "../../i18n";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
import { localTime } from "../../ui/local-time";
import { RunLink } from "../runs/RunInspector";
import { ConversationHeader } from "./ConversationHeader";
import { useConversationEvents } from "./use-conversation-events";

const contentLabels = {
  active: "",
  expired: "原文已过保留期",
  revoked: "原文已撤权或删除",
  unavailable: "原文暂不可用",
};
const deliveryLabels = {
  planned: "等待发送",
  delivering: "正在送达",
  sending: "正在送达",
  confirmed: "已送达",
  failed: "发送失败",
  unknown: "发送结果待确认",
  stale: "回复已过期",
  not_sent: "尚未发送",
};

/** Media updates decorate their parent observation, retaining the annotation's identity and availability. */
export function timelineRows(items: ConversationEventView[]): ConversationEventView[] {
  const revisions = items.filter((item) => item.kind === "media_revision");
  const latest = new Map<string, ConversationEventView>();
  for (const item of items) {
    if (item.kind === "media_revision") continue;
    const key = item.outputId
      ? `output:${item.outputId}`
      : item.kind === "inbound" || item.kind === "outbound"
        ? `source:${item.source.kind}:${item.source.id}`
        : item.wake
          ? `wake:${item.wake.id}`
          : `event:${item.seq}`;
    latest.set(key, item);
  }
  return [...latest.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((item) => {
      const parent = item.sources.find((source) => source.kind === "qq_event")?.id;
      if (!parent) return item;
      const media = [
        ...item.media,
        ...revisions
          .filter((revision) =>
            revision.sources.some((source) => source.kind === "qq_event" && source.id === parent),
          )
          .flatMap((revision) => revision.media),
      ];
      return { ...item, media: [...new Map(media.map((part) => [part.id, part])).values()] };
    });
}

export function ConversationTimeline({ conversation }: { conversation: ConversationSummary }) {
  const t = useI18n();
  const { items, hasMore, loading, error, refresh, loadMore } = useConversationEvents(
    conversation.id,
  );
  const rows = timelineRows(items);
  return (
    <section className="page conversation-page">
      <ConversationHeader
        title={conversation.title}
        detail={
          <>
            {t(conversation.topology === "shared" ? "OneBot 群聊" : "OneBot 私聊")} ·{" "}
            {t("只读消息记录")}
          </>
        }
        actions={
          <button type="button" disabled={loading} onClick={() => void refresh()}>
            {t("刷新记录")}
          </button>
        }
      />
      <details className="conversation-source">
        <summary>{t("会话来源与参与者")}</summary>
        <dl className="run-metadata">
          <div>
            <dt>{t("会话 ID")}</dt>
            <dd>
              <code>{conversation.id}</code>
            </dd>
          </div>
          <div>
            <dt>{t("来源绑定")}</dt>
            <dd>
              <code>{conversation.sourceId}</code>
            </dd>
          </div>
          <div>
            <dt>Agent</dt>
            <dd>
              <code>{conversation.agentId}</code>
            </dd>
          </div>
        </dl>
        <ul>
          {conversation.participants.map((person) => (
            <li key={person.id}>
              {person.label} · <code>{person.id}</code>
            </li>
          ))}
        </ul>
      </details>
      {error && (
        <p role="alert" className="error">
          {translateNotice(error)}
        </p>
      )}
      {loading && <p role="status">{t("正在读取会话…")}</p>}
      {!loading && !error && !rows.length && <p className="hint">{t("此会话暂无消息记录。")}</p>}
      <ol className="conversation-timeline">
        {rows.map((item) => {
          const message =
            item.kind === "inbound" ||
            (item.kind === "outbound" && item.deliveryStatus === "confirmed");
          return (
            <li
              key={item.seq}
              id={`source-${item.source.kind}-${item.source.id}`}
              className={message ? "conversation-message" : "conversation-activity"}
            >
              <header>
                <strong>
                  {item.participant?.label ?? t(item.kind === "wake" ? "唤醒记录" : "运行活动")}
                </strong>
                <time dateTime={item.occurredAt}>{localTime(item.occurredAt)}</time>
              </header>
              {item.participant && conversation.topology === "shared" && (
                <small className="conversation-member-id">
                  <code>{item.participant.id}</code>
                </small>
              )}
              <Addressing item={item} rows={rows} conversation={conversation} />
              {item.wake && <WakeActivity wake={item.wake} />}
              {item.messageStatus === "failed" && <p className="error">{t("[生成失败]")}</p>}
              {item.messageStatus === "cancelled" && <p className="hint">{t("[生成已取消]")}</p>}
              {item.deliveryStatus && (
                <p className="delivery-status" data-status={item.deliveryStatus}>
                  {t(deliveryLabels[item.deliveryStatus])}
                </p>
              )}
              {item.kind !== "wake" &&
                (item.contentState !== "active" ? (
                  <p className="hint">{t(contentLabels[item.contentState])}</p>
                ) : (
                  item.text && <p className="conversation-text">{item.text}</p>
                ))}
              {!!item.media.length && (
                <ul className="conversation-media">
                  {item.media.map((media) => (
                    <li key={media.id}>
                      <strong>
                        {t(
                          media.kind === "sticker"
                            ? "表情"
                            : media.kind === "image"
                              ? "图片"
                              : "媒体",
                        )}
                      </strong>{" "}
                      · <code>{media.id}</code>
                      <p>
                        {media.description ??
                          t(
                            media.availability === "expired"
                              ? "媒体已过保留期"
                              : "暂无可用媒体描述",
                          )}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
              <div className="conversation-row-actions">
                {item.runId && <RunLink runId={item.runId} />}
                {item.outputId && (
                  <DeliveryDetails
                    key={`${item.outputId}:${item.deliveryStatus}`}
                    outputId={item.outputId}
                    conversation={conversation}
                  />
                )}
              </div>
              <details className="conversation-source">
                <summary>{t("来源记录")}</summary>
                <code>
                  {item.source.kind}:{item.source.id}
                </code>
                <p>
                  {t("事件序号：{0}", item.seq)} · {t("来源版本")}: {item.source.revision}
                </p>
              </details>
            </li>
          );
        })}
      </ol>
      {hasMore && (
        <button type="button" disabled={loading} onClick={() => void loadMore()}>
          {t("加载更多记录")}
        </button>
      )}
      <p className="hint">{t("消息由已连接的机器人接入；在原聊天应用中继续对话。")}</p>
    </section>
  );
}

function DeliveryDetails({
  outputId,
  conversation,
}: {
  outputId: string;
  conversation: ConversationSummary;
}) {
  const t = useI18n();
  const api = useSuperstringStore((s) => s.apiClient);
  const [delivery, setDelivery] = useState<Delivery | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const load = async () => {
    if (loading) return;
    setLoading(true);
    setError("");
    try {
      setDelivery(await api.getDelivery(outputId));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  };
  return (
    <details
      className="delivery-details"
      onToggle={(event) => {
        if (event.currentTarget.open && !delivery && !loading) void load();
      }}
    >
      <summary>{t("送达详情")}</summary>
      {error && <p role="alert">{translateNotice(error)}</p>}
      {loading && <p role="status">{t("正在读取送达结果…")}</p>}
      {delivery && (
        <>
          <p>{t(deliveryLabels[delivery.status])}</p>
          <p>
            {t("输出 {0}", delivery.ordinal + 1)} ·{" "}
            {delivery.target ? (
              <>
                {t("送达会话")}: <code>{delivery.target.peerId}</code>
                {delivery.target.participantId && (
                  <>
                    {" "}
                    · {t("回应成员")}:{" "}
                    {conversation.participants.find(
                      (person) => person.id === delivery.target?.participantId,
                    )?.label ?? ""}{" "}
                    <code>{delivery.target.participantId}</code>
                  </>
                )}
              </>
            ) : (
              t("目标信息未记录")
            )}
          </p>
          {delivery.parts.some((part) => part.status === "confirmed") &&
            delivery.parts.some((part) => part.status !== "confirmed") && (
              <p className="hint">{t("部分内容已送达，请查看各部分结果。")}</p>
            )}
          <ol>
            {delivery.parts.map((part) => (
              <li key={part.id}>
                <strong>{t(part.kind === "text" ? "文本" : "表情")}</strong> ·{" "}
                {t(deliveryLabels[part.status])}
                {part.stickerId && (
                  <p>
                    {t("表情 ID")}: <code>{part.stickerId}</code>
                  </p>
                )}
                {part.platformMessageId && (
                  <p>
                    {t("平台消息 ID")}: <code>{part.platformMessageId}</code>
                  </p>
                )}
              </li>
            ))}
          </ol>
          {delivery.status === "unknown" && (
            <p className="hint">{t("尚未确认外部平台是否已收到；此处仅核对结果。")}</p>
          )}
        </>
      )}
      <button type="button" disabled={loading} onClick={() => void load()}>
        {t("刷新送达结果")}
      </button>
    </details>
  );
}

function Addressing({
  item,
  rows,
  conversation,
}: {
  item: ConversationEventView;
  rows: ConversationEventView[];
  conversation: ConversationSummary;
}) {
  const t = useI18n();
  const { reasons, mentionIds, replyTo } = item.addressing;
  const labels = {
    request: "直接请求",
    private: "私聊消息",
    mention: "提及助手",
    reply_to_agent: "回复助手",
    legacy_addressed: "历史记录标记为面向助手",
  };
  const reference =
    replyTo &&
    rows.find(
      (row) =>
        row.source.id === replyTo.sourceId ||
        row.sources.some((source) => source.id === replyTo.sourceId),
    );
  if (!reasons.length && !mentionIds.length && !replyTo) return null;
  return (
    <div className="conversation-addressing">
      {reasons.map((reason) => (
        <span key={reason}>{t(labels[reason])}</span>
      ))}
      {!!mentionIds.length && (
        <span>
          {t("提及")}:{" "}
          {mentionIds.map((id) => (
            <span key={id}>
              {conversation.participants.find((person) => person.id === id)?.label ?? id}{" "}
              <code>{id}</code>{" "}
            </span>
          ))}
        </span>
      )}
      {replyTo && (
        <span>
          {t("引用消息")}:{" "}
          {reference ? (
            <a href={`#source-${reference.source.kind}-${reference.source.id}`}>
              {reference.participant?.label ?? replyTo.sourceId}
            </a>
          ) : (
            <code>{replyTo.sourceId}</code>
          )}
        </span>
      )}
    </div>
  );
}
function WakeActivity({ wake }: { wake: NonNullable<ConversationEventView["wake"]> }) {
  const t = useI18n();
  const labels = {
    pending: "等待处理",
    leased: "正在处理",
    completed: "处理完成",
    no_output: "本次未发言",
    failed: "处理失败",
  };
  const causes: Record<string, string> = {
    direct_reply: "直接回应",
    follow_up: "连续交谈",
    chiming_in: "自主接话",
    idle_topic: "冷场发起",
    mention: "提及助手",
    private: "私聊消息",
    reply_to_agent: "回复助手",
  };
  return (
    <div className="wake-activity" data-status={wake.status}>
      <p role="status">{t(labels[wake.status])}</p>
      <small>
        {t("唤醒原因")}: {t(causes[wake.cause] ?? wake.cause)}
      </small>
      {wake.status === "pending" && (
        <p>
          {t("计划处理时间")}: <time dateTime={wake.readyAt}>{localTime(wake.readyAt)}</time>
        </p>
      )}
      {wake.errorCode && <p className="error">{wake.errorCode}</p>}
    </div>
  );
}
