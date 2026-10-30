import { Check, Copy, Pause, Play, RefreshCw, Terminal, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  QqManagedEventKind,
  QqManagedEventView,
} from "../../../shared/contracts/qq-managed-events";
import { SettingsGroup } from "../../components/settings-group";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";

export interface QqManagedMessageStreamProps {
  events: QqManagedEventView[];
  connected: boolean;
  active?: boolean;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  onClear?: () => void;
  maxEvents?: number;
}

const typeBadgeVariant: Record<QqManagedEventKind, "secondary" | "outline"> = {
  message: "secondary",
  notice: "outline",
  request: "outline",
  meta_event: "outline",
};

function formatEventSource(
  view: QqManagedEventView,
  t: (key: string, def: string) => string,
): string | null {
  const e = view.event;
  if (e.kind === "message") {
    const label =
      e.message_type === "group"
        ? t("connections.stream.source.group", "群:")
        : t("connections.stream.source.user", "用户:");
    return `${label}${e.peer_id}`;
  }
  if (e.kind === "notice") {
    if (e.group_id) return `${t("connections.stream.source.group", "群:")}${e.group_id}`;
    if (e.user_id) return `${t("connections.stream.source.user", "用户:")}${e.user_id}`;
  }
  if (e.kind === "request") {
    if (e.group_id) return `${t("connections.stream.source.group", "群:")}${e.group_id}`;
    if (e.user_id) return `${t("connections.stream.source.user", "用户:")}${e.user_id}`;
  }
  return null;
}

function formatEventSender(view: QqManagedEventView): string | null {
  const e = view.event;
  if (e.kind === "message" && e.sender_id) return `<${e.sender_id}>`;
  if (e.kind === "notice") {
    if (e.operator_id) return `op:${e.operator_id}`;
    if (e.user_id) return `<${e.user_id}>`;
  }
  if (e.kind === "request" && e.user_id) {
    return `<${e.user_id}>`;
  }
  return null;
}

function formatEventSummary(
  view: QqManagedEventView,
  t: (key: string, def: string) => string,
): string {
  const e = view.event;
  if (e.kind === "message") {
    if (view.preview_state === "available" && view.message_preview) {
      return view.message_preview;
    }
    if (view.preview_state === "unbound") {
      return t("connections.stream.preview.unbound", "未绑定，正文不可用");
    }
    if (view.preview_state === "expired") {
      return t("connections.stream.preview.expired", "正文已到期");
    }
    return `[${e.sub_type}] ${e.message_type}`;
  }
  if (e.kind === "notice") {
    return `[${e.notice_type}]` + (e.sub_type ? ` ${e.sub_type}` : "");
  }
  if (e.kind === "request") {
    return `[${e.request_type}]` + (e.sub_type ? ` ${e.sub_type}` : "");
  }
  if (e.kind === "meta_event") {
    if (e.heartbeat) {
      const interval = e.heartbeat.interval_ms ? ` ${e.heartbeat.interval_ms}ms` : "";
      return `heartbeat${interval} online=${e.heartbeat.online}`;
    }
    return `[${e.meta_event_type}]` + (e.sub_type ? ` ${e.sub_type}` : "");
  }
  return "";
}

export function QqManagedMessageStream({
  events,
  connected,
  active = true,
  loading = false,
  error = null,
  onRefresh,
  onClear,
}: QqManagedMessageStreamProps) {
  const { t } = useTranslation();
  const [filterType, setFilterType] = useState<string>("all");
  const [autoFollow, setAutoFollow] = useState(true);
  const [lastSeenSequence, setLastSeenSequence] = useState<number | null>(
    events.length > 0 ? events[events.length - 1].sequence : null,
  );
  const [selectedSequence, setSelectedSequence] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  // When component becomes inactive, immediately clear selected sequence so no stale modal can remain open
  useEffect(() => {
    if (!active) {
      setSelectedSequence(null);
    }
  }, [active]);

  const filteredEvents = useMemo(() => {
    if (filterType === "all") return events;
    return events.filter((e) => e.event.kind === filterType);
  }, [events, filterType]);

  // Derive selectedEvent strictly from current events and active flag.
  // If active is false or event is not found in events (e.g. cleared/expired), modal closes immediately.
  const selectedEvent = useMemo(() => {
    if (!active || selectedSequence === null) return null;
    return events.find((e) => e.sequence === selectedSequence) ?? null;
  }, [active, events, selectedSequence]);

  // Unread count based on unseen sequence numbers
  const newUnreadCount = useMemo(() => {
    if (autoFollow || lastSeenSequence === null) return 0;
    const lastIndex = events.findIndex((e) => e.sequence === lastSeenSequence);
    if (lastIndex === -1) {
      return events.length;
    }
    return Math.max(0, events.length - 1 - lastIndex);
  }, [events, autoFollow, lastSeenSequence]);

  useEffect(() => {
    if (autoFollow && containerRef.current && events.length > 0) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setLastSeenSequence(events[events.length - 1].sequence);
    }
  }, [events, autoFollow]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 16;
    if (!isAtBottom && autoFollow) {
      setAutoFollow(false);
      if (events.length > 0) {
        setLastSeenSequence(events[events.length - 1].sequence);
      }
    } else if (isAtBottom && !autoFollow) {
      setAutoFollow(true);
      if (events.length > 0) {
        setLastSeenSequence(events[events.length - 1].sequence);
      }
    }
  }, [autoFollow, events]);

  const handleToggleFollow = () => {
    if (!autoFollow) {
      setAutoFollow(true);
      if (events.length > 0) {
        setLastSeenSequence(events[events.length - 1].sequence);
      }
      if (containerRef.current) {
        containerRef.current.scrollTop = containerRef.current.scrollHeight;
      }
    } else {
      setAutoFollow(false);
      if (events.length > 0) {
        setLastSeenSequence(events[events.length - 1].sequence);
      }
    }
  };

  const handleScrollToLatest = () => {
    setAutoFollow(true);
    if (events.length > 0) {
      setLastSeenSequence(events[events.length - 1].sequence);
    }
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  };

  const handleCopyJson = async () => {
    if (!selectedEvent) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(selectedEvent, null, 2));
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, 2000);
    } catch {
      // ignore clipboard failure
    }
  };

  return (
    <SettingsGroup title={t("connections.stream.title", "QQ 协议事件流")} icon={Terminal}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 settings-content-padding">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {error ? (
            <Badge
              variant="outline"
              className="rounded-md border-destructive/40 px-1.5 py-0 text-xs font-mono font-medium text-destructive"
            >
              {t("connections.stream.status.error", "错误")}
            </Badge>
          ) : (
            <Badge
              variant={connected ? "secondary" : "outline"}
              className="rounded-md px-1.5 py-0 text-xs font-mono font-medium"
            >
              {connected
                ? t("connections.stream.status.connected", "已连接")
                : t("connections.stream.status.disconnected", "未连接")}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground font-mono">
            ({filteredEvents.length} {t("connections.stream.items", "条")})
          </span>
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={onRefresh}
              tooltip={t("connections.stream.refresh", "刷新")}
            >
              <RefreshCw className={loading ? "animate-spin" : undefined} />
              {t("connections.stream.refresh", "刷新")}
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={handleToggleFollow}
            tooltip={
              autoFollow
                ? t("connections.stream.pauseFollow", "暂停跟随")
                : t("connections.stream.resumeFollow", "跟随最新")
            }
          >
            {autoFollow ? (
              <>
                <Pause className="mr-1 size-3" />
                {t("connections.stream.pauseFollow", "暂停跟随")}
              </>
            ) : (
              <>
                <Play className="mr-1 size-3" />
                {t("connections.stream.resumeFollow", "跟随最新")}
              </>
            )}
          </Button>

          {onClear && (
            <Button
              variant="outline"
              size="sm"
              onClick={onClear}
              tooltip={t("connections.stream.clear", "清空")}
            >
              <Trash2 />
              {t("connections.stream.clear", "清空")}
            </Button>
          )}
        </div>
      </div>

      {/* Error notification bar */}
      {error && (
        <div
          role="alert"
          className="flex items-center justify-between gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive font-sans"
        >
          <span>{error}</span>
          {onRefresh && (
            <Button
              variant="outline"
              size="sm"
              disabled={loading}
              onClick={onRefresh}
              className="h-6 px-2 text-xs"
            >
              {t("connections.stream.retry", "重试")}
            </Button>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="min-w-0 px-4 py-3 sm:px-5">
        <Tabs value={filterType} onValueChange={setFilterType} className="w-full">
          <TabsList
            presentation="compact"
            flow="wrap"
            className="flex w-fit max-w-full justify-start gap-1"
          >
            <TabsTrigger value="all" className="min-h-8 px-3 text-[12.5px]">
              {t("connections.stream.filter.all", "全部")}
            </TabsTrigger>
            <TabsTrigger value="message" className="min-h-8 px-3 text-[12.5px]">
              {t("connections.stream.filter.message", "消息")}
            </TabsTrigger>
            <TabsTrigger value="notice" className="min-h-8 px-3 text-[12.5px]">
              {t("connections.stream.filter.notice", "通知")}
            </TabsTrigger>
            <TabsTrigger value="request" className="min-h-8 px-3 text-[12.5px]">
              {t("connections.stream.filter.request", "请求")}
            </TabsTrigger>
            <TabsTrigger value="meta_event" className="min-h-8 px-3 text-[12.5px]">
              {t("connections.stream.filter.meta_event", "元事件")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Dense CLI event container */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="relative max-h-72 min-h-[160px] overflow-y-auto p-2 font-mono text-xs leading-normal select-text"
      >
        {loading && events.length === 0 ? (
          <div className="flex h-36 items-center justify-center gap-2 text-xs text-muted-foreground font-sans">
            <RefreshCw className="size-3.5 animate-spin" />
            <span>{t("connections.stream.loading", "正在加载事件...")}</span>
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="flex h-36 items-center justify-center text-xs text-muted-foreground font-sans">
            {t("connections.stream.empty", "暂无协议事件")}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filteredEvents.map((view) => {
              const timeStr = new Date(view.event.occurred_at_seconds * 1000)
                .toTimeString()
                .split(" ")[0];
              const sourceLabel = formatEventSource(view, t);
              const senderLabel = formatEventSender(view);
              const summaryText = formatEventSummary(view, t);

              return (
                <button
                  type="button"
                  key={view.sequence}
                  data-stream-row={view.sequence}
                  onClick={() => setSelectedSequence(view.sequence)}
                  className="group flex w-full min-w-0 cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-2 py-0.5 text-left hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-primary outline-none transition-colors"
                >
                  <span className="shrink-0 text-muted-foreground/80">[{timeStr}]</span>
                  <Badge
                    variant={typeBadgeVariant[view.event.kind] ?? "outline"}
                    className="shrink-0 rounded px-1 py-0 text-xs font-mono uppercase"
                  >
                    {view.event.kind}
                  </Badge>
                  {sourceLabel && (
                    <span className="shrink-0 text-muted-foreground">{sourceLabel}</span>
                  )}
                  {senderLabel && (
                    <span className="shrink-0 font-medium text-foreground">{senderLabel}</span>
                  )}
                  <span className="min-w-0 flex-1 basis-36 truncate text-foreground/90 group-hover:text-foreground">
                    {summaryText}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Floating unread banner when follow is paused */}
        {newUnreadCount > 0 && (
          <div className="sticky bottom-2 flex justify-center">
            <button
              type="button"
              onClick={handleScrollToLatest}
              className="flex items-center gap-1.5 rounded-full border border-border bg-popover px-3 py-1 text-xs font-sans font-medium text-popover-foreground shadow-md hover:bg-muted focus-visible:ring-1 focus-visible:ring-primary outline-none transition-colors"
            >
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              {t("connections.stream.newEventsAvailable", {
                count: newUnreadCount,
                defaultValue: `有 ${newUnreadCount} 条新事件 · 点击滚至最新`,
              })}
            </button>
          </div>
        )}
      </div>

      {/* Detail modal using standard DialogClose & semantic close */}
      <Dialog
        open={selectedEvent !== null}
        onOpenChange={(open) => !open && setSelectedSequence(null)}
      >
        <DialogContent scrollMode="surface" className="max-w-lg font-mono text-xs">
          <DialogHeader>
            <DialogTitle className="workspace-dialog-title font-sans">
              {t("connections.stream.detail.title", "事件结构详情")}
            </DialogTitle>
            <DialogDescription className="font-sans text-xs text-muted-foreground">
              {t("connections.stream.detail.sanitizedNotice", "仅展示当前授权投影字段")}
            </DialogDescription>
          </DialogHeader>

          {selectedEvent && (
            <div className="max-h-80 overflow-y-auto rounded-lg border border-border bg-muted/40 p-3">
              <pre className="whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(selectedEvent, null, 2)}
              </pre>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyJson}
              className="h-8 text-xs font-sans"
            >
              {copied ? (
                <>
                  <Check className="mr-1.5 size-3" />
                  {t("connections.stream.detail.copied", "已复制")}
                </>
              ) : (
                <>
                  <Copy className="mr-1.5 size-3" />
                  {t("connections.stream.detail.copy", "复制 JSON")}
                </>
              )}
            </Button>
            <DialogClose asChild>
              <Button
                variant="outline"
                size="sm"
                data-testid="detail-close-btn"
                className="h-8 text-xs font-sans"
              >
                <X className="mr-1.5 size-3" />
                {t("connections.stream.detail.close", "关闭")}
              </Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  );
}
