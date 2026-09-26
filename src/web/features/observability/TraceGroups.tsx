import { useLayoutEffect, useRef, useState } from "react";
import type { RuntimeSpanFilters } from "../../../shared/contracts/runtime-observability";
import { translateNotice, useI18n } from "../../i18n";
import { localTime } from "../../ui/local-time";
import { TraceDetail } from "./TraceDetail";
import { TraceSummary } from "./TraceSummary";
import { useRuntimeTraces } from "./use-runtime-traces";

export function TraceGroups({ filters }: { filters: RuntimeSpanFilters }) {
  const t = useI18n();
  const [paused, setPaused] = useState(false);
  const { items, summary, loading, error, hasMore, refresh, loadMore } = useRuntimeTraces(
    filters,
    paused,
  );
  const [selectedTrace, setSelectedTrace] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const fallback = useRef<HTMLButtonElement>(null);
  const region = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  const close = () => {
    restoreFocus.current = true;
    setSelectedTrace(null);
  };
  useLayoutEffect(() => {
    if (selectedTrace !== null || !restoreFocus.current) return;
    restoreFocus.current = false;
    // The directory must be visible again before focus returns on narrow layouts.
    (trigger.current?.isConnected
      ? trigger.current
      : !fallback.current?.disabled
        ? fallback.current
        : region.current
    )?.focus();
  }, [selectedTrace]);
  return (
    <section ref={region} tabIndex={-1} className="trace-results" aria-label={t("请求与唤醒链路")}>
      <div className="trace-actions">
        <button ref={fallback} type="button" disabled={loading} onClick={refresh}>
          {t("刷新运行记录")}
        </button>
        <button type="button" aria-pressed={paused} onClick={() => setPaused((value) => !value)}>
          {t(paused ? "恢复自动刷新" : "暂停自动刷新")}
        </button>
        <small>{t("仅影响此视图，不暂停 Agent。")}</small>
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
        {summary && <small>{t("刷新于 {0}", localTime(summary.now))}</small>}
      </div>
      {error && (
        <p role="alert" className="error">
          {translateNotice(error)}
        </p>
      )}
      <div className="trace-workspace" data-inspecting={selectedTrace !== null}>
        <div className="trace-directory">
          {!loading && !error && !items.length && (
            <p className="hint">{t("暂无匹配的运行记录；启用观测前的活动可能没有记录。")}</p>
          )}
          <ol className="trace-list">
            {items.map((item) => (
              <li
                key={item.traceId}
                className="trace-row trace-group"
                data-status={item.status}
                data-selected={selectedTrace === item.traceId}
              >
                <TraceSummary item={item} compact />
                <button
                  type="button"
                  className="trace-select"
                  aria-pressed={selectedTrace === item.traceId}
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
            <button type="button" disabled={loading} onClick={loadMore}>
              {t("加载更早运行记录")}
            </button>
          )}
        </div>
        {selectedTrace ? (
          <TraceDetail
            key={selectedTrace}
            traceId={selectedTrace}
            filters={filters}
            paused={paused}
            onClose={close}
          />
        ) : (
          <div className="trace-empty-selection">
            <p>{t("选择一条请求，查看完整运行链路。")}</p>
            <p className="hint">{t("输入与输出仅在你请求查看时读取。")}</p>
          </div>
        )}
      </div>
    </section>
  );
}
