import * as Dialog from "@radix-ui/react-dialog";
import { useMemo, useRef, useState } from "react";
import {
  RuntimeChannelSchema,
  type RuntimeSpan,
  type RuntimeSpanFilters,
  RuntimeSpanStatusSchema,
  RuntimeStageSchema,
} from "../../../shared/contracts/runtime-observability";
import { translateNotice, useI18n } from "../../i18n";
import { localTime } from "../../ui/local-time";
import { DeliveryDetails } from "../conversations/DeliveryDetails";
import { RunLink } from "../runs/RunInspector";
import {
  channelLabels,
  detailLabels,
  operationLabels,
  reasonLabels,
  stageLabels,
  statusLabels,
} from "./labels";
import { filterDraft, parseFilterDraft, readFilterUrl, writeFilterUrl } from "./trace-filters";
import { useRuntimeSpans } from "./use-runtime-spans";

export function TraceExplorer({ conversationId }: { conversationId?: string }) {
  const t = useI18n();
  const [applied, setApplied] = useState<RuntimeSpanFilters>(() =>
    conversationId ? { conversationId } : readFilterUrl(),
  );
  const [draft, setDraft] = useState(() => filterDraft(applied));
  const [error, setError] = useState("");
  const update = (key: keyof typeof draft, value: string) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const apply = (next: RuntimeSpanFilters) => {
    setApplied(next);
    setDraft(filterDraft(next));
    setError("");
    if (!conversationId) writeFilterUrl(next);
  };
  const field = (key: keyof typeof draft, label: string, placeholder?: string) => (
    <label key={key}>
      <span>{t(label)}</span>
      <input
        value={draft[key]}
        maxLength={200}
        placeholder={placeholder}
        onChange={(event) => update(key, event.target.value)}
      />
    </label>
  );
  const timeField = (key: "from" | "to", label: string) => (
    <label>
      <span>{t(label)}</span>
      <input
        type="datetime-local"
        step="1"
        value={draft[key]}
        onChange={(event) => update(key, event.target.value)}
      />
    </label>
  );
  const applyDraft = (override: Partial<typeof draft> = {}) => {
    const parsed = parseFilterDraft({
      ...draft,
      ...override,
      ...(conversationId ? { conversationId } : {}),
    });
    if (!parsed.success) {
      setError(t("筛选值无效，请检查长度、关联 ID 或时间。"));
      return;
    }
    if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
      setError(t("开始时间不能晚于结束时间。"));
      return;
    }
    apply(parsed.data);
  };
  const select = (
    key: "channel" | "stage" | "status",
    label: string,
    values: readonly string[],
    labels: Record<string, string>,
  ) => (
    <label>
      <span>{t(label)}</span>
      <select
        aria-label={t(label)}
        value={draft[key]}
        onChange={(event) => update(key, event.target.value)}
      >
        <option value="">{t("全部")}</option>
        {values.map((value) => (
          <option key={value} value={value}>
            {t(labels[value] ?? value)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="trace-explorer">
      <form
        className="trace-filter-form"
        onSubmit={(event) => {
          event.preventDefault();
          applyDraft();
        }}
      >
        <div className="trace-filter-main">
          {field("q", "搜索运行记录", t("原因、名称、关联 ID 或元数据关键词"))}
          {select("channel", "来源通道", RuntimeChannelSchema.options, channelLabels)}
          {select("stage", "处理阶段", RuntimeStageSchema.options, stageLabels)}
          {select("status", "处理状态", RuntimeSpanStatusSchema.options, statusLabels)}
        </div>
        <details className="trace-advanced">
          <summary>{t("模型、时间与关联筛选")}</summary>
          <div className="trace-filter-main">
            {field("model", "模型（精确匹配）")}
            {!conversationId && field("conversationId", "会话 ID", "UUID")}
            {field("agentId", "Agent ID", "UUID")}
            {field("runId", "Run ID", "UUID")}
            {field("traceId", "Trace ID", "32 hex")}
            {timeField("from", "开始时间（本地）")}
            {timeField("to", "结束时间（本地）")}
          </div>
          <p className="hint">
            {t("当前时区：{0}", Intl.DateTimeFormat().resolvedOptions().timeZone)}
          </p>
          <div className="trace-actions">
            {[
              [15, "最近 15 分钟"],
              [60, "最近 1 小时"],
              [1440, "最近 24 小时"],
            ].map(([minutes, label]) => (
              <button
                key={minutes}
                type="button"
                onClick={() => {
                  const now = new Date();
                  applyDraft({
                    from: new Date(now.getTime() - Number(minutes) * 60000).toISOString(),
                    to: now.toISOString(),
                  });
                }}
              >
                {t(String(label))}
              </button>
            ))}
          </div>
        </details>
        <div className="trace-actions">
          <button type="submit" className="primary">
            {t("应用筛选")}
          </button>
          <button type="button" onClick={() => apply(conversationId ? { conversationId } : {})}>
            {t("清除筛选")}
          </button>
          <small>{t("搜索全部已记录的运行元数据，不搜索消息或提示词正文。")}</small>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
      <TraceResults key={JSON.stringify(applied)} filters={applied} />
    </div>
  );
}
function TraceResults({
  filters,
  trace = false,
}: {
  filters: RuntimeSpanFilters;
  trace?: boolean;
}) {
  const t = useI18n();
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const traceTrigger = useRef<HTMLButtonElement | null>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const { items, summary, loading, error, hasMore, refresh, loadMore } = useRuntimeSpans(
    filters,
    trace,
  );
  return (
    <section className="trace-results" aria-label={t(trace ? "追踪链路" : "运行记录")}>
      <div className="trace-actions">
        <button ref={refreshButton} type="button" onClick={() => void refresh()} disabled={loading}>
          {t("刷新运行记录")}
        </button>
        {loading && <span role="status">{t("正在读取运行记录…")}</span>}
        {summary && (
          <span>
            {t(
              "共 {0} 个阶段 · 进行中 {1} · 失败 {2} · 待确认 {3}",
              summary.total,
              summary.active,
              summary.failed,
              summary.unknown,
            )}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {translateNotice(error)}
        </p>
      )}
      {!loading && !error && !items.length && (
        <p className="hint">{t("暂无匹配的运行记录；启用观测前的活动可能没有记录。")}</p>
      )}
      <ol className="trace-list">
        {items.map((item) => (
          <TraceRow
            key={item.id}
            item={item}
            trace={trace}
            sampledAt={summary?.now}
            parent={items.find((row) => row.spanId === item.parentSpanId)}
            onOpenTrace={(traceId, trigger) => {
              traceTrigger.current = trigger;
              setSelectedTrace(traceId);
            }}
          />
        ))}
      </ol>
      {hasMore && (
        <button type="button" disabled={loading} onClick={() => void loadMore()}>
          {t("加载更早运行记录")}
        </button>
      )}
      {!trace && (
        <TraceDialog
          traceId={selectedTrace}
          onClose={() => setSelectedTrace(null)}
          returnFocus={() => {
            const trigger = traceTrigger.current;
            (trigger?.isConnected ? trigger : refreshButton.current)?.focus();
          }}
        />
      )}
    </section>
  );
}
function TraceRow({
  item,
  trace,
  parent,
  sampledAt,
  onOpenTrace,
}: {
  item: RuntimeSpan;
  trace: boolean;
  parent?: RuntimeSpan;
  sampledAt?: string;
  onOpenTrace: (traceId: string, trigger: HTMLButtonElement) => void;
}) {
  const t = useI18n();
  const ids = {
    "Trace ID": item.traceId,
    "Span ID": item.spanId,
    "父 Span ID": item.parentSpanId,
    "会话 ID": item.conversationId,
    "Agent ID": item.agentId,
    "Run ID": item.runId,
    "Wake ID": item.wakeId,
    "Output ID": item.outputId,
    来源序号: item.sourceSeq,
  };
  return (
    <li
      className="trace-row"
      data-status={item.status}
      id={`${trace ? "trace" : "list"}-span-${item.spanId}`}
    >
      <header>
        <div>
          <strong>{t(stageLabels[item.stage])}</strong>
          <span className="trace-status">{t(statusLabels[item.status])}</span>
        </div>
        <time dateTime={item.at}>{localTime(item.at)}</time>
      </header>
      {(operationLabels[item.name] ?? item.name) !== stageLabels[item.stage] && (
        <p className="trace-name">{t(operationLabels[item.name] ?? item.name)}</p>
      )}
      {reasonLabels[item.code] && <p>{t(reasonLabels[item.code])}</p>}
      {trace && item.parentSpanId && (
        <p className="trace-parent">
          {t("父步骤")}:{" "}
          {parent ? (
            <a href={`#trace-span-${parent.spanId}`}>
              {t(operationLabels[parent.name] ?? parent.name)}
            </a>
          ) : (
            <code>{item.parentSpanId}</code>
          )}
        </p>
      )}
      <div className="trace-facts">
        <span>{t(channelLabels[item.channel])}</span>
        {item.model && (
          <span>
            {t("模型")}: <code>{item.model}</code>
          </span>
        )}
        {item.durationMs !== null && <span>{t("耗时 {0} ms", Math.round(item.durationMs))}</span>}
        {item.status === "started" && sampledAt && (
          <span>
            {t("已运行 {0} ms", Math.max(0, Date.parse(sampledAt) - Date.parse(item.at)))}
          </span>
        )}
        <code>{item.code}</code>
      </div>
      {item.status === "unknown" && (
        <p className="hint">{t("结果尚未确认，不等同于失败；请沿追踪链路核对后续结果。")}</p>
      )}
      <div className="trace-actions">
        {!trace && (
          <button
            type="button"
            className="link-button"
            onClick={(event) => onOpenTrace(item.traceId, event.currentTarget)}
          >
            {t("追踪链路")}
          </button>
        )}
        {item.runId && <RunLink runId={item.runId} />}
        {item.channel === "onebot11" && item.outputId && (
          <DeliveryDetails key={`${item.outputId}:${item.status}`} outputId={item.outputId} />
        )}
      </div>
      <details>
        <summary>{t("关联与元数据")}</summary>
        <dl className="trace-metadata">
          {operationLabels[item.name] && (
            <div>
              <dt>{t("操作名称")}</dt>
              <dd>
                <code>{item.name}</code>
              </dd>
            </div>
          )}
          {Object.entries(ids).map(
            ([key, value]) =>
              value !== null && (
                <div key={key}>
                  <dt>{t(key)}</dt>
                  <dd>
                    <code>{value}</code>
                  </dd>
                </div>
              ),
          )}
          {item.parentSpanId && (
            <div>
              <dt>{t("父子关系")}</dt>
              <dd>{t("此步骤属于父 Span；父步骤可能在另一页。")}</dd>
            </div>
          )}
          {item.finishedAt && (
            <div>
              <dt>{t("完成时间")}</dt>
              <dd>
                <time dateTime={item.finishedAt}>{localTime(item.finishedAt)}</time>
              </dd>
            </div>
          )}
          {Object.entries(item.details).map(([key, value]) => (
            <div key={`detail:${key}`}>
              <dt>{t(detailLabels[key] ?? key)}</dt>
              <dd>{value === null ? "—" : String(value)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </li>
  );
}
function TraceDialog({
  traceId,
  onClose,
  returnFocus,
}: {
  traceId: string | null;
  onClose: () => void;
  returnFocus: () => void;
}) {
  const t = useI18n();
  const filters = useMemo(() => (traceId ? { traceId } : {}), [traceId]);
  return (
    <Dialog.Root open={traceId !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="run-inspector-overlay" />
        <Dialog.Content
          className="run-inspector trace-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus();
          }}
        >
          <header className="run-inspector-heading">
            <div>
              <Dialog.Title>{t("追踪链路")}</Dialog.Title>
              <Dialog.Description>
                {t("从接入、调度、模型到投递，查看关联步骤与父子关系。")}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label={t("关闭追踪链路")}>
                {t("关闭")}
              </button>
            </Dialog.Close>
          </header>
          <div className="run-inspector-body">
            <code>{traceId}</code>
            {traceId && <TraceResults key={traceId} filters={filters} trace />}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
