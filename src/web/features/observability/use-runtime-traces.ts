import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RuntimeSpanFilters,
  RuntimeTrace,
  RuntimeTraceDetail,
  RuntimeTracesPage,
} from "../../../shared/contracts/runtime-observability";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";

function useForegroundRefresh(load: () => Promise<void>, clear: () => void) {
  useEffect(() => {
    let foreground = true;
    const discard = () => {
      foreground = false;
      clear();
    };
    const refresh = () => {
      if (foreground && document.visibilityState !== "hidden") void load();
    };
    const focus = () => {
      foreground = true;
      refresh();
    };
    const visibility = () => (document.visibilityState === "hidden" ? discard() : focus());
    refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener("blur", discard);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      clear();
      window.removeEventListener("blur", discard);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [load, clear]);
}

/** Applied filters key the owner; the stable trace creation cursor retains loaded ranges. */
export function useRuntimeTraces(filters: RuntimeSpanFilters) {
  const api = useSuperstringStore((s) => s.apiClient);
  const [items, setItems] = useState<RuntimeTrace[]>([]);
  const [summary, setSummary] = useState<RuntimeTracesPage["summary"] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const oldest = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const clear = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
    setItems([]);
    setSummary(null);
    setLoading(false);
  }, []);
  const load = useCallback(
    async (older = false) => {
      if (pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setLoading(true);
      setError("");
      const read = (beforeId?: number) =>
        api.listRuntimeTraces({ ...filters, beforeId, limit: 100 }, controller.signal);
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
              [...(older ? previous : []), ...next].map((item) => [item.traceId, item]),
            ).values(),
          ].sort((a, b) => b.cursorId - a.cursorId),
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
    [api, filters],
  );
  useForegroundRefresh(load, clear);
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

/** Detail retains its identity when the list no longer matches; bodies are never read here. */
export function useRuntimeWaterfall(traceId: string, filters: RuntimeSpanFilters) {
  const api = useSuperstringStore((s) => s.apiClient);
  const [data, setData] = useState<RuntimeTraceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const clear = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
    setData(null);
    setLoading(false);
  }, []);
  const load = useCallback(async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setError("");
    try {
      const next = await api.getRuntimeWaterfall(traceId, filters, controller.signal);
      if (!controller.signal.aborted) setData(next);
    } catch (reason) {
      if (!controller.signal.aborted) {
        setData(null);
        setError(errorText(reason));
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setLoading(false);
      }
    }
  }, [api, filters, traceId]);
  useForegroundRefresh(load, clear);
  return { data, loading, error, refresh: load };
}
