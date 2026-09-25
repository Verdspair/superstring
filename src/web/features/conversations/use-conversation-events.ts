import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationEventView } from "../../../shared/contracts/conversation";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";

/** Bodies are source-backed projections. Sequence cursors alone cannot prove continued access. */
export function useConversationEvents(id: string, refreshMs = 5000) {
  const api = useSuperstringStore((s) => s.apiClient);
  const [items, setItems] = useState<ConversationEventView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const through = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(
    async (more = false) => {
      if (pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setLoading(true);
      setError("");
      const target = through.current;
      let cursor = more ? target : 0;
      let next: ConversationEventView[] = [];
      try {
        for (;;) {
          const page = await api.getConversationEvents(id, cursor, controller.signal);
          if (controller.signal.aborted) return;
          next = [...next, ...page.items];
          cursor = page.nextSeq;
          setHasMore(page.hasMore);
          if (more || !page.hasMore || cursor >= target) break;
        }
        through.current = cursor;
        setItems((old) =>
          [
            ...new Map([...(more ? old : []), ...next].map((item) => [item.seq, item])).values(),
          ].sort((a, b) => a.seq - b.seq),
        );
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(errorText(reason));
          // Keep the timeline positions but do not retain a body whose access could not be revalidated.
          setItems((old) =>
            old.map((item) => ({
              ...item,
              text: null,
              contentState: "unavailable",
              media: item.media.map((media) => ({
                ...media,
                description: null,
                availability: "unavailable",
              })),
            })),
          );
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
    let foreground = true;
    const clear = () => {
      foreground = false;
      pending.current?.abort();
      pending.current = null;
      setItems([]);
      setLoading(false);
    };
    const refresh = () => {
      if (foreground && document.visibilityState !== "hidden") void load();
    };
    const focus = () => {
      foreground = true;
      refresh();
    };
    const visibility = () => (document.visibilityState === "hidden" ? clear() : focus());
    refresh();
    const timer = setInterval(refresh, refreshMs);
    window.addEventListener("blur", clear);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      pending.current?.abort();
      pending.current = null;
      window.removeEventListener("blur", clear);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [load, refreshMs]);
  return { items, hasMore, loading, error, refresh: () => load(), loadMore: () => load(true) };
}
