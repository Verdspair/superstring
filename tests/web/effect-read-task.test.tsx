import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { type ReadTask, startRead, startReadPolling } from "../../src/web/services/read-task";
import { useForegroundRead } from "../../src/web/services/use-foreground-read";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("interrupts the transport synchronously and ignores an adapter resolving after cancellation", async () => {
  let signal!: AbortSignal;
  let finish!: (text: string) => void;
  const success = vi.fn(),
    failure = vi.fn(),
    settled = vi.fn();
  const task = startRead(
    (value) => {
      signal = value;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
    { success, failure, settled },
  );
  // Effect owns asynchronous scheduling; wait for the request fiber to start.
  await vi.waitFor(() => expect(signal).toBeDefined());
  task.cancel();
  expect(signal.aborted).toBe(true);
  finish("discarded protected body");
  await Promise.resolve();
  expect(success).not.toHaveBeenCalled();
  expect(failure).not.toHaveBeenCalled();
  expect(settled).not.toHaveBeenCalled();
});

it("reports a read failure once and runs completion without mutation retries", async () => {
  const reason = new Error("Access revoked");
  const request = vi.fn().mockRejectedValue(reason);
  const success = vi.fn(),
    failure = vi.fn(),
    settled = vi.fn();
  startRead(request, { success, failure, settled });
  await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce());
  expect(failure).toHaveBeenCalledExactlyOnceWith(reason);
  expect(request).toHaveBeenCalledOnce();
  expect(success).not.toHaveBeenCalled();
});

it("disposes its Effect polling fiber instead of leaving a view timer alive", async () => {
  vi.useFakeTimers();
  const tick = vi.fn();
  const polling = startReadPolling(tick, 5000);
  await vi.advanceTimersByTimeAsync(5000);
  expect(tick).toHaveBeenCalledOnce();
  polling.cancel();
  await vi.advanceTimersByTimeAsync(15000);
  expect(tick).toHaveBeenCalledOnce();
});

it("pauses foreground polling, clears on blur, cancels pending reads, and reloads on focus", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  let unresolved = false;
  const request = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return unresolved ? new Promise<string>(() => {}) : Promise.resolve("visible metadata");
  });
  function Probe() {
    const [data, setData] = useState("");
    const [paused, setPaused] = useState(false);
    const pending = useRef<ReadTask | null>(null);
    const clear = useCallback(() => {
      pending.current?.cancel();
      pending.current = null;
      setData("");
    }, []);
    const load = useCallback(() => {
      if (pending.current) return;
      pending.current = startRead(request, {
        success: setData,
        failure: () => {},
        settled: () => {
          pending.current = null;
        },
      });
    }, []);
    useForegroundRead(load, clear, { paused });
    return (
      <>
        <button type="button" onClick={() => setPaused(!paused)}>
          Pause
        </button>
        <span>{data}</span>
      </>
    );
  }
  const view = render(<Probe />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(screen.getByText("visible metadata")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(request).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  unresolved = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(request).toHaveBeenCalledTimes(2);
  fireEvent.blur(window);
  expect(signals[1].aborted).toBe(true);
  expect(screen.queryByText("visible metadata")).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(request).toHaveBeenCalledTimes(2);
  unresolved = false;
  fireEvent.focus(window);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(request).toHaveBeenCalledTimes(3);
  expect(screen.getByText("visible metadata")).toBeTruthy();
  view.unmount();
  await vi.advanceTimersByTimeAsync(15000);
  expect(request).toHaveBeenCalledTimes(3);
});
