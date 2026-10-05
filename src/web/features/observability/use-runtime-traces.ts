import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RuntimeSpanFilters,
  RuntimeTrace,
  RuntimeTraceDetail,
  RuntimeTracesPage,
} from "../../../shared/contracts/runtime-observability";
import {
  loadTracesCache,
  removeTracesCache,
  saveTracesCache,
} from "../../services/page-snapshot-cache";
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
  const sessionStateStorage = useSuperstringStore((s) => s.sessionStateStorage);
  const [items, setItems] = useState<RuntimeTrace[]>([]);
  const [summary, setSummary] = useState<RuntimeTracesPage["summary"] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const oldest = useRef(0);
  const pending = useRef<ReadTask | null>(null);
  const authoritativeSettled = useRef(false);
  const current = useRef(items);

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
    current.current = [];
    setItems([]);
    setSummary(null);
    setHasMore(false);
    oldest.current = 0;
  }, [cancel]);

  useEffect(() => {
    if (scopeRef.current.api !== api || scopeRef.current.appliedFilters !== appliedFilters) {
      scopeRef.current = { api, appliedFilters };
      authoritativeSettled.current = false;
      clear();
      setError("");
    }
  }, [api, appliedFilters, clear]);

  // F5 刷新缓存预显水合（仅摘要与列表，非瀑布流/详情；网络落地前先显，权威响应到达后拒迟到缓存）
  useEffect(() => {
    let unmounted = false;
    if (!sessionStateStorage || !active) return;
    void loadTracesCache(sessionStateStorage, key).then((cached) => {
      if (
        !unmounted &&
        cached &&
        cached.items.length > 0 &&
        items.length === 0 &&
        oldest.current === 0 &&
        !authoritativeSettled.current
      ) {
        current.current = cached.items;
        setSummary(cached.summary);
        setItems(cached.items);
      }
    });
    return () => {
      unmounted = true;
    };
  }, [sessionStateStorage, key, active, items.length]);

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
            authoritativeSettled.current = true;
            if (initial || kind !== "background") {
              oldest.current = page.nextBeforeId;
              setHasMore(page.hasMore);
            }
            setSummary(nextSummary);

            // 仅首次 initial 或显式 refresh 进行权威全量替换（淘汰已删 trace）；
            // older 分页与非 initial 的后台轮询保留既有 merge 范围
            const records = initial || kind === "refresh" ? next : [...current.current, ...next];
            const deduplicated = [
              ...new Map(records.map((item) => [item.traceId, item])).values(),
            ].sort((a, b) => b.cursorId - a.cursorId);

            current.current = deduplicated;
            setItems(deduplicated);
            void saveTracesCache(sessionStateStorage, key, nextSummary, deduplicated);
          },
          failure: (reason) => {
            clear();
            authoritativeSettled.current = true;
            setError(errorText(reason));
            void removeTracesCache(sessionStateStorage, key);
          },
          settled: () => {
            pending.current = null;
            setLoading(false);
          },
        },
      );
    },
    [api, appliedFilters, active, clear, key, sessionStateStorage],
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
