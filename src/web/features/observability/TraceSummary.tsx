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
      <header>
        <strong>
          {t(
            spec ? (taskLabels[spec] ?? spec) : (operationLabels[item.root.name] ?? item.root.name),
          )}
        </strong>
        <span className="trace-status">{t(groupStatuses[item.status] ?? item.status)}</span>
        <time dateTime={item.at}>{localTime(item.at)}</time>
      </header>
      <div className="trace-facts">
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
        <p className="trace-models">
          {t("链路任务")}: {item.specIds.map((id) => t(taskLabels[id] ?? id)).join(" · ")}
        </p>
      )}
      <p className="trace-models">
        {t("模型记录")}:{" "}
        {item.models.length
          ? item.models.map((model) => <code key={model}>{model}</code>)
          : t("尚未记录模型")}
      </p>
      {!compact && (
        <details>
          <summary>{t("请求与唤醒标识")}</summary>
          <dl className="trace-metadata">
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
