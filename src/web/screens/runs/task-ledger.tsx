import { ListChecks, RefreshCw, XCircle } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  TaskBodyPage,
  TaskDetail,
  TaskList,
  TaskStatus,
  TaskSummary,
} from "../../../shared/contracts/agent-task";
import { AlertDialog, ConfirmDialog } from "../../components/confirmation";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { NativeSelect } from "../../components/ui/native-select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../../components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { type ReadTask, startRead } from "../../services/read-task";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
import { RunLink } from "./RunEntry";

const statuses: TaskStatus[] = [
  "queued",
  "running",
  "waiting_tool",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "unknown",
];
const statusKey = (status: TaskStatus) => `connections.tasks.status.${status}`;

/** One drafted filter form: typing never queries; Apply commits all four fields at once. */
type FilterDraft = {
  status: TaskStatus | "";
  agentId: string;
  conversationId: string;
  originRunId: string;
};
const emptyFilters: FilterDraft = {
  status: "",
  agentId: "",
  conversationId: "",
  originRunId: "",
};
const sameFilters = (left: FilterDraft, right: FilterDraft) =>
  left.status === right.status &&
  left.agentId === right.agentId &&
  left.conversationId === right.conversationId &&
  left.originRunId === right.originRunId;

export function TaskLedger({ conversationId }: { conversationId?: string } = {}) {
  const { t, i18n } = useTranslation();
  const filterId = useId();
  const apiClient = useSuperstringStore((s) => s.apiClient);
  const summaryById = useSuperstringStore((s) => s.summaryById);
  const directoryIds = useSuperstringStore((s) => s.directoryIds);
  const agents = useSuperstringStore((s) => s.agents);
  // 当前会话范围：过滤条件强制带上本会话，清除筛选也保留该范围，不再重复提供会话选择。
  const lockedFilters = useMemo<FilterDraft>(
    () => (conversationId ? { ...emptyFilters, conversationId } : emptyFilters),
    [conversationId],
  );
  const [list, setList] = useState<TaskList | null>(null);
  const [draft, setDraft] = useState<FilterDraft>(lockedFilters);
  const [filters, setFilters] = useState<FilterDraft>(lockedFilters);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [approving, setApproving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const pending = useRef<ReadTask | null>(null);
  const pendingDetail = useRef<ReadTask | null>(null);
  const mutation = useRef(false);
  const previousLocked = useRef(conversationId);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (previousLocked.current === conversationId) return;
    previousLocked.current = conversationId;
    setDraft(lockedFilters);
    setFilters(lockedFilters);
  }, [conversationId, lockedFilters]);
  const load = useCallback(
    (cursor?: string) => {
      const scopedConversationId = conversationId ?? filters.conversationId;
      pending.current?.cancel();
      setLoading(true);
      // A new filter generation starts from an empty first page, so pages of two filter sets
      // never sit side by side; "load more" keeps appending to the current cursor chain.
      if (!cursor) setList(null);
      pending.current = startRead(
        (signal) =>
          apiClient.listTasks(
            {
              ...(filters.status ? { status: filters.status } : {}),
              ...(filters.agentId ? { agentId: filters.agentId } : {}),
              ...(scopedConversationId ? { conversationId: scopedConversationId } : {}),
              ...(filters.originRunId ? { originRunId: filters.originRunId } : {}),
              cursor,
              limit: 50,
            },
            signal,
          ),
        {
          success: (page) => {
            setList((previous) =>
              cursor && previous ? { ...page, items: [...previous.items, ...page.items] } : page,
            );
            setError("");
          },
          failure: (caught) => setError(errorText(caught)),
          settled: () => setLoading(false),
        },
      );
    },
    [apiClient, filters, conversationId],
  );
  useEffect(() => {
    load();
    return () => {
      pending.current?.cancel();
      pendingDetail.current?.cancel();
    };
  }, [load]);
  const updateDraft = <K extends keyof FilterDraft>(key: K, value: FilterDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const applyFilters = () =>
    setFilters((previous) => (sameFilters(previous, draft) ? previous : { ...draft }));
  const clearFilters = () => {
    setDraft(lockedFilters);
    setFilters((previous) => (sameFilters(previous, lockedFilters) ? previous : lockedFilters));
  };
  const openDetail = (id: string) => {
    pendingDetail.current?.cancel();
    setError("");
    pendingDetail.current = startRead((signal) => apiClient.getTask(id, signal), {
      success: setDetail,
      failure: (caught) => setError(errorText(caught)),
    });
  };
  const decide = async (approve: boolean) => {
    const call = detail?.calls.find((entry) => entry.status === "waiting_approval");
    if (!detail || !call || mutation.current) return;
    // A waiting call without an approval ticket cannot be decided; say so instead of returning
    // silently, so a stale state never looks like a no-op.
    if (!call.approvalRevision) {
      setApproving(false);
      setNotice(t("connections.tasks.approvalUnavailable"));
      return;
    }
    mutation.current = true;
    setSaving(true);
    try {
      await apiClient.approveTask(detail.id, {
        ordinal: call.ordinal,
        expectedApproval: call.approvalRevision,
        approve,
      });
      setApproving(false);
      setNotice(t(approve ? "connections.tasks.approved" : "connections.tasks.rejected"));
      openDetail(detail.id);
      load();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      mutation.current = false;
      setSaving(false);
    }
  };
  const cancel = async () => {
    if (!detail || mutation.current) return;
    mutation.current = true;
    setSaving(true);
    try {
      await apiClient.cancelTask(detail.id);
      setCancelling(false);
      setNotice(t("connections.tasks.cancelled"));
      openDetail(detail.id);
      load();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      mutation.current = false;
      setSaving(false);
    }
  };
  const waiting = detail?.calls.find((entry) => entry.status === "waiting_approval");
  return (
    <div className="space-y-6 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <ListChecks className="size-4 text-muted-foreground" />
            {t("connections.tasks.title")}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t("connections.tasks.description")}
          </p>
          {conversationId && (
            <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
              {t("connections.tasks.currentConversationScope")}
            </p>
          )}
        </div>
        <Button variant="outline" disabled={loading} onClick={() => load()}>
          <RefreshCw />
          {t("connections.common.refresh")}
        </Button>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <label className="grid min-w-0 gap-1.5 text-xs font-medium" htmlFor={`${filterId}-status`}>
          <span>{t("connections.tasks.filterStatus")}</span>
          <NativeSelect
            id={`${filterId}-status`}
            value={draft.status}
            onChange={(event) => updateDraft("status", event.target.value as TaskStatus | "")}
          >
            <option value="">{t("connections.tasks.allStatuses")}</option>
            {statuses.map((value) => (
              <option key={value} value={value}>
                {t(statusKey(value))}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="grid min-w-0 gap-1.5 text-xs font-medium" htmlFor={`${filterId}-agent`}>
          <span>{t("connections.tasks.filterAgent")}</span>
          <NativeSelect
            id={`${filterId}-agent`}
            className="max-w-60"
            value={draft.agentId}
            onChange={(event) => updateDraft("agentId", event.target.value)}
          >
            <option value="">{t("connections.all")}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        {!conversationId && (
          <fieldset className="min-w-0 space-y-1.5">
            <legend className="text-xs font-medium">
              {t("connections.tasks.filterConversation")}
            </legend>
            <div className="flex flex-wrap items-start gap-2">
              <div className="grid min-w-0 gap-1.5">
                <NativeSelect
                  className="max-w-60"
                  aria-label={t("connections.tasks.filterConversation")}
                  value={draft.conversationId}
                  onChange={(event) => updateDraft("conversationId", event.target.value)}
                >
                  <option value="">{t("connections.all")}</option>
                  {directoryIds.map((id) => (
                    <option key={id} value={id}>
                      {summaryById[id]?.title ?? id}
                    </option>
                  ))}
                </NativeSelect>
                {/* The dropdown only offers loaded conversations and says so; the ID input beside it is
                    the way to filter by a conversation that has not been loaded yet. */}
                <p className="text-xs text-muted-foreground">
                  {t("workspace.loaded_conversations")}
                </p>
              </div>
              <Input
                className="w-64 max-w-full"
                aria-label={t("observability.conversationId")}
                placeholder={t("observability.conversationId")}
                value={draft.conversationId}
                onChange={(event) => updateDraft("conversationId", event.target.value)}
              />
            </div>
          </fieldset>
        )}
        <label className="grid min-w-0 gap-1.5 text-xs font-medium" htmlFor={`${filterId}-run`}>
          <span>{t("connections.tasks.filterOriginRun")}</span>
          <Input
            id={`${filterId}-run`}
            className="w-64 max-w-full"
            placeholder={t("observability.runId")}
            value={draft.originRunId}
            onChange={(event) => updateDraft("originRunId", event.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit">{t("connections.tasks.applyFilters")}</Button>
          <Button type="button" variant="outline" onClick={clearFilters}>
            {t("connections.tasks.clearFilters")}
          </Button>
        </div>
      </form>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("connections.tasks.statusColumn")}</TableHead>
              <TableHead>{t("connections.tasks.calls")}</TableHead>
              <TableHead>{t("connections.tasks.conversation")}</TableHead>
              <TableHead>{t("connections.tasks.created")}</TableHead>
              <TableHead>{t("connections.tasks.expires")}</TableHead>
              <TableHead className="text-right">{t("connections.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(list?.items ?? []).map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                conversation={
                  summaryById[task.conversationId]?.title ??
                  t("connections.tasks.unknownConversation")
                }
                locale={i18n.language}
                onOpen={() => openDetail(task.id)}
              />
            ))}
            {!loading && !list?.items.length && (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                  {t("connections.tasks.empty")}
                </TableCell>
              </TableRow>
            )}
            {loading && (
              <TableRow>
                <TableCell colSpan={6} className="h-32 text-center text-muted-foreground">
                  {t("connections.common.loading")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {list?.hasMore && (
        <Button
          variant="outline"
          disabled={loading}
          onClick={() => load(list.nextCursor ?? undefined)}
        >
          {t("connections.tasks.loadMore")}
        </Button>
      )}

      <Sheet
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open && !saving) {
            pendingDetail.current?.cancel();
            setDetail(null);
          }
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader className="border-b">
            <SheetTitle>{t("connections.tasks.detail")}</SheetTitle>
            <SheetDescription>{detail?.id}</SheetDescription>
          </SheetHeader>
          {detail && (
            <div className="space-y-6 p-6">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <Badge variant="outline">{t(statusKey(detail.status))}</Badge>
                {detail.waitingReason && (
                  <span className="text-muted-foreground">
                    {t(`connections.tasks.waiting.${detail.waitingReason}`)}
                  </span>
                )}
                {detail.errorCode && (
                  <span className="font-mono text-xs text-destructive">{detail.errorCode}</span>
                )}
                {detail.originRunId && <RunLink runId={detail.originRunId} />}
              </div>
              <p className="text-xs text-muted-foreground">{t("connections.tasks.boundary")}</p>
              <div className="space-y-3">
                {detail.calls.map((call) => (
                  <CallRow
                    key={`${detail.id}:${call.ordinal}:${call.resultStatus}`}
                    taskId={detail.id}
                    call={call}
                  />
                ))}
              </div>
              <div className="flex gap-2 border-t pt-5">
                {detail.status !== "completed" &&
                  detail.status !== "failed" &&
                  detail.status !== "cancelled" &&
                  detail.status !== "unknown" && (
                    <Button variant="ghost" onClick={() => setCancelling(true)}>
                      <XCircle />
                      {t("connections.tasks.cancel")}
                    </Button>
                  )}
                {waiting && (
                  <>
                    {!waiting.approvalRevision && (
                      <p className="text-xs text-muted-foreground">
                        {t("connections.tasks.approvalUnavailable")}
                      </p>
                    )}
                    <Button
                      className="ml-auto"
                      disabled={!waiting.approvalRevision || saving}
                      onClick={() => setApproving(true)}
                    >
                      {t("connections.tasks.reviewApproval")}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
      {approving && detail && waiting?.approvalRevision && (
        <AlertDialog
          title={t("connections.tasks.approvalTitle")}
          onCancel={() => setApproving(false)}
          busy={saving}
        >
          <div className="space-y-3 text-sm">
            <p>{t("connections.tasks.approvalHint")}</p>
            <dl className="space-y-1">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t("connections.tasks.tool")}</dt>
                <dd className="font-mono">{waiting.name}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{t("connections.tasks.arguments")}</dt>
                <dd className="max-w-80 truncate font-mono text-xs">
                  {waiting.argumentsPreview.text ?? t("connections.tasks.unavailable")}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">{t("connections.tasks.ticketHint")}</p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              disabled={saving}
              data-dialog-cancel
              onClick={() => void decide(false)}
            >
              {t("connections.tasks.reject")}
            </Button>
            <Button disabled={saving} onClick={() => void decide(true)}>
              {t("connections.tasks.approveOnce")}
            </Button>
          </div>
        </AlertDialog>
      )}
      {cancelling && (
        <ConfirmDialog
          message={t("connections.tasks.cancelConfirm")}
          busy={saving}
          onCancel={() => setCancelling(false)}
          onConfirm={() => void cancel()}
        />
      )}
    </div>
  );
}

function TaskRow({
  task,
  conversation,
  locale,
  onOpen,
}: {
  task: TaskSummary;
  conversation: string;
  locale: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const date = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
      new Date(value),
    );
  return (
    <TableRow>
      <TableCell>
        <Badge variant="outline">{t(statusKey(task.status))}</Badge>
        {task.errorCode && (
          <span className="ml-2 font-mono text-xs text-destructive">{task.errorCode}</span>
        )}
      </TableCell>
      <TableCell className="text-sm tabular-nums">
        {task.completedCallCount}/{task.callCount}
      </TableCell>
      <TableCell className="max-w-56 truncate text-sm">{conversation}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{date(task.createdAt)}</TableCell>
      <TableCell className="text-xs text-muted-foreground">{date(task.expiresAt)}</TableCell>
      <TableCell className="text-right">
        <Button variant="ghost" size="sm" onClick={onOpen}>
          {t("connections.tasks.open")}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function CallRow({ taskId, call }: { taskId: string; call: TaskDetail["calls"][number] }) {
  const { t } = useTranslation();
  const apiClient = useSuperstringStore((s) => s.apiClient);
  const [page, setPage] = useState<{ field: "arguments" | "result"; value: TaskBodyPage } | null>(
    null,
  );
  const [error, setError] = useState("");
  const pending = useRef<ReadTask | null>(null);
  useEffect(() => () => pending.current?.cancel(), []);
  const clear = () => {
    pending.current?.cancel();
    setPage(null);
  };
  const read = (field: "arguments" | "result", offset = 0) => {
    pending.current?.cancel();
    setError("");
    pending.current = startRead(
      (signal) => apiClient.getTaskBody(taskId, call.ordinal, field, offset, 2048, signal),
      {
        success: (value) => setPage({ field, value }),
        failure: (caught) => setError(errorText(caught)),
      },
    );
  };
  return (
    <section className="space-y-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">#{call.ordinal}</span>
        <span className="font-mono">{call.name}</span>
        <Badge variant="outline">
          {t(
            call.effect === "read"
              ? "connections.grants.effectRead"
              : "connections.grants.effectWrite",
          )}
        </Badge>
        <Badge variant="outline">{t(`connections.tasks.call.${call.status}`)}</Badge>
        {call.errorCode && (
          <span className="font-mono text-xs text-destructive">{call.errorCode}</span>
        )}
        <span className="ml-auto flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (page?.field === "arguments" ? clear() : read("arguments"))}
          >
            {t("connections.tasks.arguments")}
          </Button>
          {call.resultStatus === "available" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => (page?.field === "result" ? clear() : read("result"))}
            >
              {t("connections.tasks.result")}
            </Button>
          )}
        </span>
      </div>
      {call.approvalRevision && (
        <p className="text-xs text-muted-foreground">{t("connections.tasks.ticket")}</p>
      )}
      {call.resultStatus === "revoked" && (
        <p className="text-xs text-destructive">{t("connections.tasks.revoked")}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {page && (
        <div className="space-y-2">
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
            {page.value.text ?? t("connections.tasks.unavailable")}
          </pre>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              {t("connections.tasks.page", {
                "0": page.value.offset,
                "1": page.value.total ?? "?",
              })}
            </span>
            {page.value.nextOffset !== null && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => read(page.field, page.value.nextOffset ?? 0)}
              >
                {t("connections.tasks.nextPage")}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
