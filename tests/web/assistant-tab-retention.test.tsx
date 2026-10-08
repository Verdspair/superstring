import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("retains visited editor DOM and follows a later context route without hidden capability reads", async () => {
  setupLibrary();
  const organization = vi.fn().mockResolvedValue(undefined);
  store.setState({ loadOrganization: organization });
  render(<AssistantWorkspace active />);
  await act(async () => {});
  expect(organization).not.toHaveBeenCalled();
  const identity = screen.getByRole("tab", { name: "身份与表达" });
  const panel = identity.closest('[data-slot="tabs"]')?.querySelector('[data-slot="tabs-content"]');
  expect(panel).toBeTruthy();
  act(() => store.getState().openSettingsRoute("context"));
  await act(async () => {});
  expect(store.getState().settingsRoute).toBe("context");
  expect(screen.getByRole("tab", { name: "模型与上下文" }).getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(organization).toHaveBeenCalledTimes(1);
  fireEvent.mouseDown(identity);
  await act(async () => {});
  expect(identity.getAttribute("aria-selected")).toBe("true");
  expect(identity.closest('[data-slot="tabs"]')?.querySelector('[data-slot="tabs-content"]')).toBe(
    panel,
  );
  expect(organization).toHaveBeenCalledTimes(1);
  act(() => store.getState().openSettingsRoute("basic"));
  await act(async () => {});
  act(() => store.getState().openSettingsRoute("context"));
  await act(async () => {});
  expect(screen.getByRole("tab", { name: "模型与上下文" }).getAttribute("aria-selected")).toBe(
    "true",
  );
});
