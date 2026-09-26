import { Download, GitCompareArrows, Pause, Play, RefreshCw } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { RuntimeSpanFilters } from "../../../shared/contracts/runtime-observability";
import { readFilterUrl, writeFilterUrl } from "../../features/observability/trace-filters";
import { useRuntimeTraces } from "../../features/observability/use-runtime-traces";
import { formatDate } from "../../i18n/runtime";
import { ExecutionLedger } from "./ExecutionLedger";
import { InvestigationCanvas } from "./InvestigationCanvas";
import { ReadError } from "./presentation";
import { QueryToolbar } from "./QueryToolbar";
import { TraceComparison } from "./TraceComparison";
export function ObservabilityWorkspace() {
  return (
    <div className="mx-auto w-full max-w-[1600px] p-4 lg:p-8">
      <ExecutionWorkspace />
    </div>
  );
}
export function ExecutionWorkspace({ conversationId }: { conversationId?: string }) {
  const { t, i18n } = useTranslation(),
    reduceMotion = useReducedMotion();
  const [filters, setFilters] = useState<RuntimeSpanFilters>(() =>
    conversationId
      ? {
          conversationId,
        }
      : readFilterUrl(),
  );
  const [paused, setPaused] = useState(false),
    [trace, setTrace] = useState<string | null>(null),
    [compare, setCompare] = useState(false),
    [selected, setSelected] = useState<string[]>([]);
  const { items, summary, loading, error, hasMore, refresh, loadMore } = useRuntimeTraces(
    filters,
    paused,
  );
  const root = useRef<HTMLElement>(null),
    previousRow = useRef<string | null>(null),
    restore = useRef(false),
    scroll = useRef(0);
  const open = useCallback((id: string, trigger: HTMLButtonElement) => {
    previousRow.current = id;
    scroll.current = root.current?.closest("[data-workspace-scroll]")?.scrollTop ?? window.scrollY;
    trigger.dataset.traceAction = id;
    setTrace(id);
  }, []);
  const chooseCompare = useCallback(
    (id: string) =>
      setSelected((current) =>
        current.includes(id)
          ? current.filter((item) => item !== id)
          : current.length < 2
            ? [...current, id]
            : current,
      ),
    [],
  );
  const back = () => {
    restore.current = true;
    setTrace(null);
    setCompare(false);
    refresh();
  };
  useLayoutEffect(() => {
    if (!trace && !compare && restore.current) {
      restore.current = false;
      const target = Array.from(
        root.current?.querySelectorAll<HTMLButtonElement>("[data-trace-action]") ?? [],
      ).find((button) => button.dataset.traceAction === previousRow.current);
      (target ?? root.current)?.focus({
        preventScroll: true,
      });
      const area = root.current?.closest("[data-workspace-scroll]");
      if (area) area.scrollTop = scroll.current;
    }
  }, [trace, compare]);
  const apply = (next: RuntimeSpanFilters) => {
    setFilters(next);
    setSelected([]);
    if (!conversationId) writeFilterUrl(next);
  };
  const exportMetadata = () => {
    const file = new Blob(
      [
        JSON.stringify(
          {
            filters,
            summary,
            items,
          },
          null,
          2,
        ),
      ],
      {
        type: "application/json",
      },
    );
    const url = URL.createObjectURL(file);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "superstring-executions.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label={t("observability.executionWorkspace")}
      className="min-w-0 space-y-6 outline-none"
    >
      {trace ? (
        <InvestigationCanvas
          key={trace}
          traceId={trace}
          filters={filters}
          paused={paused}
          onBack={back}
        />
      ) : compare ? (
        <TraceComparison ids={selected} filters={filters} onBack={back} />
      ) : (
        <motion.div
          initial={false}
          animate={{
            opacity: 1,
          }}
          transition={{
            duration: reduceMotion ? 0 : 0.15,
          }}
          className="space-y-6"
        >
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[.18em] text-primary">
                {t("observability.observability")}
              </p>
              <h1 className="text-3xl font-semibold tracking-tight">
                {t("observability.executions")}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("observability.followAnActivityThroughEveryModelCallAndDelivery")}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPaused((value) => !value)}
                aria-pressed={paused}
              >
                {paused ? <Play /> : <Pause />}
                {t(paused ? "observability.resumeAutoRefresh" : "observability.pauseAutoRefresh")}
              </Button>
              <Button variant="outline" size="sm" disabled={loading} onClick={refresh}>
                <RefreshCw />
                {t("observability.refreshRuns")}
              </Button>
              <Button variant="outline" size="sm" disabled={!items.length} onClick={exportMetadata}>
                <Download />
                {t("observability.exportLoadedMetadata")}
              </Button>
            </div>
          </header>
          <QueryToolbar
            key={conversationId ?? "global"}
            filters={filters}
            onApply={apply}
            conversationId={conversationId}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 border-y py-3 text-xs text-muted-foreground">
            <div className="flex flex-wrap gap-4">
              {summary ? (
                <>
                  <span>
                    {t("observability.valueTraces", {
                      "0": summary.totalTraces,
                    })}
                  </span>
                  <span>
                    {t("observability.valueActive", {
                      "0": summary.activeTraces,
                    })}
                  </span>
                  <span>
                    {t("observability.valueWithFailures", {
                      "0": summary.failedTraces,
                    })}
                  </span>
                  <span>
                    {t("observability.valueMatchingSpans", {
                      "0": summary.matchedSpans,
                    })}
                  </span>
                  <span>
                    {t("observability.updatedAtValue", {
                      "0": formatDate(summary.now, i18n.language, {
                        dateStyle: "medium",
                        timeStyle: "medium",
                      }),
                    })}
                  </span>
                </>
              ) : (
                <span>{t("observability.loadingRuns")}</span>
              )}
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={selected.length !== 2}
              onClick={() => setCompare(true)}
            >
              <GitCompareArrows />
              {t("observability.compareValueSelected", {
                "0": selected.length,
              })}
            </Button>
          </div>
          <ReadError error={error} />
          {loading && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("observability.loadingRuns")}
            </p>
          )}
          {!!items.length && (
            <ExecutionLedger
              items={items}
              selected={selected}
              onCompareSelect={chooseCompare}
              onInvestigate={open}
            />
          )}
          {!loading && !error && !items.length && (
            <div className="rounded-xl border border-dashed px-6 py-16 text-center">
              <p className="font-medium">{t("observability.noMatchingExecutions")}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {t("observability.noMatchingRecordsActivityBeforeTelemetryWasEnabledMayNot")}
              </p>
            </div>
          )}
          <footer className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {t("observability.valueTracesLoaded", {
                "0": items.length,
              })}{" "}
              · {t("observability.onlyAffectsThisViewTheAgentContinuesRunning")}
            </span>
            {hasMore && (
              <Button variant="outline" disabled={loading} onClick={loadMore}>
                {t("observability.loadEarlierRuntimeRecords")}
              </Button>
            )}
          </footer>
        </motion.div>
      )}
    </section>
  );
}
