import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationEventView } from "../../../shared/contracts/conversation";
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

/** Refresh every loaded source projection: expiry/revocation does not append a sequence. */
export function useConversationEvents(
  id: string,
  beforeChange?: BeforeHistoryChange,
  { refreshMs = 5000, enabled = true }: { refreshMs?: number; enabled?: boolean } = {},
) {
  const api = useSuperstringStore((s) => s.apiClient);
  const [items, setItems] = useState<ConversationEventView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const first = useRef(0);
  const current = useRef(items);
  const notify = useRef(beforeChange);
  notify.current = beforeChange;
  const pending = useRef<AbortController | null>(null);
  const lastRefreshTime = useRef(0);
  const hadPendingAborted = useRef(false);
  const needsRevalidation = useRef(false);

  // Scope change cleanup
  const lastScopeId = useRef(id);
  const lastApi = useRef(api);
  useEffect(() => {
    if (lastScopeId.current !== id || lastApi.current !== api) {
      lastScopeId.current = id;
      lastApi.current = api;
      pending.current?.abort();
      pending.current = null;
      first.current = 0;
      current.current = [];
      setItems([]);
      setHasMore(false);
      setLoading(false);
      setError("");
      needsRevalidation.current = false;
      notify.current?.("clear", []);
    }
  }, [id, api]);

  const load = useCallback(
    async (older = false) => {
      if (pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setLoading(true);
      setError("");
      hadPendingAborted.current = false;
      const initial = !first.current;
      const loadedCount = current.current.length;
      try {
        const page = await api.getConversationEvents(
          id,
          initial
            ? { direction: "latest" }
            : older
              ? { direction: "before", beforeSeq: first.current }
              : {
                  direction: "after",
                  afterSeq: first.current - 1,
                  limit: Math.max(100, loadedCount + 100),
                },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        let next = page.items;
        if (initial || older) {
          setHasMore(page.hasMore);
        } else {
          // If server has more beyond our expanded limit, page forward
          let cursor = page.nextSeq;
          let more = page.hasMore;
          while (more) {
            const following = await api.getConversationEvents(
              id,
              { direction: "after", afterSeq: cursor },
              controller.signal,
            );
            if (controller.signal.aborted) return;
            next = [...next, ...following.items];
            more = following.hasMore && following.nextSeq > cursor;
            cursor = following.nextSeq;
          }
        }

        let merged: ConversationEventView[];
        if (older) {
          merged = [
            ...new Map([...next, ...current.current].map((item) => [item.seq, item])).values(),
          ].sort((a, b) => a.seq - b.seq);
        } else {
          // Fresh authoritative projections from server replace loaded range
          merged = [...next].sort((a, b) => a.seq - b.seq);
        }

        first.current = merged[0]?.seq ?? 0;
        notify.current?.(initial ? "initial" : older ? "older" : "refresh", merged);
        current.current = merged;
        setItems(merged);
        lastRefreshTime.current = Date.now();
        needsRevalidation.current = false;
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(errorText(reason));
          const redacted: ConversationEventView[] = current.current.map(redactEvent);
          notify.current?.("refresh", redacted);
          current.current = redacted;
          setItems(redacted);
        }
      } finally {
        if (pending.current === controller) {
          pending.current = null;
          setLoading(false);
        }
      }
    },
    [api, id],
  );

  useEffect(() => {
    let foreground = document.visibilityState !== "hidden";

    const redact = () => {
      foreground = false;
      needsRevalidation.current = true;
      if (pending.current) {
        hadPendingAborted.current = true;
        pending.current.abort();
        pending.current = null;
      }
      const redacted = current.current.map(redactEvent);
      notify.current?.("clear", []);
      current.current = redacted;
      setItems(redacted);
      setLoading(false);
    };

    if (!enabled) {
      // 当页签隐藏或会话失活时，脱敏受保护正文与 qqMessageFacts，保留占位/seq
      redact();
      return;
    }

    const onBlur = () => {
      if (document.visibilityState !== "hidden") {
        // visible blur: cancel in-flight and pause polling, do NOT clear body
        if (pending.current) {
          hadPendingAborted.current = true;
          pending.current.abort();
          pending.current = null;
          setLoading(false);
        }
        foreground = false;
        return;
      }
      redact();
    };

    const refresh = () => {
      if (foreground && document.visibilityState !== "hidden") void load();
    };

    const onFocus = () => {
      const wasForeground = foreground;
      foreground = true;
      if (document.visibilityState !== "hidden") {
        const timeSince = Date.now() - lastRefreshTime.current;
        // Skip repeat fetch ONLY if NOT redacted/needsRevalidation, within refreshMs, and no aborted pending
        if (
          !needsRevalidation.current &&
          !wasForeground &&
          timeSince < refreshMs &&
          !hadPendingAborted.current &&
          current.current.length > 0
        ) {
          return;
        }
        void load();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        redact();
      } else {
        onFocus();
      }
    };

    // Initial load when enabled
    void load();
    const timer = setInterval(refresh, refreshMs);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      if (pending.current) {
        pending.current.abort();
        pending.current = null;
      }
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, load, refreshMs]);

  return {
    items,
    hasMore,
    loading,
    error,
    refresh: () => load(),
    loadMore: () => load(true),
  };
}
