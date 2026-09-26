import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { MemoryScopeView } from "../../../shared/contracts";
import { translateNotice, useI18n } from "../../i18n";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
import { SettingsGroup } from "../../ui/Accordion";
import { Field } from "../../ui/Field";
import { localTime } from "../../ui/local-time";
import { JobRunLink } from "../runs/RunInspector";
import { QqMemoryControls } from "./QqMemoryControls";
import { memoryScopeLabel } from "./scope-label";

export function MemoryScopePanel({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (key: string) => void;
  disabled: boolean;
}) {
  const t = useI18n();
  const api = useSuperstringStore((s) => s.apiClient);
  const agentId = useSuperstringStore((s) => s.editorAgentId);
  const policy = useSuperstringStore((s) => s.pageEditor?.policy ?? s.policy);
  const [scopes, setScopes] = useState<MemoryScopeView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (agentId === "__new__") return;
    const ticket = ++request.current;
    setLoading(true);
    setError("");
    try {
      const result = await api.listMemoryScopes(agentId);
      if (ticket === request.current) setScopes(result);
    } catch (reason) {
      if (ticket === request.current) setError(errorText(reason));
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }, [api, agentId]);
  useEffect(() => {
    void refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh]);
  const waiting = scopes.some(
    (scope) => scope.latest_job && ["queued", "running"].includes(scope.latest_job.status),
  );
  useEffect(() => {
    if (!waiting || dirty || loading || error) return;
    const timer = setTimeout(() => void refresh(), 2000);
    return () => clearTimeout(timer);
  }, [waiting, dirty, loading, error, refresh]);
  const current = scopes.find((scope) => scope.scope_key === value);
  const label = (key: string) => memoryScopeLabel(key, agentId, t);
  const latest = current?.latest_job;
  const jobStatus = {
    queued: "排队中",
    running: "整理中",
    succeeded: "整理成功",
    failed: "整理失败",
  } as const;
  return (
    <SettingsGroup
      id="settings-memory-scopes"
      title="记忆分区与整理状态"
      note="选择分区只筛选管理内容，不修改聊天的读取权限；不同助手的记忆不互通。"
    >
      <div className="memory-scope-toolbar flex flex-wrap items-end gap-3 [&>.field]:min-w-0 [&>.field]:flex-1">
        <Field label="记忆分区">
          <NativeSelect
            className="w-full"
            aria-label={t("记忆分区")}
            value={value}
            disabled={disabled || dirty || loading}
            onChange={(event) => onChange(event.target.value)}
          >
            <option value="">{t("全部分区（统一管理）")}</option>
            {scopes.map((scope) => (
              <option key={scope.scope_key} value={scope.scope_key}>
                {label(scope.scope_key)} · {scope.count}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Button
          variant="outline"
          type="button"
          disabled={disabled || dirty || loading}
          onClick={() => void refresh()}
        >
          {t("刷新分区与任务状态")}
        </Button>
      </div>
      {loading && (
        <p className="hint text-sm leading-relaxed text-muted-foreground" role="status">
          {t("正在读取记忆分区…")}
        </p>
      )}
      {error && (
        <p className="error text-sm text-destructive" role="alert">
          {translateNotice(error)}
        </p>
      )}
      {!value && (
        <p className="hint text-sm leading-relaxed text-muted-foreground">
          {t("此处能管理全部分区，不代表群聊能读取全部记忆；请选择分区查看读写范围与整理状态。")}
        </p>
      )}
      {current && (
        <>
          <p className="hint text-sm leading-relaxed text-muted-foreground">
            {t("共 {0} 条，其中 {1} 条处于生效状态。", current.count, current.active_count)}
          </p>
          <div className="memory-scope-facts grid gap-3 rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground sm:grid-cols-2 [&>p]:m-0">
            <p>
              {t(
                "聊天可读取：{0}",
                current.read_scope_keys === null
                  ? t("当前助手的全部记忆分区")
                  : current.read_scope_keys.length
                    ? current.read_scope_keys.map(label).join(" · ")
                    : t("当前无可用的 QQ 读取授权"),
              )}
            </p>
            <p>{t("新整理结果存入：{0}", label(current.write_scope_key))}</p>
          </div>
          <p className="hint text-sm leading-relaxed text-muted-foreground">
            {t(
              "读取范围不等于每次全部注入；网页与 QQ 回复使用下方的读取配置，QQ 开口判断使用轻量读取。",
            )}
          </p>
          {current.binding ? (
            <QqMemoryControls
              key={current.binding.id}
              binding={current.binding}
              pending={current.pending ?? 0}
              disabled={disabled}
              onChanged={() => void refresh()}
              onDirty={setDirty}
            />
          ) : value === agentId ? (
            <p className="hint text-sm leading-relaxed text-muted-foreground">
              {policy
                ? t(
                    policy.auto_enabled
                      ? "网页自动整理已开启：每 {0} 个完整轮次触发。"
                      : "网页自动整理已关闭；仍可手动整理。",
                    policy.every_turns,
                  )
                : t("正在读取网页整理策略…")}{" "}
              <a href="#settings-policy">{t("调整网页自动整理")}</a>
            </p>
          ) : (
            <p className="hint text-sm leading-relaxed text-muted-foreground">
              {t("此分区未绑定当前助手，保留历史记忆供管理，不会自动整理新消息。")}
            </p>
          )}
          <p className="hint text-sm leading-relaxed text-muted-foreground" role="status">
            {latest
              ? t(
                  "最近整理：{0} · {1}",
                  t(jobStatus[latest.status]),
                  localTime(latest.finished_at ?? latest.created_at),
                )
              : t("此分区还没有整理记录。")}
          </p>
          {latest && <JobRunLink ownerKind="memory_job" ownerId={latest.id} />}
          {latest?.status === "succeeded" && !latest.result_id && (
            <p className="hint text-sm leading-relaxed text-muted-foreground">
              {t("本次整理完成，但没有需要长期保留的新信息。")}
            </p>
          )}
          {latest?.error_code && (
            <p className="error text-sm text-destructive">
              {t("整理失败原因：{0}", latest.error_code)}
            </p>
          )}
        </>
      )}
    </SettingsGroup>
  );
}
