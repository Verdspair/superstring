import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import type { RuntimeTrace } from "../../../shared/contracts/runtime-observability";
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
export function traceTask(trace: RuntimeTrace, t: (key: string) => string) {
  return (
    trace.specIds.map((id) => t(taskLabels[id] ?? id)).join(" · ") ||
    t(operationLabels[trace.root.name] ?? trace.root.name)
  );
}
export function traceCause(trace: RuntimeTrace, t: (key: string) => string) {
  return trace.causes.map((id) => t(triggerLabels[id] ?? id)).join(" · ");
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
