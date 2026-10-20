import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { useSuperstringStore } from "../../store";

export function AllocationModelCapacity({
  model,
  active = true,
  capacity: controlledCapacity,
}: {
  model: string | null | undefined;
  active?: boolean;
  capacity?: number | null;
}) {
  const { t } = useTranslation();
  const api = useSuperstringStore((s) => s.apiClient);
  const navigate = useSuperstringStore((s) => s.requestContextAllocation);
  const target = useSuperstringStore((s) => s.contextAllocationTarget);
  const [reading, setReading] = useState<{ model: string; capacity: number | null } | null>(null);
  useEffect(() => {
    if (!active || !model || controlledCapacity !== undefined) return;
    let current = true;
    void api
      .getModelCapacity(model)
      .then((value) => {
        if (current) setReading({ model, capacity: value.context_length });
      })
      .catch(() => {
        if (current) setReading({ model, capacity: null });
      });
    return () => {
      current = false;
    };
  }, [active, api, model, controlledCapacity]);
  const capacity =
    controlledCapacity !== undefined
      ? controlledCapacity
      : reading !== null && reading.model === model
        ? reading.capacity
        : null;
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-medium text-foreground break-all">
          {model || t("schemes.allocation.section.unknown")}
        </span>
        <span className="text-muted-foreground/60">•</span>
        <span>
          {t("schemes.allocation.modelTotalCapacity")}:{" "}
          {capacity === null ? t("schemes.allocation.section.unknown") : `${capacity} Tokens`}
        </span>
      </div>
      <Button
        tooltip={<Trans i18nKey="hints.complete.modelJump" />}
        variant="ghost"
        size="sm"
        disabled={!model}
        onClick={() => navigate({ ...target, capacityModel: model }, "external-api")}
        className="min-h-8 h-auto px-2 text-xs text-foreground/80 hover:text-foreground inline-flex items-center gap-1"
      >
        {t("schemes.allocation.modelJump")}
        <ExternalLink className="size-3.5" />
      </Button>
    </div>
  );
}
