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

it("keeps visible reads active across blur, while explicit pause still suspends and clears", async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  let unresolved = false;
  let finishPending!: (value: string) => void;
  const request = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return unresolved
      ? new Promise<string>((resolve) => {
          finishPending = resolve;
        })
      : Promise.resolve("visible metadata");
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
    useForegroundRead(load, clear, {
      paused,
      onSuspend: () => {
        pending.current?.cancel();
        pending.current = null;
      },
    });
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
  unresolved = true;
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(request).toHaveBeenCalledTimes(2);
  fireEvent.blur(window);
  expect(signals[1]?.aborted).toBe(false);
  expect(screen.getByText("visible metadata")).toBeTruthy();
  await act(async () => {
    finishPending("accepted while blurred");
    await Promise.resolve();
  });
  expect(screen.getByText("accepted while blurred")).toBeTruthy();
  unresolved = false;
  fireEvent.focus(window);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(request).toHaveBeenCalledTimes(2);
  view.unmount();
  await vi.advanceTimersByTimeAsync(15000);
  expect(request).toHaveBeenCalledTimes(2);
});

it("publishes intermediate pages through the same owner and rejects late progress after cancel", async () => {
  let publish!: (value: string) => void;
  let finish!: (value: string) => void;
  const progress = vi.fn();
  const success = vi.fn();
  const failure = vi.fn();
  const task = startRead<string>(
    (_signal, emit) => {
      publish = emit;
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    },
    { progress, success, failure },
  );
  await vi.waitFor(() => expect(publish).toBeDefined());
  publish("first page");
  expect(progress).toHaveBeenCalledExactlyOnceWith("first page");
  expect(success).not.toHaveBeenCalled();
  task.cancel();
  publish("late next page");
  finish("late complete range");
  await Promise.resolve();
  expect(progress).toHaveBeenCalledOnce();
  expect(success).not.toHaveBeenCalled();
  expect(failure).not.toHaveBeenCalled();
});
