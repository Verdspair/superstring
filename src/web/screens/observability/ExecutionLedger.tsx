import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table";
import { ArrowUpRight, Columns3 } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RuntimeTrace } from "../../../shared/contracts/runtime-observability";
import { formatDate } from "../../i18n/runtime";
import { channelLabels } from "./labels";
import { milliseconds, StatusMark, traceCause, traceTask } from "./presentation";

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, RuntimeTrace>();
export function ExecutionLedger({
  items,
  selected,
  onCompareSelect,
  onInvestigate,
}: {
  items: RuntimeTrace[];
  selected: string[];
  onCompareSelect(id: string): void;
  onInvestigate(id: string, trigger: HTMLButtonElement): void;
}) {
  const { t, i18n } = useTranslation(),
    columnId = useId(),
    [models, setModels] = useState(true),
    [counts, setCounts] = useState(true);
  const columns = useMemo(
    () =>
      helper.columns([
        helper.display({
          id: "choose",
          header: () => <span className="sr-only">{t("observability.selectForComparison")}</span>,
          cell: ({ row }) => (
            <Checkbox
              aria-label={t("observability.compareValue", {
                "0": row.original.traceId,
              })}
              checked={selected.includes(row.original.traceId)}
              disabled={selected.length === 2 && !selected.includes(row.original.traceId)}
              onCheckedChange={() => onCompareSelect(row.original.traceId)}
            />
          ),
        }),
        helper.accessor("at", {
          header: t("observability.started"),
          cell: ({ row }) => (
            <time className="text-xs tabular-nums text-muted-foreground" dateTime={row.original.at}>
              {formatDate(row.original.at, i18n.language, {
                dateStyle: "medium",
                timeStyle: "medium",
              })}
            </time>
          ),
        }),
        helper.display({
          id: "task",
          header: t("observability.taskAndTrigger"),
          cell: ({ row }) => (
            <div className="max-w-sm space-y-1">
              <Button
                variant="link"
                data-trace-action={row.original.traceId}
                className="h-auto justify-start gap-2 whitespace-normal p-0 text-left"
                onClick={(event) => onInvestigate(row.original.traceId, event.currentTarget)}
              >
                {traceTask(row.original, t)}
                <ArrowUpRight className="size-3.5 shrink-0" />
              </Button>
              <div className="text-xs text-muted-foreground">
                {traceCause(row.original, t) || t("observability.triggerNotRecorded")}
              </div>
            </div>
          ),
        }),
        helper.display({
          id: "channel",
          header: t("observability.channel"),
          cell: ({ row }) => (
            <span className="text-xs">
              {row.original.channels.map((channel) => t(channelLabels[channel])).join(" / ")}
            </span>
          ),
        }),
        helper.accessor("status", {
          header: t("observability.status"),
          cell: ({ row }) => <StatusMark status={row.original.status} />,
        }),
        helper.accessor("durationMs", {
          header: t("observability.duration"),
          cell: ({ row }) => (
            <span className="font-mono text-xs">{milliseconds(row.original.durationMs)}</span>
          ),
        }),
        ...(models
          ? [
              helper.display({
                id: "models",
                header: t("observability.recordedModels"),
                cell: ({ row }) => (
                  <span className="block max-w-48 whitespace-normal break-words font-mono text-xs">
                    {row.original.models.join(" · ") || "—"}
                  </span>
                ),
              }),
            ]
          : []),
        ...(counts
          ? [
              helper.display({
                id: "counts",
                header: t("observability.matchesSteps"),
                cell: ({ row }) => (
                  <span className="text-xs tabular-nums">
                    {row.original.matchedSpanCount} / {row.original.spanCount}
                  </span>
                ),
              }),
            ]
          : []),
      ]),
    [t, selected, onCompareSelect, onInvestigate, models, counts, i18n.language],
  );
  const table = useTable({
    features,
    data: items,
    columns,
    getRowId: (row) => row.traceId,
  });
  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost">
              <Columns3 />
              {t("observability.columns")}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-48">
            {[
              [models, setModels, "observability.recordedModels"],
              [counts, setCounts, "observability.matchesSteps"],
            ].map(([value, setter, label]) => (
              <label
                htmlFor={`${columnId}-${String(label)}`}
                key={String(label)}
                className="flex items-center gap-2 p-1 text-sm"
              >
                <Checkbox
                  id={`${columnId}-${String(label)}`}
                  checked={value as boolean}
                  onCheckedChange={(checked) =>
                    (setter as (value: boolean) => void)(checked === true)
                  }
                />
                {t(String(label))}
              </label>
            ))}
          </PopoverContent>
        </Popover>
      </div>
      <div className="overflow-hidden rounded-xl border">
        <Table aria-label={t("observability.executions")}>
          <TableHeader className="bg-muted/30">
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                data-state={selected.includes(row.id) ? "selected" : undefined}
              >
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id} className="py-4">
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
