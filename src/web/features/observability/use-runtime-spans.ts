import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RuntimeSpan,
  RuntimeSpanFilters,
  RuntimeSpansPage,
} from "../../../shared/contracts/runtime-observability";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";

/** The owner keys this hook by applied filters, so a response cannot cross scope. */
export function useRuntimeSpans(filters: RuntimeSpanFilters, trace = false) {
  const api = useSuperstringStore((state) => state.apiClient);
  const [items, setItems] = useState<RuntimeSpan[]>([]);
  const [summary, setSummary] = useState<RuntimeSpansPage["summary"] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const oldest = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const load = useCallback(
    async (older = false) => {
      if (pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setLoading(true);
      setError("");
      const read = (beforeId?: number) =>
        trace && filters.traceId
          ? api.getRuntimeTrace(filters.traceId, beforeId, controller.signal)
          : api.listRuntimeSpans({ ...filters, beforeId, limit: 100 }, controller.signal);
      try {
        let page = await read(older ? oldest.current : undefined);
        if (controller.signal.aborted) return;
        const nextSummary = page.summary;
        let next = page.items;
        while (!older && page.hasMore && oldest.current && page.nextBeforeId > oldest.current) {
          const cursor = page.nextBeforeId;
          page = await read(cursor);
          if (controller.signal.aborted) return;
          next = [...next, ...page.items];
          if (page.nextBeforeId >= cursor) break;
        }
        oldest.current = page.nextBeforeId;
        setSummary(nextSummary);
        setHasMore(page.hasMore);
        setItems((previous) =>
          [
            ...new Map(
              [...(older ? previous : []), ...next].map((item) => [item.id, item]),
            ).values(),
          ].sort((a, b) => b.id - a.id),
        );
      } catch (reason) {
        if (!controller.signal.aborted) {
          setError(errorText(reason));
          setItems([]);
          setSummary(null);
          setHasMore(false);
        }
      } finally {
        if (pending.current === controller) {
          pending.current = null;
          setLoading(false);
        }
      }
    },
    [api, filters, trace],
  );
  useEffect(() => {
    let foreground = true;
    const clear = () => {
      foreground = false;
      pending.current?.abort();
      pending.current = null;
      setItems([]);
      setSummary(null);
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
    const timer = setInterval(refresh, 5000);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", clear);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      pending.current?.abort();
      pending.current = null;
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", clear);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [load]);
  return {
    items,
    summary,
    hasMore,
    loading,
    error,
    refresh: () => load(),
    loadMore: () => load(true),
  };
}
