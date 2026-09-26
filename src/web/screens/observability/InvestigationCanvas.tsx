import { ArrowLeft, ArrowUpRight, Copy, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type {
  RuntimeSpan,
  RuntimeSpanFilters,
} from "../../../shared/contracts/runtime-observability";
import { useRuntimeWaterfall } from "../../features/observability/use-runtime-traces";
import { formatDate } from "../../i18n/runtime";
import { useSuperstringStore } from "../../store";
import { DeliveryDetails } from "../runs/DeliveryEvidence";
import { EvidenceWorkbench } from "./EvidenceWorkbench";
import { ModelCallsTable } from "./ModelCallsTable";
import { milliseconds, ReadError, StatusMark, traceCause, traceTask } from "./presentation";
import { TraceTimeline } from "./TraceTimeline";
export function InvestigationCanvas({
  traceId,
  filters,
  paused = false,
  onBack,
}: {
  traceId: string;
  filters: RuntimeSpanFilters;
  paused?: boolean;
  onBack(): void;
}) {
  const { t, i18n } = useTranslation(),
    id = useId(),
    { data, loading, error, refresh } = useRuntimeWaterfall(traceId, filters, paused);
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [expanded, setExpanded] = useState(false),
    [copied, setCopied] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null),
    evidenceHeading = useRef<HTMLHeadingElement>(null),
    moveFocus = useRef(false);
  const summaries = useSuperstringStore((s) => s.summaryById),
    openConversation = useSuperstringStore((s) => s.requestConversationNavigation);
  useLayoutEffect(() => {
    heading.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (moveFocus.current) {
      moveFocus.current = false;
      evidenceHeading.current?.focus();
    }
  });
  const selected = data?.items.find((item) => item.spanId === selectedId);
  const choose = (item: RuntimeSpan) => {
    if (item.spanId === selectedId) evidenceHeading.current?.focus();
    else {
      moveFocus.current = true;
      setSelectedId(item.spanId);
    }
  };
  const next = (ids: string[]) => {
    const index = ids.indexOf(selectedId ?? "");
    const item = data?.items.find((span) => span.spanId === ids[(index + 1) % ids.length]);
    if (item) choose(item);
  };
  const conversationIds = [
    ...new Set(
      data?.items.flatMap((item) => (item.conversationId ? [item.conversationId] : [])) ?? [],
    ),
  ];
  const outputs = [
    ...new Set(
      data?.items.flatMap((item) =>
        item.channel === "onebot11" && item.outputId ? [item.outputId] : [],
      ) ?? [],
    ),
  ];
  return (
    <section
      aria-label={t("observability.traceDetails")}
      className="min-w-0 space-y-5"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !(event.target instanceof HTMLInputElement)
        ) {
          event.preventDefault();
          onBack();
        }
      }}
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <Button variant="ghost" className="-ml-2" onClick={onBack}>
            <ArrowLeft />
            {t("observability.backToExecutions")}
          </Button>
          <h2
            tabIndex={-1}
            ref={heading}
            className="break-words text-2xl font-semibold tracking-tight outline-none"
          >
            {data ? traceTask(data.trace, t) : t("observability.traceDetails")}
          </h2>
          {data && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <StatusMark status={data.trace.status} />
              <span>{traceCause(data.trace, t) || t("observability.triggerNotRecorded")}</span>
              <time dateTime={data.trace.at}>
                {formatDate(data.trace.at, i18n.language, {
                  dateStyle: "medium",
                  timeStyle: "medium",
                })}
              </time>
              <span>{milliseconds(data.trace.durationMs)}</span>
              <span>
                {t("observability.valueSteps", {
                  "0": data.trace.spanCount,
                })}
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(traceId);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            <Copy />
            {t(copied ? "observability.copied" : "observability.copyTraceId")}
          </Button>
          <Button variant="outline" size="sm" disabled={loading} onClick={refresh}>
            <RefreshCw />
            {t("observability.refreshThisTrace")}
          </Button>
        </div>
      </header>
      {!!conversationIds.length && (
        <div className="flex flex-wrap gap-2">
          {conversationIds.map((conversationId) => (
            <Button
              key={conversationId}
              size="sm"
              variant="link"
              disabled={!summaries[conversationId]}
              title={
                summaries[conversationId]?.title ??
                t("observability.conversationIsNotLoadedInTheDirectory")
              }
              onClick={() => void openConversation(conversationId)}
            >
              <ArrowUpRight />
              {summaries[conversationId]?.title ?? conversationId}
            </Button>
          ))}
        </div>
      )}
      <ReadError error={error} />
      {loading && !data && <p role="status">{t("observability.loadingRuns")}</p>}
      {data && (
        <>
          {!data.matchedSpanIds.length && (
            <p className="text-sm text-muted-foreground">
              {t("observability.thisChainNoLongerMatchesTheFiltersTheFullChain")}
            </p>
          )}
          <fieldset
            className="flex flex-wrap items-center gap-2"
            aria-label={t("observability.locateEvidence")}
          >
            {(["failed", "unknown", "started"] as const).map((status) => {
              const matches = data.items.filter((item) => item.status === status);
              return (
                <Button
                  key={status}
                  variant="outline"
                  size="sm"
                  disabled={!matches.length}
                  onClick={() => next(matches.map((item) => item.spanId))}
                >
                  <StatusMark status={status} />
                  <span>{matches.length}</span>
                </Button>
              );
            })}
            <Button
              size="sm"
              variant="outline"
              disabled={!data.matchedSpanIds.length}
              onClick={() => next(data.matchedSpanIds)}
            >
              {t("observability.nextMatch")} · {data.matchedSpanIds.length}
            </Button>
          </fieldset>
          <div className="h-[max(46rem,80dvh)] overflow-hidden rounded-xl border bg-card text-card-foreground">
            <ResizablePanelGroup orientation="vertical">
              {!expanded && (
                <>
                  <ResizablePanel id={`${id}-timeline`} defaultSize="48%" minSize="20%">
                    <Tabs defaultValue="timeline" className="flex h-full min-h-0 flex-col gap-0">
                      <TabsList
                        variant="line"
                        className="mx-3 h-11 shrink-0"
                        aria-label={t("observability.investigationViews")}
                      >
                        <TabsTrigger value="timeline">
                          {t("observability.fullTimeline")}
                        </TabsTrigger>
                        <TabsTrigger value="models">
                          {t("observability.modelInvocation")} ·{" "}
                          {data.items.filter((item) => item.stage === "model").length}
                        </TabsTrigger>
                        <TabsTrigger value="outputs">
                          {t("observability.outputsAndDelivery")} · {outputs.length}
                        </TabsTrigger>
                      </TabsList>
                      <TabsContent value="timeline" className="min-h-0 flex-1">
                        <TraceTimeline data={data} selected={selectedId} onSelect={choose} />
                      </TabsContent>
                      <TabsContent value="models" className="min-h-0 flex-1 overflow-auto">
                        <ModelCallsTable
                          items={data.items}
                          selected={selectedId}
                          onSelect={choose}
                        />
                      </TabsContent>
                      <TabsContent value="outputs" className="min-h-0 flex-1 overflow-auto p-4">
                        <div className="space-y-3">
                          {outputs.map((outputId) => (
                            <DeliveryDetails key={outputId} outputId={outputId} />
                          ))}
                          {!outputs.length && (
                            <p className="text-sm text-muted-foreground">
                              {t("observability.thisTraceHasNoExternalDeliveryRecords")}
                            </p>
                          )}
                        </div>
                      </TabsContent>
                    </Tabs>
                  </ResizablePanel>
                  <ResizableHandle
                    withHandle
                    aria-label={t("observability.resizeTimelineAndInspector")}
                  />
                </>
              )}
              <ResizablePanel id={`${id}-evidence`} defaultSize="52%" minSize="25%">
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex items-center justify-between border-b px-4 py-2">
                    <h3
                      ref={evidenceHeading}
                      tabIndex={-1}
                      className="text-xs font-medium uppercase tracking-widest text-muted-foreground outline-none"
                    >
                      {t("observability.evidenceWorkbench")}
                    </h3>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-pressed={expanded}
                      onClick={() => setExpanded((value) => !value)}
                    >
                      {expanded ? <Minimize2 /> : <Maximize2 />}
                      {t(expanded ? "observability.restoreLayout" : "observability.expandReader")}
                    </Button>
                  </div>
                  <ScrollArea className="min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:block!">
                    <div className="min-w-0 p-4 md:p-6">
                      {selected ? (
                        <EvidenceWorkbench key={selected.spanId} item={selected} />
                      ) : (
                        <div className="grid min-h-40 place-content-center gap-2 text-center">
                          <p className="font-medium">
                            {t("observability.selectACallToInspectItsEvidence")}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {t("observability.inputsAndOutputsAreLoadedOnlyWhenYouInspectThem")}
                          </p>
                        </div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        </>
      )}
    </section>
  );
}
