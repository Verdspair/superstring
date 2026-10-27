import { ChevronDown, Eye, EyeOff, ImageOff } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ContextHandle, InspectedContext } from "../../../shared/contracts/agent-run";
import { type ReadTask, startRead } from "../../services/read-task";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
import { ContentReader } from "./ContentReader";
import { ReadError } from "./presentation";

type InspectionReader = (
  request: () => Promise<InspectedContext>,
  signal: AbortSignal,
) => Promise<InspectedContext>;
const InspectionReaderContext = createContext<InspectionReader | null>(null);

/** One open run owns its inspection slots; protected results remain in each reader. */
export function RunEvidenceScope({ children }: { children: ReactNode }) {
  const api = useSuperstringStore((state) => state.apiClient);
  const [scope, setScope] = useState({ api, revision: 0 });
  if (scope.api !== api) setScope({ api, revision: scope.revision + 1 });
  return <InspectionSlots key={scope.revision}>{children}</InspectionSlots>;
}

function InspectionSlots({ children }: { children: ReactNode }) {
  const active = useRef(new Set<Promise<void>>());
  const read = useCallback<InspectionReader>(async (request, signal) => {
    let abort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      abort = () => resolve();
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      while (active.current.size >= 3 && !signal.aborted) {
        await Promise.race([...active.current, aborted]);
      }
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      let release!: () => void;
      const slot = new Promise<void>((resolve) => {
        release = resolve;
      });
      active.current.add(slot);
      try {
        return await request();
      } finally {
        active.current.delete(slot);
        release();
      }
    } finally {
      if (abort) signal.removeEventListener("abort", abort);
    }
  }, []);
  return (
    <InspectionReaderContext.Provider value={read}>{children}</InspectionReaderContext.Provider>
  );
}

export function ModelEvidence({
  handle,
  autoInspect = false,
  inspectionRevision = "",
  embedded = false,
  fullEvidence = false,
}: {
  handle: ContextHandle;
  autoInspect?: boolean;
  inspectionRevision?: string;
  embedded?: boolean;
  fullEvidence?: boolean;
}) {
  const { t } = useTranslation(),
    api = useSuperstringStore((s) => s.apiClient);
  const scopedRead = useContext(InspectionReaderContext);
  const [value, setValue] = useState<InspectedContext | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const pending = useRef<ReadTask | null>(null);
  const activeReadRef = useRef<{ api: typeof api; runId: string; stepId: string } | null>(null);
  const autoInspectedRef = useRef<{
    api: typeof api;
    runId: string;
    stepId: string;
    revision: string;
  } | null>(null);
  const userClearedRef = useRef(false);

  const runId = handle.runId;
  const stepId = handle.stepId;

  const clear = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
    activeReadRef.current = null;
    setValue(null);
    setLoading(false);
    setError("");
  }, []);

  const inspect = useCallback(() => {
    clear();
    setLoading(true);
    const targetScope = { api, runId, stepId };
    activeReadRef.current = targetScope;
    pending.current = startRead(
      (signal) =>
        scopedRead
          ? scopedRead(() => api.inspectRunContext({ runId, stepId }, signal), signal)
          : api.inspectRunContext({ runId, stepId }, signal),
      {
        success: (context) => {
          if (
            activeReadRef.current?.api === api &&
            activeReadRef.current?.runId === runId &&
            activeReadRef.current?.stepId === stepId
          ) {
            setValue(context);
          }
        },
        failure: (cause) => {
          if (
            activeReadRef.current?.api === api &&
            activeReadRef.current?.runId === runId &&
            activeReadRef.current?.stepId === stepId
          ) {
            setError(errorText(cause));
          }
        },
        settled: () => {
          pending.current = null;
          setLoading(false);
        },
      },
    );
  }, [api, clear, runId, stepId, scopedRead]);

  const shouldAutoInspect = autoInspect || embedded;

  // biome-ignore lint/correctness/useExhaustiveDependencies: runId, stepId, and api own the scope of protected content.
  useEffect(() => {
    userClearedRef.current = false;
    clear();
    const hidden = () => {
      if (document.visibilityState === "hidden") {
        clear();
        autoInspectedRef.current = null;
      } else if (shouldAutoInspect && !userClearedRef.current) {
        autoInspectedRef.current = { api, runId, stepId, revision: inspectionRevision };
        inspect();
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      pending.current?.cancel();
      autoInspectedRef.current = null;
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [clear, api, runId, stepId, shouldAutoInspect, inspect]);

  useEffect(() => {
    if (!shouldAutoInspect) return;
    if (document.visibilityState === "hidden") return;
    if (userClearedRef.current) return;
    const current = autoInspectedRef.current;
    if (
      current &&
      current.api === api &&
      current.runId === runId &&
      current.stepId === stepId &&
      current.revision === inspectionRevision
    ) {
      return;
    }
    autoInspectedRef.current = { api, runId, stepId, revision: inspectionRevision };
    inspect();
  }, [shouldAutoInspect, api, runId, stepId, inspectionRevision, inspect]);

  const onUserInspect = () => {
    userClearedRef.current = false;
    inspect();
  };

  const onUserClear = () => {
    userClearedRef.current = true;
    clear();
  };

  return (
    <section aria-label={t("observability.modelEvidence")} className="min-w-0 space-y-4">
      {!embedded && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-3">
          <p className="text-xs text-muted-foreground">
            {t("observability.inputsAndOutputsAreLoadedOnlyWhenYouInspectThem")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={onUserInspect}
              disabled={loading}
              disabledReason={t("hints.investigation.evidence.inspectLoading")}
              tooltip={
                value
                  ? t("hints.investigation.evidence.recheck")
                  : t("hints.investigation.evidence.inspect")
              }
            >
              <Eye />
              {t(
                value
                  ? "observability.recheckActualInputAndOutput"
                  : "observability.inspectActualInputAndOutput",
              )}
            </Button>
            {(value || loading) && (
              <Button
                variant="ghost"
                size="sm"
                tooltip={t("hints.investigation.evidence.hide")}
                onClick={onUserClear}
              >
                <EyeOff />
                {t("observability.hideActualInputAndOutput")}
              </Button>
            )}
          </div>
        </div>
      )}
      {loading && <p role="status">{t("observability.checkingSourceAccessAndRetention")}</p>}
      <ReadError error={error} />
      {value && <InspectedEvidence value={value} fullEvidence={fullEvidence} />}
    </section>
  );
}
export function InspectedEvidence({
  value,
  fullEvidence = false,
}: {
  value: InspectedContext;
  fullEvidence?: boolean;
}) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<string>("input");
  const [openSections, setOpenSections] = useState<Set<string>>(() => new Set());
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
  const canShowMetadata = readable && result.status !== "expired" && result.status !== "revoked";
  const inputContent = () => (
    <>
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
                    <dt>{t("observability.imageHashType", { "0": part.mimeType })}</dt>
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
    </>
  );
  const outputContent = () => (
    <>
      <p role="status" className="text-sm text-muted-foreground">
        {t(resultText)}
      </p>
      {readable &&
        (result.status === "exact" || result.status === "partial") &&
        typeof result.text === "string" && (
          <ContentReader label={t("observability.modelOutput")} text={result.text} />
        )}
      {canShowMetadata && (
        <section
          className="min-w-0 space-y-2 border-t pt-3"
          aria-label={t("observability.finishReason")}
        >
          <h4 className="text-xs font-semibold text-muted-foreground">
            {t("observability.finishReason")}
          </h4>
          {result.responses && result.responses.length > 0 ? (
            <ol className="space-y-1.5 text-xs font-mono">
              {result.responses.map((attempt, index) => {
                const reasons = Array.isArray(attempt.finishReasons) ? attempt.finishReasons : [];
                return (
                  <li
                    // biome-ignore lint/suspicious/noArrayIndexKey: Attempts are strictly ordered immutable records of each HTTP request.
                    key={index}
                    className="flex flex-wrap items-center gap-1.5 text-muted-foreground"
                  >
                    <span className="font-semibold text-foreground">#{index + 1}</span>
                    <span>·</span>
                    <span>{attempt.transport}</span>
                    <span>·</span>
                    {attempt.httpStatus !== undefined ? (
                      <>
                        {/* i18next-instrument-ignore-next-line */}
                        <span>HTTP {attempt.httpStatus}</span>
                      </>
                    ) : (
                      <span>{t("observability.noHttpResponse")}</span>
                    )}
                    {reasons.length > 0 && (
                      <>
                        <span>·</span>
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <span>{t("observability.finishReason")}:</span>
                          {reasons.map((reason, rIdx) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: Finish reasons retain their exact arrival order within an attempt.
                            <span key={rIdx}>
                              {rIdx > 0 && ", "}
                              <code>{reason === null ? "null" : JSON.stringify(reason)}</code>
                            </span>
                          ))}
                        </span>
                      </>
                    )}
                    {reasons.length === 0 && attempt.httpStatus !== undefined && (
                      <>
                        <span>·</span>
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <span>{t("observability.finishReason")}:</span>
                          <span>{t("observability.finishReasonProviderDidNotReport")}</span>
                        </span>
                      </>
                    )}
                    {attempt.doneMarker && (
                      <>
                        <span>·</span>
                        {/* i18next-instrument-ignore-next-line */}
                        <span className="font-semibold text-foreground">[DONE]</span>
                      </>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("observability.finishReasonNotRecorded")}
            </p>
          )}
        </section>
      )}
    </>
  );
  const sourcesContent = () => (
    <>
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
    </>
  );
  if (fullEvidence) {
    return (
      <div className="min-w-0 divide-y rounded-lg border">
        {(["output", "input", "sources"] as const).map((section) => {
          const open = openSections.has(section);
          const label = t(
            section === "output"
              ? "observability.modelOutput"
              : section === "input"
                ? "observability.modelInput"
                : "observability.sourcesAndRevisions",
          );
          const hint = t(
            section === "output"
              ? "hints.investigation.evidence.sectionOutput"
              : section === "input"
                ? "hints.investigation.evidence.sectionInput"
                : "hints.investigation.evidence.sectionSources",
          );
          return (
            <Collapsible
              key={section}
              open={open}
              onOpenChange={(nextOpen) =>
                setOpenSections((previous) => {
                  const next = new Set(previous);
                  if (nextOpen) next.add(section);
                  else next.delete(section);
                  return next;
                })
              }
              className="min-w-0"
            >
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-auto min-h-12 w-full justify-between gap-3 rounded-none px-3 py-2 text-left whitespace-normal"
                  aria-label={label}
                  tooltip={hint}
                >
                  <span className="text-sm font-semibold">{label}</span>
                  <ChevronDown
                    aria-hidden="true"
                    className={`size-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
                  />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="min-w-0">
                {/* Presence keeps this subtree so the exit can be measured and animated. */}
                <section aria-label={label} className="min-w-0 space-y-3 border-t p-3">
                  {section === "output"
                    ? outputContent()
                    : section === "input"
                      ? inputContent()
                      : sourcesContent()}
                </section>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    );
  }
  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="min-w-0 gap-4">
      <TabsList
        className="h-auto w-full flex-wrap sm:w-fit"
        aria-label={t("observability.modelInputOutputAndSources")}
      >
        <TabsTrigger value="input">{t("observability.modelInput")}</TabsTrigger>
        <TabsTrigger value="output">{t("observability.modelOutput")}</TabsTrigger>
        <TabsTrigger value="sources">{t("observability.sourcesAndRevisions")}</TabsTrigger>
      </TabsList>
      <TabsContent value="input" className="min-w-0 space-y-4">
        {activeTab === "input" && inputContent()}
      </TabsContent>
      <TabsContent value="output" className="min-w-0 space-y-4">
        {activeTab === "output" && outputContent()}
      </TabsContent>
      <TabsContent value="sources">{activeTab === "sources" && sourcesContent()}</TabsContent>
    </Tabs>
  );
}
