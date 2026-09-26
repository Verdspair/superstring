import { Eye, EyeOff, ImageOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ContextHandle, InspectedContext } from "../../../shared/contracts/agent-run";
import { type ReadTask, startRead } from "../../services/read-task";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
import { ContentReader } from "./ContentReader";
import { ReadError } from "./presentation";
export function ModelEvidence({ handle }: { handle: ContextHandle }) {
  const { t } = useTranslation(),
    api = useSuperstringStore((s) => s.apiClient);
  const [value, setValue] = useState<InspectedContext | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<ReadTask | null>(null);
  const clear = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
    setValue(null);
    setLoading(false);
    setError("");
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Both IDs own the lifetime of protected content.
  useEffect(() => {
    clear();
    const hidden = () => {
      if (document.visibilityState === "hidden") clear();
    };
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      pending.current?.cancel();
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [clear, handle.runId, handle.stepId]);
  const inspect = () => {
    clear();
    setLoading(true);
    pending.current = startRead((signal) => api.inspectRunContext(handle, signal), {
      success: setValue,
      failure: (cause) => setError(errorText(cause)),
      settled: () => {
        pending.current = null;
        setLoading(false);
      },
    });
  };
  return (
    <section aria-label={t("observability.modelEvidence")} className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-3">
        <p className="text-xs text-muted-foreground">
          {t("observability.inputsAndOutputsAreLoadedOnlyWhenYouInspectThem")}
        </p>
        <div className="flex gap-2">
          <Button size="sm" onClick={inspect} disabled={loading}>
            <Eye />
            {t(
              value
                ? "observability.recheckActualInputAndOutput"
                : "observability.inspectActualInputAndOutput",
            )}
          </Button>
          {(value || loading) && (
            <Button variant="ghost" size="sm" onClick={clear}>
              <EyeOff />
              {t("observability.hideActualInputAndOutput")}
            </Button>
          )}
        </div>
      </div>
      {loading && <p role="status">{t("observability.checkingSourceAccessAndRetention")}</p>}
      <ReadError error={error} />
      {value && <InspectedEvidence value={value} />}
    </section>
  );
}
export function InspectedEvidence({ value }: { value: InspectedContext }) {
  const { t } = useTranslation();
  const readable = value.status === "exact" || value.status === "partial";
  const status = {
    exact: "observability.theExactTextInputIsAvailable",
    partial: "observability.textIsAvailableSomeOriginalImageBytesCannotBeRetrieved",
    expired: "observability.sourceRetentionHasExpiredActualInputWasRemovedOnlyLayout",
    revoked: "observability.sourcesWereRevokedOrDeletedActualInputIsUnavailableOnly",
  };
  const result = value.result;
  const resultText =
    value.status === "expired"
      ? "observability.sourceRetentionHasEndedModelOutputHasBeenCleared"
      : value.status === "revoked"
        ? "observability.sourceAccessWasRevokedOrDeletedModelOutputIsUnavailable"
        : result.status === "partial"
          ? "observability.thisIsPartialModelOutputRetainedBeforeInterruption"
          : result.status === "expired"
            ? "observability.sourceRetentionHasEndedModelOutputHasBeenCleared"
            : result.status === "revoked"
              ? "observability.sourceAccessWasRevokedOrDeletedModelOutputIsUnavailable"
              : result.status === "unavailable"
                ? result.reason === "pending"
                  ? "observability.theModelCallHasNotFinished"
                  : result.reason === "no_response"
                    ? "observability.theModelReturnedNoPreservableText"
                    : "observability.noModelOutputWasRetainedForThisStep"
                : "observability.originalModelOutput";
  return (
    <Tabs defaultValue="input" className="min-w-0 gap-4">
      <TabsList
        className="w-full sm:w-fit"
        aria-label={t("observability.modelInputOutputAndSources")}
      >
        <TabsTrigger value="input">{t("observability.modelInput")}</TabsTrigger>
        <TabsTrigger value="output">{t("observability.modelOutput")}</TabsTrigger>
        <TabsTrigger value="sources">{t("observability.sourcesAndRevisions")}</TabsTrigger>
      </TabsList>
      <TabsContent value="input" className="min-w-0 space-y-4">
        <p role="status" className="text-sm text-muted-foreground">
          {t(status[value.status])}
        </p>
        <div className="flex flex-wrap gap-2">
          {value.layout.map((item, index) => (
            <Badge
              // biome-ignore lint/suspicious/noArrayIndexKey: Layout blocks belong to an immutable ordered snapshot.
              key={`${item.role}:${index}`}
              variant="outline"
            >
              {item.role} ·{" "}
              {t("observability.valueUnitsValueSources", {
                "0": item.units,
                "1": item.sourceIds.length,
              })}
            </Badge>
          ))}
        </div>
        {readable &&
          value.exactMessages?.map((message, index) => (
            <section
              // biome-ignore lint/suspicious/noArrayIndexKey: The model input is an immutable ordered snapshot.
              key={`${message.role}:${index}`}
              className="min-w-0 space-y-3 border-t pt-4"
            >
              <h4 className="flex items-center gap-2 text-sm font-semibold">
                <Badge variant="secondary">{message.role}</Badge>
                {t("observability.messageValue", {
                  "0": index + 1,
                })}
              </h4>
              {message.content.map((part, partIndex) =>
                part.kind === "text" ? (
                  <ContentReader
                    // biome-ignore lint/suspicious/noArrayIndexKey: Source parts retain their exact immutable order.
                    key={`${partIndex}:text`}
                    text={part.text}
                    label={t("observability.messageValueValue", {
                      "0": index + 1,
                      "1": message.role,
                    })}
                  />
                ) : (
                  <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: Repeated frames can share a source hash in an immutable snapshot.
                    key={`${partIndex}:${part.sha256}`}
                    className="flex gap-3 rounded-lg border p-4 text-xs"
                  >
                    <ImageOff className="size-5 shrink-0 text-muted-foreground" />
                    <dl className="min-w-0 space-y-1 break-all">
                      <dt>{t("observability.imageSource")}</dt>
                      <dd>{part.sourceId}</dd>
                      <dt>{t("observability.sourceRevision")}</dt>
                      <dd>{part.revision}</dd>
                      <dt>SHA-256 · {part.mimeType}</dt>
                      <dd>{part.sha256}</dd>
                    </dl>
                  </div>
                ),
              )}
            </section>
          ))}
        {readable &&
          value.unavailableMedia?.map((item) => (
            <p
              key={`${item.sourceId}:${item.sha256}`}
              className="break-all text-xs text-muted-foreground"
            >
              {t("observability.originalMediaBytesAreUnavailable")}: {item.sourceId} · {item.sha256}
            </p>
          ))}
      </TabsContent>
      <TabsContent value="output" className="min-w-0 space-y-4">
        <p role="status" className="text-sm text-muted-foreground">
          {t(resultText)}
        </p>
        {readable &&
          (result.status === "exact" || result.status === "partial") &&
          typeof result.text === "string" && (
            <ContentReader label={t("observability.modelOutput")} text={result.text} />
          )}
      </TabsContent>
      <TabsContent value="sources">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("observability.sourceId")}</TableHead>
              <TableHead>{t("observability.sourceRevision")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {value.sourceVersions.map((source, index) => (
              <TableRow
                // biome-ignore lint/suspicious/noArrayIndexKey: Immutable provenance may repeat the same source.
                key={`${source.id}:${index}`}
              >
                <TableCell className="whitespace-normal break-all font-mono text-xs">
                  {source.id}
                </TableCell>
                <TableCell className="whitespace-normal break-all font-mono text-xs">
                  {source.revision}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {!value.sourceVersions.length && (
          <p className="p-4 text-sm text-muted-foreground">
            {t("observability.noAssociatedSourcesAreRecorded")}
          </p>
        )}
      </TabsContent>
    </Tabs>
  );
}
