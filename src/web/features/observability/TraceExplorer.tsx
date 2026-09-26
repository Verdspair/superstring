import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  RuntimeChannelSchema,
  type RuntimeSpanFilters,
  RuntimeSpanStatusSchema,
  RuntimeStageSchema,
} from "../../../shared/contracts/runtime-observability";
import { useI18n } from "../../i18n";
import { channelLabels, stageLabels, statusLabels } from "./labels";
import { TraceGroups } from "./TraceGroups";
import { filterDraft, parseFilterDraft, readFilterUrl, writeFilterUrl } from "./trace-filters";

export function TraceExplorer({ conversationId }: { conversationId?: string }) {
  const t = useI18n();
  const formId = useId();
  const [applied, setApplied] = useState<RuntimeSpanFilters>(() =>
    conversationId ? { conversationId } : readFilterUrl(),
  );
  const [draft, setDraft] = useState(() => filterDraft(applied));
  const [error, setError] = useState("");
  const update = (key: keyof typeof draft, value: string) =>
    setDraft((old) => ({ ...old, [key]: value }));
  const apply = (next: RuntimeSpanFilters) => {
    setApplied(next);
    setDraft(filterDraft(next));
    setError("");
    if (!conversationId) writeFilterUrl(next);
  };
  const field = (key: keyof typeof draft, label: string, placeholder?: string) => (
    <label key={key} htmlFor={`${formId}-${key}`}>
      <span>{t(label)}</span>
      <Input
        id={`${formId}-${key}`}
        value={draft[key]}
        maxLength={200}
        placeholder={placeholder}
        onChange={(event) => update(key, event.target.value)}
      />
    </label>
  );
  const timeField = (key: "from" | "to", label: string) => (
    <label htmlFor={`${formId}-${key}`}>
      <span>{t(label)}</span>
      <Input
        id={`${formId}-${key}`}
        type="datetime-local"
        step="1"
        value={draft[key]}
        onChange={(event) => update(key, event.target.value)}
      />
    </label>
  );
  const applyDraft = (override: Partial<typeof draft> = {}) => {
    const parsed = parseFilterDraft({
      ...draft,
      ...override,
      ...(conversationId ? { conversationId } : {}),
    });
    if (!parsed.success) {
      setError(t("筛选值无效，请检查长度、关联 ID 或时间。"));
      return;
    }
    if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
      setError(t("开始时间不能晚于结束时间。"));
      return;
    }
    apply(parsed.data);
  };
  const select = (
    key: "channel" | "stage" | "status",
    label: string,
    values: readonly string[],
    labels: Record<string, string>,
  ) => (
    <label htmlFor={`${formId}-${key}`}>
      <span>{t(label)}</span>
      <NativeSelect
        id={`${formId}-${key}`}
        className="w-full"
        aria-label={t(label)}
        value={draft[key]}
        onChange={(event) => update(key, event.target.value)}
      >
        <NativeSelectOption value="">{t("全部")}</NativeSelectOption>
        {values.map((value) => (
          <NativeSelectOption key={value} value={value}>
            {t(labels[value] ?? value)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </label>
  );
  return (
    <div className="trace-explorer flex min-w-0 flex-col gap-4">
      <form
        className="trace-filter-form flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 text-card-foreground"
        onSubmit={(event) => {
          event.preventDefault();
          applyDraft();
        }}
      >
        <div className="trace-filter-main grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 [&_label]:grid [&_label]:min-w-0 [&_label]:gap-1.5 [&_label]:text-xs [&_label]:font-medium">
          {field("q", "搜索运行记录", t("原因、名称、关联 ID 或元数据关键词"))}
          {select("channel", "来源通道", RuntimeChannelSchema.options, channelLabels)}
          {select("stage", "处理阶段", RuntimeStageSchema.options, stageLabels)}
          {select("status", "处理状态", RuntimeSpanStatusSchema.options, statusLabels)}
        </div>
        <details className="trace-advanced space-y-3 [&>summary]:cursor-pointer [&>summary]:text-sm [&>summary]:font-medium">
          <summary>{t("模型、时间与关联筛选")}</summary>
          <div className="trace-filter-main grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4 [&_label]:grid [&_label]:min-w-0 [&_label]:gap-1.5 [&_label]:text-xs [&_label]:font-medium">
            {field("model", "模型（精确匹配）")}
            {!conversationId && field("conversationId", "会话 ID", "UUID")}
            {field("agentId", "Agent ID", "UUID")}
            {field("runId", "Run ID", "UUID")}
            {field("traceId", "Trace ID", "32 hex")}
            {timeField("from", "开始时间（本地）")}
            {timeField("to", "结束时间（本地）")}
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("当前时区：{0}", Intl.DateTimeFormat().resolvedOptions().timeZone)}
          </p>
          <div className="trace-actions flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {[
              [15, "最近 15 分钟"],
              [60, "最近 1 小时"],
              [1440, "最近 24 小时"],
            ].map(([minutes, label]) => (
              <Button
                variant="outline"
                size="sm"
                key={minutes}
                type="button"
                onClick={() => {
                  const now = new Date();
                  applyDraft({
                    from: new Date(now.getTime() - Number(minutes) * 60000).toISOString(),
                    to: now.toISOString(),
                  });
                }}
              >
                {t(String(label))}
              </Button>
            ))}
          </div>
        </details>
        <div className="trace-actions flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Button type="submit" size="sm">
            {t("应用筛选")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            type="button"
            onClick={() => apply(conversationId ? { conversationId } : {})}
          >
            {t("清除筛选")}
          </Button>
          <small>{t("搜索全部已记录的运行元数据，不搜索消息或提示词正文。")}</small>
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
      </form>
      <TraceGroups filters={applied} />
    </div>
  );
}
