import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLiveResource } from "../../src/web/services/use-live-resource";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("does not read a paused resource on mount and resumes it once", async () => {
  const read = vi.fn().mockResolvedValue("current");
  const { result, rerender } = renderHook(({ paused }) => useLiveResource(read, { paused }), {
    initialProps: { paused: true },
  });
  await act(async () => {});
  expect(read).not.toHaveBeenCalled();
  rerender({ paused: false });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  expect(result.current.data).toBe("current");
  rerender({ paused: true });
  await act(async () => {});
  expect(result.current.data).toBe("current");
});

it("aborts the old read on pause and rejects its late result after one resume read", async () => {
  const releases: ((value: string) => void)[] = [];
  const signals: AbortSignal[] = [];
  const read = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return new Promise<string>((resolve) => releases.push(resolve));
  });
  const { result, rerender } = renderHook(({ paused }) => useLiveResource(read, { paused }), {
    initialProps: { paused: false },
  });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
  rerender({ paused: true });
  expect(signals[0].aborted).toBe(true);
  rerender({ paused: false });
  act(() => {
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.focus(window);
  });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(2);
  await act(async () => releases[0]("old"));
  expect(result.current.data).toBeNull();
  expect(result.current.loading).toBe(true);
  await act(async () => releases[1]("new"));
  expect(result.current.data).toBe("new");
  expect(result.current.loading).toBe(false);
});

it("does not duplicate a resume read when its scope callback changes in the same render", async () => {
  const first = vi.fn().mockResolvedValue("A");
  const second = vi.fn().mockResolvedValue("B");
  const { result, rerender } = renderHook(({ paused, read }) => useLiveResource(read, { paused }), {
    initialProps: { paused: true, read: first },
  });
  rerender({ paused: false, read: second });
  await act(async () => {});
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
  expect(result.current.data).toBe("B");
});
