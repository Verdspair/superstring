import { ExternalLink } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Button } from "../../components/ui/button";
import { type ReadTask, startRead } from "../../services/read-task";
import { useForegroundRead } from "../../services/use-foreground-read";
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
  const [reading, setReading] = useState<{
    api: typeof api;
    model: string;
    capacity: number | null;
  } | null>(null);
  const task = useRef<ReadTask | null>(null);
  const generation = useRef(0);
  const cancel = useCallback(() => {
    generation.current++;
    task.current?.cancel();
    task.current = null;
  }, []);
  const load = useCallback(() => {
    if (
      !model ||
      controlledCapacity !== undefined ||
      useSuperstringStore.getState().apiClient !== api
    )
      return;
    const request = ++generation.current;
    const matches = () =>
      request === generation.current && useSuperstringStore.getState().apiClient === api;
    task.current = startRead((signal) => api.getModelCapacity(model, signal), {
      success: (value) => {
        if (matches()) setReading({ api, model, capacity: value.context_length });
      },
      failure: () => {
        if (matches()) setReading({ api, model, capacity: null });
      },
      settled: () => {
        if (matches()) task.current = null;
      },
    });
  }, [api, model, controlledCapacity]);
  useForegroundRead(load, cancel, {
    enabled: !!model && controlledCapacity === undefined,
    paused: !active,
    intervalMs: null,
    retainOnHide: true,
    onSuspend: cancel,
  });
  const capacity =
    controlledCapacity !== undefined
      ? controlledCapacity
      : reading !== null && reading.api === api && reading.model === model
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
