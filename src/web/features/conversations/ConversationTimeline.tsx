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
      <header className="page-header">
        <div>
          <h1>{conversation.title}</h1>
          <p>
            {t("OneBot 私聊")} · {t("只读消息记录")}
          </p>
        </div>
        <button type="button" disabled={loading} onClick={() => void refresh()}>
          {t("刷新记录")}
        </button>
      </header>
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
              className={message ? "conversation-message" : "conversation-activity"}
            >
              <header>
                <strong>
                  {item.participant?.label ?? t(item.kind === "wake" ? "唤醒记录" : "运行活动")}
                </strong>
                <time dateTime={item.occurredAt}>{localTime(item.occurredAt)}</time>
              </header>
              {item.messageStatus === "failed" && <p className="error">{t("[生成失败]")}</p>}
              {item.messageStatus === "cancelled" && <p className="hint">{t("[生成已取消]")}</p>}
              {item.deliveryStatus && (
                <p className="delivery-status" data-status={item.deliveryStatus}>
                  {t(deliveryLabels[item.deliveryStatus])}
                </p>
              )}
              {item.contentState !== "active" ? (
                <p className="hint">{t(contentLabels[item.contentState])}</p>
              ) : (
                item.text && <p className="conversation-text">{item.text}</p>
              )}
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

function DeliveryDetails({ outputId }: { outputId: string }) {
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
