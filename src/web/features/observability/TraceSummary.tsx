import { Badge } from "@/components/ui/badge";
import type { RuntimeTrace } from "../../../shared/contracts/runtime-observability";
import { useI18n } from "../../i18n";
import { localTime } from "../../ui/local-time";
import { channelLabels, operationLabels, taskLabels, triggerLabels } from "./labels";

const groupStatuses: Record<string, string> = {
  started: "仍有运行步骤",
  failed: "包含失败步骤",
  unknown: "包含待确认步骤",
  completed: "步骤已完成",
  no_output: "本次未发言",
  cancelled: "包含取消步骤",
  observed: "已观察",
  scheduled: "已排期",
  deferred: "延后处理",
  skipped: "本次跳过",
};
export function TraceSummary({ item, compact = false }: { item: RuntimeTrace; compact?: boolean }) {
  const t = useI18n();
  const spec = typeof item.root.details.specId === "string" ? item.root.details.specId : null;
  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <strong className="min-w-0 break-words text-sm font-semibold">
          {t(
            spec ? (taskLabels[spec] ?? spec) : (operationLabels[item.root.name] ?? item.root.name),
          )}
        </strong>
        <Badge variant={item.status === "failed" ? "destructive" : "secondary"}>
          {t(groupStatuses[item.status] ?? item.status)}
        </Badge>
        <time className="basis-full text-xs tabular-nums text-muted-foreground" dateTime={item.at}>
          {localTime(item.at)}
        </time>
      </header>
      <div className="trace-facts flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span>
          {t("触发类型")}:{" "}
          {item.causes.length
            ? item.causes.map((cause) => t(triggerLabels[cause] ?? cause)).join(" · ")
            : t(
                item.root.channel === "web" && item.root.name === "conversation.activate"
                  ? "网页请求"
                  : "触发类型未记录",
              )}
        </span>
        <span>{item.channels.map((channel) => t(channelLabels[channel])).join(" · ")}</span>
        <span>{t("{0} 个步骤 · {1} 个命中", item.spanCount, item.matchedSpanCount)}</span>
        <span>{t("耗时 {0} ms", Math.round(item.durationMs))}</span>
      </div>
      {!!item.specIds.length && (
        <p className="trace-models break-words text-xs leading-relaxed text-muted-foreground [&_code]:mr-1 [&_code]:inline-block [&_code]:max-w-full [&_code]:break-all [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5">
          {t("链路任务")}: {item.specIds.map((id) => t(taskLabels[id] ?? id)).join(" · ")}
        </p>
      )}
      <p className="trace-models break-words text-xs leading-relaxed text-muted-foreground [&_code]:mr-1 [&_code]:inline-block [&_code]:max-w-full [&_code]:break-all [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5">
        {t("模型记录")}:{" "}
        {item.models.length
          ? item.models.map((model) => <code key={model}>{model}</code>)
          : t("尚未记录模型")}
      </p>
      {!compact && (
        <details className="mt-3 border-t pt-3 [&_summary]:cursor-pointer [&_summary]:text-xs [&_summary]:font-medium [&_dl]:mt-3">
          <summary>{t("请求与唤醒标识")}</summary>
          <dl className="trace-metadata grid gap-3 text-sm [&>div]:grid [&>div]:gap-1 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:break-words [&_code]:break-all [&_code]:text-xs">
            <div>
              <dt>Trace ID</dt>
              <dd>
                <code>{item.traceId}</code>
              </dd>
            </div>
            {!!item.wakeIds.length && (
              <div>
                <dt>Wake ID</dt>
                <dd>
                  {item.wakeIds.map((id) => (
                    <code key={id}>{id}</code>
                  ))}
                </dd>
              </div>
            )}
            {!!item.runIds.length && (
              <div>
                <dt>Run ID</dt>
                <dd>
                  {item.runIds.map((id) => (
                    <code key={id}>{id}</code>
                  ))}
                </dd>
              </div>
            )}
            {!!item.specIds.length && (
              <div>
                <dt>Spec ID</dt>
                <dd>
                  {item.specIds.map((id) => (
                    <code key={id}>{id}</code>
                  ))}
                </dd>
              </div>
            )}
            {(operationLabels[item.root.name] || spec) && (
              <div>
                <dt>{t("操作名称")}</dt>
                <dd>
                  <code>{item.root.name}</code>
                </dd>
              </div>
            )}
          </dl>
        </details>
      )}
    </>
  );
}
