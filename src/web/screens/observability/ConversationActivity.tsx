import { Activity, ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
export function ConversationActivity({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation(),
    [open, setOpen] = useState(false);
  return (
    <section className="min-w-0 space-y-3">
      <ConversationRuntimeSummary conversationId={conversationId} />
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="outline" size="sm">
            <Activity />
            {t("observability.investigateConversationExecutions")}
            <ChevronDown className={open ? "rotate-180" : ""} />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {open && (
            <div className="mt-4 rounded-xl border p-4">
              <ExecutionWorkspace key={conversationId} conversationId={conversationId} />
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
export function ConversationRuntimeSummary({ conversationId }: { conversationId: string }) {
  const { t, i18n } = useTranslation(),
    api = useSuperstringStore((s) => s.apiClient);
  const read = useCallback(
    (signal: AbortSignal) => api.getConversationRuntimeStatus(conversationId, signal),
    [api, conversationId],
  );
  const { data, error, loading, refresh } = useLiveResource(read);
  return (
    <section
      aria-label={t("observability.currentProcessingState")}
      className="space-y-3 rounded-xl border bg-muted/20 p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
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
        <Button variant="ghost" size="sm" disabled={loading} onClick={refresh}>
          <RefreshCw />
          {t("observability.refreshProcessingState")}
        </Button>
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
