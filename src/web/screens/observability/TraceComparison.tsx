import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { RuntimeSpanFilters } from "../../../shared/contracts/runtime-observability";
import { useRuntimeWaterfall } from "../../features/observability/use-runtime-traces";
import { EvidenceWorkbench } from "./EvidenceWorkbench";
import { ModelCallsTable } from "./ModelCallsTable";
import { milliseconds, ReadError, StatusMark, traceTask } from "./presentation";
export function TraceComparison({
  ids,
  filters,
  onBack,
}: {
  ids: string[];
  filters: RuntimeSpanFilters;
  onBack(): void;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-5" aria-label={t("observability.compareTraces")}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t("observability.compareTraces")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("observability.selectACallOnEachSideContentIsAuthorizedIndependently")}
          </p>
        </div>
        <Button variant="outline" onClick={onBack}>
          {t("observability.backToExecutions")}
        </Button>
      </header>
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        {ids.map((id) => (
          <ComparisonColumn key={id} id={id} filters={filters} />
        ))}
      </div>
    </section>
  );
}
function ComparisonColumn({ id, filters }: { id: string; filters: RuntimeSpanFilters }) {
  const { t } = useTranslation(),
    query = useMemo(
      () => ({
        ...filters,
        traceId: id,
      }),
      [filters, id],
    ),
    { data, error, loading } = useRuntimeWaterfall(id, query),
    [selected, setSelected] = useState<string | null>(null);
  const item = data?.items.find((span) => span.spanId === selected);
  return (
    <section aria-label={id} className="min-w-0 space-y-4 rounded-xl border p-4">
      <ReadError error={error} />
      {loading && !data && <p role="status">{t("observability.loadingRuns")}</p>}
      {data && (
        <>
          <header className="space-y-2">
            <h3 className="font-semibold">{traceTask(data.trace, t)}</h3>
            <div className="flex flex-wrap items-center gap-2">
              <StatusMark status={data.trace.status} />
              <span className="font-mono text-xs">
                {milliseconds(data.trace.durationMs)} ·{" "}
                {t("observability.valueSteps", {
                  "0": data.trace.spanCount,
                })}
              </span>
            </div>
            <code className="break-all text-[10px] text-muted-foreground">{id}</code>
          </header>
          <ScrollArea className="h-72">
            <ModelCallsTable
              items={data.items}
              selected={selected}
              onSelect={(span) => setSelected(span.spanId)}
            />
          </ScrollArea>
          {item ? (
            <EvidenceWorkbench key={item.spanId} item={item} />
          ) : (
            <p className="border-t pt-4 text-sm text-muted-foreground">
              {t("observability.selectACallToInspectItsEvidence")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
