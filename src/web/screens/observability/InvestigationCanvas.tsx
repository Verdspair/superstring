import { ArrowLeft, ArrowUpRight, Copy, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
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
import { RunWorkspace } from "../runs/RunEntry";
import { EvidenceWorkbench } from "./EvidenceWorkbench";
import { ModelCallsTable } from "./ModelCallsTable";
import {
  latestWakeOutcome,
  milliseconds,
  ReadError,
  StatusMark,
  spanTitle,
  traceCause,
  traceTask,
  wakeCauseSummary,
} from "./presentation";

const locateHintKeys = {
  failed: "hints.investigation.canvas.locateFailed",
  unknown: "hints.investigation.canvas.locateUnknown",
  started: "hints.investigation.canvas.locateStarted",
} as const;

import { TraceTimeline } from "./TraceTimeline";
export function InvestigationCanvas({
  traceId,
  filters,
  paused = false,
  initialView = "timeline",
  onBack,
}: {
  traceId: string;
  filters: RuntimeSpanFilters;
  paused?: boolean;
  initialView?: "timeline" | "models";
  onBack(): void;
}) {
  const { t, i18n } = useTranslation(),
    id = useId(),
    { data, loading, error, refresh } = useRuntimeWaterfall(traceId, filters, paused);
  const [selectedId, setSelectedId] = useState<string | null>(null),
    [expanded, setExpanded] = useState(false),
    [copied, setCopied] = useState(false),
    [activeView, setActiveView] = useState<string>(initialView);
  useEffect(() => setActiveView(initialView), [initialView]);
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
  const wakeSummaries = data ? wakeCauseSummary(data.items, t) : [];
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
          <Button
            variant="ghost"
            className="-ml-2"
            tooltip={t("hints.investigation.canvas.backToExecutions")}
            onClick={onBack}
          >
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
              {latestWakeOutcome(data.items, t) && <span>{latestWakeOutcome(data.items, t)}</span>}
              <span>{traceCause(data.trace, t) || t("observability.triggerNotRecorded")}</span>
              <time dateTime={data.trace.at}>
                {formatDate(data.trace.at, i18n.language, {
                  dateStyle: "medium",
                  timeStyle: "medium",
                })}
              </time>
              {initialView === "models" && (
                <span>
                  {t("observability.recordedModelCallsTotalUnknown", {
                    "0": new Set(
                      data.items
                        .filter((item) => item.stage === "model")
                        .map((item) => item.spanId),
                    ).size,
                  })}
                </span>
              )}
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
            tooltip={
              copied ? t("observability.copied") : t("hints.investigation.canvas.copyTraceId")
            }
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
          <Button
            variant="outline"
            size="sm"
            disabled={loading}
            disabledReason={t("hints.investigation.canvas.refreshLoading")}
            tooltip={t("hints.investigation.canvas.refreshThisTrace")}
            onClick={refresh}
          >
            <RefreshCw />
            {t("observability.refreshThisTrace")}
          </Button>
        </div>
      </header>
      {!!conversationIds.length && (
        <div className="flex flex-wrap gap-2">
          {conversationIds.map((conversationId) => (
            <Button
              tooltip={<Trans i18nKey="hints.complete.conversationOpen" />}
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
      {wakeSummaries.length > 0 && (
        <section aria-label={t("observability.wakeReasons")} className="space-y-2">
          <h3 className="text-sm font-medium">{t("observability.wakeReasons")}</h3>
          <dl className="space-y-2 text-sm">
            {wakeSummaries.map((summary) => (
              <div
                key={summary.wakeId}
                className="space-y-1 rounded-lg border bg-card p-3 text-card-foreground"
              >
                <dt className="font-mono text-xs text-muted-foreground">{summary.wakeId}</dt>
                <dd className="space-x-2">
                  <span>{summary.cause}</span>
                  {summary.condition && <span>{summary.condition}</span>}
                  {summary.count !== null && (
                    <span>{t("observability.wakeEligibleMessages", { "0": summary.count })}</span>
                  )}
                  {summary.addressing && <span>{summary.addressing}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
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
          {initialView === "models" && (
            <ol className="space-y-2 text-sm" aria-label={t("observability.triggerAndFlow")}>
              {data.items
                .filter((item) => item.stage === "wake")
                .map((item) => (
                  <li key={item.spanId} className="flex flex-wrap items-center gap-2">
                    <span>{spanTitle(item, t)}</span>
                    <StatusMark status={item.status} />
                    {typeof item.details.activationAt === "string" && (
                      <span>
                        {t("observability.actualActivationAt", {
                          "0": formatDate(item.details.activationAt, i18n.language, {
                            timeStyle: "medium",
                          }),
                        })}
                      </span>
                    )}
                    {typeof item.details.lastMergedAt === "string" && (
                      <span>
                        {t("observability.opportunityLastMergedAt", {
                          "0": formatDate(item.details.lastMergedAt, i18n.language, {
                            timeStyle: "medium",
                          }),
                        })}
                      </span>
                    )}
                    {typeof item.details.triggerFunction === "string" && (
                      <code className="text-xs">{item.details.triggerFunction}</code>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {item.durationMs === null ? "—" : milliseconds(item.durationMs)}
                    </span>
                  </li>
                ))}
            </ol>
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
                  disabledReason={t("hints.investigation.canvas.locateNone", {
                    "0": t(
                      status === "failed"
                        ? "observability.processingFailed"
                        : status === "unknown"
                          ? "observability.resultUnconfirmed"
                          : "observability.inProgress",
                    ),
                  })}
                  tooltip={t(locateHintKeys[status])}
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
              disabledReason={t("hints.investigation.canvas.nextMatchNone")}
              tooltip={t("hints.investigation.canvas.nextMatch")}
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
                    <Tabs
                      value={activeView}
                      onValueChange={setActiveView}
                      className="flex h-full min-h-0 flex-col gap-0"
                    >
                      <TabsList
                        variant="line"
                        presentation="compact"
                        flow="wrap"
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
                      tooltip={
                        expanded
                          ? t("hints.investigation.canvas.restoreLayout")
                          : t("hints.investigation.canvas.expandReader")
                      }
                      onClick={() => setExpanded((value) => !value)}
                    >
                      {expanded ? <Minimize2 /> : <Maximize2 />}
                      {t(expanded ? "observability.restoreLayout" : "observability.expandReader")}
                    </Button>
                  </div>
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="min-w-0 p-4 md:p-6">
                      {selected ? (
                        <EvidenceWorkbench
                          key={selected.spanId}
                          item={selected}
                          autoInspect
                          renderRun={(runId) => <RunWorkspace runId={runId} />}
                        />
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
