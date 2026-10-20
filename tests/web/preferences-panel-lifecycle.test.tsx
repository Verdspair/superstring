import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../src/web/App";
import { api, type SuperstringApi } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

// Background services are stubbed: they are not part of the preferences
// lifecycle contract under test.
vi.mock("../../src/web/state/preload-orchestrator", () => ({
  startChunkPreload: () => ({ cancel: () => {} }),
}));
vi.mock("../../src/web/services/conversation-changes", () => ({
  startConversationChanges: () => () => {},
}));

// Leaf workspaces are stubs: this suite drives the real App host, the real
// Sheet primitive and the real Preferences panel, never a synthetic host.
vi.mock("../../src/web/screens/conversations/ConversationWorkspace", async () => {
  const React = await import("react");
  return {
    ConversationWorkspace: ({ active = true }: { active?: boolean }) =>
      React.createElement("section", {
        "data-testid": "leaf-conversations",
        "data-active": String(active),
      }),
  };
});
vi.mock("../../src/web/screens/assistants/AssistantWorkspace", async () => {
  const React = await import("react");
  return {
    AssistantWorkspace: ({ active = true }: { active?: boolean }) =>
      React.createElement("section", {
        "data-testid": "leaf-assistants",
        "data-active": String(active),
      }),
  };
});
vi.mock("../../src/web/screens/connections/CapabilitiesWorkspace", async () => {
  const React = await import("react");
  return {
    CapabilitiesWorkspace: ({ active = true }: { active?: boolean }) =>
      React.createElement("section", {
        "data-testid": "leaf-capabilities",
        "data-active": String(active),
      }),
  };
});
vi.mock("../../src/web/screens/connections/SchemesWorkspace", async () => {
  const React = await import("react");
  return {
    SchemesWorkspace: ({ active = true }: { active?: boolean }) =>
      React.createElement("section", {
        "data-testid": "leaf-schemes",
        "data-active": String(active),
      }),
  };
});
vi.mock("../../src/web/screens/library/LibraryWorkspace", async () => {
  const React = await import("react");
  return {
    LibraryWorkspace: ({ active = true }: { active?: boolean }) =>
      React.createElement("section", {
        "data-testid": "leaf-library",
        "data-active": String(active),
      }),
  };
});
vi.mock("../../src/web/screens/connections/ConnectionWorkspace", async () => {
  const React = await import("react");
  return {
    ConnectionWorkspace: ({ active = true }: { active?: boolean }) =>
      React.createElement("section", {
        "data-testid": "leaf-connections",
        "data-active": String(active),
      }),
  };
});
vi.mock("../../src/web/screens/environment/ModelServices", async () => {
  const React = await import("react");
  return {
    ModelServices: ({ active = true }: { active?: boolean }) =>
      React.createElement("section", {
        "data-testid": "leaf-models",
        "data-active": String(active),
      }),
  };
});

let removeDesktopMeta: () => void = () => {};
function desktopMode() {
  const meta = document.createElement("meta");
  meta.name = "desktop-mode";
  meta.content = "1";
  document.head.append(meta);
  removeDesktopMeta = () => meta.remove();
}

function bootApp(extra: Record<string, unknown> = {}) {
  const client = {
    ...api,
    listConversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listAgents: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue({
      provider: "lm_studio",
      status: "available",
      models: [],
      default_model: null,
    }),
    listModelProviders: vi.fn().mockResolvedValue([]),
    getDesktopSettings: vi.fn().mockResolvedValue({ close_action: "background", revision: 1 }),
    updateDesktopSettings: vi.fn().mockResolvedValue({ close_action: "exit", revision: 2 }),
    subscribeConversationChanges: vi.fn().mockResolvedValue(() => {}),
  };
  store.getState().resetForTests(client as unknown as SuperstringApi);
  selectLocale("zh-CN");
  store.setState({ status: "ready", bootstrap: vi.fn().mockResolvedValue(undefined), ...extra });
  return client;
}

function sheetContents() {
  return document.querySelectorAll('[data-slot="sheet-content"]');
}

async function openPreferencesFromNavigation() {
  await userEvent.click(screen.getByRole("button", { name: "偏好" }));
  await waitFor(() => expect(screen.getByText("让工作区更像你")).toBeTruthy());
}

async function closeAndExpectRouteGone() {
  await waitFor(() => expect(sheetContents()).toHaveLength(0));
}

afterEach(() => {
  cleanup();
  removeDesktopMeta();
  removeDesktopMeta = () => {};
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

describe("preferences panel lifecycle in the real App host", () => {
  it.each(["external-api", "qq-scheme-config", "qq-group-config"] as const)(
    "returns to the exact %s sub-route after Escape and after dismissing the panel",
    async (settingsRoute) => {
      bootApp();
      render(<App />);
      await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());
      // "before" goes through the real draft-aware route action, never a state patch.
      act(() => store.getState().openSettingsRoute(settingsRoute));
      expect(store.getState().settingsRoute).toBe(settingsRoute);

      await openPreferencesFromNavigation();
      expect(store.getState().settingsView).toBe("general");
      await userEvent.keyboard("{Escape}");
      await closeAndExpectRouteGone();
      expect(store.getState().page).toBe("settings");
      expect(store.getState().settingsView).toBe("workspace");
      expect(store.getState().settingsRoute).toBe(settingsRoute);

      // Reopen, then dismiss through the panel close button instead of Escape.
      await openPreferencesFromNavigation();
      await userEvent.click(screen.getByRole("button", { name: "关闭面板" }));
      await closeAndExpectRouteGone();
      expect(store.getState().page).toBe("settings");
      expect(store.getState().settingsView).toBe("workspace");
      expect(store.getState().settingsRoute).toBe(settingsRoute);
    },
  );

  it("keeps one panel instance, releases it on close, and reopens with persisted appearance", async () => {
    desktopMode();
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const client = bootApp();
    render(<App />);
    await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());
    const storageDelta = () =>
      addSpy.mock.calls.filter(([type]) => type === "storage").length -
      removeSpy.mock.calls.filter(([type]) => type === "storage").length;
    const baseline = storageDelta();

    await openPreferencesFromNavigation();
    expect(document.querySelectorAll('[data-slot="sheet-content"]')).toHaveLength(1);
    expect(screen.getAllByText("让工作区更像你")).toHaveLength(1);
    // One desktop read per activation; the existing loadDesktopSettings action
    // merges concurrent reads, so a single activation never duplicates it.
    await waitFor(() => expect(client.getDesktopSettings).toHaveBeenCalledTimes(1));
    expect(storageDelta() - baseline).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "峡湾" }));
    expect(localStorage.getItem("superstring-appearance")).toBe("fjord");

    await userEvent.click(screen.getByRole("button", { name: "关闭面板" }));
    await closeAndExpectRouteGone();
    expect(storageDelta() - baseline).toBe(0);

    await openPreferencesFromNavigation();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "峡湾" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );
    await waitFor(() => expect(client.getDesktopSettings).toHaveBeenCalledTimes(2));
    expect(document.querySelectorAll('[data-slot="sheet-content"]')).toHaveLength(1);
    expect(storageDelta() - baseline).toBe(1);
  });

  it("falls back to conversations when preferences is the first destination and is dismissed", async () => {
    bootApp({ page: "settings", settingsView: "hub", settingsRoute: "basic" });
    render(<App />);
    await waitFor(() => expect(screen.getByText("让工作区更像你")).toBeTruthy());
    expect(store.getState().page).toBe("settings");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(store.getState().page).toBe("chat"));
    await closeAndExpectRouteGone();
  });

  it("never opens preferences when the unsaved-draft guard is cancelled", async () => {
    bootApp({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
      dirty: true,
      editorAgentId: "__new__",
    });
    render(<App />);
    await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "偏好" }));
    expect(screen.getByText("当前分区有未保存修改")).toBeTruthy();
    expect(document.querySelector('[data-slot="sheet-content"]')).toBeNull();
    expect(store.getState().navigationConfirmOpen).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "取消离开" }));
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(store.getState().page).toBe("settings");
    expect(store.getState().settingsView).toBe("workspace");
    expect(screen.queryByText("让工作区更像你")).toBeNull();
    expect(sheetContents()).toHaveLength(0);
  });

  it("restores focus to the preferences trigger after the panel closes", async () => {
    bootApp();
    render(<App />);
    await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());
    const trigger = screen.getByRole("button", { name: "偏好" });

    // jsdom has zero rectangles; avoid the splitter origin when testing focus restoration.
    await userEvent.pointer({
      target: trigger,
      keys: "[MouseLeft]",
      coords: { clientX: 100, clientY: 400 },
    });
    await waitFor(() => expect(screen.getByText("让工作区更像你")).toBeTruthy());
    await userEvent.keyboard("{Escape}");
    await closeAndExpectRouteGone();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps a single modal on mobile when preferences opens from the navigation sheet", async () => {
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    bootApp();
    render(<App />);
    await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "会话与导航" }));
    expect(sheetContents()).toHaveLength(1);
    await userEvent.click(
      within(screen.getByRole("dialog", { name: "会话与导航" })).getByRole("button", {
        name: "偏好",
      }),
    );
    await waitFor(() => expect(screen.getByText("让工作区更像你")).toBeTruthy());
    expect(store.getState().settingsView).toBe("general");
    // Navigation sheet has yielded; only the preferences modal remains.
    await waitFor(() => expect(sheetContents()).toHaveLength(1));

    await userEvent.keyboard("{Escape}");
    await closeAndExpectRouteGone();
    expect(store.getState().page).toBe("chat");
    // Focus falls back to the stable mobile navigation trigger, queried by
    // role and accessible name (no implementation id).
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "会话与导航" })),
    );
  });

  it("opens preferences from the command palette on the active sub-route and restores it on Escape", async () => {
    // Non-preferences child route is the starting point; the palette entry must
    // navigate through the real guarded navigation, then Escape returns to it.
    bootApp({ page: "settings", settingsView: "workspace", settingsRoute: "external-api" });
    render(<App />);
    await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());

    await userEvent.click(screen.getByRole("button", { name: "搜索与跳转" }));
    const command = await screen.findByRole("dialog", { name: "搜索与跳转" });
    await userEvent.type(within(command).getByRole("combobox"), "偏好");
    expect(screen.getByRole("option", { name: /偏好/ })).toBeTruthy();
    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(screen.getByText("让工作区更像你")).toBeTruthy());
    expect(store.getState().settingsView).toBe("general");

    await userEvent.keyboard("{Escape}");
    await closeAndExpectRouteGone();
    expect(store.getState().page).toBe("settings");
    expect(store.getState().settingsView).toBe("workspace");
    expect(store.getState().settingsRoute).toBe("external-api");

    // Focus lands on a visible, still-mounted trigger: the search trigger itself
    // or a button inside the main navigation aside. The palette option that was
    // selected is unmounted by now and must not be demanded here.
    await waitFor(() => {
      const focused = document.activeElement;
      expect(focused).toBeInstanceOf(HTMLElement);
      const el = focused as HTMLElement;
      expect(el.isConnected).toBe(true);
      const searchTrigger = screen.getByRole("button", { name: "搜索与跳转" });
      expect(focused === searchTrigger || el.closest("aside") !== null).toBe(true);
    });
  });
});
