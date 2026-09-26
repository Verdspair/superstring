import { useEffect, useRef } from "react";
import { startReadPolling } from "./read-task";

/** No polling outside the foreground. Losing focus also discards the current read material. */
export function useForegroundRead(
  load: () => void,
  clear: () => void,
  { paused = false, intervalMs = 5000 }: { paused?: boolean; intervalMs?: number } = {},
) {
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    let foreground = document.visibilityState !== "hidden";
    const discard = () => {
      foreground = false;
      clear();
    };
    const refresh = () => {
      if (foreground && document.visibilityState !== "hidden" && !pausedRef.current) load();
    };
    const focus = () => {
      foreground = true;
      refresh();
    };
    const visibility = () => (document.visibilityState === "hidden" ? discard() : focus());
    if (foreground) load();
    const polling = startReadPolling(refresh, intervalMs);
    window.addEventListener("blur", discard);
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      polling.cancel();
      clear();
      window.removeEventListener("blur", discard);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [load, clear, intervalMs]);
}
