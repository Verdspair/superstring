import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { RuntimeSpan, RuntimeTrace } from "../../../shared/contracts/runtime-observability";
import { i18n } from "../../i18n/runtime";
import { operationLabels, statusLabels, taskLabels, triggerLabels } from "./labels";
export function StatusMark({ status }: { status: string }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant={status === "failed" ? "destructive" : status === "started" ? "default" : "secondary"}
      className="gap-1.5"
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {t(statusLabels[status] ?? status)}
    </Badge>
  );
}
export function ReadError({ error }: { error: string }) {
  return error ? (
    <p
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {error}
    </p>
  ) : null;
}
export function taskName(specId: string, t: (key: string) => string): string {
  if (Object.hasOwn(taskLabels, specId)) {
    return t(taskLabels[specId]);
  }
  return specId;
}
export function spanTitle(span: RuntimeSpan, t: (key: string) => string): string {
  const specId = span.details?.specId ? String(span.details.specId) : null;
  if (span.name === "agent.run" && specId && Object.hasOwn(taskLabels, specId)) {
    return taskName(specId, t);
  }
  return t(operationLabels[span.name] ?? span.name);
}
const GENERIC_OPERATIONS = new Set(["agent.run", "agent.model", "agent.action", "agent.context"]);

export function traceTask(trace: RuntimeTrace, t: (key: string) => string): string {
  const rootSpecId = trace.root.details?.specId ? String(trace.root.details.specId) : null;
  if (rootSpecId) {
    return taskName(rootSpecId, t);
  }
  if (trace.specIds.length === 1) {
    return taskName(trace.specIds[0], t);
  }
  if (trace.specIds.length > 1) {
    if (
      !GENERIC_OPERATIONS.has(trace.root.name) &&
      Object.hasOwn(operationLabels, trace.root.name)
    ) {
      return t(operationLabels[trace.root.name]);
    }
    return t("observability.multipleTasksRunning");
  }
  if (Object.hasOwn(operationLabels, trace.root.name)) {
    return t(operationLabels[trace.root.name]);
  }
  return trace.root.name;
}
export function traceCause(trace: RuntimeTrace, t: (key: string) => string): string {
  if (trace.causes && trace.causes.length > 0) {
    return trace.causes.map((id) => t(triggerLabels[id] ?? id)).join(" · ");
  }
  const rootSpec = trace.root.details?.specId ? String(trace.root.details.specId) : null;
  const isSoleEvents =
    !rootSpec && trace.specIds.length === 1 && trace.specIds[0] === "context.compress.events";
  if (rootSpec === "context.compress.events" || isSoleEvents) {
    return t("observability.backgroundHistorySummary");
  }
  return "";
}
export function milliseconds(value: number) {
  return new Intl.NumberFormat(i18n.language, {
    style: "unit",
    unit: value >= 1000 ? "second" : "millisecond",
    unitDisplay: "short",
    maximumFractionDigits: value >= 1000 ? 2 : 0,
  }).format(value >= 1000 ? value / 1000 : value);
}
export const phaseLabels: Record<string, string> = {
  next: "observability.actionDecision",
  generate: "observability.generateReply",
  leaf: "observability.singleTurnTask",
  vision: "observability.imageUnderstanding",
};

/**
 * 提取唯一确定 wake 信号的终态摘要（如「最近尝试已完成（第 3 次）」）。
 * 全部 wake 激活 span 必须属于同一个已知非空 wakeId；否则返回 null，不推定整体成功。
 */
export function latestWakeOutcome(
  items: RuntimeSpan[],
  t: (key: string, options?: Record<string, string | number>) => string,
): string | null {
  const wakeSpans = items.filter(
    (item) => item.stage === "wake" && item.name === "bot.wake.activate",
  );
  if (wakeSpans.length === 0) return null;

  const targetWakeId = wakeSpans[0].wakeId;
  if (!targetWakeId || !wakeSpans.every((span) => span.wakeId === targetWakeId)) {
    return null;
  }

  const sorted = [...wakeSpans].sort((a, b) => {
    const attemptA = typeof a.details?.attempt === "number" ? a.details.attempt : 0;
    const attemptB = typeof b.details?.attempt === "number" ? b.details.attempt : 0;
    if (attemptA !== attemptB) return attemptA - attemptB;
    return a.id - b.id;
  });

  const latest = sorted.at(-1);
  if (!latest) return null;

  const attempt = typeof latest.details?.attempt === "number" ? latest.details.attempt : null;

  if (latest.status === "completed") {
    if (attempt !== null) {
      return t("observability.latestAttemptCompleted", { "0": attempt });
    }
    return t("observability.latestAttemptCompletedWithoutAttempt");
  }
  if (latest.status === "failed") {
    if (attempt !== null) {
      return t("observability.latestAttemptFailed", { "0": attempt });
    }
  }

  return null;
}
