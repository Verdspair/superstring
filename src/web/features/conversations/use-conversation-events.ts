import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationEventView } from "../../../shared/contracts/conversation";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";

export type HistoryChange = "initial" | "older" | "refresh" | "clear";
export type BeforeHistoryChange = (kind: HistoryChange, next: ConversationEventView[]) => void;

/** Refresh every loaded source projection: expiry/revocation does not append a sequence. */
export function useConversationEvents(
  id: string,
  beforeChange?: BeforeHistoryChange,
  refreshMs = 5000,
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
  const load = useCallback(
    async (older = false) => {
      if (pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setLoading(true);
      setError("");
      const initial = !first.current;
      try {
        const page = await api.getConversationEvents(
          id,
          initial
            ? { direction: "latest" }
            : older
              ? { direction: "before", beforeSeq: first.current }
              : { direction: "after", afterSeq: first.current - 1 },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        let next = page.items;
        if (initial || older) setHasMore(page.hasMore);
        else {
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
            // A non-advancing response cannot represent another page.
            more = following.hasMore && following.nextSeq > cursor;
            cursor = following.nextSeq;
          }
        }
        next = [
          ...new Map(
            [...(older ? current.current : []), ...next].map((item) => [item.seq, item]),
          ).values(),
        ].sort((a, b) => a.seq - b.seq);
        first.current = next[0]?.seq ?? 0;
        notify.current?.(initial ? "initial" : older ? "older" : "refresh", next);
        current.current = next;
        setItems(next);
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(errorText(reason));
          const redacted: ConversationEventView[] = current.current.map((item) => ({
            ...item,
            text: null,
            contentState: "unavailable",
            media: item.media.map((media) => ({
              ...media,
              description: null,
              availability: "unavailable",
            })),
          }));
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
    let foreground = true;
    const clear = () => {
      foreground = false;
      pending.current?.abort();
      pending.current = null;
      notify.current?.("clear", []);
      current.current = [];
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
