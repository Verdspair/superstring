// 运行数据与保留：只读存储统计 + 手动清理（先预览、再确认、不可恢复）。
//
// 判定全部在服务端：`expired` 用服务端时钟，前端只做展示；手动清理不是自动策略的替代，
// 60 秒自动清扫照常运行，且不删除消息、记忆等用户内容（用户内容不设 TTL）。

import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UUID_REGEX } from "../../../shared/contracts/common";
import type {
  RuntimeStorageCategory,
  RuntimeStorageCleanupRequest,
  RuntimeStorageCleanupResult,
  RuntimeStorageItem,
  RuntimeStorageItemsPage,
  RuntimeStorageStatusFilter,
} from "../../../shared/contracts/runtime-observability";
import { ConfirmDialog } from "../../components/confirmation";
import { Field } from "../../components/form-field";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { formatDate } from "../../i18n/runtime";
import { type ReadTask, startRead } from "../../services/read-task";
import { useForegroundRead } from "../../services/use-foreground-read";
import { useLiveResource } from "../../services/use-live-resource";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";
import { channelLabels, statusLabels } from "../observability/labels";

const P = "connections.execution.runtimeStorage";
const PAGE_SIZE = 50;
const CATEGORIES: readonly RuntimeStorageCategory[] = ["traces", "contexts", "task_payloads"];
const STATUS_FILTERS: readonly RuntimeStorageStatusFilter[] = ["all", "live", "expired"];
const categoryLabels: Record<RuntimeStorageCategory, string> = {
  traces: `${P}.categoryTraces`,
  contexts: `${P}.categoryContexts`,
  task_payloads: `${P}.categoryTaskPayloads`,
};
const statusFilterLabels: Record<RuntimeStorageStatusFilter, string> = {
  all: "observability.all",
  live: `${P}.statusLive`,
  expired: `${P}.statusExpired`,
};
const contextStatusLabels: Record<"exact" | "expired" | "revoked", string> = {
  exact: `${P}.contextStatusExact`,
  expired: `${P}.contextStatusExpired`,
  revoked: `${P}.contextStatusRevoked`,
};

export function runtimeStorageItemId(item: RuntimeStorageItem): string {
  switch (item.kind) {
    case "trace":
      return item.traceId;
    case "context":
      return item.stepId;
    case "task_payload":
      return item.taskId;
  }
}

/** 行内可清理 = 已到期且没有保全标记；上下文快照只有正文副本可清。 */
export function runtimeStorageItemEligible(item: RuntimeStorageItem): boolean {
  if (!item.expired) return false;
  switch (item.kind) {
    case "trace":
      return !item.protected;
    case "context":
      return item.hasProtectedBody;
    case "task_payload":
      return !item.protected;
  }
}

export function RuntimeStoragePanel({ active = true }: { active?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const api = useSuperstringStore((s) => s.apiClient);
  const [category, setCategory] = useState<RuntimeStorageCategory>("traces");
  const [status, setStatus] = useState<RuntimeStorageStatusFilter>("all");
  const [agentFilter, setAgentFilter] = useState("");
  const [conversationFilter, setConversationFilter] = useState("");
  const [appliedIds, setAppliedIds] = useState<{ agentId?: string; conversationId?: string }>({});
  const [filterProblem, setFilterProblem] = useState(false);
  const [position, setPosition] = useState(0);
  const trail = useRef<(string | null)[]>([null]);
  const [page, setPage] = useState<RuntimeStorageItemsPage | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [preview, setPreview] = useState<{
    request: RuntimeStorageCleanupRequest;
    result: RuntimeStorageCleanupResult;
  } | null>(null);
  const [outcome, setOutcome] = useState<{
    category: RuntimeStorageCategory;
    result: RuntimeStorageCleanupResult;
  } | null>(null);
  const pending = useRef<ReadTask | null>(null);
  const writeToken = useRef(0);
  const busyRef = useRef(false);

  const summary = useLiveResource(
    useCallback((signal: AbortSignal) => api.getRuntimeStorage(signal), [api]),
    { paused: !active },
  );

  const load = useCallback(() => {
    if (pending.current) return;
    const cursor = trail.current[position] ?? undefined;
    setListLoading(true);
    setListError("");
    const task = startRead(
      (signal) =>
        api.listRuntimeStorageItems(
          {
            category,
            status,
            limit: PAGE_SIZE,
            ...(cursor ? { cursor } : {}),
            ...(appliedIds.agentId ? { agentId: appliedIds.agentId } : {}),
            ...(appliedIds.conversationId ? { conversationId: appliedIds.conversationId } : {}),
          },
          signal,
        ),
      {
        success: (result) => {
          if (pending.current !== task) return;
          setPage(result);
        },
        failure: (cause) => {
          if (pending.current !== task) return;
          setPage(null);
          setListError(errorText(cause));
        },
        settled: () => {
          if (pending.current !== task) return;
          pending.current = null;
          setListLoading(false);
        },
      },
    );
    pending.current = task;
  }, [api, appliedIds, category, position, status]);

  const cancel = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
    setListLoading(false);
  }, []);

  const clear = useCallback(() => {
    cancel();
    setPage(null);
    setListError("");
  }, [cancel]);
  // 作用域（类别/页位/筛选）变化时 load 依赖更新，由 useForegroundRead onSuspend 统一取消在途读取，
  // 再执行新的 load()；task identity 守卫配合 startRead 同步 abort 阻断迟到响应。
  useForegroundRead(load, clear, { paused: !active, onSuspend: cancel });

  // 迟到响应不允许落在别的类别页：离开面板后作废仍未完成的手动清理。
  useEffect(
    () => () => {
      writeToken.current += 1;
    },
    [],
  );

  const resetTrail = () => {
    trail.current = [null];
    setPosition(0);
  };

  const switchCategory = (next: RuntimeStorageCategory) => {
    if (next === category) return;
    resetTrail();
    setCategory(next);
    setSelected([]);
    setOutcome(null);
    setActionError("");
  };

  const switchStatus = (next: RuntimeStorageStatusFilter) => {
    if (next === status) return;
    resetTrail();
    setStatus(next);
    setSelected([]);
    setOutcome(null);
    setActionError("");
  };

  const applyFilters = () => {
    const agent = agentFilter.trim();
    const conversation = conversationFilter.trim();
    const valid = (value: string) => value === "" || UUID_REGEX.test(value);
    if (!valid(agent) || !valid(conversation)) {
      setFilterProblem(true);
      return;
    }
    setFilterProblem(false);
    resetTrail();
    setSelected([]);
    setOutcome(null);
    setActionError("");
    setAppliedIds({
      ...(agent ? { agentId: agent } : {}),
      ...(conversation ? { conversationId: conversation } : {}),
    });
  };

  const goNext = () => {
    const cursor = page?.nextCursor;
    if (!page?.hasMore || !cursor) return;
    trail.current[position + 1] = cursor;
    setPosition(position + 1);
    setSelected([]);
  };

  const goPrev = () => {
    if (position === 0) return;
    setPosition(position - 1);
    setSelected([]);
  };

  const toggleSelected = (id: string, checked: boolean) => {
    setSelected((previous) =>
      checked
        ? previous.includes(id)
          ? previous
          : [...previous, id]
        : previous.filter((value) => value !== id),
    );
  };

  const beginPreview = async (request: RuntimeStorageCleanupRequest) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const token = ++writeToken.current;
    setBusy(true);
    setActionError("");
    setOutcome(null);
    try {
      const result = await api.previewRuntimeStorageCleanup(request);
      if (writeToken.current !== token) return;
      setPreview({ request, result });
    } catch (cause) {
      if (writeToken.current === token) setActionError(errorText(cause));
    } finally {
      if (writeToken.current === token) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  // 确认执行的是预览时保存的目标快照，而不是此刻的勾选；取消不产生任何写入。
  const confirmCleanup = async () => {
    const snapshot = preview;
    if (!snapshot || busyRef.current) return;
    busyRef.current = true;
    const token = ++writeToken.current;
    setBusy(true);
    setActionError("");
    try {
      const result = await api.runRuntimeStorageCleanup(snapshot.request);
      if (writeToken.current !== token) return;
      setOutcome({ category: snapshot.request.category, result });
      setPreview(null);
      setSelected([]);
      summary.refresh();
      load();
    } catch (cause) {
      if (writeToken.current === token) {
        setPreview(null);
        setActionError(errorText(cause));
      }
    } finally {
      if (writeToken.current === token) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const traceStatusText = (value: string) => {
    const label = statusLabels[value];
    return label ? t(label) : value;
  };
  const channelsText = (channels: readonly string[]) =>
    channels.map((value) => t(channelLabels[value] ?? value)).join(" / ");
  const statusText = (item: RuntimeStorageItem) => {
    switch (item.kind) {
      case "trace":
        return traceStatusText(item.status);
      case "context":
        return t(contextStatusLabels[item.status]);
      case "task_payload":
        return t(`connections.tasks.status.${item.status}`);
    }
  };
  const detailText = (item: RuntimeStorageItem) => {
    switch (item.kind) {
      case "trace":
        return [
          t(`${P}.spansCount`, { "0": item.spanCount }),
          channelsText(item.channels),
          t(`${P}.lastActivity`, { "0": formatDate(item.lastActivityAt, locale) }),
        ].join(" · ");
      case "context":
        return [
          t(`${P}.sources`, { "0": item.sourceCount }),
          t(`${P}.lastActivity`, { "0": formatDate(item.at, locale) }),
        ].join(" · ");
      case "task_payload":
        return [
          t(`${P}.calls`, { "0": item.callCount, "1": item.payloadCallCount }),
          t(`${P}.lastActivity`, { "0": formatDate(item.updatedAt, locale) }),
        ].join(" · ");
    }
  };
  const protectionBadge = (item: RuntimeStorageItem) => {
    if (item.kind === "context") return item.hasProtectedBody ? t(`${P}.contextBodyBadge`) : null;
    return item.protected ? t(`${P}.protectedBadge`) : null;
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <p className="font-medium">{t(`${P}.title`)}</p>
          <p className="text-xs text-muted-foreground">{t(`${P}.autoNote`)}</p>
          <p className="text-xs text-muted-foreground">{t(`${P}.userContentNote`)}</p>
        </div>
        <Button
          variant="outline"
          disabled={summary.loading || busy}
          onClick={() => summary.refresh()}
        >
          <RefreshCw />
          {t(`${P}.refresh`)}
        </Button>
      </div>
      {summary.loading && (
        <p className="text-sm text-muted-foreground">{t("connections.common.loading")}</p>
      )}
      {summary.error && (
        <p className="text-xs text-destructive" aria-live="polite">
          {t(`${P}.summaryError`, { "0": summary.error })}
        </p>
      )}
      {summary.data && (
        <div className="space-y-1 text-sm">
          <p className="text-muted-foreground">
            {t(`${P}.retentionLine`, {
              "0": summary.data.retention.traceRetentionDays,
              "1": summary.data.retention.traceRetentionDefaultDays,
              "2": summary.data.retention.traceRetentionMinDays,
              "3": summary.data.retention.traceRetentionMaxDays,
            })}
          </p>
          <p className="text-muted-foreground">
            {t(`${P}.tracesLine`, {
              "0": summary.data.traces.live,
              "1": summary.data.traces.expired,
              "2": summary.data.traces.started,
              "3": summary.data.traces.unknown,
            })}
          </p>
          <p className="text-muted-foreground">
            {t(`${P}.spansLine`, {
              "0": summary.data.spans.live,
              "1": summary.data.spans.expired,
            })}
          </p>
          <p className="text-muted-foreground">
            {t(`${P}.contextsLine`, {
              "0": summary.data.contexts.live,
              "1": summary.data.contexts.expired,
              "2": summary.data.contexts.revoked,
              "3": summary.data.contexts.withProtectedBody,
              "4": summary.data.contexts.expiredProtectedBodies,
            })}
          </p>
          <p className="text-muted-foreground">
            {t(`${P}.payloadsLine`, {
              "0": summary.data.taskPayloads.live,
              "1": summary.data.taskPayloads.expired,
              "2": summary.data.taskPayloads.protected,
              "3": summary.data.taskPayloads.removable,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(`${P}.scopeNote`, {
              "0": summary.data.cleanupScope.protectedTraceStatuses
                .map(traceStatusText)
                .join(" / "),
              "1": summary.data.cleanupScope.protectedTaskStatuses
                .map((value) => t(`connections.tasks.status.${value}`))
                .join(" / "),
              "2": summary.data.cleanupScope.protectedCallStatuses
                .map((value) => t(`connections.tasks.status.${value}`))
                .join(" / "),
              "3": summary.data.cleanupScope.contextClearedFields.join(", "),
              "4": summary.data.cleanupScope.taskClearedFields.join(", "),
            })}
          </p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          value={category}
          onValueChange={(value) => switchCategory(value as RuntimeStorageCategory)}
          className="min-w-0 max-w-full"
        >
          <TabsList
            aria-label={t(`${P}.categoryLabel`)}
            className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-auto [&_[role=tab]]:min-h-8 [&_[role=tab]]:max-w-full [&_[role=tab]]:flex-none [&_[role=tab]]:whitespace-normal"
          >
            {CATEGORIES.map((value) => (
              <TabsTrigger key={value} value={value} disabled={busy}>
                {t(categoryLabels[value])}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Tabs
          value={status}
          onValueChange={(value) => switchStatus(value as RuntimeStorageStatusFilter)}
          className="min-w-0 max-w-full"
        >
          <TabsList
            aria-label={t(`${P}.statusLabel`)}
            className="max-w-full flex-wrap gap-1 group-data-horizontal/tabs:h-auto [&_[role=tab]]:h-auto [&_[role=tab]]:min-h-8 [&_[role=tab]]:max-w-full [&_[role=tab]]:flex-none [&_[role=tab]]:whitespace-normal"
          >
            {STATUS_FILTERS.map((value) => (
              <TabsTrigger key={value} value={value} disabled={busy}>
                {t(statusFilterLabels[value])}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="flex min-w-0 max-w-full flex-wrap items-end gap-2">
        <Field label={`${P}.filterAgentId`}>
          <Input
            className="w-56 min-w-0 max-w-full"
            value={agentFilter}
            disabled={busy}
            onChange={(event) => setAgentFilter(event.target.value)}
          />
        </Field>
        <Field label={`${P}.filterConversationId`}>
          <Input
            className="w-56 min-w-0 max-w-full"
            value={conversationFilter}
            disabled={busy}
            onChange={(event) => setConversationFilter(event.target.value)}
          />
        </Field>
        <Button variant="outline" disabled={busy} onClick={applyFilters}>
          {t("observability.applyFilters")}
        </Button>
      </div>
      {filterProblem && (
        <p className="text-xs text-destructive" aria-live="polite">
          {t(`${P}.filterInvalid`)}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={busy || selected.length === 0}
          onClick={() => void beginPreview({ category, ids: [...selected] })}
        >
          <Trash2 />
          {t(`${P}.cleanSelected`)}
        </Button>
        <Button variant="outline" disabled={busy} onClick={() => void beginPreview({ category })}>
          <Trash2 />
          {t(`${P}.cleanCategory`)}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t(`${P}.selectedCount`, { "0": selected.length })}
        </span>
      </div>
      {actionError && (
        <p className="text-sm text-destructive" aria-live="polite">
          {t(`${P}.actionError`, { "0": actionError })}
        </p>
      )}
      {outcome && (
        <div role="status" className="space-y-1 rounded-md border bg-muted/40 p-3 text-sm">
          <p className="font-medium">{t("connections.storage.cleaned")}</p>
          <p className="text-muted-foreground">
            {t(`${P}.resultLine`, {
              "0": outcome.result.removed,
              "1": outcome.result.expired,
              "2": outcome.result.protected,
              "3": outcome.result.matched,
              "4": outcome.result.missing,
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(`${P}.resultCategory`, { "0": t(categoryLabels[outcome.category]) })}
          </p>
          {outcome.result.truncated && (
            <p className="text-xs text-muted-foreground">{t(`${P}.truncated`)}</p>
          )}
        </div>
      )}
      {listError && (
        <div
          className="flex flex-wrap items-center gap-2 text-sm text-destructive"
          aria-live="polite"
        >
          <span>{t(`${P}.itemsError`, { "0": listError })}</span>
          <Button variant="outline" disabled={listLoading || busy} onClick={load}>
            {t("capabilities.retry")}
          </Button>
        </div>
      )}
      {listLoading && !page && (
        <p className="text-sm text-muted-foreground">{t("connections.common.loading")}</p>
      )}
      {page && page.items.length === 0 && !listLoading && (
        <p className="text-sm text-muted-foreground">{t(`${P}.empty`)}</p>
      )}
      {page && page.items.length > 0 && (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <span className="sr-only">{t(`${P}.columnSelect`)}</span>
                </TableHead>
                <TableHead>{t(`${P}.columnId`)}</TableHead>
                <TableHead>{t(`${P}.columnStatus`)}</TableHead>
                <TableHead>{t(`${P}.columnDetail`)}</TableHead>
                <TableHead>{t(`${P}.columnExpires`)}</TableHead>
                <TableHead>{t(`${P}.columnProtection`)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((item) => {
                const id = runtimeStorageItemId(item);
                const eligible = runtimeStorageItemEligible(item);
                const badge = protectionBadge(item);
                return (
                  <TableRow key={`${item.kind}:${id}`}>
                    <TableCell>
                      {eligible ? (
                        <Checkbox
                          checked={selected.includes(id)}
                          disabled={busy}
                          aria-label={t(`${P}.selectRow`, { "0": id })}
                          onCheckedChange={(next) => toggleSelected(id, next === true)}
                        />
                      ) : (
                        <span aria-hidden="true" className="text-muted-foreground">
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-64 font-mono text-xs whitespace-normal break-words">
                      {id}
                    </TableCell>
                    <TableCell>{statusText(item)}</TableCell>
                    <TableCell className="max-w-80 text-xs text-muted-foreground whitespace-normal break-words">
                      {detailText(item)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {item.expiresAt ? formatDate(item.expiresAt, locale) : "—"}
                    </TableCell>
                    <TableCell>{badge ? <Badge variant="outline">{badge}</Badge> : null}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {t(`${P}.listSummary`, {
                "0": page.summary.total,
                "1": page.summary.live,
                "2": page.summary.expired,
              })}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                disabled={position === 0 || listLoading || busy}
                onClick={goPrev}
              >
                {t(`${P}.prev`)}
              </Button>
              <Button
                variant="outline"
                disabled={!page.hasMore || listLoading || busy}
                onClick={goNext}
              >
                {t(`${P}.next`)}
              </Button>
            </div>
          </div>
        </>
      )}
      {preview && (
        <ConfirmDialog
          message={t(`${P}.previewLine`, {
            "0": preview.result.removable,
            "1": preview.result.expired,
            "2": preview.result.protected,
            "3": preview.result.matched,
          })}
          confirmLabel={t(`${P}.confirm`)}
          busy={busy}
          onConfirm={confirmCleanup}
          onCancel={() => setPreview(null)}
        />
      )}
    </section>
  );
}
