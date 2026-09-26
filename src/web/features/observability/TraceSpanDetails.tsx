import type { RuntimeSpan } from "../../../shared/contracts/runtime-observability";
import { useI18n } from "../../i18n";
import { localTime } from "../../ui/local-time";
import { DeliveryDetails } from "../conversations/DeliveryDetails";
import { RunLink, StepContext } from "../runs/RunInspector";
import { detailLabels, reasonLabels } from "./labels";

export function TraceSpanDetails({
  item,
  onInspectRun,
}: {
  item: RuntimeSpan;
  onInspectRun?: (runId: string) => void;
}) {
  const t = useI18n();
  const ids = {
    "Trace ID": item.traceId,
    "Span ID": item.spanId,
    "父 Span ID": item.parentSpanId,
    "会话 ID": item.conversationId,
    "Agent ID": item.agentId,
    "Run ID": item.runId,
    "Wake ID": item.wakeId,
    "Output ID": item.outputId,
    来源序号: item.sourceSeq,
  };
  const stepId = typeof item.details.stepId === "string" ? item.details.stepId : null;
  return (
    <>
      {reasonLabels[item.code] && <p>{t(reasonLabels[item.code])}</p>}
      {item.status === "unknown" && (
        <p className="hint">{t("结果尚未确认，不等同于失败；请沿追踪链路核对后续结果。")}</p>
      )}
      <div className="trace-actions">
        {item.runId &&
          (onInspectRun ? (
            <button
              type="button"
              className="link-button"
              onClick={() => item.runId && onInspectRun(item.runId)}
            >
              {t("运行详情")}
            </button>
          ) : (
            <RunLink runId={item.runId} />
          ))}
        {item.channel === "onebot11" && item.outputId && (
          <DeliveryDetails key={`${item.outputId}:${item.status}`} outputId={item.outputId} />
        )}
      </div>
      {item.runId && stepId && item.stage === "model" && (
        <StepContext key={`${item.runId}:${stepId}`} context={{ runId: item.runId, stepId }} />
      )}
      <details>
        <summary>{t("关联与元数据")}</summary>
        <dl className="trace-metadata">
          <div>
            <dt>{t("操作名称")}</dt>
            <dd>
              <code>{item.name}</code>
            </dd>
          </div>
          <div>
            <dt>{t("原因代码")}</dt>
            <dd>
              <code>{item.code}</code>
            </dd>
          </div>
          {Object.entries(ids).map(
            ([key, value]) =>
              value !== null && (
                <div key={key}>
                  <dt>{t(key)}</dt>
                  <dd>
                    <code>{value}</code>
                  </dd>
                </div>
              ),
          )}
          {item.finishedAt && (
            <div>
              <dt>{t("完成时间")}</dt>
              <dd>
                <time dateTime={item.finishedAt}>{localTime(item.finishedAt)}</time>
              </dd>
            </div>
          )}
          {Object.entries(item.details).map(([key, value]) => (
            <div key={`detail:${key}`}>
              <dt>{t(detailLabels[key] ?? key)}</dt>
              <dd>{value === null ? "—" : String(value)}</dd>
            </div>
          ))}
        </dl>
      </details>
    </>
  );
}
