import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { AgentStepSnapshot, RunStatus } from "../../../shared/contracts/agent-run";
import { formatDate } from "../../i18n/runtime";
import { useLiveResource } from "../../services/use-live-resource";
import { useSuperstringStore } from "../../store";
import { ModelEvidence } from "../observability/ModelEvidence";
import { phaseLabels, ReadError } from "../observability/presentation";

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
export function RunLink({ runId }: { runId: string }) {
  return <RunEntry runId={runId} />;
}
export function JobRunLink({ ownerKind, ownerId }: { ownerKind: string; ownerId: string }) {
  return <RunEntry ownerKind={ownerKind} ownerId={ownerId} />;
}
function RunEntry(
  props:
    | {
        runId: string;
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
        <Button variant="link" size="sm" className="h-auto gap-1 px-0">
          <ArrowUpRight />
          {t("observability.runDetails")}
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
    (signal: AbortSignal) => api.listRuns(ownerKind, ownerId, signal),
    [api, ownerKind, ownerId],
  );
  const { data, error, loading, refresh } = useLiveResource(read);
  const runs = [...(data?.runs ?? [])].sort(
      (a, b) => b.startedAt.localeCompare(a.startedAt) || a.runId.localeCompare(b.runId),
    ),
    runId = runs.some((run) => run.runId === selected) ? selected : runs[0]?.runId;
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
        <Button variant="outline" size="sm" disabled={loading} onClick={refresh}>
          <RefreshCw />
          {t("observability.refreshRuns")}
        </Button>
      </div>
      <ReadError error={error} />
      {!loading && !error && !runs.length && (
        <p>{t("observability.noRecordedRunsYetQueuedTasksAndTasksBeforeMigration")}</p>
      )}
      {runId && <RunWorkspace key={runId} runId={runId} />}
    </div>
  );
}
export function RunWorkspace({ runId }: { runId: string }) {
  const { t, i18n } = useTranslation(),
    api = useSuperstringStore((s) => s.apiClient),
    receive = useSuperstringStore((s) => s.receiveRunSnapshot),
    live = useSuperstringStore((s) => s.runById[runId]),
    [selected, setSelected] = useState<string | null>(null);
  const read = useCallback(
    async (signal: AbortSignal) => {
      const snapshot = await api.getRun(runId, signal);
      if (!signal.aborted) receive(snapshot);
      return snapshot;
    },
    [api, runId, receive],
  );
  const { data, loading, error, refresh } = useLiveResource(read);
  const run = data
    ? {
        ...data,
        status: live?.status ?? data.status,
        errorCode: live?.errorCode ?? data.errorCode,
        outputs: live?.outputs ?? data.outputs,
      }
    : null;
  const step = run?.steps.find((item) => item.stepId === selected) ?? run?.steps[0];
  return (
    <section aria-label={t("observability.selectedRunDetails")} className="min-w-0 space-y-5">
      <ReadError error={error} />
      {loading && !run && <p role="status">{t("observability.loadingRuns")}</p>}
      {run && (
        <>
          <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold">{run.specId}</h3>
                <Badge variant={run.status === "failed" ? "destructive" : "secondary"}>
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
              <code className="block break-all text-xs text-muted-foreground">{run.runId}</code>
            </div>
            <Button variant="outline" size="sm" disabled={loading} onClick={refresh}>
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
          <fieldset
            className="flex gap-2 overflow-x-auto pb-2"
            aria-label={t("observability.modelSteps")}
          >
            {run.steps.map((item) => (
              <Button
                key={item.stepId}
                variant={step?.stepId === item.stepId ? "default" : "outline"}
                className="h-auto min-w-40 flex-col items-start gap-1 py-3"
                aria-pressed={step?.stepId === item.stepId}
                onClick={() => setSelected(item.stepId)}
              >
                <span>
                  {t("observability.stepValueValue", {
                    "0": item.stepNo,
                    "1": t(phaseLabels[item.phase]),
                  })}
                </span>
                <span className="max-w-56 truncate text-xs opacity-75">{item.model}</span>
                <span className="text-xs">
                  {item.errorCode ??
                    t(item.status === "running" ? "observability.running" : runLabels[item.status])}
                </span>
              </Button>
            ))}
          </fieldset>
          {!run.steps.length && (
            <p className="text-muted-foreground">{t("observability.noModelStepHasStartedYet")}</p>
          )}
          {step && <ModelEvidence key={step.stepId} handle={step.context} />}
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
        </>
      )}
    </section>
  );
}
