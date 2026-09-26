import { scaleTime } from "@visx/scale";
import { ChevronRight } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import type {
  RuntimeSpan,
  RuntimeTraceDetail,
} from "../../../shared/contracts/runtime-observability";
import { type WaterfallNode, waterfallLayout } from "../../features/observability/waterfall-layout";
import { operationLabels, stageLabels } from "./labels";
import { milliseconds, StatusMark } from "./presentation";
export function TraceTimeline({
  data,
  selected,
  onSelect,
}: {
  data: RuntimeTraceDetail;
  selected: string | null;
  onSelect(span: RuntimeSpan): void;
}) {
  const { t } = useTranslation(),
    id = useId(),
    [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const layout = useMemo(() => waterfallLayout(data.items, data.now), [data.items, data.now]);
  // Explicit evidence selection reveals its ancestry without discarding siblings.
  const ancestors = useMemo(() => {
    const seen = new Set<string>();
    let item = data.items.find((span) => span.spanId === selected);
    while (item?.parentSpanId && !seen.has(item.parentSpanId)) {
      seen.add(item.parentSpanId);
      item = data.items.find((span) => span.spanId === item?.parentSpanId);
    }
    return seen;
  }, [selected, data.items]);
  // Reopen ancestry only when the explicit selection changes, not on every poll or collapse.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection owns this navigation effect; refreshed metadata must not reset manual branch state.
  useEffect(() => {
    setCollapsed((previous) => new Set([...previous].filter((id) => !ancestors.has(id))));
  }, [selected]);
  const timeScale = scaleTime({
    domain: [new Date(layout.start), new Date(layout.start + layout.duration)],
    range: [0, 100],
  });
  const renderNode = (node: WaterfallNode, depth: number) => {
    const item = node.span,
      timing = layout.interval(item),
      hidden = collapsed.has(item.spanId),
      childId = `${id}-${item.spanId}`;
    return (
      <li key={item.spanId} className="list-none">
        <div
          data-selected={item.spanId === selected}
          className="grid grid-cols-[22rem_minmax(18rem,1fr)] items-center border-b data-[selected=true]:bg-accent/60"
        >
          <div
            className="flex min-w-0 items-center gap-1 border-r py-2 pr-3"
            style={{
              paddingLeft: `${12 + Math.min(depth, 10) * 14}px`,
            }}
          >
            {node.children.length ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t(
                  hidden
                    ? "observability.expandChildrenOfValue"
                    : "observability.collapseChildrenOfValue",
                  {
                    "0": t(operationLabels[item.name] ?? item.name),
                  },
                )}
                aria-expanded={!hidden}
                aria-controls={childId}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (next.has(item.spanId)) next.delete(item.spanId);
                    else next.add(item.spanId);
                    return next;
                  })
                }
              >
                <ChevronRight className={hidden ? "" : "rotate-90"} />
              </Button>
            ) : (
              <span className="w-6 shrink-0" />
            )}
            <Button
              variant="ghost"
              className="h-auto min-w-0 flex-1 flex-col items-start gap-1 whitespace-normal px-2 text-left"
              aria-pressed={selected === item.spanId}
              aria-label={t(
                item.stage === "model"
                  ? "observability.viewInputOutputAndDetails"
                  : "observability.viewStepDetails",
              )}
              aria-describedby={`${childId}-title`}
              onClick={() => onSelect(item)}
            >
              <span id={`${childId}-title`} className="text-xs font-medium">
                {t(operationLabels[item.name] ?? item.name)}
              </span>
              <span className="max-w-full break-all text-[11px] text-muted-foreground">
                {item.model ?? t(stageLabels[item.stage])}
              </span>
            </Button>
            <StatusMark status={item.status} />
          </div>
          <div className="space-y-1 px-4">
            <div className="relative h-4 overflow-hidden rounded bg-muted/50" aria-hidden="true">
              <div
                className={`absolute top-0 h-4 min-w-px rounded ${item.status === "failed" ? "bg-destructive/65" : "bg-primary/65"}`}
                style={{
                  left: `${timeScale(new Date(layout.start + timing.offsetMs))}%`,
                  width: `${timeScale(new Date(layout.start + timing.offsetMs + timing.durationMs)) - timeScale(new Date(layout.start + timing.offsetMs))}%`,
                }}
              />
            </div>
            <div className="flex justify-between text-[10px] tabular-nums text-muted-foreground">
              <span>+{milliseconds(timing.offsetMs)}</span>
              <span>{milliseconds(timing.durationMs)}</span>
            </div>
          </div>
        </div>
        {node.missingParent && (
          <p className="px-4 py-1 text-xs text-muted-foreground">
            {t("observability.parentStepIsNotRetainedOrAccessible")}: {item.parentSpanId}
          </p>
        )}
        {!!node.children.length && (
          <ol id={childId} className="m-0 p-0" hidden={hidden}>
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ol>
        )}
      </li>
    );
  };
  return (
    <div className="flex h-full min-h-48 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="sm" onClick={() => setCollapsed(new Set())}>
          {t("observability.expandAllSteps")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCollapsed(new Set(data.items.map((item) => item.spanId)))}
        >
          {t("observability.collapseAllSteps")}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          0 → {milliseconds(layout.duration)}
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <section
          aria-label={t("observability.parentAndChildTiming")}
          className="min-w-[42rem] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus within the scrolling viewport supports keyboard horizontal scrolling.
          tabIndex={0}
        >
          <ol className="m-0 p-0">{layout.roots.map((root) => renderNode(root, 0))}</ol>
        </section>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  );
}
