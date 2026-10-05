import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

function filterKey(filters: RuntimeSpanFilters): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(filters)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

export function useRuntimeTraces(filters: RuntimeSpanFilters, paused = false, active = true) {
  const api = useSuperstringStore((s) => s.apiClient);
  const [items, setItems] = useState<RuntimeTrace[]>([]);
  const [summary, setSummary] = useState<RuntimeTracesPage["summary"] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const oldest = useRef(0);
  const pending = useRef<ReadTask | null>(null);

  const key = filterKey(filters);
  const appliedFilters = useMemo(() => JSON.parse(key) as RuntimeSpanFilters, [key]);

  const scopeRef = useRef({ api, appliedFilters });

  const cancel = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
    setLoading(false);
  }, []);

  const clear = useCallback(() => {
    cancel();
    setItems([]);
    setSummary(null);
    setHasMore(false);
    oldest.current = 0;
  }, [cancel]);

  useEffect(() => {
    if (scopeRef.current.api !== api || scopeRef.current.appliedFilters !== appliedFilters) {
      scopeRef.current = { api, appliedFilters };
      clear();
      setError("");
    }
  }, [api, appliedFilters, clear]);

  const load = useCallback(
    (kind: "background" | "refresh" | "older" = "background") => {
      if (!active || pending.current) return;
      const boundary = oldest.current;
      const initial = boundary === 0;
      setLoading(true);
      setError("");
      pending.current = startRead(
        async (signal) => {
          const read = (beforeId?: number) =>
            api.listRuntimeTraces({ ...appliedFilters, beforeId, limit: 100 }, signal);
          let page = await read(kind === "older" ? boundary : undefined);
          const nextSummary = page.summary;
          const next = [...page.items];
          while (
            !signal.aborted &&
            kind === "refresh" &&
            boundary &&
            page.hasMore &&
            page.nextBeforeId > boundary
          ) {
            const cursor = page.nextBeforeId;
            page = await read(cursor);
            next.push(...page.items);
            if (page.nextBeforeId >= cursor) break;
          }
          return { page, next, nextSummary };
        },
        {
          success: ({ page, next, nextSummary }) => {
            if (initial || kind !== "background") {
              oldest.current = page.nextBeforeId;
              setHasMore(page.hasMore);
            }
            setSummary(nextSummary);
            setItems((previous) => {
              const records = kind === "refresh" ? next : [...previous, ...next];
              return [...new Map(records.map((item) => [item.traceId, item])).values()].sort(
                (a, b) => b.cursorId - a.cursorId,
              );
            });
          },
          failure: (reason) => {
            clear();
            setError(errorText(reason));
          },
          settled: () => {
            pending.current = null;
            setLoading(false);
          },
        },
      );
    },
    [api, appliedFilters, active, clear],
  );

  const background = useCallback(() => load("background"), [load]);
  useForegroundRead(background, clear, {
    paused,
    enabled: active,
    retainOnBlur: true,
    onSuspend: cancel,
  });

  return {
    items,
    summary,
    hasMore,
    loading,
    error,
    refresh: () => load("refresh"),
    loadMore: () => load("older"),
  };
}

export function useRuntimeWaterfall(traceId: string, filters: RuntimeSpanFilters, paused = false) {
  const api = useSuperstringStore((s) => s.apiClient);
  const [data, setData] = useState<RuntimeTraceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<ReadTask | null>(null);

  const key = filterKey(filters);
  const appliedFilters = useMemo(() => JSON.parse(key) as RuntimeSpanFilters, [key]);

  const cancel = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
    setLoading(false);
  }, []);

  const clear = useCallback(() => {
    cancel();
    setData(null);
    setError("");
  }, [cancel]);

  const load = useCallback(() => {
    if (pending.current) return;
    setLoading(true);
    setError("");
    pending.current = startRead(
      (signal) => api.getRuntimeWaterfall(traceId, appliedFilters, signal),
      {
        success: setData,
        failure: (reason) => {
          setData(null);
          setError(errorText(reason));
        },
        settled: () => {
          pending.current = null;
          setLoading(false);
        },
      },
    );
  }, [api, appliedFilters, traceId]);

  useForegroundRead(load, clear, { paused, onSuspend: cancel });
  return { data, loading, error, refresh: load };
}
