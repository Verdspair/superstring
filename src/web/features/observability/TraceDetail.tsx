import { useEffect, useRef, useState } from "react";
import type { RuntimeSpanFilters } from "../../../shared/contracts/runtime-observability";
import { translateNotice, useI18n } from "../../i18n";
import { TraceSummary } from "./TraceSummary";
import { TraceWaterfall } from "./TraceWaterfall";
import { useRuntimeWaterfall } from "./use-runtime-traces";

export function TraceDetail({
  traceId,
  filters,
  paused,
  onClose,
}: {
  traceId: string;
  filters: RuntimeSpanFilters;
  paused: boolean;
  onClose(): void;
}) {
  const t = useI18n();
  const { data, loading, error, refresh } = useRuntimeWaterfall(traceId, filters, paused);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section
      className="trace-detail-pane"
      aria-label={t("追踪链路")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="trace-detail-heading">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            {t("追踪链路")}
          </h2>
          <p className="hint">{t("每次请求或唤醒独立展示；时间条按实际起点和耗时排列。")}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={t("关闭追踪链路")}>
          {t("返回请求列表")}
        </button>
      </header>
      <div className="trace-actions">
        <button type="button" disabled={loading} onClick={refresh}>
          {t("刷新当前链路")}
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
          <TraceWaterfall
            data={data}
            selectedSpanId={selectedSpanId}
            onSelectSpan={setSelectedSpanId}
          />
        </>
      )}
    </section>
  );
}
