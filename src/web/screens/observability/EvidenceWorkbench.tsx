import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { RuntimeSpan } from "../../../shared/contracts/runtime-observability";
import { formatDate } from "../../i18n/runtime";
import { DeliveryEvidence } from "../runs/DeliveryEvidence";
import { RunWorkspace } from "../runs/RunEntry";
import { detailLabels, operationLabels, reasonLabels } from "./labels";
import { ModelEvidence } from "./ModelEvidence";
import { phaseLabels, StatusMark } from "./presentation";
export function EvidenceWorkbench({ item }: { item: RuntimeSpan }) {
  const reducedMotion = useReducedMotion();
  const { t, i18n } = useTranslation(),
    [run, setRun] = useState(false);
  const back = useRef<HTMLButtonElement>(null),
    title = useRef<HTMLHeadingElement>(null),
    navigation = useRef(false);
  const changeRun = (next: boolean) => {
    navigation.current = true;
    setRun(next);
  };
  useLayoutEffect(() => {
    if (navigation.current) {
      navigation.current = false;
      (run ? back.current : title.current)?.focus();
    }
  }, [run]);
  const stepId = typeof item.details.stepId === "string" ? item.details.stepId : null;
  const metadata = {
    "observability.traceId": item.traceId,
    "observability.spanId": item.spanId,
    "observability.parentSpanId": item.parentSpanId,
    "observability.conversationId": item.conversationId,
    "observability.agentId": item.agentId,
    "observability.runId": item.runId,
    "observability.wakeId": item.wakeId,
    "observability.outputId": item.outputId,
    "observability.sourceSequence": item.sourceSeq,
    "observability.operationName": item.name,
    "observability.reasonCode": item.code,
    "observability.startedAt": formatDate(item.at, i18n.language, {
      dateStyle: "medium",
      timeStyle: "medium",
    }),
    "observability.finishedAt": item.finishedAt
      ? formatDate(item.finishedAt, i18n.language, {
          dateStyle: "medium",
          timeStyle: "medium",
        })
      : null,
    ...item.details,
  };
  if (run && item.runId)
    return (
      <section
        aria-label={t("observability.parentRun")}
        className="space-y-4"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            changeRun(false);
          }
        }}
      >
        <Button ref={back} variant="ghost" onClick={() => changeRun(false)}>
          <ArrowLeft />
          {t("observability.backToStepDetails")}
        </Button>
        <RunWorkspace runId={item.runId} />
      </section>
    );
  return (
    <motion.section
      initial={reducedMotion ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.15 }}
      aria-label={t("observability.stepInspector")}
      className="min-w-0 space-y-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              ref={title}
              tabIndex={-1}
              className="text-base font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t(operationLabels[item.name] ?? item.name)}
            </h3>
            <StatusMark status={item.status} />
            {item.details.phase && (
              <Badge variant="outline">
                {t(phaseLabels[String(item.details.phase)] ?? String(item.details.phase))}
              </Badge>
            )}
          </div>
          {item.model && (
            <p className="break-all font-mono text-xs">
              {t(
                item.details.modelResolved === true
                  ? "observability.actualRequestedModel"
                  : item.details.modelResolved === false
                    ? "observability.requestedModel"
                    : "observability.recordedModelUnverified",
              )}
              : {item.model}
            </p>
          )}
          {item.details.modelResolved === true &&
            item.details.requestedModel &&
            item.details.requestedModel !== item.model && (
              <p className="text-xs text-muted-foreground">
                {t("observability.fallbackUsedRequestedModelValue", {
                  "0": String(item.details.requestedModel),
                })}
              </p>
            )}
          {reasonLabels[item.code] && <p className="text-sm">{t(reasonLabels[item.code])}</p>}
        </div>
        {item.runId && (
          <Button variant="outline" size="sm" onClick={() => changeRun(true)}>
            <ArrowUpRight />
            {t("observability.parentRun")}
          </Button>
        )}
      </header>
      {item.status === "unknown" && (
        <p className="text-sm text-muted-foreground">
          {t("observability.theOutcomeIsUnconfirmedNotFailedFollowTheTraceTo")}
        </p>
      )}
      <Tabs
        defaultValue={
          item.stage === "model" && item.runId && stepId
            ? "model"
            : item.channel === "onebot11" && item.outputId
              ? "delivery"
              : "metadata"
        }
        className="min-w-0"
      >
        <TabsList aria-label={t("observability.evidenceType")}>
          <TabsTrigger value="metadata">{t("observability.runAndMetadata")}</TabsTrigger>
          {item.stage === "model" && item.runId && stepId && (
            <TabsTrigger value="model">{t("observability.modelEvidence")}</TabsTrigger>
          )}
          {item.channel === "onebot11" && item.outputId && (
            <TabsTrigger value="delivery">{t("observability.deliveryDetails")}</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="metadata">
          <dl className="grid gap-x-8 gap-y-4 py-4 text-xs sm:grid-cols-2 xl:grid-cols-3">
            {Object.entries(metadata)
              .filter(([, value]) => value !== null)
              .map(([key, value]) => (
                <div key={key} className="min-w-0">
                  <dt className="text-muted-foreground">{t(detailLabels[key] ?? key)}</dt>
                  <dd className="mt-1 break-all font-mono">{String(value)}</dd>
                </div>
              ))}
          </dl>
        </TabsContent>
        {item.runId && stepId && (
          <TabsContent value="model" className="min-w-0 pt-3">
            <ModelEvidence
              handle={{
                runId: item.runId,
                stepId,
              }}
            />
          </TabsContent>
        )}
        {item.outputId && (
          <TabsContent value="delivery">
            <DeliveryEvidence outputId={item.outputId} />
          </TabsContent>
        )}
      </Tabs>
    </motion.section>
  );
}
