import { Activity, ArrowUpRight, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useLiveResource } from "../../services/use-live-resource";
import { useSuperstringStore } from "../../store";
import { InvestigationCanvas } from "../observability/InvestigationCanvas";
import { StatusMark, traceCause, traceTask } from "../observability/presentation";

export function ConversationActiveTraces({
  conversationId,
  active = true,
}: {
  conversationId: string;
  active?: boolean;
}) {
  const { t } = useTranslation();
  const api = useSuperstringStore((s) => s.apiClient);
  const requestConversationView = useSuperstringStore((s) => s.requestConversationView);
  const [inspectTraceId, setInspectTraceId] = useState<string | null>(null);
  const descriptionId = useId();

  const prevScope = useRef({ api, conversationId });
  useEffect(() => {
    if (prevScope.current.api !== api || prevScope.current.conversationId !== conversationId) {
      prevScope.current = { api, conversationId };
      setInspectTraceId(null);
    }
  }, [api, conversationId]);

  const read = useCallback(
    async (signal: AbortSignal) => {
      const page = await api.listRuntimeTraces(
        {
          conversationId,
          status: "started",
          limit: 50,
        },
        signal,
      );
      return { api, conversationId, page };
    },
    [api, conversationId],
  );

  const { data } = useLiveResource(read, {
    enabled: active && Boolean(conversationId),
    paused: !active,
    conversationScope: { conversationId },
  });

  const isCurrentScope = data && data.api === api && data.conversationId === conversationId;
  const traces = isCurrentScope ? data.page.items : [];
  const hasMore = Boolean(isCurrentScope && data.page.hasMore);

  return (
    <>
      {traces.length > 0 && (
        <aside
          aria-label={t("observability.currentProcessingState")}
          className="flex min-w-0 flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs md:px-7"
        >
          <span className="flex items-center gap-1.5 font-medium text-muted-foreground shrink-0">
            <Activity className="size-3.5 text-primary" />
            <span>{t("observability.currentProcessingState")}</span>
            <Badge variant="secondary" className="h-4 px-1 text-[0.65rem]">
              {traces.length}
              {hasMore ? "+" : ""}
            </Badge>
          </span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {traces.map((trace) => {
              const taskLabel = traceTask(trace, t);
              const causeLabel = traceCause(trace, t);
              const title = taskLabel || causeLabel || trace.traceId.slice(0, 8);
              return (
                <Button
                  key={trace.traceId}
                  variant="outline"
                  size="sm"
                  className="h-6 gap-1.5 px-2 text-xs"
                  onClick={() => setInspectTraceId(trace.traceId)}
                >
                  <StatusMark status={trace.status} />
                  <span className="max-w-44 truncate">{title}</span>
                  <span className="font-mono text-[0.65rem] text-muted-foreground">
                    {trace.spanCount}
                  </span>
                  <ChevronRight className="size-3 opacity-60" />
                </Button>
              );
            })}
            {hasMore && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
                onClick={() => requestConversationView("activity", "current")}
              >
                <span>{t("observability.allActivity")}</span>
                <ArrowUpRight className="size-3" />
              </Button>
            )}
          </div>
        </aside>
      )}

      <Dialog
        open={Boolean(inspectTraceId)}
        onOpenChange={(open) => {
          if (!open) setInspectTraceId(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="gap-4 sm:max-w-6xl"
          aria-describedby={descriptionId}
        >
          <header className="flex items-start justify-between gap-4 border-b pb-3">
            <div className="space-y-1">
              <DialogTitle>{t("observability.traceDetails")}</DialogTitle>
              <DialogDescription id={descriptionId}>{inspectTraceId}</DialogDescription>
            </div>
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                <X className="size-4" />
                {t("observability.close")}
              </Button>
            </DialogClose>
          </header>
          <ScrollArea className="h-[75dvh] pr-3 [&_[data-radix-scroll-area-viewport]>div]:block!">
            {inspectTraceId && (
              <InvestigationCanvas
                key={inspectTraceId}
                traceId={inspectTraceId}
                filters={{ conversationId }}
                paused={!active}
                onBack={() => setInspectTraceId(null)}
              />
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
