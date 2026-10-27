import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ReadTask, startRead } from "../../src/web/services/read-task";
import { useForegroundRead } from "../../src/web/services/use-foreground-read";
import { useLiveResource } from "../../src/web/services/use-live-resource";

type Visibility = "visible" | "hidden";

let originalVisibilityDesc: PropertyDescriptor | undefined;

const setVisibility = (value: Visibility) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  fireEvent(document, new Event("visibilitychange"));
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  originalVisibilityDesc =
    Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState") ??
    Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalVisibilityDesc) {
    Object.defineProperty(document, "visibilityState", originalVisibilityDesc);
  }
});

describe("visibility-only read lifecycle", () => {
  it("starts once when visible, suspends in-flight on hide and reloads once without polling or blur reads", async () => {
    vi.useFakeTimers();
    try {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      const first = deferred<string>();
      const second = deferred<string>();
      const published: string[] = [];
      const signals: AbortSignal[] = [];
      let task: ReadTask | null = null;
      const read = vi.fn((signal: AbortSignal) => {
        signals.push(signal);
        return signals.length === 1 ? first.promise : second.promise;
      });
      const load = vi.fn(() => {
        task = startRead((signal) => read(signal), {
          success: (value) => published.push(value),
          failure: () => {},
        });
      });
      const suspend = vi.fn(() => {
        task?.cancel();
        task = null;
      });
      const clear = vi.fn();
      renderHook(() => useForegroundRead(load, clear, { intervalMs: null, onSuspend: suspend }));
      expect(load).not.toHaveBeenCalled();
      act(() => setVisibility("visible"));
      expect(load).toHaveBeenCalledTimes(1);
      act(() => setVisibility("hidden"));
      expect(signals[0]?.aborted).toBe(true);
      await act(async () => {
        first.resolve("late");
        await first.promise;
      });
      expect(published).toEqual([]);
      act(() => setVisibility("visible"));
      expect(load).toHaveBeenCalledTimes(2);
      await act(async () => {
        second.resolve("current");
        await second.promise;
      });
      expect(published).toEqual(["current"]);
      act(() => {
        fireEvent.blur(window);
        fireEvent.focus(window);
        vi.advanceTimersByTime(60_000);
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(suspend).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("visible-window read lifecycle", () => {
  it("accepts the first in-flight read after a window blur without waiting for refocus", async () => {
    const first = deferred<string>();
    const read = vi.fn((_signal: AbortSignal) => first.promise);
    const { result } = renderHook(() => useLiveResource(read));

    expect(read).toHaveBeenCalledTimes(1);
    act(() => fireEvent.blur(window));
    expect(read.mock.calls[0]?.[0].aborted).toBe(false);

    await act(async () => {
      first.resolve("loaded while window is unfocused");
      await first.promise;
    });

    expect(result.current.data).toBe("loaded while window is unfocused");
    expect(result.current.loading).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("does not start an extra GET when the window receives focus", async () => {
    const read = vi.fn(async (_signal: AbortSignal) => "metadata");
    const { result } = renderHook(() => useLiveResource(read));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.data).toBe("metadata");
    expect(read).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("cancels and ignores a late hidden-document response, then reads once when visible", async () => {
    const hiddenRead = deferred<string>();
    const visibleRead = deferred<string>();
    const signals: AbortSignal[] = [];
    const read = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? hiddenRead.promise : visibleRead.promise;
    });
    const { result } = renderHook(() => useLiveResource(read, { retainOnHide: true }));

    expect(read).toHaveBeenCalledTimes(1);
    act(() => setVisibility("hidden"));
    expect(signals[0]?.aborted).toBe(true);

    await act(async () => {
      hiddenRead.resolve("late hidden response");
      await hiddenRead.promise;
    });
    expect(result.current.data).toBeNull();

    act(() => setVisibility("visible"));
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => {
      visibleRead.resolve("visible response");
      await visibleRead.promise;
    });

    expect(result.current.data).toBe("visible response");
    expect(read).toHaveBeenCalledTimes(2);
  });
});
