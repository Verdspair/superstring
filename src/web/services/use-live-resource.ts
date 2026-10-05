import { useCallback, useRef, useState } from "react";
import { errorText } from "../state/helpers";
import { type ReadTask, startRead } from "./read-task";
import { useForegroundRead } from "./use-foreground-read";

/** Foreground metadata reads. Never use for protected model bodies, which require explicit inspection. */
export function useLiveResource<A>(
  read: (signal: AbortSignal) => Promise<A>,
  {
    enabled = true,
    paused = false,
    retainOnBlur = false,
  }: { enabled?: boolean; paused?: boolean; retainOnBlur?: boolean } = {},
) {
  const [data, setData] = useState<A | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<ReadTask | null>(null);
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
  const refresh = useCallback(() => {
    if (!enabled || pending.current) return;
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
      },
    });
  }, [enabled, read]);
  useForegroundRead(refresh, clear, { enabled, paused, retainOnBlur, onSuspend: cancel });
  return { data, loading, error, refresh };
}
