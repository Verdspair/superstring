import { Filter, Search, X } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  RuntimeChannelSchema,
  type RuntimeSpanFilters,
  RuntimeSpanStatusSchema,
  RuntimeStageSchema,
} from "../../../shared/contracts/runtime-observability";
import {
  type FilterDraft,
  filterDraft,
  parseFilterDraft,
} from "../../features/observability/trace-filters";
import { channelLabels, stageLabels, statusLabels } from "./labels";
import { ReadError } from "./presentation";
export function QueryToolbar({
  filters,
  onApply,
  conversationId,
}: {
  filters: RuntimeSpanFilters;
  onApply(filters: RuntimeSpanFilters): void;
  conversationId?: string;
}) {
  const { t } = useTranslation(),
    id = useId(),
    [draft, setDraft] = useState(() => filterDraft(filters)),
    [error, setError] = useState("");
  const update = (key: keyof FilterDraft, value: string) =>
    setDraft((previous) => ({
      ...previous,
      [key]: value,
    }));
  const apply = (value = draft) => {
    const result = parseFilterDraft({
      ...value,
      ...(conversationId
        ? {
            conversationId,
          }
        : {}),
    });
    if (!result.success) {
      setError(t("observability.invalidFiltersCheckValueLengthCorrelationIdsAndTimestamps"));
      return;
    }
    setError("");
    onApply(result.data);
    setDraft(filterDraft(result.data));
  };
  const remove = (key: keyof FilterDraft) => {
    const next = {
      ...filterDraft(filters),
      [key]: "",
    };
    apply(next);
  };
  const text = (key: keyof FilterDraft, label: string, time = false) => (
    <label className="grid gap-1.5 text-xs font-medium" htmlFor={`${id}-${key}`}>
      <span>{t(label)}</span>
      <Input
        id={`${id}-${key}`}
        value={draft[key]}
        type={time ? "datetime-local" : "text"}
        step={time ? "1" : undefined}
        onChange={(event) => update(key, event.target.value)}
      />
    </label>
  );
  const select = (
    key: "channel" | "stage" | "status",
    label: string,
    values: readonly string[],
    labels: Record<string, string>,
  ) => (
    <label className="grid gap-1.5 text-xs font-medium" htmlFor={`${id}-${key}`}>
      <span>{t(label)}</span>
      <NativeSelect
        id={`${id}-${key}`}
        value={draft[key]}
        className="w-full"
        onChange={(event) => update(key, event.target.value)}
      >
        <NativeSelectOption value="">{t("observability.all")}</NativeSelectOption>
        {values.map((value) => (
          <NativeSelectOption key={value} value={value}>
            {t(labels[value] ?? value)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </label>
  );
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search
            className="absolute left-3 top-2.5 size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            className="pl-9"
            aria-label={t("observability.searchRuntimeRecords")}
            placeholder={t("observability.reasonNameCorrelationIdOrMetadataKeyword")}
            value={draft.q}
            maxLength={200}
            onChange={(event) => update("q", event.target.value)}
          />
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" type="button">
              <Filter />
              {t("observability.addFilter")}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            className="max-h-[75dvh] w-[min(38rem,90vw)] gap-4 overflow-y-auto p-4"
            align="end"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {select(
                "channel",
                "observability.channel",
                RuntimeChannelSchema.options,
                channelLabels,
              )}
              {select("stage", "observability.stage", RuntimeStageSchema.options, stageLabels)}
              {select(
                "status",
                "observability.status",
                RuntimeSpanStatusSchema.options,
                statusLabels,
              )}
              {text("model", "observability.modelExactMatch")}
              {text("agentId", "observability.agentId")}
              {!conversationId && text("conversationId", "observability.conversationId")}
              {text("runId", "observability.runId")}
              {text("traceId", "observability.traceId")}
              {text("from", "observability.startTimeLocal", true)}
              {text("to", "observability.endTimeLocal", true)}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("observability.currentTimeZoneValue", {
                "0": Intl.DateTimeFormat().resolvedOptions().timeZone,
              })}
            </p>
            <div className="flex flex-wrap gap-2">
              {[
                [15, "observability.last15Minutes"],
                [60, "observability.lastHour"],
                [1440, "observability.last24Hours"],
              ].map(([minutes, label]) => (
                <Button
                  key={minutes}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const now = new Date();
                    apply({
                      ...draft,
                      from: new Date(now.getTime() - Number(minutes) * 60000).toISOString(),
                      to: now.toISOString(),
                    });
                  }}
                >
                  {t(String(label))}
                </Button>
              ))}
            </div>
            <Button type="button" onClick={() => apply()}>
              {t("observability.applyFilters")}
            </Button>
          </PopoverContent>
        </Popover>
        <Button type="submit">{t("observability.search")}</Button>
      </div>
      <fieldset
        className="flex flex-wrap items-center gap-2"
        aria-label={t("observability.appliedFilters")}
      >
        {(["", "started", "failed", "unknown"] as const).map((status) => (
          <Button
            key={status}
            size="sm"
            variant={(filters.status ?? "") === status ? "secondary" : "ghost"}
            type="button"
            aria-pressed={(filters.status ?? "") === status}
            onClick={() =>
              apply({
                ...filterDraft(filters),
                status,
              })
            }
          >
            {t(status ? statusLabels[status] : "observability.allActivity")}
          </Button>
        ))}
        {Object.entries(filters)
          .filter(
            ([key]) =>
              !["beforeId", "limit", ...(conversationId ? ["conversationId"] : [])].includes(key),
          )
          .map(([key, value]) => (
            <Badge key={key} variant="outline" className="max-w-full gap-1 py-1">
              <span className="max-w-52 truncate" title={String(value)}>
                {key}: {String(value)}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                aria-label={t("observability.removeFilterValue", {
                  "0": key,
                })}
                onClick={() => remove(key as keyof FilterDraft)}
              >
                <X />
              </Button>
            </Badge>
          ))}
        {!!Object.keys(filters).filter((key) => key !== "conversationId" || !conversationId)
          .length && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            onClick={() =>
              apply(
                filterDraft(
                  conversationId
                    ? {
                        conversationId,
                      }
                    : {},
                ),
              )
            }
          >
            {t("observability.clearFilters")}
          </Button>
        )}
      </fieldset>
      <ReadError error={error} />
      <p className="text-xs text-muted-foreground">
        {t("observability.searchAllRecordedRuntimeMetadataExcludingMessageAndPromptContents")}
      </p>
    </form>
  );
}
