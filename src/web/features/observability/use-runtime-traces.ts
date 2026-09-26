import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RuntimeSpanFilters,
  RuntimeTrace,
  RuntimeTraceDetail,
  RuntimeTracesPage,
} from "../../../shared/contracts/runtime-observability";
import { type ReadTask, startRead } from "../../services/read-task";
import { useForegroundRead } from "../../services/use-foreground-read";
import { errorText } from "../../state/helpers";
import { useSuperstringStore } from "../../store";

/** Stable trace creation cursors retain the loaded range, scoped to the applied filters. */
export function useRuntimeTraces(filters: RuntimeSpanFilters, paused = false) {
  const api = useSuperstringStore((s) => s.apiClient);
  const [items, setItems] = useState<RuntimeTrace[]>([]);
  const [summary, setSummary] = useState<RuntimeTracesPage["summary"] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const oldest = useRef(0);
  const pending = useRef<ReadTask | null>(null);
  // Filter changes reset pagination without resetting the selected trace's separate owner.
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new filter scope owns a new pagination range.
  useEffect(() => {
    oldest.current = 0;
  }, [filters]);
  const clear = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
    setItems([]);
    setSummary(null);
    setHasMore(false);
    setLoading(false);
    setError("");
  }, []);
  const load = useCallback(
    (older = false) => {
      if (pending.current) return;
      setLoading(true);
      setError("");
      pending.current = startRead(
        async (signal) => {
          const read = (beforeId?: number) =>
            api.listRuntimeTraces({ ...filters, beforeId, limit: 100 }, signal);
          let page = await read(older ? oldest.current : undefined);
          const nextSummary = page.summary;
          let next = page.items;
          while (
            !signal.aborted &&
            !older &&
            page.hasMore &&
            oldest.current &&
            page.nextBeforeId > oldest.current
          ) {
            const cursor = page.nextBeforeId;
            page = await read(cursor);
            next = [...next, ...page.items];
            if (page.nextBeforeId >= cursor) break;
          }
          return { page, next, nextSummary };
        },
        {
          success: ({ page, next, nextSummary }) => {
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
          },
          failure: (reason) => {
            setError(errorText(reason));
            setItems([]);
            setSummary(null);
            setHasMore(false);
          },
          settled: () => {
            pending.current = null;
            setLoading(false);
          },
        },
      );
    },
    [api, filters],
  );
  useForegroundRead(load, clear, { paused });
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

/** Detail retains identity outside the filtered list; protected bodies are never read here. */
export function useRuntimeWaterfall(traceId: string, filters: RuntimeSpanFilters, paused = false) {
  const api = useSuperstringStore((s) => s.apiClient);
  const [data, setData] = useState<RuntimeTraceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<ReadTask | null>(null);
  const clear = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
    setData(null);
    setLoading(false);
    setError("");
  }, []);
  const load = useCallback(() => {
    if (pending.current) return;
    setLoading(true);
    setError("");
    pending.current = startRead((signal) => api.getRuntimeWaterfall(traceId, filters, signal), {
      success: setData,
      failure: (reason) => {
        setData(null);
        setError(errorText(reason));
      },
      settled: () => {
        pending.current = null;
        setLoading(false);
      },
    });
  }, [api, filters, traceId]);
  useForegroundRead(load, clear, { paused });
  return { data, loading, error, refresh: load };
}
