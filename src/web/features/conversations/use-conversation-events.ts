import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationEventView } from "../../../shared/contracts/conversation";
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

/** Refresh every loaded source projection: expiry/revocation does not append a sequence. */
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
  const pending = useRef<AbortController | null>(null);
  const authoritativeSettled = useRef(false);

  // Scope change cleanup: 严格按 summary (id, agentId, bindingEpoch) 及 api 判定范围跃迁
  const lastScope = useRef({ id, agentId, bindingEpoch, api });
  useEffect(() => {
    const prev = lastScope.current;
    if (
      prev.id !== id ||
      prev.agentId !== agentId ||
      prev.bindingEpoch !== bindingEpoch ||
      prev.api !== api
    ) {
      lastScope.current = { id, agentId, bindingEpoch, api };
      pending.current?.abort();
      pending.current = null;
      first.current = 0;
      current.current = [];
      authoritativeSettled.current = false;
      setItems([]);
      setHasMore(false);
      setLoading(false);
      setError("");
      notify.current?.("clear", []);
    }
  }, [id, agentId, bindingEpoch, api]);

  // F5 刷新缓存预显水合（缺 scope 不 hydrate；仅在网络落地前预显，绝不推进 first.current 保持 0）
  useEffect(() => {
    let active = true;
    if (!sessionStateStorage || !id || agentId === null || bindingEpoch === null) return;
    void loadQqEventsCache(sessionStateStorage, id, agentId, bindingEpoch).then((cached) => {
      const scopeNow = lastScope.current;
      const scopeMatches =
        scopeNow.id === id &&
        scopeNow.agentId === agentId &&
        scopeNow.bindingEpoch === bindingEpoch;
      if (
        active &&
        scopeMatches &&
        cached &&
        cached.length > 0 &&
        current.current.length === 0 &&
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

  const load = useCallback(
    async (older = false) => {
      if (pending.current) return;
      const controller = new AbortController();
      pending.current = controller;
      setLoading(true);
      setError("");
      // R7: 初始网络读取以是否已有权威数据到达为准，首次必走 latest，不把预览缓存当作已加载范围
      const initial = !authoritativeSettled.current;
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
        if (controller.signal.aborted || lastScope.current.id !== id) return;
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
            if (controller.signal.aborted || lastScope.current.id !== id) return;
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
        authoritativeSettled.current = true;
        notify.current?.(initial ? "initial" : older ? "older" : "refresh", merged);
        current.current = merged;
        setItems(merged);
        void saveQqEventsCache(sessionStateStorage, id, agentId, bindingEpoch, merged);
      } catch (reason) {
        if (!controller.signal.aborted && lastScope.current.id === id) {
          authoritativeSettled.current = true;
          setError(errorText(reason));
          const redacted: ConversationEventView[] = current.current.map(redactEvent);
          notify.current?.("refresh", redacted);
          current.current = redacted;
          setItems(redacted);
          void removeQqEventsCache(sessionStateStorage, id);
        }
      } finally {
        if (pending.current === controller) {
          pending.current = null;
          setLoading(false);
        }
      }
    },
    [api, id, agentId, bindingEpoch, sessionStateStorage],
  );

  useEffect(() => {
    let foreground = document.visibilityState !== "hidden";

    const pause = () => {
      // 暂停：只取消在途请求，不清空已加载内容。
      // 通知"refresh"而不是"clear"：后者会让滚动层把整份记录当已清空而渲染为空。
      foreground = false;
      if (pending.current) {
        pending.current.abort();
        pending.current = null;
      }
      notify.current?.("refresh", current.current);
      setLoading(false);
    };

    if (!enabled) {
      // 当页签隐藏或会话失活时暂停在途请求，保留已加载正文与占位
      pause();
      return;
    }

    const onBlur = () => {
      if (document.visibilityState !== "hidden") {
        // visible blur: cancel in-flight and pause polling, do NOT clear body
        if (pending.current) {
          pending.current.abort();
          pending.current = null;
        }
        setLoading(false);
        foreground = false;
        return;
      }
      pause();
    };

    const refresh = () => {
      if (foreground && document.visibilityState !== "hidden") void load();
    };

    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      const wasForeground = foreground;
      foreground = true;
      // 回到前台状态跃迁（false -> true）一律后台复验一次；同一轮回到前台若 visibilitychange 与 focus 先后到达，不重复触发
      if (!wasForeground) {
        void load();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        pause();
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
      setLoading(false);
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
