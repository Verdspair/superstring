import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("QQ app visited views remain mounted", () => {
  it("retains the actual schemes and groups DOM, query state, and scroll nodes while inactive", async () => {
    setupLibrary();
    const view = render(<SchemesWorkspace />);
    const schemesRoute = "qq-app-schemes" as const;
    await act(async () => {
      store.setState({ settingsRoute: schemesRoute });
    });

    const schemesScroll = document.querySelector<HTMLElement>(
      '[data-qq-retained-scroll="schemes"] [data-workspace-scroll]',
    );
    expect(schemesScroll).toBeTruthy();
    fireEvent.change(screen.getByLabelText("搜索方案"), { target: { value: "保留检索" } });
    schemesScroll!.scrollTop = 73;

    await act(async () => store.getState().openSettingsRoute("qq-app-groups"));
    const groupsScroll = document.querySelector<HTMLElement>(
      '[data-qq-retained-scroll="groups"] [data-workspace-scroll]',
    );
    expect(groupsScroll).toBeTruthy();
    fireEvent.change(screen.getByLabelText("搜索群"), { target: { value: "保留群检索" } });
    groupsScroll!.scrollTop = 41;

    await act(async () => store.getState().openSettingsRoute("qq-connection"));
    const schemesPanel = document.querySelector('[data-qq-retained-scroll="schemes"]');
    const groupsPanel = document.querySelector('[data-qq-retained-scroll="groups"]');
    expect(schemesPanel?.querySelector("[data-workspace-scroll]")).toBe(schemesScroll);
    expect(groupsPanel?.querySelector("[data-workspace-scroll]")).toBe(groupsScroll);
    expect(schemesPanel?.hasAttribute("hidden")).toBe(true);
    expect(groupsPanel?.hasAttribute("hidden")).toBe(true);
    expect(schemesScroll!.scrollTop).toBe(73);
    expect(groupsScroll!.scrollTop).toBe(41);
    expect((screen.getByLabelText("搜索方案") as HTMLInputElement).value).toBe("保留检索");
    expect((screen.getByLabelText("搜索群") as HTMLInputElement).value).toBe("保留群检索");

    await act(async () => store.getState().openSettingsRoute("qq-app-schemes"));
    expect(
      document.querySelector('[data-qq-retained-scroll="schemes"] [data-workspace-scroll]'),
    ).toBe(schemesScroll);
    expect(
      document.querySelector('[data-qq-retained-scroll="schemes"]')?.hasAttribute("hidden"),
    ).toBe(false);
    expect(schemesScroll!.scrollTop).toBe(73);
    view.unmount();
  });

  it("does not mount unvisited child views until selected", async () => {
    setupLibrary();
    render(<SchemesWorkspace />);
    await act(async () => store.getState().openSettingsRoute("qq-connection"));
    expect(document.querySelector('[data-qq-retained-scroll="schemes"]')).toBeNull();
    expect(document.querySelector('[data-qq-retained-scroll="groups"]')).toBeNull();
    await act(async () => store.getState().openSettingsRoute("qq-app-schemes"));
    expect(document.querySelector('[data-qq-retained-scroll="schemes"]')).toBeTruthy();
    expect(document.querySelector('[data-qq-retained-scroll="groups"]')).toBeNull();
  });
});
