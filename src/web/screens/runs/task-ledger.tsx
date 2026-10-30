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
import { scheduleSourceExpiry, sourceExpired } from "../../features/conversations/source-expiry";
import { formatDate } from "../../i18n/runtime";
import { addConversationChangeListener } from "../../services/conversation-changes";
import { type ReadTask, startRead } from "../../services/read-task";
import { useForegroundRead } from "../../services/use-foreground-read";
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

export function TaskLedger({
  conversationId,
  active = true,
}: {
  conversationId?: string;
  active?: boolean;
} = {}) {
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
  const errorSource = useRef<"list" | "detail" | null>(null);
  const detailScope = useMemo(
    () => ({ apiClient, conversationId: conversationId ?? filters.conversationId }),
    [apiClient, conversationId, filters.conversationId],
  );
  const [detailState, setDetailState] = useState<{
    scope: typeof detailScope;
    value: TaskDetail;
  } | null>(null);
  const detail = detailState?.scope === detailScope ? detailState.value : null;
  const selectedTask = useRef<{ conversationId: string | undefined; id: string } | null>(null);
  const [approving, setApproving] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // 常挂载审批框在关闭段落期间仍渲染；保留最近一次打开的内容快照，避免详情先被清空。
  const approvalSnapshot = useRef<{
    name: string;
    argumentsText: string | null;
  } | null>(null);
  const pending = useRef<ReadTask | null>(null);
  const pendingDetail = useRef<ReadTask | null>(null);
  const previousLocked = useRef(conversationId);
  const isInitialRead = useRef(true);
  const effectiveFilters = useMemo<FilterDraft>(
    () => (conversationId ? { ...filters, conversationId } : filters),
    [conversationId, filters],
  );
  const [visibilityRevision, setVisibilityRevision] = useState(0);
  const hiddenRetired = useRef(false);
  const owner = useMemo(
    () => ({ detailScope, active, filters: effectiveFilters, visibilityRevision }),
    [detailScope, active, effectiveFilters, visibilityRevision],
  );
  const currentOwner = useRef<typeof owner | null>(owner);
  currentOwner.current = owner;
  const mutation = useRef<{
    owner: typeof owner;
    id: string;
    selection: typeof selectedTask.current;
  } | null>(null);
  const [operation, setOperation] = useState<typeof mutation.current>(null);
  const saving = operation?.owner === owner && operation.id === detail?.id;
  useEffect(() => {
    currentOwner.current = owner;
    errorSource.current = null;
    setError("");
    setNotice("");
    return () => {
      if (currentOwner.current === owner) currentOwner.current = null;
    };
  }, [owner]);
  useEffect(() => {
    if (previousLocked.current === conversationId) return;
    previousLocked.current = conversationId;
    setDraft(lockedFilters);
    setFilters(lockedFilters);
  }, [conversationId, lockedFilters]);
  const pendingRevalidate = useRef(false);
  const detailRef = useRef<TaskDetail | null>(null);
  detailRef.current = detail;
  const listRef = useRef<TaskList | null>(null);
  listRef.current = list;

  const cancelPending = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
    pendingRevalidate.current = false;
    setLoading(false);
  }, []);

  const readDetail = useCallback(
    (id: string) => {
      if (currentOwner.current !== owner || !active || document.visibilityState === "hidden")
        return;
      pendingDetail.current?.cancel();
      pendingDetail.current = startRead((signal) => apiClient.getTask(id, signal), {
        success: (next) => {
          if (currentOwner.current !== owner || selectedTask.current?.id !== id) return;
          setDetailState({ scope: detailScope, value: next });
          if (errorSource.current === "detail") {
            errorSource.current = null;
            setError("");
          }
        },
        failure: (caught) => {
          if (currentOwner.current !== owner || selectedTask.current?.id !== id) return;
          setDetailState(null);
          errorSource.current = "detail";
          setError(errorText(caught));
        },
        settled: () => {
          if (currentOwner.current === owner && selectedTask.current?.id === id)
            pendingDetail.current = null;
        },
      });
    },
    [apiClient, active, owner, detailScope],
  );
  const refreshDetail = useCallback(() => {
    const selected = selectedTask.current;
    if (selected && selected.conversationId === detailScope.conversationId) readDetail(selected.id);
  }, [detailScope, readDetail]);
  useEffect(
    () =>
      scheduleSourceExpiry([detail?.expiresAt], () => {
        approvalSnapshot.current = null;
        setApproving(false);
        setCancelling(false);
        refreshDetail();
      }),
    [detail?.expiresAt, refreshDetail],
  );
  const load = useCallback(
    (cursor?: string, clear = false) => {
      if (currentOwner.current !== owner || !active || document.visibilityState === "hidden")
        return;
      const scopedConversationId = conversationId ?? effectiveFilters.conversationId;
      if (pending.current) {
        if (!clear && !cursor) {
          pendingRevalidate.current = true;
          return;
        }
        cancelPending();
      }
      setLoading(true);
      // A new filter generation clears the first page; event-driven reloads preserve content
      if (!cursor && clear) setList(null);
      // The server caps one page at 200; a background refresh re-reads the loaded range
      // page by page (50 per page along the current cursor) and stops early when the
      // server reports no more rows, instead of one over-limit request. A cleared filter
      // or a load-more click reads exactly one 50-row page.
      const loadedCount = listRef.current?.items.length ?? 0;
      const target = clear || cursor ? 0 : Math.max(0, loadedCount - 50);
      const isRefresh = !cursor && !clear;
      const existingItems = isRefresh ? (listRef.current?.items ?? []) : [];
      pending.current = startRead<TaskList>(
        async (signal, publish) => {
          let page = await apiClient.listTasks(
            {
              ...(effectiveFilters.status ? { status: effectiveFilters.status } : {}),
              ...(effectiveFilters.agentId ? { agentId: effectiveFilters.agentId } : {}),
              ...(scopedConversationId ? { conversationId: scopedConversationId } : {}),
              ...(effectiveFilters.originRunId
                ? { originRunId: effectiveFilters.originRunId }
                : {}),
              cursor,
              limit: 50,
            },
            signal,
          );
          if (cursor || clear) return page;

          // Background refresh of loaded range: publish the fresh first page immediately
          // with deduped tail so visible items are updated without waiting for later pages.
          let items = [...page.items];
          const newIds = new Set(page.items.map((i) => i.id));
          const dedupedTail = existingItems
            .slice(page.items.length)
            .filter((i) => !newIds.has(i.id));
          publish({
            items: page.hasMore ? [...page.items, ...dedupedTail] : page.items,
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
          });

          while (!signal.aborted && page.hasMore && page.nextCursor && items.length < target + 50) {
            page = await apiClient.listTasks(
              {
                ...(effectiveFilters.status ? { status: effectiveFilters.status } : {}),
                ...(effectiveFilters.agentId ? { agentId: effectiveFilters.agentId } : {}),
                ...(scopedConversationId ? { conversationId: scopedConversationId } : {}),
                ...(effectiveFilters.originRunId
                  ? { originRunId: effectiveFilters.originRunId }
                  : {}),
                cursor: page.nextCursor,
                limit: 50,
              },
              signal,
            );
            items = [...items, ...page.items];
            const allNewIds = new Set(items.map((i) => i.id));
            const remainingTail = existingItems
              .slice(items.length)
              .filter((i) => !allNewIds.has(i.id));
            publish({
              items: page.hasMore ? [...items, ...remainingTail] : items,
              nextCursor: page.nextCursor,
              hasMore: page.hasMore,
            });
          }
          return { ...page, items };
        },
        {
          progress: (intermediate) => {
            if (currentOwner.current !== owner) return;
            setList(intermediate);
            if (errorSource.current !== "detail") setError("");
          },
          success: (page) => {
            if (currentOwner.current !== owner) return;
            setList(
              cursor && listRef.current
                ? { ...page, items: [...listRef.current.items, ...page.items] }
                : page,
            );
            if (errorSource.current !== "detail") setError("");
          },
          failure: (caught) => {
            if (currentOwner.current !== owner) return;
            errorSource.current = "list";
            setError(errorText(caught));
          },
          settled: () => {
            if (currentOwner.current !== owner) return;
            isInitialRead.current = false;
            setLoading(false);
            pending.current = null;
            if (pendingRevalidate.current) {
              pendingRevalidate.current = false;
              if (active && document.visibilityState !== "hidden") load(undefined, false);
            }
          },
        },
      );
    },
    [apiClient, effectiveFilters, conversationId, cancelPending, active, owner],
  );

  const readScope = useRef<{
    apiClient: typeof apiClient;
    filters: FilterDraft;
    conversationId: string | undefined;
  } | null>(null);
  const suspend = useCallback(() => {
    // Document suspension retires both the domain operation and its confirmation invocation.
    if (document.visibilityState === "hidden" && !hiddenRetired.current) {
      hiddenRetired.current = true;
      currentOwner.current = null;
      setVisibilityRevision((revision) => revision + 1);
    }
    cancelPending();
    pendingDetail.current?.cancel();
    pendingDetail.current = null;
    mutation.current = null;
    setOperation(null);
    setApproving(false);
    setCancelling(false);
  }, [cancelPending]);
  const resume = useCallback(() => {
    hiddenRetired.current = false;
    const previous = readScope.current;
    const changed =
      !previous ||
      previous.apiClient !== apiClient ||
      previous.filters !== effectiveFilters ||
      previous.conversationId !== conversationId;
    readScope.current = { apiClient, filters: effectiveFilters, conversationId };
    load(undefined, changed);
    refreshDetail();
  }, [apiClient, effectiveFilters, conversationId, load, refreshDetail]);
  useForegroundRead(resume, cancelPending, {
    paused: !active,
    intervalMs: null,
    onSuspend: suspend,
  });

  useEffect(() => {
    if (!active) return;
    const targetConversationId = conversationId ?? effectiveFilters.conversationId;
    return addConversationChangeListener((event) => {
      const matches =
        event.event === "ready" ||
        (event.event === "conversation_changed" &&
          (!targetConversationId || event.conversationId === targetConversationId));
      if (!matches || document.visibilityState === "hidden") return;
      if (
        event.event === "ready" &&
        isInitialRead.current &&
        pending.current &&
        listRef.current === null
      )
        return;
      load(undefined, false);
      if (
        detailRef.current &&
        (!event.conversationId || detailRef.current.conversationId === event.conversationId)
      )
        refreshDetail();
    });
  }, [conversationId, effectiveFilters.conversationId, load, refreshDetail, active]);
  const updateDraft = <K extends keyof FilterDraft>(key: K, value: FilterDraft[K]) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  const applyFilters = () =>
    setFilters((previous) => (sameFilters(previous, draft) ? previous : { ...draft }));
  const clearFilters = () => {
    setDraft(lockedFilters);
    setFilters((previous) => (sameFilters(previous, lockedFilters) ? previous : lockedFilters));
  };
  const openDetail = (id: string) => {
    if (!active || currentOwner.current !== owner || document.visibilityState === "hidden") return;
    selectedTask.current = { conversationId: detailScope.conversationId, id };
    setApproving(false);
    setCancelling(false);
    setError("");
    setNotice("");
    if (detail?.id !== id) setDetailState(null);
    readDetail(id);
  };
  const mutate = async (approve?: boolean) => {
    if (
      !detail ||
      !active ||
      sourceExpired(detail.expiresAt) ||
      currentOwner.current !== owner ||
      document.visibilityState === "hidden" ||
      mutation.current?.owner === owner
    )
      return;
    const call = detail.calls.find((entry) => entry.status === "waiting_approval");
    if (approve !== undefined && !call?.approvalRevision) {
      setApproving(false);
      setNotice(t("connections.tasks.approvalUnavailable"));
      return;
    }
    const invocation = { owner, id: detail.id, selection: selectedTask.current };
    mutation.current = invocation;
    setOperation(invocation);
    setError("");
    setNotice("");
    const isCurrent = () => {
      const current = detailRef.current;
      const currentCall = current?.calls.find((entry) => entry.ordinal === call?.ordinal);
      return (
        mutation.current === invocation &&
        currentOwner.current === owner &&
        selectedTask.current === invocation.selection &&
        current?.id === detail.id &&
        current.conversationId === detail.conversationId &&
        current.agentId === detail.agentId &&
        (approve === undefined || currentCall?.approvalRevision === call?.approvalRevision) &&
        document.visibilityState !== "hidden"
      );
    };
    try {
      if (approve === undefined) await apiClient.cancelTask(detail.id);
      else if (call?.approvalRevision)
        await apiClient.approveTask(detail.id, {
          ordinal: call.ordinal,
          expectedApproval: call.approvalRevision,
          approve,
        });
      if (!isCurrent()) return;
      setApproving(false);
      setCancelling(false);
      setNotice(
        t(
          approve === undefined
            ? "connections.tasks.cancelled"
            : approve
              ? "connections.tasks.approved"
              : "connections.tasks.rejected",
        ),
      );
      readDetail(invocation.id);
      load();
    } catch (caught) {
      if (isCurrent()) setError(errorText(caught));
    } finally {
      if (mutation.current === invocation) {
        mutation.current = null;
        if (currentOwner.current === owner) setOperation(null);
      }
    }
  };
  const waiting = detail?.calls.find((entry) => entry.status === "waiting_approval");
  const approval =
    detail && waiting?.approvalRevision
      ? { name: waiting.name, argumentsText: waiting.argumentsPreview.text ?? null }
      : approvalSnapshot.current;
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
        <Button
          variant="outline"
          disabled={loading}
          disabledReason={t("hints.investigation.tasks.refreshLoading")}
          tooltip={t("hints.investigation.tasks.refresh")}
          onClick={() => load()}
        >
          <RefreshCw />
          {t("connections.common.refresh")}
        </Button>
      </div>
      <form
        className="flex flex-wrap items-end gap-4 rounded-xl border border-border/80 bg-card/60 p-4"
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
          <Button type="submit" tooltip={t("hints.investigation.tasks.applyFilters")}>
            {t("connections.tasks.applyFilters")}
          </Button>
          <Button
            type="button"
            variant="outline"
            tooltip={t("hints.investigation.tasks.clearFilters")}
            onClick={clearFilters}
          >
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
      <div className="overflow-hidden rounded-xl border border-border/80 bg-card">
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
          disabledReason={t("hints.investigation.tasks.loadingMore")}
          tooltip={t("hints.investigation.tasks.loadMore")}
          onClick={() => load(list.nextCursor ?? undefined)}
        >
          {t("connections.tasks.loadMore")}
        </Button>
      )}

      <Sheet
        open={active && detail !== null}
        onOpenChange={(open) => {
          if (!open && !saving) {
            pendingDetail.current?.cancel();
            pendingDetail.current = null;
            selectedTask.current = null;
            setDetailState(null);
            setApproving(false);
            setCancelling(false);
          }
        }}
      >
        <SheetContent scrollMode="surface" className="w-full  sm:max-w-2xl">
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
                    key={`${detail.id}:${call.ordinal}`}
                    task={detail}
                    call={call}
                    active={active}
                  />
                ))}
              </div>
              <div className="flex gap-2 border-t pt-5">
                {detail.status !== "completed" &&
                  detail.status !== "failed" &&
                  detail.status !== "cancelled" &&
                  detail.status !== "unknown" && (
                    <Button
                      variant="ghost"
                      tooltip={t("hints.investigation.tasks.cancel")}
                      onClick={() => setCancelling(true)}
                    >
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
                      disabledReason={
                        !waiting.approvalRevision
                          ? t("connections.tasks.approvalUnavailable")
                          : t("hints.investigation.tasks.saving")
                      }
                      tooltip={t("hints.investigation.tasks.reviewApproval")}
                      onClick={() => {
                        if (!detail || !waiting?.approvalRevision) return;
                        approvalSnapshot.current = {
                          name: waiting.name,
                          argumentsText: waiting.argumentsPreview.text ?? null,
                        };
                        setApproving(true);
                      }}
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
      <AlertDialog
        open={active && approving && Boolean(detail && waiting?.approvalRevision)}
        title={t("connections.tasks.approvalTitle")}
        onCancel={() => setApproving(false)}
        busy={saving}
      >
        <div className="space-y-3 text-sm">
          <p>{t("connections.tasks.approvalHint")}</p>
          <dl className="space-y-1">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{t("connections.tasks.tool")}</dt>
              <dd className="font-mono">{approval?.name}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">{t("connections.tasks.arguments")}</dt>
              <dd className="max-w-80 truncate font-mono text-xs">
                {approval?.argumentsText ?? t("connections.tasks.unavailable")}
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
            disabledReason={t("hints.investigation.tasks.saving")}
            data-dialog-cancel
            tooltip={t("hints.investigation.tasks.reject")}
            onClick={() => void mutate(false)}
          >
            {t("connections.tasks.reject")}
          </Button>
          <Button
            disabled={saving}
            disabledReason={t("hints.investigation.tasks.saving")}
            tooltip={t("hints.investigation.tasks.approve")}
            onClick={() => void mutate(true)}
          >
            {t("connections.tasks.approveOnce")}
          </Button>
        </div>
      </AlertDialog>
      <ConfirmDialog
        open={active && cancelling}
        message={t("connections.tasks.cancelConfirm")}
        busy={saving}
        onCancel={() => setCancelling(false)}
        onConfirm={() => mutate()}
        invocationOwner={owner}
      />
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
    formatDate(value, locale, { dateStyle: "short", timeStyle: "short" });
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
        <Button
          variant="ghost"
          size="sm"
          tooltip={t("hints.investigation.tasks.open")}
          onClick={onOpen}
        >
          {t("connections.tasks.open")}
        </Button>
      </TableCell>
    </TableRow>
  );
}

function CallRow({
  task,
  call,
  active,
}: {
  task: TaskDetail;
  call: TaskDetail["calls"][number];
  active: boolean;
}) {
  const { t } = useTranslation();
  const apiClient = useSuperstringStore((s) => s.apiClient);
  const scope = useMemo(
    () => ({
      apiClient,
      taskId: task.id,
      conversationId: task.conversationId,
      agentId: task.agentId,
      expiresAt: task.expiresAt,
      dataStatus: task.dataStatus,
      ordinal: call.ordinal,
      revision: call.revision,
      name: call.name,
      resultStatus: call.resultStatus,
    }),
    [
      apiClient,
      task.id,
      task.conversationId,
      task.agentId,
      task.expiresAt,
      task.dataStatus,
      call.ordinal,
      call.revision,
      call.name,
      call.resultStatus,
    ],
  );
  const currentScope = useRef<typeof scope | null>(scope);
  currentScope.current = scope;
  const [body, setBody] = useState<{
    scope: typeof scope;
    field: "arguments" | "result";
    value: TaskBodyPage;
  } | null>(null);
  const [failure, setFailure] = useState<{ scope: typeof scope; message: string } | null>(null);
  const page = body?.scope === scope ? body : null;
  const error = failure?.scope === scope ? failure.message : "";
  const pending = useRef<ReadTask | null>(null);
  const cancelRead = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
  }, []);
  const clear = useCallback(() => {
    cancelRead();
    setBody(null);
    setFailure(null);
  }, [cancelRead]);
  useEffect(() => {
    currentScope.current = scope;
    clear();
    return () => {
      cancelRead();
      if (currentScope.current === scope) currentScope.current = null;
    };
  }, [scope, clear, cancelRead]);
  useEffect(() => scheduleSourceExpiry([task.expiresAt], clear), [task.expiresAt, clear]);
  const retain = useCallback(() => {}, []);
  useForegroundRead(retain, clear, {
    paused: !active,
    intervalMs: null,
    onSuspend: cancelRead,
  });
  const read = (field: "arguments" | "result", offset = 0) => {
    if (
      !active ||
      document.visibilityState === "hidden" ||
      task.dataStatus !== "available" ||
      sourceExpired(task.expiresAt)
    )
      return;
    cancelRead();
    setFailure(null);
    pending.current = startRead(
      (signal) => apiClient.getTaskBody(task.id, call.ordinal, field, offset, 2048, signal),
      {
        success: (value) => {
          if (currentScope.current === scope && !sourceExpired(task.expiresAt))
            setBody({ scope, field, value });
        },
        failure: (caught) => {
          if (currentScope.current === scope) setFailure({ scope, message: errorText(caught) });
        },
        settled: () => {
          if (currentScope.current === scope) pending.current = null;
        },
      },
    );
  };
  return (
    <section className="space-y-2.5 rounded-xl border border-border/80 bg-card/50 p-4 text-sm">
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
            tooltip={t("hints.investigation.tasks.arguments")}
            onClick={() => (page?.field === "arguments" ? clear() : read("arguments"))}
          >
            {t("connections.tasks.arguments")}
          </Button>
          {call.resultStatus === "available" && (
            <Button
              variant="ghost"
              size="sm"
              tooltip={t("hints.investigation.tasks.result")}
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
                tooltip={t("hints.investigation.tasks.nextPage")}
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
