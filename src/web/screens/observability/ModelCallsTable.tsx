import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RuntimeSpan } from "../../../shared/contracts/runtime-observability";
import { taskLabels } from "./labels";
import { milliseconds, phaseLabels, StatusMark } from "./presentation";
export function ModelCallsTable({
  items,
  selected,
  onSelect,
}: {
  items: RuntimeSpan[];
  selected: string | null;
  onSelect(span: RuntimeSpan): void;
}) {
  const { t } = useTranslation(),
    calls = items.filter((item) => item.stage === "model").sort((a, b) => a.id - b.id);
  return (
    <Table aria-label={t("observability.modelInvocation")}>
      <TableHeader>
        <TableRow>
          <TableHead>{t("observability.task")}</TableHead>
          <TableHead>{t("observability.runPhase")}</TableHead>
          <TableHead>{t("observability.model")}</TableHead>
          <TableHead>{t("observability.status")}</TableHead>
          <TableHead>{t("observability.duration")}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {calls.map((item) => (
          <TableRow
            key={item.spanId}
            data-state={selected === item.spanId ? "selected" : undefined}
          >
            <TableCell>
              {t(
                taskLabels[String(item.details.specId)] ?? String(item.details.specId ?? item.name),
              )}
            </TableCell>
            <TableCell>
              {t(phaseLabels[String(item.details.phase)] ?? String(item.details.phase ?? "—"))}
            </TableCell>
            <TableCell className="max-w-64 whitespace-normal break-words">
              <p className="font-mono text-xs">{item.model ?? "—"}</p>
              <p className="text-xs text-muted-foreground">
                {t(
                  item.details.modelResolved === true
                    ? "observability.actualRequestedModel"
                    : item.details.modelResolved === false
                      ? "observability.requestedModel"
                      : "observability.recordedModelUnverified",
                )}
              </p>
            </TableCell>
            <TableCell>
              <StatusMark status={item.status} />
            </TableCell>
            <TableCell>{item.durationMs === null ? "—" : milliseconds(item.durationMs)}</TableCell>
            <TableCell>
              <Button size="sm" variant="outline" onClick={() => onSelect(item)}>
                {t("observability.inspectCall")}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
