import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ConversationRuntimeStatus } from "../../../shared/contracts/runtime-observability";
import { translateNotice, useI18n } from "../../i18n";
import { type ReadTask, startRead } from "../../services/read-task";
import { useForegroundRead } from "../../services/use-foreground-read";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
import { localTime } from "../../ui/local-time";

const phases: Record<string, string> = {
  idle: "连接未启动",
  connecting: "正在连接",
  verifying: "正在验证连接",
  ready: "连接已就绪",
  closed: "连接已断开",
  unavailable: "连接状态不可用",
  unknown: "连接状态未知",
};
export function ConversationRuntimeSummary({ conversationId }: { conversationId: string }) {
  const t = useI18n();
  const api = useSuperstringStore((state) => state.apiClient);
  const [status, setStatus] = useState<ConversationRuntimeStatus | null>(null);
  const [error, setError] = useState("");
  const pending = useRef<ReadTask | null>(null);
  const clear = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
    setStatus(null);
    setError("");
  }, []);
  const load = useCallback(() => {
    if (pending.current) return;
    pending.current = startRead(
      (signal) => api.getConversationRuntimeStatus(conversationId, signal),
      {
        success: (next) => {
          setStatus(next);
          setError("");
        },
        failure: (reason) => {
          setStatus(null);
          setError(errorText(reason));
        },
        settled: () => {
          pending.current = null;
        },
      },
    );
  }, [api, conversationId]);
  useForegroundRead(load, clear);
  return (
    <section
      className="conversation-runtime-summary rounded-lg border bg-card p-3 text-card-foreground [&_summary]:flex [&_summary]:cursor-pointer [&_summary]:flex-wrap [&_summary]:items-center [&_summary]:gap-3 [&_summary]:text-sm [&_dl]:mt-3"
      aria-label={t("当前处理状态")}
    >
      {error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {t("当前状态读取失败")}: {translateNotice(error)}{" "}
          <Button variant="outline" size="sm" type="button" onClick={load}>
            {t("刷新处理状态")}
          </Button>
        </p>
      ) : !status ? (
        <span className="text-sm leading-relaxed text-muted-foreground">
          {t("正在读取处理状态…")}
        </span>
      ) : (
        <details>
          <summary>
            <strong>{t(phases[status.connectionPhase] ?? status.connectionPhase)}</strong>
            <span>{t("进行中 {0} · 排队 {1}", status.activeRuns, status.pendingWakes)}</span>
            {status.connectionPhase === "ready" &&
              status.activeRuns === 0 &&
              status.pendingWakes > 0 &&
              status.nextReadyAt && (
                <span title={localTime(status.nextReadyAt)}>
                  {t(
                    new Date(status.nextReadyAt) > new Date(status.now)
                      ? "等待处理窗口"
                      : "等待调度",
                  )}
                </span>
              )}
            {status.unknownDeliveries > 0 && (
              <span>{t("待确认投递 {0}", status.unknownDeliveries)}</span>
            )}
          </summary>
          <dl className="trace-metadata grid gap-3 text-sm [&>div]:grid [&>div]:gap-1 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:min-w-0 [&_dd]:break-words [&_code]:break-all [&_code]:text-xs">
            <div>
              <dt>{t("处理失败的唤醒")}</dt>
              <dd>{status.failedWakes}</dd>
            </div>
            <div>
              <dt>{t("结果待确认的投递")}</dt>
              <dd>{status.unknownDeliveries}</dd>
            </div>
            {status.nextReadyAt && (
              <div>
                <dt>
                  {t(
                    new Date(status.nextReadyAt) > new Date(status.now)
                      ? "等待窗口至"
                      : "最早待处理时间",
                  )}
                </dt>
                <dd>
                  <time dateTime={status.nextReadyAt}>{localTime(status.nextReadyAt)}</time>
                </dd>
              </div>
            )}
            {status.lastActivityAt && (
              <div>
                <dt>{t("最近活动")}</dt>
                <dd>
                  <time dateTime={status.lastActivityAt}>{localTime(status.lastActivityAt)}</time>
                </dd>
              </div>
            )}
            <div>
              <dt>{t("状态采样时间")}</dt>
              <dd>
                <time dateTime={status.now}>{localTime(status.now)}</time>
              </dd>
            </div>
          </dl>
        </details>
      )}
    </section>
  );
}
