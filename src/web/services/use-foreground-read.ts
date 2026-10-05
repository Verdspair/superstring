import { useEffect, useRef } from "react";
import { startReadPolling } from "./read-task";

export interface ForegroundReadOptions {
  paused?: boolean;
  enabled?: boolean;
  intervalMs?: number;
  retainOnBlur?: boolean;
  onSuspend?: () => void;
}

export function useForegroundRead(
  load: () => void,
  clear: () => void,
  {
    paused = false,
    enabled = true,
    intervalMs = 5000,
    retainOnBlur = false,
    onSuspend,
  }: ForegroundReadOptions = {},
) {
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const suspendRef = useRef(onSuspend);
  suspendRef.current = onSuspend;
  const refreshRef = useRef<(() => void) | null>(null);
  const previousPaused = useRef(paused);
  const lastLoad = useRef(0);
  useEffect(() => {
    let foreground = document.visibilityState !== "hidden";
    let discarded = false;
    const read = () => {
      if (!enabled || !foreground || document.visibilityState === "hidden") return;
      discarded = false;
      lastLoad.current = Date.now();
      load();
    };
    const suspend = () => {
      foreground = false;
      suspendRef.current?.();
      if (!retainOnBlur) {
        discarded = true;
        clear();
      }
    };
    const hide = suspend;
    const focus = () => {
      const wasForeground = foreground;
      foreground = true;
      if (pausedRef.current) return;
      if (
        retainOnBlur &&
        !discarded &&
        !wasForeground &&
        Date.now() - lastLoad.current < intervalMs
      )
        return;
      read();
    };
    const visibility = () => (document.visibilityState === "hidden" ? hide() : focus());
    const blur = () => (document.visibilityState === "hidden" ? hide() : suspend());
    refreshRef.current = read;
    if (enabled && foreground) read();
    else suspendRef.current?.();
    const polling = enabled
      ? startReadPolling(() => {
          if (!pausedRef.current && Date.now() - lastLoad.current >= intervalMs) read();
        }, intervalMs)
      : null;
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      polling?.cancel();
      suspendRef.current?.();
      if (!retainOnBlur) clear();
      refreshRef.current = null;
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [load, clear, enabled, intervalMs, retainOnBlur]);
  useEffect(() => {
    if (paused && !previousPaused.current) suspendRef.current?.();
    previousPaused.current = paused;
  }, [paused]);
}
