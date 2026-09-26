import { useState } from "react";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../../shared/contracts/conversation";
import { translateNotice, useI18n } from "../../i18n";
import { localTime } from "../../ui/local-time";
import { ConversationRuntimeSummary } from "../observability/ConversationRuntimeSummary";
import { TraceExplorer } from "../observability/TraceExplorer";
import { RunLink } from "../runs/RunInspector";
import { ConversationHeader } from "./ConversationHeader";
import { DeliveryDetails, deliveryLabels } from "./DeliveryDetails";
import { useConversationEvents } from "./use-conversation-events";
import { timelineKey, useTimelineScroll } from "./use-timeline-scroll";

const contentLabels = {
  active: "",
  expired: "原文已过保留期",
  revoked: "原文已撤权或删除",
  unavailable: "原文暂不可用",
};
/** Media updates decorate loaded parents; otherwise their authorized projection remains visible. */
export function timelineRows(items: ConversationEventView[]): ConversationEventView[] {
  const revisions = [
    ...new Map(
      items
        .filter((item) => item.kind === "media_revision")
        .map((item) => [timelineKey(item), item]),
    ).values(),
  ];
  const latest = new Map<string, ConversationEventView>();
  for (const item of items) {
    if (item.kind === "media_revision") continue;
    const key = timelineKey(item);
    latest.set(key, item);
  }
  const parents = new Set(
    [...latest.values()]
      .filter((item) => item.kind === "inbound")
      .flatMap((item) =>
        item.sources.filter((source) => source.kind === "qq_event").map((source) => source.id),
      ),
  );
  for (const revision of revisions) {
    if (!revision.sources.some((source) => source.kind === "qq_event" && parents.has(source.id)))
      latest.set(timelineKey(revision), revision);
  }
  return [...latest.values()]
    .sort((a, b) => a.seq - b.seq)
    .map((item) => {
      if (item.kind !== "inbound") return item;
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
  const [hasViewedDiagnostics, setHasViewedDiagnostics] = useState(false);
  const [view, setView] = useState<"messages" | "diagnostics">("messages");
  const scroll = useTimelineScroll();
  const { items, hasMore, loading, error, refresh, loadMore } = useConversationEvents(
    conversation.id,
    scroll.beforeChange,
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
      <ConversationRuntimeSummary conversationId={conversation.id} />
      <fieldset className="conversation-view-switch" aria-label={t("会话视图")}>
        <button
          type="button"
          aria-pressed={view === "messages"}
          onClick={() => setView("messages")}
        >
          {t("消息记录")}
        </button>
        <button
          type="button"
          aria-pressed={view === "diagnostics"}
          onClick={() => {
            setHasViewedDiagnostics(true);
            setView("diagnostics");
          }}
        >
          {t("运行观测")}
        </button>
      </fieldset>
      {hasViewedDiagnostics && (
        <div className="conversation-reading" hidden={view !== "diagnostics"}>
          <TraceExplorer conversationId={conversation.id} />
        </div>
      )}
      <section
        hidden={view !== "messages"}
        className="conversation-reading"
        ref={scroll.viewport}
        onScroll={scroll.onScroll}
        onKeyDown={(event) => {
          if (
            event.target !== event.currentTarget ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
            return;
          if (event.key === "End") {
            event.preventDefault();
            scroll.toLatest();
          }
          if (event.key === "Home") {
            event.preventDefault();
            event.currentTarget.scrollTop = 0;
            scroll.onScroll();
          }
        }}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Native scroll region must support keyboard scrolling.
        tabIndex={0}
        aria-label={t("消息记录")}
      >
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
        {loading && (
          <p role="status" className={rows.length ? "visually-hidden" : undefined}>
            {t("正在读取会话…")}
          </p>
        )}
        {!loading && !error && !rows.length && <p className="hint">{t("此会话暂无消息记录。")}</p>}
        {hasMore && (
          <button
            type="button"
            className="history-earlier"
            disabled={loading}
            onClick={() => void loadMore()}
          >
            {t("加载更早记录")}
          </button>
        )}
        <ol className="conversation-timeline">
          {rows.map((item) => {
            const message =
              item.kind === "inbound" ||
              (item.kind === "outbound" && item.deliveryStatus === "confirmed");
            return (
              <li
                key={timelineKey(item)}
                data-timeline-key={timelineKey(item)}
                id={`source-${item.source.kind}-${item.source.id}`}
                className={message ? "conversation-message" : "conversation-activity"}
              >
                <header>
                  <strong>
                    {item.participant?.label ??
                      t(
                        item.kind === "wake"
                          ? "唤醒记录"
                          : item.kind === "media_revision"
                            ? "媒体理解更新"
                            : "运行活动",
                      )}
                  </strong>
                  <time dateTime={item.occurredAt}>{localTime(item.occurredAt)}</time>
                </header>
                {item.participant && conversation.topology === "shared" && (
                  <small className="conversation-member-id">
                    <code>{item.participant.id}</code>
                  </small>
                )}
                <Addressing item={item} rows={rows} conversation={conversation} />
                {item.kind === "media_revision" && (
                  <p className="hint">
                    {t("关联消息尚未加载；此记录为媒体理解更新。")}{" "}
                    <code>{item.sources.find((source) => source.kind === "qq_event")?.id}</code>
                  </p>
                )}
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
                    item.kind !== "media_revision" &&
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
      </section>
      {view === "messages" && scroll.away && (
        <button className="conversation-latest" type="button" onClick={scroll.toLatest}>
          {scroll.unread ? t("{0} 条新消息 · 回到最新", scroll.unread) : t("回到最新")}
        </button>
      )}
      <span className="visually-hidden" role="status">
        {scroll.unread ? t("{0} 条新消息", scroll.unread) : ""}
      </span>
      <p className="hint conversation-footer">
        {t("消息由已连接的机器人接入；在原聊天应用中继续对话。")}
      </p>
    </section>
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
