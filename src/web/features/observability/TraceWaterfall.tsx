import { ChevronDown, ChevronRight } from "lucide-react";
import { type CSSProperties, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { useIsMobile } from "@/hooks/use-mobile";
import type { RuntimeTraceDetail } from "../../../shared/contracts/runtime-observability";
import { useI18n } from "../../i18n";
import { RunDetails } from "../runs/RunInspector";
import { operationLabels, stageLabels, statusLabels, taskLabels } from "./labels";
import { TraceSpanDetails } from "./TraceSpanDetails";
import { type WaterfallNode, waterfallLayout } from "./waterfall-layout";

const phaseLabels: Record<string, string> = {
  next: "行动判断",
  generate: "生成回复",
  leaf: "单轮任务",
  vision: "图片理解",
};
export function TraceWaterfall({
  data,
  selectedSpanId,
  onSelectSpan,
}: {
  data: RuntimeTraceDetail;
  selectedSpanId?: string | null;
  onSelectSpan?: (id: string) => void;
}) {
  const t = useI18n();
  const isMobile = useIsMobile();
  const layout = useMemo(() => waterfallLayout(data.items, data.now), [data.items, data.now]);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const selectedId = selectedSpanId === undefined ? localSelected : selectedSpanId;
  const setSelectedId = onSelectSpan ?? setLocalSelected;
  const inspectorId = useId();
  const [runId, setRunId] = useState<string | null>(null);
  const inspectorHeading = useRef<HTMLHeadingElement>(null);
  const runBack = useRef<HTMLButtonElement>(null);
  const selected = data.items.find((item) => item.spanId === selectedId);
  const focusTarget = useRef<"step" | "run" | null>(null);
  useLayoutEffect(() => {
    // Only explicit navigation requests focus. Revalidation/remount must not steal it.
    const target = focusTarget.current;
    focusTarget.current = null;
    if (target === "run") runBack.current?.focus();
    if (target === "step") inspectorHeading.current?.focus();
  });
  const chooseSpan = (id: string) => {
    if (id === selectedId && !runId) {
      inspectorHeading.current?.focus();
      return;
    }
    focusTarget.current = "step";
    setSelectedId(id);
    setRunId(null);
  };
  const inspectRun = (id: string) => {
    focusTarget.current = "run";
    setRunId(id);
  };
  const closeRun = () => {
    focusTarget.current = "step";
    setRunId(null);
  };
  const matching = new Set(data.matchedSpanIds);
  const toggle = (id: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const node = (item: WaterfallNode, depth: number) => {
    const span = item.span,
      interval = layout.interval(span),
      hidden = collapsed.has(span.spanId);
    const title = operationLabels[span.name] ?? span.name;
    const task = span.details.specId ?? span.details.action ?? span.details.name;
    const phase =
      typeof span.details.phase === "string"
        ? (phaseLabels[span.details.phase] ?? span.details.phase)
        : null;
    const resolved = span.details.modelResolved === true;
    const fallback =
      resolved &&
      typeof span.details.requestedModel === "string" &&
      span.model &&
      span.details.requestedModel !== span.model;
    const childrenId = `waterfall-children-${span.spanId}`;
    return (
      <li
        key={span.spanId}
        id={`trace-span-${span.spanId}`}
        className="waterfall-node min-w-0 list-none"
        data-status={span.status}
      >
        <div
          className="waterfall-row grid grid-cols-[minmax(16rem,3fr)_minmax(12rem,2fr)] items-center gap-3 border-b px-3 py-2 pl-[calc(.75rem+var(--waterfall-depth)*.75rem)] data-[selected=true]:bg-accent/60"
          data-selected={selectedId === span.spanId}
          style={{ "--waterfall-depth": Math.min(depth, 8) } as CSSProperties}
        >
          <div className="waterfall-label flex min-w-0 items-start gap-1">
            {item.children.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="waterfall-branch mt-1 size-6 shrink-0 p-0"
                aria-expanded={!hidden}
                aria-controls={childrenId}
                aria-label={t(hidden ? "展开 {0} 的子步骤" : "折叠 {0} 的子步骤", t(title))}
                onClick={() => toggle(span.spanId)}
              >
                {hidden ? (
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                ) : (
                  <ChevronDown className="size-3.5" aria-hidden="true" />
                )}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="waterfall-select h-auto min-w-0 flex-1 flex-wrap justify-start gap-1 whitespace-normal border-0 bg-transparent px-2 py-1 text-left [&_strong]:text-xs [&_small]:basis-full [&_small]:break-words [&_small]:text-[11px] [&_small]:leading-relaxed [&_small]:text-muted-foreground [&_code]:break-all"
              data-selected={selectedId === span.spanId}
              aria-pressed={selectedId === span.spanId}
              aria-label={t(span.stage === "model" ? "查看输入、输出与详情" : "查看步骤详情")}
              aria-describedby={`waterfall-title-${span.spanId}`}
              aria-controls={inspectorId}
              onClick={() => chooseSpan(span.spanId)}
            >
              <strong id={`waterfall-title-${span.spanId}`}>{t(title)}</strong>
              <Badge
                className="max-w-full text-[10px]"
                variant={span.status === "failed" ? "destructive" : "outline"}
              >
                {t(statusLabels[span.status])}
              </Badge>
              <small>
                {t(stageLabels[span.stage])}
                {phase && <> · {t(phase)}</>}
                {task && <> · {t(taskLabels[String(task)] ?? String(task))}</>}
              </small>
              {typeof span.details.attempt === "number" && (
                <small>{t("尝试 #{0}", span.details.attempt)}</small>
              )}
              {span.stage === "run" && span.runId && (
                <small>
                  Run <code title={span.runId}>{span.runId.slice(0, 8)}</code>
                </small>
              )}
              {span.model && (
                <small>
                  {t(
                    resolved
                      ? "实际请求模型"
                      : span.details.modelResolved === false
                        ? "请求模型"
                        : "记录模型（未验证）",
                  )}
                  : <code>{span.model}</code>
                </small>
              )}
              {fallback && (
                <small>
                  {t("已使用替补模型；请求模型：{0}", String(span.details.requestedModel))}
                </small>
              )}
              {matching.has(span.spanId) && data.matchedSpanIds.length !== data.items.length && (
                <small className="waterfall-match font-semibold !text-primary">
                  {t("命中筛选")}
                </small>
              )}
              {item.missingParent && (
                <small>
                  {t("父步骤未保留或不可访问")}: <code>{span.parentSpanId}</code>
                </small>
              )}
            </Button>
          </div>
          <div className="waterfall-timing min-w-0 space-y-1 [&>small]:text-[10px] [&>small]:tabular-nums [&>small]:text-muted-foreground">
            <div
              className="waterfall-track relative h-5 overflow-hidden rounded-sm bg-muted"
              aria-hidden="true"
            >
              <span
                className="waterfall-bar absolute top-1 h-3 min-w-px rounded-sm bg-primary/65 data-[running=true]:bg-primary"
                data-running={span.status === "started"}
                style={{ left: `${interval.left}%`, width: `${interval.width}%` }}
              />
            </div>
            <small>
              {t(
                "起点 +{0} ms · 耗时 {1} ms",
                Math.round(interval.offsetMs),
                Math.round(interval.durationMs),
              )}
            </small>
          </div>
        </div>
        {!!item.children.length && (
          <ol className="m-0 list-none p-0" id={childrenId} hidden={hidden}>
            {item.children.map((child) => node(child, depth + 1))}
          </ol>
        )}
      </li>
    );
  };
  const selectNextMatch = () => {
    const ids = data.matchedSpanIds;
    const index = selectedId ? ids.indexOf(selectedId) : -1;
    const next = ids[(index + 1) % ids.length];
    if (!next) return;
    const parents = new Set<string>();
    let current = data.items.find((item) => item.spanId === next);
    while (current?.parentSpanId && !parents.has(current.parentSpanId)) {
      parents.add(current.parentSpanId);
      current = data.items.find((item) => item.spanId === current?.parentSpanId);
    }
    setCollapsed((old) => new Set([...old].filter((id) => !parents.has(id))));
    chooseSpan(next);
  };
  return (
    <div className="trace-analysis-workspace h-[min(76dvh,56rem)] min-h-[34rem] overflow-hidden rounded-lg border">
      <ResizablePanelGroup
        orientation={isMobile ? "vertical" : "horizontal"}
        className="h-full w-full"
      >
        <ResizablePanel id={`${inspectorId}-timeline`} defaultSize="60%" minSize="25%">
          <ScrollArea className="h-full w-full">
            <section
              className="trace-waterfall min-w-[34rem] pb-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-label={t("父子时序图")}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: A focus target inside the viewport enables keyboard horizontal scrolling.
              tabIndex={0}
            >
              <div className="trace-actions sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b bg-card p-3 text-xs text-muted-foreground">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => setCollapsed(new Set())}
                >
                  {t("展开全部步骤")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => setCollapsed(new Set(data.items.map((item) => item.spanId)))}
                >
                  {t("折叠全部步骤")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  disabled={!data.matchedSpanIds.length}
                  onClick={selectNextMatch}
                >
                  {t("下一个命中")}
                </Button>
              </div>
              <div className="waterfall-ruler grid grid-cols-[minmax(16rem,3fr)_minmax(12rem,2fr)] gap-3 border-b bg-muted/30 p-3 text-xs font-medium text-muted-foreground [&>div]:flex [&>div]:justify-between">
                <span>{t("任务与实际模型")}</span>
                <div>
                  <span>0 ms</span>
                  <span>{Math.round(layout.duration / 2)} ms</span>
                  <span>{Math.round(layout.duration)} ms</span>
                </div>
              </div>
              <ol className="m-0 list-none p-0">{layout.roots.map((item) => node(item, 0))}</ol>
            </section>
            <ScrollBar orientation="horizontal" />
          </ScrollArea>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label={t("调整时间线与检查器大小")} />
        <ResizablePanel id={`${inspectorId}-panel`} defaultSize="40%" minSize="25%">
          <ScrollArea className="h-full w-full">
            <aside
              id={inspectorId}
              className="trace-step-inspector min-w-0 space-y-4 p-4"
              aria-label={t("步骤检查器")}
            >
              <header className="trace-step-heading border-b pb-3 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:outline-none">
                <h3 ref={inspectorHeading} tabIndex={-1}>
                  {t(selected ? (operationLabels[selected.name] ?? selected.name) : "步骤检查器")}
                </h3>
              </header>
              {selected ? (
                runId ? (
                  <section
                    aria-label={t("选中运行的详情")}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        closeRun();
                      }
                    }}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      ref={runBack}
                      type="button"
                      onClick={closeRun}
                    >
                      {t("返回步骤详情")}
                    </Button>
                    <RunDetails key={runId} runId={runId} />
                  </section>
                ) : (
                  <TraceSpanDetails
                    key={selected.spanId}
                    item={selected}
                    onInspectRun={inspectRun}
                  />
                )
              ) : (
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {t("选择一个步骤，核对任务、模型及实际输入输出。")}
                </p>
              )}
            </aside>
          </ScrollArea>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
