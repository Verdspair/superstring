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

function redactEvent(item: ConversationEventView): ConversationEventView {
  return {
    ...item,
    text: null,
    contentState: "unavailable",
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
  { refreshMs = 5000, enabled = true }: { refreshMs?: number; enabled?: boolean } = {},
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
  const authoritativeSettled = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const lastScope = useRef({ id, agentId, bindingEpoch, api });

  const cancel = useCallback(() => {
    rangeRead.current?.abort();
    tailRead.current?.abort();
    rangeRead.current = null;
    tailRead.current = null;
    pendingRevalidate.current = false;
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
    authoritativeSettled.current = false;
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
        !authoritativeSettled.current
      ) {
        current.current = cached;
        setItems(cached);
        notify.current?.("initial", cached);
      }
    });
    return () => {
      active = false;
    };
  }, [id, agentId, bindingEpoch, sessionStateStorage]);

  const publish = useCallback((kind: HistoryChange, records: ConversationEventView[]) => {
    const previous = new Map(current.current.map((row) => [row.seq, row]));
    const next = [...new Map(records.map((row) => [row.seq, row])).values()]
      .sort((a, b) => a.seq - b.seq)
      .map((row) => {
        const old = previous.get(row.seq);
        return old && JSON.stringify(old) === JSON.stringify(row) ? old : row;
      });
    first.current = next[0]?.seq ?? 0;
    notify.current?.(kind, next);
    current.current = next;
    setItems(next);
  }, []);

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
      publish("refresh", current.current.map(redactEvent));
      void removeQqEventsCache(sessionStateStorage, id);
    },
    [id, sessionStateStorage, publish],
  );

  const append = useCallback(async () => {
    if (tailRead.current || !authoritativeSettled.current) return;
    const controller = new AbortController();
    const scope = lastScope.current;
    tailRead.current = controller;
    let cursor = current.current.at(-1)?.seq ?? 0;
    try {
      for (;;) {
        const requestedSeq = wantedSeq.current;
        const page = await api.getConversationEvents(
          id,
          { direction: "after", afterSeq: cursor, limit: 100 },
          controller.signal,
        );
        if (controller.signal.aborted || lastScope.current !== scope) return;
        publish("refresh", [...current.current, ...page.items]);
        const progressed = page.nextSeq > cursor;
        cursor = page.nextSeq;
        if (!page.hasMore && wantedSeq.current <= requestedSeq) wantedSeq.current = 0;
        if (!progressed || (!page.hasMore && wantedSeq.current === 0)) break;
      }
      if (!rangeRead.current) save();
    } catch (reason) {
      if (!controller.signal.aborted && lastScope.current === scope) fail(reason);
    } finally {
      if (tailRead.current === controller) tailRead.current = null;
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
      const initial = !authoritativeSettled.current;
      const lower = first.current;
      const upper = current.current.at(-1)?.seq ?? 0;
      wantedSeq.current = 0;
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
        if (!initial && !older) {
          let cursor = page.nextSeq;
          let more = page.hasMore;
          while (more) {
            const following = await api.getConversationEvents(
              id,
              { direction: "after", afterSeq: cursor },
              controller.signal,
            );
            if (controller.signal.aborted || lastScope.current !== scope) return;
            records = [...records, ...following.items];
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
            : [...records, ...current.current.filter((row) => row.seq < lower || row.seq > upper)];
        authoritativeSettled.current = true;
        publish(initial ? "initial" : older ? "older" : "refresh", next);
        save();
      } catch (reason) {
        if (!controller.signal.aborted && lastScope.current === scope) {
          authoritativeSettled.current = true;
          fail(reason);
        }
      } finally {
        if (rangeRead.current === controller) {
          rangeRead.current = null;
          setLoading(false);
          if (enabledRef.current && document.visibilityState !== "hidden") {
            if (pendingRevalidate.current) {
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
      if (document.visibilityState !== "hidden") void load();
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
    const timer = setInterval(refresh, refreshMs);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      cancel();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [enabled, load, refreshMs, cancel]);

  useEffect(
    () =>
      addConversationChangeListener((event) => {
        if (event.event !== "ready" && event.conversationId !== id) return;
        if (event.event === "conversation_changed")
          wantedSeq.current = Math.max(wantedSeq.current, event.seq);
        if (!enabled || document.visibilityState === "hidden") return;
        if (event.event === "ready" && rangeRead.current && !authoritativeSettled.current) return;
        if (
          event.event === "conversation_changed" &&
          authoritativeSettled.current &&
          event.seq > (current.current.at(-1)?.seq ?? 0)
        ) {
          void append();
        } else {
          void load();
        }
      }),
    [id, enabled, append, load],
  );

  return { items, hasMore, loading, error, refresh: () => load(), loadMore: () => load(true) };
}
