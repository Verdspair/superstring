import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, setupLibrary } from "./helpers/library-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("retains visited editor DOM and follows a later context route without hidden capability reads", async () => {
  setupLibrary();
  const organization = vi.fn().mockResolvedValue(undefined);
  store.setState({ loadOrganization: organization });
  render(
    <DesignSystemProvider>
      <AssistantWorkspace active />
    </DesignSystemProvider>,
  );
  await act(async () => {});
  expect(organization).not.toHaveBeenCalled();
  const studioCards = document.querySelectorAll('.agent-workspace-content [data-slot="card"]');
  expect(studioCards.length).toBeGreaterThan(0);
  expect(
    Array.from(studioCards).every((card) => card.getAttribute("data-presentation") === "plain"),
  ).toBe(true);
  const identity = screen.getByRole("tab", { name: "人设表达" });
  const panel = identity.closest('[data-slot="tabs"]')?.querySelector('[data-slot="tabs-content"]');
  expect(panel).toBeTruthy();
  act(() => store.getState().openSettingsRoute("context"));
  await act(async () => {});
  expect(store.getState().settingsRoute).toBe("context");
  expect(screen.getByRole("tab", { name: "模型配置" }).getAttribute("aria-selected")).toBe("true");
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
  expect(screen.getByRole("tab", { name: "模型配置" }).getAttribute("aria-selected")).toBe("true");
});

it("keeps directory cards boxed and selectable while filtering agents", async () => {
  setupLibrary();
  store.setState({ settingsView: "agents", selectedNewSessionAgentId: A });
  render(
    <DesignSystemProvider>
      <AssistantWorkspace active />
    </DesignSystemProvider>,
  );
  await act(async () => {});
  const agentButton = screen.getByRole("button", { name: "Agent A" });
  const card = agentButton.closest('[data-slot="card"]');
  expect(card?.getAttribute("data-presentation")).toBe("default");
  expect(card?.classList.contains("border")).toBe(true);
  expect(card?.classList.contains("border-primary")).toBe(true);
  expect(card?.querySelector('[data-slot="card-content"]')?.className).toContain(
    "px-(--card-spacing)",
  );
  const selection = screen.getByRole("checkbox", { name: "选择 Agent A" });
  fireEvent.click(selection);
  expect(selection.getAttribute("aria-checked")).toBe("true");
  fireEvent.change(screen.getByRole("textbox", { name: "搜索 Agent" }), {
    target: { value: "Agent B" },
  });
  expect(screen.queryByRole("button", { name: "Agent A" })).toBeNull();
  expect(
    screen
      .getByRole("button", { name: "Agent B" })
      .closest('[data-slot="card"]')
      ?.getAttribute("data-presentation"),
  ).toBe("default");
});
