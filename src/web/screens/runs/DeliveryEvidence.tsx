import { CheckCheck, PackageOpen, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ConversationSummary } from "../../../shared/contracts/conversation";
import { formatDate } from "../../i18n/runtime";
import { useLiveResource } from "../../services/use-live-resource";
import { useSuperstringStore } from "../../store";
import { ReadError } from "../observability/presentation";
export const deliveryLabels = {
  planned: "observability.waitingToSend",
  delivering: "observability.delivering",
  sending: "observability.delivering",
  confirmed: "observability.delivered",
  failed: "observability.deliveryFailed",
  unknown: "observability.deliveryOutcomeUnconfirmed",
  stale: "observability.replyExpired",
  not_sent: "observability.notSent",
};
export function DeliveryDetails({
  outputId,
  conversation,
}: {
  outputId: string;
  conversation?: Pick<ConversationSummary, "participants">;
}) {
  const { t } = useTranslation(),
    [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="min-w-0 rounded-lg border">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" className="w-full justify-start">
          <PackageOpen />
          {t("observability.deliveryDetails")}
          <span className="ml-auto max-w-28 truncate font-mono text-xs text-muted-foreground">
            {outputId}
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {open && <DeliveryEvidence outputId={outputId} conversation={conversation} />}
      </CollapsibleContent>
    </Collapsible>
  );
}
export function DeliveryEvidence({
  outputId,
  conversation,
}: {
  outputId: string;
  conversation?: Pick<ConversationSummary, "participants">;
}) {
  const { t, i18n } = useTranslation(),
    api = useSuperstringStore((s) => s.apiClient);
  const read = useCallback(
    (signal: AbortSignal) => api.getDelivery(outputId, signal),
    [api, outputId],
  );
  const { data, error, loading, refresh } = useLiveResource(read);
  const partial =
    data?.parts.some((part) => part.status === "confirmed") &&
    data.parts.some((part) => part.status !== "confirmed");
  return (
    <section aria-label={t("observability.deliveryResults")} className="min-w-0 space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {data && (
            <Badge variant={data.status === "failed" ? "destructive" : "secondary"}>
              {t(deliveryLabels[data.status])}
            </Badge>
          )}
          {partial && (
            <Badge variant="outline">
              {t("observability.somePartsWereDeliveredCheckEachPartSOutcome")}
            </Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
          <RefreshCw />
          {t("observability.refreshDeliveryResult")}
        </Button>
      </div>
      <ReadError error={error} />
      {loading && !data && <p role="status">{t("observability.loadingDeliveryResult")}</p>}
      {data && (
        <>
          <dl className="grid gap-3 text-xs sm:grid-cols-3 [&_dt]:text-muted-foreground [&_dd]:mt-1 [&_dd]:break-all">
            <div>
              <dt>{t("observability.destinationConversation")}</dt>
              <dd>
                {data.target?.peerId ?? t("observability.recipientInformationWasNotRecorded")}
              </dd>
            </div>
            <div>
              <dt>{t("observability.recipient_138f8")}</dt>
              <dd>
                {data.target?.participantId ? (
                  <>
                    {
                      conversation?.participants.find(
                        (person) => person.id === data.target?.participantId,
                      )?.label
                    }{" "}
                    <code>{data.target.participantId}</code>
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt>{t("observability.deliveryDeadline")}</dt>
              <dd>
                {formatDate(data.deliverBy, i18n.language, {
                  dateStyle: "medium",
                  timeStyle: "medium",
                })}
              </dd>
            </div>
          </dl>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>{t("observability.contentType")}</TableHead>
                <TableHead>{t("observability.status")}</TableHead>
                <TableHead>{t("observability.platformMessageId")}</TableHead>
                <TableHead>{t("observability.latestActivity")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.parts.map((part) => (
                <TableRow key={part.id}>
                  <TableCell>{part.ordinal + 1}</TableCell>
                  <TableCell>
                    <div>
                      {t(part.kind === "text" ? "observability.text" : "observability.sticker")}
                    </div>
                    {part.stickerId && <code className="text-xs">{part.stickerId}</code>}
                  </TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1">
                      {part.status === "confirmed" && <CheckCheck className="size-4" />}
                      {t(deliveryLabels[part.status])}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {part.platformMessageId ?? "—"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {part.finishedAt || part.attemptedAt
                      ? formatDate(part.finishedAt ?? part.attemptedAt ?? "", i18n.language, {
                          dateStyle: "medium",
                          timeStyle: "medium",
                        })
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {data.status === "unknown" && (
            <p className="text-sm text-muted-foreground">
              {t("observability.thePlatformReceiptIsUnconfirmedThisViewOnlyChecksIts")}
            </p>
          )}
        </>
      )}
    </section>
  );
}
