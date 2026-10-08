import { useEffect, useRef } from "react";
import { startReadPolling } from "./read-task";

export interface ForegroundReadOptions {
  paused?: boolean;
  enabled?: boolean;
  intervalMs?: number;
  retainOnHide?: boolean;
  onSuspend?: () => void;
}

export function useForegroundRead(
  load: () => void,
  clear: () => void,
  {
    paused = false,
    enabled = true,
    intervalMs = 5000,
    retainOnHide = true,
    onSuspend,
  }: ForegroundReadOptions = {},
) {
  const suspendRef = useRef(onSuspend);
  suspendRef.current = onSuspend;
  const lastLoad = useRef(0);
  useEffect(() => {
    let hidden = document.visibilityState === "hidden";
    const read = () => {
      if (!enabled || paused || document.visibilityState === "hidden") return;
      lastLoad.current = Date.now();
      load();
    };
    const visibility = () => {
      const nextHidden = document.visibilityState === "hidden";
      if (nextHidden === hidden) return;
      hidden = nextHidden;
      if (hidden) {
        suspendRef.current?.();
        if (!retainOnHide) clear();
      } else {
        read();
      }
    };
    if (enabled && !paused && !hidden) read();
    else suspendRef.current?.();
    const polling = enabled
      ? startReadPolling(() => {
          if (!paused && Date.now() - lastLoad.current >= intervalMs) read();
        }, intervalMs)
      : null;
    document.addEventListener("visibilitychange", visibility);
    return () => {
      polling?.cancel();
      suspendRef.current?.();
      if (!retainOnHide) clear();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [load, clear, enabled, paused, intervalMs, retainOnHide]);
}
