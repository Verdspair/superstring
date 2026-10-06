import { useCallback, useRef, useState } from "react";
import { errorText } from "../state/helpers";
import { useConversationChangeSubscription } from "./conversation-changes";
import { type ReadTask, startRead } from "./read-task";
import { useForegroundRead } from "./use-foreground-read";

export interface LiveResourceOptions {
  enabled?: boolean;
  paused?: boolean;
  retainOnBlur?: boolean;
  /** When supplied, invalidates on matching SSE conversation events */
  conversationScope?: { conversationId?: string };
}

/** Foreground metadata reads. Never use for protected model bodies, which require explicit inspection. */
export function useLiveResource<A>(
  read: (signal: AbortSignal) => Promise<A>,
  {
    enabled = true,
    paused = false,
    retainOnBlur = true,
    conversationScope,
  }: LiveResourceOptions = {},
) {
  const [data, setData] = useState<A | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<ReadTask | null>(null);
  const pendingRevalidate = useRef(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const cancel = useCallback(() => {
    pending.current?.cancel();
    pending.current = null;
    pendingRevalidate.current = false;
    setLoading(false);
  }, []);

  const clear = useCallback(() => {
    cancel();
    setData(null);
    setError("");
  }, [cancel]);

  const refresh = useCallback(() => {
    if (!enabled) return;
    if (pending.current) {
      pendingRevalidate.current = true;
      return;
    }
    setLoading(true);
    setError("");
    pending.current = startRead(read, {
      success: setData,
      failure: (cause) => {
        setData(null);
        setError(errorText(cause));
      },
      settled: () => {
        pending.current = null;
        setLoading(false);
        if (pendingRevalidate.current) {
          pendingRevalidate.current = false;
          if (document.visibilityState !== "hidden" && !pausedRef.current && enabledRef.current) {
            refresh();
          }
        }
      },
    });
  }, [enabled, read]);

  useForegroundRead(refresh, clear, { enabled, paused, retainOnBlur, onSuspend: cancel });
  useConversationChangeSubscription(refresh, {
    conversationId: conversationScope?.conversationId,
    enabled: enabled && conversationScope !== undefined,
    paused,
  });
  return { data, loading, error, refresh };
}
