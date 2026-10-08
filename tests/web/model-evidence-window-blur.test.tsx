import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { InspectedContext } from "../../src/shared/contracts/agent-run";
import { api } from "../../src/web/api";
import { i18n } from "../../src/web/i18n/runtime";
import { ModelEvidence } from "../../src/web/screens/observability/ModelEvidence";
import { useSuperstringStore as store } from "../../src/web/store";

const exact: InspectedContext = {
  status: "exact",
  layout: [],
  sourceVersions: [],
  exactMessages: [{ role: "user", content: [{ kind: "text", text: "Protected input" }] }],
  result: { status: "exact", format: "text", text: "Protected output" },
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

let originalVisibilityDesc: PropertyDescriptor | undefined;

beforeEach(() => {
  originalVisibilityDesc =
    Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState") ??
    Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  void i18n.changeLanguage("zh-CN");
  store.getState().resetForTests(api);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalVisibilityDesc) {
    Object.defineProperty(document, "visibilityState", originalVisibilityDesc);
  }
});

it("keeps an explicitly inspected response when the visible window blurs", async () => {
  const response = deferred<InspectedContext>();
  const inspect = vi.fn(() => response.promise);
  store.getState().resetForTests({ ...api, inspectRunContext: inspect });
  render(<ModelEvidence handle={{ runId: "run-1", stepId: "step-1" }} />);

  fireEvent.click(screen.getByRole("button", { name: "查看实际输入与输出" }));
  expect(inspect).toHaveBeenCalledOnce();
  fireEvent.blur(window);

  await act(async () => {
    response.resolve(exact);
    await response.promise;
  });
  expect(screen.getByText("Protected input")).toBeTruthy();
  expect(inspect).toHaveBeenCalledOnce();

  fireEvent.focus(window);
  expect(screen.getByText("Protected input")).toBeTruthy();
  expect(inspect).toHaveBeenCalledOnce();
});

it("aborts an explicit inspection while the document is hidden and ignores its late response", async () => {
  const response = deferred<InspectedContext>();
  let capturedSignal: AbortSignal | undefined;
  const inspect = vi.fn((_handle, signal?: AbortSignal) => {
    capturedSignal = signal;
    return response.promise;
  });
  store.getState().resetForTests({ ...api, inspectRunContext: inspect });
  render(<ModelEvidence handle={{ runId: "run-1", stepId: "step-1" }} />);

  fireEvent.click(screen.getByRole("button", { name: "查看实际输入与输出" }));
  expect(capturedSignal?.aborted).toBe(false);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  fireEvent(document, new Event("visibilitychange"));
  expect(capturedSignal?.aborted).toBe(true);
  expect(screen.queryByRole("button", { name: "隐藏实际输入与输出" })).toBeNull();

  await act(async () => {
    response.resolve(exact);
    await response.promise;
  });
  expect(screen.queryByText("Protected input")).toBeNull();
  expect(screen.queryByText("Protected output")).toBeNull();
  expect(inspect).toHaveBeenCalledOnce();
});
