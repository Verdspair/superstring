import { ArrowUpRight, Copy, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  AgentStepSnapshot,
  RunSnapshot,
  RunStatus,
} from "../../../shared/contracts/agent-run";
import type {
  RuntimeSpan,
  RuntimeTraceDetail,
} from "../../../shared/contracts/runtime-observability";
import { formatDate } from "../../i18n/runtime";
import { useConversationChangeSubscription } from "../../services/conversation-changes";
import { useLiveResource } from "../../services/use-live-resource";
import { useSuperstringStore } from "../../store";
import { EvidenceWorkbench } from "../observability/EvidenceWorkbench";
import { ModelEvidence, RunEvidenceScope } from "../observability/ModelEvidence";
import {
  phaseLabels,
  ReadError,
  StatusMark,
  spanTitle,
  taskName,
} from "../observability/presentation";
import { TraceTimeline } from "../observability/TraceTimeline";
import { DeliveryEvidence } from "./DeliveryEvidence";

const runLabels: Record<RunStatus, string> = {
  prepared: "observability.waiting",
  deciding: "observability.preparing",
  observing: "observability.readingSources",
  generating: "observability.replying",
  completed: "observability.runCompleted",
  no_output: "observability.noResponseThisTime",
  failed: "observability.runFailed",
  cancelled: "observability.runCancelled",
};
export function runStatusLabel(status: RunStatus, phase?: AgentStepSnapshot["phase"]) {
  return status === "generating" && phase === "leaf"
    ? "observability.processing"
    : status === "generating" && phase === "vision"
      ? "observability.understandingImages"
      : runLabels[status];
}
export function RunLink({ runId, children }: { runId: string; children?: ReactNode }) {
  return <RunEntry runId={runId} label={children} />;
}
export function JobRunLink({ ownerKind, ownerId }: { ownerKind: string; ownerId: string }) {
  return <RunEntry ownerKind={ownerKind} ownerId={ownerId} />;
}
function RunEntry(
  props:
    | {
        runId: string;
        label?: ReactNode;
      }
    | {
        ownerKind: string;
        ownerId: string;
      },
) {
  const { t } = useTranslation(),
    [open, setOpen] = useState(false),
    close = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="link"
          size="sm"
          className="h-auto gap-1 px-0"
          tooltip={t("hints.investigation.runEntry.openDetails")}
        >
          <ArrowUpRight />
          {"runId" in props
            ? (props.label ?? t("observability.runDetails"))
            : t("observability.runDetails")}
        </Button>
      </DialogTrigger>
      <DialogContent
        showCloseButton={false}
        className="gap-4 sm:max-w-6xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          close.current?.focus();
        }}
      >
        <header className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <DialogTitle>{t("observability.runDetails")}</DialogTitle>
            <DialogDescription>
              {t("observability.inspectModelBehaviorByAttemptAndCall")}
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              ref={close}
              variant="outline"
              size="sm"
              aria-label={t("observability.closeRunDetails")}
              tooltip={t("hints.investigation.runEntry.closeDetails")}
            >
              {t("observability.close")}
            </Button>
          </DialogClose>
        </header>
        <ScrollArea className="h-[75dvh] pr-3 [&_[data-radix-scroll-area-viewport]>div]:block!">
          {open &&
            ("runId" in props ? <RunWorkspace runId={props.runId} /> : <RunAttempts {...props} />)}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
export function RunAttempts({ ownerKind, ownerId }: { ownerKind: string; ownerId: string }) {
  const { t, i18n } = useTranslation(),
    api = useSuperstringStore((s) => s.apiClient),
    [selected, setSelected] = useState("");
  const read = useCallback(
    async (signal: AbortSignal) => {
      const result = await api.listRuns(ownerKind, ownerId, signal);
      return { api, ownerKind, ownerId, runs: result.runs };
    },
    [api, ownerKind, ownerId],
  );
  const conversationScope = ownerKind === "conversation" ? { conversationId: ownerId } : undefined;
  const { data, error, loading, refresh } = useLiveResource(read, { conversationScope });
  const isDataCurrent =
    data && data.api === api && data.ownerKind === ownerKind && data.ownerId === ownerId;
  const runs = isDataCurrent
      ? [...data.runs].sort(
          (a, b) => b.startedAt.localeCompare(a.startedAt) || a.runId.localeCompare(b.runId),
        )
      : [],
    runId = runs.some((run) => run.runId === selected) ? selected : runs[0]?.runId;
  const selectedRun = runs.find((run) => run.runId === runId);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <NativeSelect
          aria-label={t("observability.runAttempt")}
          value={runId ?? ""}
          onChange={(event) => setSelected(event.target.value)}
          className="min-w-56 flex-1"
        >
          {runs.map((run) => (
            <NativeSelectOption key={run.runId} value={run.runId}>
              {formatDate(run.startedAt, i18n.language, {
                dateStyle: "medium",
                timeStyle: "medium",
              })}{" "}
              · {t(runStatusLabel(run.status, run.steps.at(-1)?.phase))} · {run.runId}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          disabledReason={t("hints.investigation.runEntry.refreshLoading")}
          tooltip={t("hints.investigation.runEntry.refreshRuns")}
          onClick={refresh}
        >
          <RefreshCw />
          {t("observability.refreshRuns")}
        </Button>
      </div>
      <ReadError error={error} />
      {!loading && !error && !runs.length && (
        <p>{t("observability.noRecordedRunsYetQueuedTasksAndTasksBeforeMigration")}</p>
      )}
      {runId && <RunWorkspace key={runId} runId={runId} initialSnapshot={selectedRun} />}
    </div>
  );
}
interface UnifiedModelCall {
  key: string;
  runId: string;
  stepId: string;
  stepNo: number;
  phase: AgentStepSnapshot["phase"];
  model: string;
  status: AgentStepSnapshot["status"];
  errorCode: string | null;
  startedAt?: string;
  durationMs?: number | null;
  context: { runId: string; stepId: string };
}

function RunTraceSection({
  data,
  selected,
  onSelect,
}: {
  data: RuntimeTraceDetail;
  selected: string | null;
  onSelect(span: RuntimeSpan): void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const next = (ids: string[]) => {
    const index = ids.indexOf(selected ?? "");
    const span = data.items.find((item) => item.spanId === ids[(index + 1) % ids.length]);
    if (span) onSelect(span);
  };
  return (
    <section
      className="min-w-0 space-y-4 rounded-xl border border-border/80 bg-card/50 p-4"
      aria-label={t("observability.traceDetails")}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <code className="min-w-0 break-all text-xs">{data.trace.traceId}</code>
        <Button
          size="sm"
          variant="outline"
          tooltip={
            copied ? t("observability.copied") : t("hints.investigation.runEntry.copyTraceId")
          }
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(data.trace.traceId);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          <Copy />
          {t(copied ? "observability.copied" : "observability.copyTraceId")}
        </Button>
      </header>
      <fieldset className="flex flex-wrap gap-2" aria-label={t("observability.locateEvidence")}>
        {(["failed", "unknown", "started"] as const).map((status) => {
          const matches = data.items.filter((item) => item.status === status);
          return (
            <Button
              key={status}
              size="sm"
              variant="outline"
              disabled={!matches.length}
              disabledReason={t("hints.investigation.runEntry.locateNone", {
                "0": t(
                  status === "failed"
                    ? "observability.processingFailed"
                    : status === "unknown"
                      ? "observability.resultUnconfirmed"
                      : "observability.inProgress",
                ),
              })}
              tooltip={t(
                status === "failed"
                  ? "hints.investigation.runEntry.locateFailed"
                  : status === "unknown"
                    ? "hints.investigation.runEntry.locateUnknown"
                    : "hints.investigation.runEntry.locateStarted",
              )}
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
      <TraceTimeline
        data={data}
        selected={selected}
        onSelect={onSelect}
        alwaysExpanded
        hideToggles
      />
    </section>
  );
}

export function RunWorkspace({
  runId,
  initialSnapshot,
}: {
  runId: string;
  initialSnapshot?: RunSnapshot;
}) {
  const { t, i18n } = useTranslation(),
    api = useSuperstringStore((s) => s.apiClient),
    receive = useSuperstringStore((s) => s.receiveRunSnapshot),
    live = useSuperstringStore((s) => s.runById[runId]),
    [view, setView] = useState<"overview" | "technical">("overview"),
    [selectedKey, setSelectedKey] = useState<string | null>(null),
    [selectedSpan, setSelectedSpan] = useState<{ traceId: string; spanId: string } | null>(null),
    [fallbackCallKey, setFallbackCallKey] = useState<string | null>(null),
    [inspectionRevision, setInspectionRevision] = useState(0);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (view !== "technical" || (!selectedSpan && !fallbackCallKey)) return;
    detailHeading.current?.scrollIntoView?.({ block: "nearest" });
    detailHeading.current?.focus({ preventScroll: true });
  }, [view, selectedSpan, fallbackCallKey]);

  const prevApiRef = useRef(api);
  if (prevApiRef.current !== api) {
    prevApiRef.current = api;
    if (selectedKey !== null) setSelectedKey(null);
    if (selectedSpan !== null) setSelectedSpan(null);
    if (fallbackCallKey !== null) setFallbackCallKey(null);
  }
  const prevRunIdRef = useRef(runId);
  if (prevRunIdRef.current !== runId) {
    prevRunIdRef.current = runId;
    if (selectedKey !== null) setSelectedKey(null);
    if (selectedSpan !== null) setSelectedSpan(null);
    if (fallbackCallKey !== null) setFallbackCallKey(null);
  }

  const read = useCallback(
    async (signal: AbortSignal) => {
      const snapshot = await api.getRun(runId, signal);
      if (!signal.aborted) receive(snapshot);
      return { api, snapshot };
    },
    [api, runId, receive],
  );
  const { data, loading, error, refresh } = useLiveResource(read);
  const currentData =
    data && data.api === api && data.snapshot.runId === runId ? data.snapshot : null;
  const validInitial = initialSnapshot?.runId === runId ? initialSnapshot : null;
  const currentOwner = currentData?.owner ?? validInitial?.owner;
  const conversationScope =
    currentOwner?.kind === "conversation" ? { conversationId: currentOwner.id } : undefined;
  useConversationChangeSubscription(refresh, {
    conversationId: conversationScope?.conversationId,
    enabled: conversationScope !== undefined,
  });
  const base = error ? null : (currentData ?? validInitial);

  const isLiveCurrent = Boolean(currentData && live?.snapshot === currentData);
  const run = base
    ? {
        ...base,
        status: isLiveCurrent ? (live?.status ?? base.status) : base.status,
        errorCode: isLiveCurrent ? (live?.errorCode ?? base.errorCode) : base.errorCode,
        outputs: isLiveCurrent ? (live?.outputs ?? base.outputs) : base.outputs,
      }
    : null;

  // Trace reading: discover all associated traces and their waterfalls
  const readTraces = useCallback(
    async (signal: AbortSignal) => {
      let beforeId: number | undefined;
      const allTraces = [];
      while (!signal.aborted) {
        const page = await api.listRuntimeTraces({ runId, beforeId, limit: 100 }, signal);
        const matched = page.items.filter((tr) => tr.runIds.includes(runId));
        allTraces.push(...matched);
        if (!page.hasMore || !page.nextBeforeId || page.nextBeforeId >= (beforeId ?? Infinity)) {
          break;
        }
        beforeId = page.nextBeforeId;
      }
      const waterfalls = [];
      for (const trace of allTraces) {
        if (signal.aborted) break;
        waterfalls.push(await api.getRuntimeWaterfall(trace.traceId, { runId }, signal));
      }
      return { api, runId, traces: allTraces, waterfalls };
    },
    [api, runId],
  );

  const shouldFetchTraces = Boolean(run);
  const tracesResource = useLiveResource(readTraces, {
    enabled: shouldFetchTraces,
    conversationScope,
  });

  const tracesData =
    tracesResource.data?.api === api && tracesResource.data?.runId === runId
      ? tracesResource.data
      : null;
  const traces = tracesData?.traces ?? [];
  const waterfalls = tracesData?.waterfalls ?? [];

  // Deduplicate and aggregate model calls
  const modelCalls = useMemo(() => {
    const seenHandles = new Set<string>();
    const calls: UnifiedModelCall[] = [];

    // 1. Own steps from RunSnapshot
    if (run?.steps) {
      for (const step of run.steps) {
        const key = `${step.runId ?? run.runId}|${step.stepId}`;
        if (!seenHandles.has(key)) {
          seenHandles.add(key);
          calls.push({
            key,
            runId: step.runId ?? run.runId,
            stepId: step.stepId,
            stepNo: step.stepNo,
            phase: step.phase,
            model: step.model,
            status: step.status,
            errorCode: step.errorCode,
            startedAt: step.startedAt,
            durationMs:
              step.endedAt && step.startedAt
                ? Date.parse(step.endedAt) - Date.parse(step.startedAt)
                : null,
            context: step.context ?? { runId: step.runId ?? run.runId, stepId: step.stepId },
          });
        }
      }
    }

    // 2. Discovered model spans from all trace waterfalls
    for (const wf of waterfalls) {
      if (!wf?.items) continue;
      const byId = new Map(wf.items.map((item) => [item.spanId, item]));
      const belongsToRun = (item: RuntimeSpan) => {
        const visited = new Set<string>();
        let current: RuntimeSpan | undefined = item;
        while (current && !visited.has(current.spanId)) {
          if (current.runId === run?.runId) return true;
          visited.add(current.spanId);
          current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
        }
        return false;
      };
      for (const item of wf.items) {
        if (
          item.stage === "model" &&
          item.runId &&
          typeof item.details?.stepId === "string" &&
          belongsToRun(item)
        ) {
          const stepId = item.details.stepId;
          const key = `${item.runId}|${stepId}`;
          if (!seenHandles.has(key)) {
            seenHandles.add(key);
            calls.push({
              key,
              runId: item.runId,
              stepId,
              stepNo: calls.length + 1,
              phase: (item.details.phase as AgentStepSnapshot["phase"]) ?? "leaf",
              model: item.model ?? item.name,
              status:
                item.status === "failed"
                  ? "failed"
                  : item.status === "cancelled"
                    ? "cancelled"
                    : item.status === "started"
                      ? "running"
                      : "completed",
              errorCode: item.status === "failed" ? item.code : null,
              startedAt: item.at,
              durationMs: item.durationMs,
              context: { runId: item.runId, stepId },
            });
          }
        }
      }
    }

    return calls;
  }, [run?.steps, run?.runId, waterfalls]);

  const activeCall = modelCalls.find((call) => call.key === selectedKey) ?? modelCalls[0] ?? null;

  const deliveryOwners = useMemo(() => {
    const owners = new Map<string, string>();
    for (const waterfall of waterfalls)
      for (const span of waterfall.items) {
        if (span.channel === "onebot11" && span.outputId && !owners.has(span.outputId)) {
          owners.set(span.outputId, `${span.traceId}|${span.spanId}`);
        }
      }
    return owners;
  }, [waterfalls]);

  const technicalSpan = selectedSpan
    ? waterfalls
        .find((waterfall) => waterfall.trace.traceId === selectedSpan.traceId)
        ?.items.find((span) => span.spanId === selectedSpan.spanId)
    : undefined;
  const technicalCallKey =
    technicalSpan?.stage === "model" &&
    technicalSpan.runId &&
    typeof technicalSpan.details.stepId === "string"
      ? `${technicalSpan.runId}|${technicalSpan.details.stepId}`
      : fallbackCallKey;
  const technicalCall = modelCalls.find((call) => call.key === technicalCallKey);
  const untracedCalls = useMemo(() => {
    const traced = new Set<string>();
    for (const waterfall of waterfalls)
      for (const span of waterfall.items)
        if (span.stage === "model" && span.runId && typeof span.details.stepId === "string")
          traced.add(`${span.runId}|${span.details.stepId}`);
    return modelCalls.filter((call) => !traced.has(call.key));
  }, [modelCalls, waterfalls]);
  const chooseSpan = (span: RuntimeSpan) => {
    setFallbackCallKey(null);
    setSelectedSpan({ traceId: span.traceId, spanId: span.spanId });
  };

  const isTracing = shouldFetchTraces && tracesResource.loading && !tracesData;
  const traceError = tracesResource.error;

  return (
    <RunEvidenceScope key={runId}>
      <section
        aria-label={t("observability.selectedRunDetails")}
        className="flex min-w-0 flex-col gap-5"
      >
        <ReadError error={error} />
        {traceError && <ReadError error={traceError} />}
        {loading && !run && <p role="status">{t("observability.loadingRuns")}</p>}
        {run && (
          <>
            <header className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-border/80 bg-card/60 p-4">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold tracking-tight">
                    {taskName(run.specId, t)}
                  </h3>
                  {taskName(run.specId, t) !== run.specId && (
                    <span className="font-mono text-xs text-muted-foreground">{run.specId}</span>
                  )}
                  <Badge
                    variant={run.status === "failed" ? "destructive" : "secondary"}
                    className="gap-1"
                  >
                    {t(runStatusLabel(run.status, run.steps.at(-1)?.phase))}
                  </Badge>
                  <Badge variant="outline">v{run.specVersion}</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatDate(run.startedAt, i18n.language, {
                    dateStyle: "medium",
                    timeStyle: "medium",
                  })}{" "}
                  {run.endedAt && (
                    <>
                      →{" "}
                      {formatDate(run.endedAt, i18n.language, {
                        dateStyle: "medium",
                        timeStyle: "medium",
                      })}
                    </>
                  )}
                </p>
                <code className="block break-all text-xs text-muted-foreground font-mono">
                  {run.runId}
                </code>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={loading || tracesResource.loading}
                disabledReason={t("hints.investigation.runEntry.refreshLoading")}
                tooltip={t("hints.investigation.runEntry.refreshAll")}
                onClick={() => {
                  refresh();
                  setInspectionRevision((revision) => revision + 1);
                  if (shouldFetchTraces) tracesResource.refresh();
                }}
              >
                <RefreshCw />
                {t("observability.refreshRuns")}
              </Button>
            </header>

            {run.errorCode && <ReadError error={run.errorCode} />}
            {run.status === "completed" && (
              <p className="text-sm text-muted-foreground">
                {t("observability.runCompletionMeansTheModelTaskFinishedExternalMessageDelivery")}
              </p>
            )}

            <nav className="flex flex-wrap gap-2" aria-label={t("observability.runView")}>
              <Button
                variant={view === "overview" ? "default" : "outline"}
                aria-pressed={view === "overview"}
                tooltip={t("hints.investigation.runEntry.overview")}
                onClick={() => setView("overview")}
              >
                {t("observability.overview")}
              </Button>
              <Button
                variant={view === "technical" ? "default" : "outline"}
                aria-pressed={view === "technical"}
                tooltip={t("hints.investigation.runEntry.technical")}
                onClick={() => setView("technical")}
              >
                {t("observability.technicalDetails")}
              </Button>
            </nav>

            <div className={view === "technical" ? "order-2 space-y-6" : "space-y-6"}>
              {run.steps.length > 0 && (
                <p className="text-sm font-medium">
                  {t("observability.ownRecordedModelCalls", {
                    "0": new Set(run.steps.map((item) => item.stepId)).size,
                  })}
                </p>
              )}
              {!run.steps.length && modelCalls.length > 0 && (
                <p className="text-sm font-medium">
                  {t("observability.recordedModelCallsTotalUnknown", {
                    "0": modelCalls.length,
                  })}
                </p>
              )}
              {view === "overview" && modelCalls.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("observability.selectCallForInputOutput")}
                </p>
              )}

              {isTracing && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t("observability.loadingRuns")}
                </p>
              )}

              {view === "overview" && (
                <>
                  {/* Vertical list of step buttons */}
                  {modelCalls.length > 0 && (
                    <fieldset className="grid gap-2.5" aria-label={t("observability.modelSteps")}>
                      {modelCalls.map((call) => {
                        const isSelected = activeCall?.key === call.key;
                        return (
                          <Button
                            key={call.key}
                            data-key={call.key}
                            data-run-id={call.runId}
                            data-step-id={call.stepId}
                            variant={isSelected ? "default" : "outline"}
                            className="h-auto w-full flex-col items-start gap-1.5 rounded-xl p-4 text-left justify-start transition-colors"
                            aria-label={t("observability.stepValueValue", {
                              "0": call.stepNo,
                              "1": t(phaseLabels[call.phase]),
                            })}
                            aria-pressed={isSelected}
                            tooltip={
                              isSelected
                                ? t("hints.investigation.runEntry.stepSelected")
                                : t("hints.investigation.runEntry.stepSelect")
                            }
                            onClick={() => setSelectedKey(call.key)}
                          >
                            <span className="font-semibold text-sm">
                              {t("observability.stepValueValue", {
                                "0": call.stepNo,
                                "1": t(phaseLabels[call.phase]),
                              })}
                            </span>
                            <span className="font-mono text-xs opacity-80 break-all">
                              {call.model}
                            </span>
                            <span className="text-xs">
                              {call.errorCode ??
                                t(
                                  call.status === "running"
                                    ? "observability.running"
                                    : runLabels[call.status],
                                )}
                            </span>
                          </Button>
                        );
                      })}
                    </fieldset>
                  )}
                </>
              )}

              {view === "technical" && untracedCalls.length > 0 && (
                <fieldset
                  className="flex flex-wrap gap-2"
                  aria-label={t("observability.modelSteps")}
                >
                  {untracedCalls.map((call) => {
                    const label = t("observability.stepValueValue", {
                      "0": call.stepNo,
                      "1": t(phaseLabels[call.phase]),
                    });
                    return (
                      <Button
                        key={call.key}
                        variant={fallbackCallKey === call.key ? "default" : "outline"}
                        aria-label={label}
                        aria-pressed={fallbackCallKey === call.key}
                        className="h-auto max-w-full flex-col items-start whitespace-normal text-left"
                        tooltip={t("hints.investigation.runEntry.stepSelect")}
                        onClick={() => {
                          setSelectedSpan(null);
                          setFallbackCallKey(call.key);
                        }}
                      >
                        <span>{label}</span>
                        <span className="max-w-full break-all text-xs">{call.model}</span>
                      </Button>
                    );
                  })}
                </fieldset>
              )}

              <section
                role={view === "technical" ? "region" : undefined}
                aria-label={view === "technical" ? t("observability.viewStepDetails") : undefined}
                className="min-w-0 space-y-4"
              >
                {view === "technical" && (technicalSpan || technicalCall) && (
                  <h3
                    ref={detailHeading}
                    tabIndex={-1}
                    className="text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {technicalSpan
                      ? spanTitle(technicalSpan, t)
                      : t("observability.viewStepDetails")}
                  </h3>
                )}
                <div className="min-w-0">
                  {modelCalls.map((call) => {
                    const active =
                      view === "overview"
                        ? call.key === activeCall?.key
                        : call.key === technicalCall?.key;
                    return (
                      <Collapsible
                        key={call.key}
                        open={active}
                        hidden={!active}
                        className="min-w-0"
                      >
                        <CollapsibleContent forceMount hidden={!active}>
                          <div
                            className={
                              view === "technical" ? "space-y-3 rounded-lg border p-3" : "min-w-0"
                            }
                          >
                            {view === "technical" && active && (
                              <code className="block break-all text-xs text-muted-foreground">
                                {call.runId} · {call.stepId}
                              </code>
                            )}
                            <ModelEvidence
                              handle={call.context}
                              autoInspect
                              embedded
                              fullEvidence
                              inspectionRevision={`${call.status === "running" ? "running" : "settled"}:${inspectionRevision}`}
                            />
                          </div>
                        </CollapsibleContent>
                      </Collapsible>
                    );
                  })}
                </div>
                {view === "technical" && technicalSpan && (
                  <details
                    key={`${technicalSpan.traceId}|${technicalSpan.spanId}`}
                    className="min-w-0 rounded-lg border"
                  >
                    <summary className="cursor-pointer p-3 text-sm">
                      {t("observability.runAndMetadata")}
                    </summary>
                    <div className="border-t p-3">
                      <EvidenceWorkbench
                        item={technicalSpan}
                        fullEvidence
                        includeDelivery={false}
                      />
                    </div>
                  </details>
                )}
                {[...deliveryOwners.keys()].map((outputId) => (
                  <div
                    key={outputId}
                    hidden={view !== "technical" || technicalSpan?.outputId !== outputId}
                  >
                    <DeliveryEvidence outputId={outputId} />
                  </div>
                ))}
              </section>
              {!run.steps.length && !isTracing && !modelCalls.length && (
                <p className="text-muted-foreground">
                  {t("observability.noModelStepHasStartedYet")}
                </p>
              )}

              {/* External outputs and delivery */}
              {!!run.outputs.length && (
                <section className="space-y-3 border-t pt-4">
                  <h3 className="text-sm font-semibold">{t("observability.outputsAndDelivery")}</h3>
                  {run.outputs.map((output) => (
                    <div key={output.outputId} className="space-y-2">
                      <p className="break-all text-xs">
                        {output.targetId} · {output.status}
                        {output.code && ` · ${output.code}`}
                      </p>
                      <code className="block break-all text-xs text-muted-foreground">
                        {output.outputId}
                      </code>
                    </div>
                  ))}
                </section>
              )}
            </div>

            <div hidden={view !== "technical"} className="order-1 space-y-6">
              {waterfalls.map((waterfall) => (
                <RunTraceSection
                  key={waterfall.trace.traceId}
                  data={waterfall}
                  selected={
                    selectedSpan?.traceId === waterfall.trace.traceId ? selectedSpan.spanId : null
                  }
                  onSelect={chooseSpan}
                />
              ))}
              {!isTracing && !traces.length && (
                <p className="text-muted-foreground">
                  {t("observability.noAssociatedSourcesAreRecorded")}
                </p>
              )}
            </div>
          </>
        )}
      </section>
    </RunEvidenceScope>
  );
}
