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
    retainOnBlur = true,
    onSuspend,
  }: ForegroundReadOptions = {},
) {
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const suspendRef = useRef(onSuspend);
  suspendRef.current = onSuspend;
  const previousPaused = useRef(paused);
  const lastLoad = useRef(0);
  useEffect(() => {
    let foreground = document.visibilityState !== "hidden";
    const read = () => {
      if (!enabled || !foreground || document.visibilityState === "hidden") return;
      lastLoad.current = Date.now();
      load();
    };
    const suspend = () => {
      foreground = false;
      suspendRef.current?.();
      if (!retainOnBlur) clear();
    };
    const hide = suspend;
    const focus = () => {
      if (document.visibilityState === "hidden") return;
      const wasForeground = foreground;
      foreground = true;
      if (pausedRef.current) return;
      // 仅在前台状态跃迁（false -> true）时后台复验一次；同一次回到前台若 visibilitychange 与 focus 先后到达，不重复触发
      if (!wasForeground) {
        read();
      }
    };
    const visibility = () => (document.visibilityState === "hidden" ? hide() : focus());
    const blur = () => (document.visibilityState === "hidden" ? hide() : suspend());
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
