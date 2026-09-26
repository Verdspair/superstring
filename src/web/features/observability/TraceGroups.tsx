import * as Dialog from "@radix-ui/react-dialog";
import { useRef, useState } from "react";
import type {
  RuntimeSpanFilters,
  RuntimeTrace,
} from "../../../shared/contracts/runtime-observability";
import { translateNotice, useI18n } from "../../i18n";
import { localTime } from "../../ui/local-time";
import { channelLabels, operationLabels, taskLabels, triggerLabels } from "./labels";
import { TraceWaterfall } from "./TraceWaterfall";
import { useRuntimeTraces, useRuntimeWaterfall } from "./use-runtime-traces";

const groupStatuses: Record<string, string> = {
  started: "仍有运行步骤",
  failed: "包含失败步骤",
  unknown: "包含待确认步骤",
  completed: "步骤已完成",
  no_output: "本次未发言",
  cancelled: "包含取消步骤",
  observed: "已观察",
  scheduled: "已排期",
  deferred: "延后处理",
  skipped: "本次跳过",
};
function TraceSummary({ item }: { item: RuntimeTrace }) {
  const t = useI18n();
  const spec = typeof item.root.details.specId === "string" ? item.root.details.specId : null;
  return (
    <>
      <header>
        <strong>
          {t(
            spec ? (taskLabels[spec] ?? spec) : (operationLabels[item.root.name] ?? item.root.name),
          )}
        </strong>
        <span className="trace-status">{t(groupStatuses[item.status] ?? item.status)}</span>
        <time dateTime={item.at}>{localTime(item.at)}</time>
      </header>
      <div className="trace-facts">
        <span>
          {t("触发类型")}:{" "}
          {item.causes.length
            ? item.causes.map((cause) => t(triggerLabels[cause] ?? cause)).join(" · ")
            : t(
                item.root.channel === "web" && item.root.name === "conversation.activate"
                  ? "网页请求"
                  : "触发类型未记录",
              )}
        </span>
        <span>{item.channels.map((channel) => t(channelLabels[channel])).join(" · ")}</span>
        <span>{t("{0} 个步骤 · {1} 个命中", item.spanCount, item.matchedSpanCount)}</span>
        <span>{t("耗时 {0} ms", Math.round(item.durationMs))}</span>
      </div>
      {!!item.specIds.length && (
        <p className="trace-models">
          {t("链路任务")}: {item.specIds.map((id) => t(taskLabels[id] ?? id)).join(" · ")}
        </p>
      )}
      <p className="trace-models">
        {t("模型记录")}:{" "}
        {item.models.length
          ? item.models.map((model) => <code key={model}>{model}</code>)
          : t("尚未记录模型")}
      </p>
      <details>
        <summary>{t("请求与唤醒标识")}</summary>
        <dl className="trace-metadata">
          <div>
            <dt>Trace ID</dt>
            <dd>
              <code>{item.traceId}</code>
            </dd>
          </div>
          {!!item.wakeIds.length && (
            <div>
              <dt>Wake ID</dt>
              <dd>
                {item.wakeIds.map((id) => (
                  <code key={id}>{id}</code>
                ))}
              </dd>
            </div>
          )}
          {!!item.runIds.length && (
            <div>
              <dt>Run ID</dt>
              <dd>
                {item.runIds.map((id) => (
                  <code key={id}>{id}</code>
                ))}
              </dd>
            </div>
          )}
          {!!item.specIds.length && (
            <div>
              <dt>Spec ID</dt>
              <dd>
                {item.specIds.map((id) => (
                  <code key={id}>{id}</code>
                ))}
              </dd>
            </div>
          )}
          {(operationLabels[item.root.name] || spec) && (
            <div>
              <dt>{t("操作名称")}</dt>
              <dd>
                <code>{item.root.name}</code>
              </dd>
            </div>
          )}
        </dl>
      </details>
    </>
  );
}

export function TraceGroups({ filters }: { filters: RuntimeSpanFilters }) {
  const t = useI18n();
  const { items, summary, loading, error, hasMore, refresh, loadMore } = useRuntimeTraces(filters);
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const fallback = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLElement>(null);
  return (
    <section ref={region} tabIndex={-1} className="trace-results" aria-label={t("请求与唤醒链路")}>
      <div className="trace-actions">
        <button ref={fallback} type="button" disabled={loading} onClick={() => void refresh()}>
          {t("刷新运行记录")}
        </button>
        {loading && <span role="status">{t("正在读取运行记录…")}</span>}
        {summary && (
          <span>
            {t(
              "共 {0} 条链路 · 活跃 {1} · 含失败 {2} · {3} 个阶段命中",
              summary.totalTraces,
              summary.activeTraces,
              summary.failedTraces,
              summary.matchedSpans,
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
          <li key={item.traceId} className="trace-row trace-group" data-status={item.status}>
            <TraceSummary item={item} />
            <button
              type="button"
              className="link-button"
              onClick={(event) => {
                trigger.current = event.currentTarget;
                setSelectedTrace(item.traceId);
              }}
            >
              {t("展开时序链路")}
            </button>
          </li>
        ))}
      </ol>
      {hasMore && (
        <button type="button" disabled={loading} onClick={() => void loadMore()}>
          {t("加载更早运行记录")}
        </button>
      )}
      <Dialog.Root
        open={selectedTrace !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedTrace(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="run-inspector-overlay" />
          <Dialog.Content
            className="run-inspector trace-dialog waterfall-dialog"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              (trigger.current?.isConnected
                ? trigger.current
                : !fallback.current?.disabled
                  ? fallback.current
                  : region.current
              )?.focus();
            }}
          >
            <header className="run-inspector-heading">
              <div>
                <Dialog.Title>{t("追踪链路")}</Dialog.Title>
                <Dialog.Description>
                  {t("每次请求或唤醒独立展示；时间条按实际起点和耗时排列。")}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button type="button" aria-label={t("关闭追踪链路")}>
                  {t("关闭")}
                </button>
              </Dialog.Close>
            </header>
            <div className="run-inspector-body">
              {selectedTrace && (
                <TraceDetail key={selectedTrace} traceId={selectedTrace} filters={filters} />
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

function TraceDetail({ traceId, filters }: { traceId: string; filters: RuntimeSpanFilters }) {
  const t = useI18n();
  const { data, loading, error, refresh } = useRuntimeWaterfall(traceId, filters);
  return (
    <section aria-label={t("追踪链路")}>
      <div className="trace-actions">
        <button type="button" disabled={loading} onClick={() => void refresh()}>
          {t("刷新运行记录")}
        </button>
        {loading && <span role="status">{t("正在读取运行记录…")}</span>}
      </div>
      {error && (
        <p className="error" role="alert">
          {translateNotice(error)}
        </p>
      )}
      {data && (
        <>
          <div className="trace-row trace-group" data-status={data.trace.status}>
            <TraceSummary item={data.trace} />
          </div>
          {data.matchedSpanIds.length === 0 && (
            <p className="hint">{t("当前链路已不匹配筛选；仍保留完整链路供核对。")}</p>
          )}
          <TraceWaterfall data={data} />
        </>
      )}
    </section>
  );
}
