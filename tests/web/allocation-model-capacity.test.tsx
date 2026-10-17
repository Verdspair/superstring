import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectLocale } from "../../src/web/i18n";
import { AllocationModelCapacity } from "../../src/web/screens/connections/AllocationModelCapacity";
import { useSuperstringStore as store } from "../../src/web/store";

beforeEach(async () => {
  store.getState().resetForTests();
  await selectLocale("en");
});
afterEach(cleanup);
it("uses the model capacity endpoint and carries the precise model target through guarded navigation", async () => {
  const getModelCapacity = vi.fn(async (model: string) => ({
    model,
    status: "loaded" as const,
    context_length: 65536,
  }));
  store.setState({ apiClient: { ...store.getState().apiClient, getModelCapacity } });
  render(<AllocationModelCapacity model="declared-model" />);
  await waitFor(() => expect(screen.getByText(/65536 Tokens/)).toBeTruthy());
  expect(getModelCapacity).toHaveBeenCalledWith("declared-model");
  fireEvent.click(screen.getByRole("button"));
  await waitFor(() => expect(store.getState().settingsRoute).toBe("external-api"));
  expect(store.getState().modelCapacityTarget).toBe("declared-model");
});
it("rejects late capacity from a previously selected model and keeps unknown honest", async () => {
  let resolveOld: (value: { model: string; status: "loaded"; context_length: number }) => void =
    () => {};
  const old = new Promise<{ model: string; status: "loaded"; context_length: number }>(
    (resolve) => {
      resolveOld = resolve;
    },
  );
  const getModelCapacity = vi.fn((model: string) =>
    model === "old"
      ? old
      : Promise.resolve({ model, status: "unknown" as const, context_length: null }),
  );
  store.setState({ apiClient: { ...store.getState().apiClient, getModelCapacity } });
  const view = render(<AllocationModelCapacity model="old" />);
  view.rerender(<AllocationModelCapacity model="new" />);
  await act(async () => resolveOld({ model: "old", status: "loaded", context_length: 99999 }));
  expect(screen.queryByText(/99999/)).toBeNull();
  expect(screen.getByText("new")).toBeTruthy();
});
