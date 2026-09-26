import { type CSSProperties, useMemo, useState } from "react";
import type { RuntimeTraceDetail } from "../../../shared/contracts/runtime-observability";
import { useI18n } from "../../i18n";
import { operationLabels, stageLabels, statusLabels, taskLabels } from "./labels";
import { TraceSpanDetails } from "./TraceSpanDetails";
import { type WaterfallNode, waterfallLayout } from "./waterfall-layout";

const phaseLabels: Record<string, string> = {
  next: "行动判断",
  generate: "生成回复",
  leaf: "单轮任务",
  vision: "图片理解",
};
export function TraceWaterfall({ data }: { data: RuntimeTraceDetail }) {
  const t = useI18n();
  const layout = useMemo(() => waterfallLayout(data.items, data.now), [data.items, data.now]);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [expanded, setExpanded] = useState(new Set<string>());
  const matching = new Set(data.matchedSpanIds);
  const toggle = (id: string, kind: "branch" | "detail") => {
    const setter = kind === "branch" ? setCollapsed : setExpanded;
    setter((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const node = (item: WaterfallNode, depth: number) => {
    const span = item.span,
      interval = layout.interval(span),
      hidden = collapsed.has(span.spanId);
    const title = operationLabels[span.name] ?? span.name;
    const task = span.details.specId ?? span.details.action ?? span.details.name;
    const phase =
      typeof span.details.phase === "string"
        ? (phaseLabels[span.details.phase] ?? span.details.phase)
        : null;
    const resolved = span.details.modelResolved === true;
    const fallback =
      resolved &&
      typeof span.details.requestedModel === "string" &&
      span.model &&
      span.details.requestedModel !== span.model;
    const childrenId = `waterfall-children-${span.spanId}`;
    return (
      <li
        key={span.spanId}
        id={`trace-span-${span.spanId}`}
        className="waterfall-node"
        data-status={span.status}
      >
        <div
          className="waterfall-row"
          style={{ "--waterfall-depth": Math.min(depth, 8) } as CSSProperties}
        >
          <div className="waterfall-label">
            {item.children.length > 0 && (
              <button
                type="button"
                className="waterfall-branch"
                aria-expanded={!hidden}
                aria-controls={childrenId}
                aria-label={t(hidden ? "展开 {0} 的子步骤" : "折叠 {0} 的子步骤", t(title))}
                onClick={() => toggle(span.spanId, "branch")}
              >
                {hidden ? "▸" : "▾"}
              </button>
            )}
            <div>
              <strong>{t(title)}</strong>
              <span className="trace-status">{t(statusLabels[span.status])}</span>
              <small>
                {t(stageLabels[span.stage])}
                {phase && <> · {t(phase)}</>}
                {task && <> · {t(taskLabels[String(task)] ?? String(task))}</>}
              </small>
              {typeof span.details.attempt === "number" && (
                <small>{t("尝试 #{0}", span.details.attempt)}</small>
              )}
              {span.stage === "run" && span.runId && (
                <small>
                  Run <code title={span.runId}>{span.runId.slice(0, 8)}</code>
                </small>
              )}
              {span.model && (
                <small>
                  {t(
                    resolved
                      ? "实际请求模型"
                      : span.details.modelResolved === false
                        ? "请求模型"
                        : "记录模型（未验证）",
                  )}
                  : <code>{span.model}</code>
                </small>
              )}
              {fallback && (
                <small>
                  {t("已使用替补模型；请求模型：{0}", String(span.details.requestedModel))}
                </small>
              )}
              {matching.has(span.spanId) && data.matchedSpanIds.length !== data.items.length && (
                <small className="waterfall-match">{t("命中筛选")}</small>
              )}
              {item.missingParent && (
                <small>
                  {t("父步骤未保留或不可访问")}: <code>{span.parentSpanId}</code>
                </small>
              )}
            </div>
          </div>
          <div className="waterfall-timing">
            <div className="waterfall-track" aria-hidden="true">
              <span
                className="waterfall-bar"
                data-running={span.status === "started"}
                style={{ left: `${interval.left}%`, width: `${interval.width}%` }}
              />
            </div>
            <small>
              {t(
                "起点 +{0} ms · 耗时 {1} ms",
                Math.round(interval.offsetMs),
                Math.round(interval.durationMs),
              )}
            </small>
          </div>
        </div>
        <div className="waterfall-details">
          <button
            type="button"
            className="link-button"
            aria-expanded={expanded.has(span.spanId)}
            aria-controls={`waterfall-detail-${span.spanId}`}
            onClick={() => toggle(span.spanId, "detail")}
          >
            {t(
              expanded.has(span.spanId)
                ? "收起步骤详情"
                : span.stage === "model"
                  ? "查看输入、输出与详情"
                  : "查看步骤详情",
            )}
          </button>
          {expanded.has(span.spanId) && (
            <section
              id={`waterfall-detail-${span.spanId}`}
              aria-label={t("步骤详情：{0}", t(title))}
            >
              <TraceSpanDetails item={span} />
            </section>
          )}
        </div>
        {!!item.children.length && (
          <ol id={childrenId} hidden={hidden}>
            {item.children.map((child) => node(child, depth + 1))}
          </ol>
        )}
      </li>
    );
  };
  return (
    <section className="trace-waterfall" aria-label={t("父子时序图")}>
      <div className="waterfall-ruler">
        <span>{t("任务与实际模型")}</span>
        <div>
          <span>0 ms</span>
          <span>{Math.round(layout.duration / 2)} ms</span>
          <span>{Math.round(layout.duration)} ms</span>
        </div>
      </div>
      <ol>{layout.roots.map((item) => node(item, 0))}</ol>
    </section>
  );
}
