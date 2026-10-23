import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationEventView } from "../../../shared/contracts/conversation";
import { addConversationChangeListener } from "../../services/conversation-changes";
import {
  loadQqEventsCache,
  removeQqEventsCache,
  saveQqEventsCache,
} from "../../services/page-snapshot-cache";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";

export type HistoryChange = "initial" | "older" | "refresh" | "clear";
export type BeforeHistoryChange = (kind: HistoryChange, next: ConversationEventView[]) => void;

function lapsedAt(row: ConversationEventView, now: number): boolean {
  return Boolean(
    (row.source?.expiresAt && now >= Date.parse(row.source.expiresAt)) ||
      row.sources.some((source) => source.expiresAt && now >= Date.parse(source.expiresAt)),
  );
}

function redactEvent(
  item: ConversationEventView,
  contentState: ConversationEventView["contentState"] = "unavailable",
): ConversationEventView {
  return {
    ...item,
    text: null,
    contentState,
    media: item.media.map((media) => ({
      ...media,
      description: null,
      availability: "unavailable",
    })),
    qqMessageFacts: [],
  };
}

/** New arrivals do not wait for older pages; loaded projections still revalidate expiry. */
export function useConversationEvents(
  id: string,
  beforeChange?: BeforeHistoryChange,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const api = useSuperstringStore((s) => s.apiClient);
  const sessionStateStorage = useSuperstringStore((s) => s.sessionStateStorage);
  const conversation = useSuperstringStore((s) => s.summaryById[id]);
  const agentId = conversation?.agentId ?? null;
  const bindingEpoch = conversation?.bindingEpoch ?? null;
  const [items, setItems] = useState<ConversationEventView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const first = useRef(0);
  const current = useRef(items);
  const notify = useRef(beforeChange);
  notify.current = beforeChange;
  const rangeRead = useRef<AbortController | null>(null);
  const tailRead = useRef<AbortController | null>(null);
  const pendingRevalidate = useRef(false);
  const wantedSeq = useRef(0);
  const revalidateRef = useRef<() => void>(() => {});
  const readState = useRef<"unsettled" | "failed" | "loaded">("unsettled");
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const lastScope = useRef({ id, agentId, bindingEpoch, api });
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    rangeRead.current?.abort();
    tailRead.current?.abort();
    rangeRead.current = null;
    tailRead.current = null;
    pendingRevalidate.current = false;
    if (expiryTimer.current !== null) {
      clearTimeout(expiryTimer.current);
      expiryTimer.current = null;
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    const previous = lastScope.current;
    if (
      previous.id === id &&
      previous.agentId === agentId &&
      previous.bindingEpoch === bindingEpoch &&
      previous.api === api
    )
      return;
    cancel();
    lastScope.current = { id, agentId, bindingEpoch, api };
    first.current = 0;
    current.current = [];
    wantedSeq.current = 0;
    readState.current = "unsettled";
    setItems([]);
    setHasMore(false);
    setError("");
    notify.current?.("clear", []);
  }, [id, agentId, bindingEpoch, api, cancel]);

  useEffect(() => {
    let active = true;
    if (!sessionStateStorage || !id || agentId === null || bindingEpoch === null) return;
    const scope = lastScope.current;
    void loadQqEventsCache(sessionStateStorage, id, agentId, bindingEpoch).then((cached) => {
      if (
        active &&
        lastScope.current === scope &&
        cached?.length &&
        !current.current.length &&
        readState.current === "unsettled"
      ) {
        current.current = cached;
        setItems(cached);
        notify.current?.("initial", cached);
        scheduleExpiryRef.current();
      }
    });
    return () => {
      active = false;
    };
  }, [id, agentId, bindingEpoch, sessionStateStorage]);

  const publish = useCallback((kind: HistoryChange, records: ConversationEventView[]) => {
    const now = Date.now();
    const sourced = records.map((row) => (lapsedAt(row, now) ? redactEvent(row, "expired") : row));
    const previous = new Map(current.current.map((row) => [row.seq, row]));
    const next = [...new Map(sourced.map((row) => [row.seq, row])).values()]
      .sort((a, b) => a.seq - b.seq)
      .map((row) => {
        const old = previous.get(row.seq);
        return old && (old === row || JSON.stringify(old) === JSON.stringify(row)) ? old : row;
      });
    if (
      next.length === current.current.length &&
      next.every((row, index) => row === current.current[index])
    ) {
      scheduleExpiryRef.current();
      return false;
    }
    first.current = next[0]?.seq ?? 0;
    notify.current?.(kind, next);
    current.current = next;
    setItems(next);
    scheduleExpiryRef.current();
    return true;
  }, []);

  const scheduleExpiryRef = useRef<() => void>(() => {});

  const sanitizeExpired = useCallback(() => {
    publish("refresh", current.current);
  }, [publish]);

  const scheduleExpiry = useCallback(() => {
    if (expiryTimer.current !== null) {
      clearTimeout(expiryTimer.current);
      expiryTimer.current = null;
    }
    if (!enabledRef.current || document.visibilityState === "hidden") return;
    const now = Date.now();
    let nearest = Number.POSITIVE_INFINITY;
    for (const row of current.current) {
      if (row.contentState !== "active" || lapsedAt(row, now)) continue;
      for (const source of [row.source, ...row.sources]) {
        const at = source?.expiresAt ? Date.parse(source.expiresAt) : Number.NaN;
        if (Number.isFinite(at) && at > now && at < nearest) nearest = at;
      }
    }
    if (!Number.isFinite(nearest)) return;
    expiryTimer.current = setTimeout(
      () => {
        expiryTimer.current = null;
        sanitizeExpired();
      },
      Math.min(2_147_483_647, Math.max(0, nearest - Date.now())),
    );
  }, [sanitizeExpired]);
  scheduleExpiryRef.current = scheduleExpiry;

  const save = useCallback(() => {
    void saveQqEventsCache(sessionStateStorage, id, agentId, bindingEpoch, current.current);
  }, [sessionStateStorage, id, agentId, bindingEpoch]);

  const fail = useCallback(
    (reason: unknown) => {
      rangeRead.current?.abort();
      rangeRead.current = null;
      tailRead.current?.abort();
      tailRead.current = null;
      pendingRevalidate.current = false;
      setLoading(false);
      wantedSeq.current = 0;
      setError(errorText(reason));
      publish(
        "refresh",
        current.current.map((row) => redactEvent(row)),
      );
      void removeQqEventsCache(sessionStateStorage, id);
    },
    [id, sessionStateStorage, publish],
  );

  const append = useCallback(async () => {
    if (tailRead.current || readState.current !== "loaded") return;
    const controller = new AbortController();
    const scope = lastScope.current;
    tailRead.current = controller;
    let cursor = current.current.at(-1)?.seq ?? 0;
    let changed = false;
    try {
      for (;;) {
        const requestedSeq = wantedSeq.current;
        const page = await api.getConversationEvents(
          id,
          { direction: "after", afterSeq: cursor, limit: 100 },
          controller.signal,
        );
        if (controller.signal.aborted || lastScope.current !== scope) return;
        changed = publish("refresh", [...current.current, ...page.items]) || changed;
        const progressed = page.nextSeq > cursor;
        if (progressed) cursor = page.nextSeq;
        if (!page.hasMore && wantedSeq.current <= requestedSeq) wantedSeq.current = 0;
        if (
          (!progressed && wantedSeq.current <= requestedSeq) ||
          (!page.hasMore && wantedSeq.current === 0)
        )
          break;
      }
      if (changed && !rangeRead.current) save();
    } catch (reason) {
      if (!controller.signal.aborted && lastScope.current === scope) fail(reason);
    } finally {
      if (tailRead.current === controller) {
        tailRead.current = null;
        if (
          pendingRevalidate.current &&
          !rangeRead.current &&
          enabledRef.current &&
          document.visibilityState !== "hidden"
        ) {
          pendingRevalidate.current = false;
          revalidateRef.current();
        }
      }
    }
  }, [api, id, publish, save, fail]);

  const load = useCallback(
    async (older = false) => {
      if (rangeRead.current) {
        if (!older) pendingRevalidate.current = true;
        return;
      }
      const controller = new AbortController();
      const scope = lastScope.current;
      rangeRead.current = controller;
      setLoading(true);
      setError("");
      const initial = readState.current !== "loaded";
      const captured = current.current;
      const lower = first.current;
      const upper = current.current.at(-1)?.seq ?? 0;
      const requestedSeq = wantedSeq.current;
      // Range reads do not consume notifications owned by the independent tail read.
      try {
        const page = await api.getConversationEvents(
          id,
          initial
            ? { direction: "latest" }
            : older
              ? { direction: "before", beforeSeq: lower }
              : {
                  direction: "after",
                  afterSeq: Math.max(0, lower - 1),
                  limit: Math.max(100, current.current.length + 100),
                },
          controller.signal,
        );
        if (controller.signal.aborted || lastScope.current !== scope) return;
        let records = page.items;
        const rangeTail: ConversationEventView[] = [];
        if (!initial && !older) {
          const keepCapturedRange = (rows: ConversationEventView[]) => {
            const beyondUpper = rows.filter((row) => row.seq > upper);
            rangeTail.push(...beyondUpper);
            wantedSeq.current = Math.max(wantedSeq.current, ...beyondUpper.map((row) => row.seq));
            return rows.filter((row) => row.seq >= lower && row.seq <= upper);
          };
          records = keepCapturedRange(records);
          let cursor = page.nextSeq;
          let more = page.hasMore && cursor > Math.max(0, lower - 1);
          while (more && cursor < upper) {
            const following = await api.getConversationEvents(
              id,
              { direction: "after", afterSeq: cursor },
              controller.signal,
            );
            if (controller.signal.aborted || lastScope.current !== scope) return;
            records = [...records, ...keepCapturedRange(following.items)];
            more = following.hasMore && following.nextSeq > cursor;
            cursor = following.nextSeq;
          }
        }
        if (initial || older) setHasMore(page.hasMore);
        // A range response owns only the range it began with, not concurrent tail arrivals.
        const next = initial
          ? records
          : older
            ? [...records, ...current.current]
            : [
                ...records,
                ...rangeTail,
                ...current.current.filter((row) => row.seq < lower || row.seq > upper),
              ];
        readState.current = "loaded";
        const changed = publish(initial ? "initial" : older ? "older" : "refresh", next);
        if (
          !older &&
          !tailRead.current &&
          wantedSeq.current <= requestedSeq &&
          (!page.hasMore || wantedSeq.current <= (current.current.at(-1)?.seq ?? 0))
        )
          wantedSeq.current = 0;
        // A concurrent append defers its cache write until this range is authoritative.
        if (initial || changed || current.current !== captured) save();
      } catch (reason) {
        if (!controller.signal.aborted && lastScope.current === scope) {
          if (readState.current !== "loaded") {
            readState.current = "failed";
          }
          fail(reason);
        }
      } finally {
        if (rangeRead.current === controller) {
          rangeRead.current = null;
          setLoading(false);
          if (enabledRef.current && document.visibilityState !== "hidden") {
            if (pendingRevalidate.current && !tailRead.current) {
              pendingRevalidate.current = false;
              void load();
            } else if (wantedSeq.current > (current.current.at(-1)?.seq ?? 0)) {
              void append();
            }
          }
        }
      }
    },
    [api, id, append, fail, publish, save],
  );

  revalidateRef.current = () => {
    void load();
  };

  const manualRefresh = useCallback(() => {
    rangeRead.current?.abort();
    rangeRead.current = null;
    if (!tailRead.current) pendingRevalidate.current = false;
    return load();
  }, [load]);

  useEffect(() => {
    const pause = () => {
      cancel();
      notify.current?.("refresh", current.current);
    };
    if (!enabled) {
      pause();
      return;
    }
    const refresh = () => {
      if (document.visibilityState !== "hidden") {
        sanitizeExpired();
        void load();
      }
    };
    let hidden = document.visibilityState === "hidden";
    const visibility = () => {
      const nextHidden = document.visibilityState === "hidden";
      if (nextHidden === hidden) return;
      hidden = nextHidden;
      if (hidden) pause();
      else refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancel();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled, load, sanitizeExpired, cancel]);

  useEffect(
    () =>
      addConversationChangeListener((event) => {
        if (event.event !== "ready" && event.conversationId !== id) return;
        // Runtime activity never changes timeline content: no read, cache write or watermark.
        if (event.event === "conversation_activity_changed") return;
        const changedDuringTail =
          event.event === "conversation_changed" &&
          tailRead.current !== null &&
          event.seq <= Math.max(wantedSeq.current, current.current.at(-1)?.seq ?? 0);
        if (event.event === "conversation_changed")
          wantedSeq.current = Math.max(wantedSeq.current, event.seq);
        if (!enabled || document.visibilityState === "hidden") return;
        // A repeated seq can revise a row not yet published by the pending tail response.
        if (changedDuringTail) {
          pendingRevalidate.current = true;
          return;
        }
        if (event.event === "ready" && rangeRead.current && readState.current !== "loaded") return;
        if (
          event.event === "conversation_changed" &&
          readState.current === "loaded" &&
          event.seq > (current.current.at(-1)?.seq ?? 0)
        ) {
          void append();
        } else {
          void load();
        }
      }),
    [id, enabled, append, load],
  );

  return { items, hasMore, loading, error, refresh: manualRefresh, loadMore: () => load(true) };
}
