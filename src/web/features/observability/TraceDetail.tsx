import { ArrowLeft, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
      className="trace-detail-pane min-w-0 space-y-4 rounded-xl border bg-card p-4 text-card-foreground"
      aria-label={t("追踪链路")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="trace-detail-heading flex flex-wrap items-start justify-between gap-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2:focus-visible]:outline-2 [&_h2:focus-visible]:outline-ring">
        <div>
          <h2 ref={heading} tabIndex={-1}>
            {t("追踪链路")}
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("每次请求或唤醒独立展示；时间条按实际起点和耗时排列。")}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={onClose}
          aria-label={t("关闭追踪链路")}
        >
          <ArrowLeft className="size-3.5" aria-hidden="true" />
          {t("返回请求列表")}
        </Button>
      </header>
      <div className="trace-actions flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Button variant="outline" size="sm" type="button" disabled={loading} onClick={refresh}>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          {t("刷新当前链路")}
        </Button>
        {loading && <span role="status">{t("正在读取运行记录…")}</span>}
      </div>
      {error && (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {translateNotice(error)}
        </p>
      )}
      {data && (
        <>
          <Card
            className="trace-row trace-group gap-2 bg-muted/20 p-4"
            data-status={data.trace.status}
          >
            <TraceSummary item={data.trace} />
          </Card>
          {data.matchedSpanIds.length === 0 && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("当前链路已不匹配筛选；仍保留完整链路供核对。")}
            </p>
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
