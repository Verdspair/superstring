import { Activity, Pause, Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate } from "../../i18n/runtime";
import { useLiveResource } from "../../services/use-live-resource";
import { useSuperstringStore } from "../../store";
import { ExecutionWorkspace } from "./ObservabilityWorkspace";
import { ReadError } from "./presentation";

const phases: Record<string, string> = {
  idle: "observability.connectionNotStarted",
  connecting: "observability.connecting",
  verifying: "observability.verifyingConnection",
  ready: "observability.connectionReady",
  closed: "observability.connectionClosed",
  unavailable: "observability.connectionStatusUnavailable",
  unknown: "observability.connectionStatusUnknown",
};

export function ConversationActivity({
  conversationId,
  active = true,
}: {
  conversationId: string;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [paused, setPaused] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [tracesLoading, setTracesLoading] = useState(false);
  const reportSummary = useCallback(
    (state: { loading: boolean }) => setSummaryLoading(state.loading),
    [],
  );
  const reportTraces = useCallback(
    (state: { loading: boolean }) => setTracesLoading(state.loading),
    [],
  );
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={t("workspace.conversationHub.activityTitle")}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <h1 className="text-sm font-medium">{t("workspace.conversationHub.activityTitle")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-pressed={paused}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? <Play /> : <Pause />}
            {t(paused ? "observability.resumeAutoRefresh" : "observability.pauseAutoRefresh")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={summaryLoading || tracesLoading}
            onClick={() => setRefreshSignal((value) => value + 1)}
          >
            <RefreshCw />
            {t("connections.common.refresh")}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-workspace-scroll>
        <div className="space-y-4">
          <ConversationRuntimeSummary
            conversationId={conversationId}
            refreshSignal={refreshSignal}
            paused={!active || paused}
            active={active}
            onState={reportSummary}
          />
          <ExecutionWorkspace
            key={conversationId}
            conversationId={conversationId}
            header={false}
            refreshSignal={refreshSignal}
            paused={!active || paused}
            active={active}
            onPausedChange={setPaused}
            onState={reportTraces}
          />
        </div>
      </div>
    </section>
  );
}

export function ConversationRuntimeSummary({
  conversationId,
  refreshSignal = 0,
  paused = false,
  active = true,
  onState,
}: {
  conversationId: string;
  refreshSignal?: number;
  paused?: boolean;
  active?: boolean;
  onState?: (state: { loading: boolean }) => void;
}) {
  const { t, i18n } = useTranslation(),
    api = useSuperstringStore((s) => s.apiClient);
  const read = useCallback(
    (signal: AbortSignal) => api.getConversationRuntimeStatus(conversationId, signal),
    [api, conversationId],
  );
  const { data, error, loading, refresh } = useLiveResource(read, {
    paused: paused || !active,
    enabled: active,
    conversationScope: { conversationId },
  });
  const lastRefreshSignal = useRef(0);
  const notify = useRef(onState);
  notify.current = onState;
  useEffect(() => {
    notify.current?.({ loading });
  }, [loading]);
  useEffect(() => {
    if (refreshSignal === lastRefreshSignal.current) return;
    lastRefreshSignal.current = refreshSignal;
    refresh();
  }, [refreshSignal, refresh]);
  return (
    <section
      aria-label={t("observability.currentProcessingState")}
      className="space-y-3 rounded-xl border bg-muted/20 p-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Activity className="size-4 text-primary" />
        {data ? (
          <>
            <Badge variant="outline">
              {t(phases[data.connectionPhase] ?? data.connectionPhase)}
            </Badge>
            <span className="text-sm">
              {t("observability.valueActiveValueQueued", {
                "0": data.activeRuns,
                "1": data.pendingWakes,
              })}
            </span>
            {data.nextReadyAt && (
              <span className="text-xs text-muted-foreground">
                {t(
                  new Date(data.nextReadyAt) > new Date(data.now)
                    ? "observability.waitingWindowUntil"
                    : "observability.earliestQueuedTime",
                )}{" "}
                {formatDate(data.nextReadyAt, i18n.language, {
                  dateStyle: "medium",
                  timeStyle: "medium",
                })}
              </span>
            )}
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("observability.loadingProcessingState")}
          </span>
        )}
      </div>
      <ReadError error={error} />
      {data && (
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs [&>div]:flex [&>div]:gap-2 [&_dt]:text-muted-foreground">
          <div>
            <dt>{t("observability.failedWakes")}</dt>
            <dd>{data.failedWakes}</dd>
          </div>
          <div>
            <dt>{t("observability.unconfirmedDeliveries")}</dt>
            <dd>{data.unknownDeliveries}</dd>
          </div>
          <div>
            <dt>{t("observability.latestActivity")}</dt>
            <dd>
              {data.lastActivityAt
                ? formatDate(data.lastActivityAt, i18n.language, {
                    dateStyle: "medium",
                    timeStyle: "medium",
                  })
                : "—"}
            </dd>
          </div>
          <div>
            <dt>{t("observability.sampledAt")}</dt>
            <dd>
              {formatDate(data.now, i18n.language, {
                dateStyle: "medium",
                timeStyle: "medium",
              })}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
