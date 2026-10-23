import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopHostBridge } from "../../src/shared/desktop-host";
import App from "../../src/web/App";
import { api, type SuperstringApi } from "../../src/web/api";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

// Background services are stubbed: startup prewarm and change subscription are not
// part of the desktop workspace-ready contract under test.
vi.mock("../../src/web/state/preload-orchestrator", () => ({
  startChunkPreload: () => ({ cancel: () => {} }),
}));
vi.mock("../../src/web/services/conversation-changes", () => ({
  startConversationChanges: () => () => {},
}));

// Leaf workspaces are stubs: this suite drives the real App host, the real lazy
// Suspense boundaries and the real WorkspaceReady effect, never a synthetic host.
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
vi.mock("../../src/web/screens/environment/Preferences", async () => {
  const React = await import("react");
  return {
    Preferences: ({ active = true }: { active?: boolean }) =>
      React.createElement("section", {
        "data-testid": "leaf-preferences",
        "data-active": String(active),
      }),
  };
});

function createMockDesktopHost(overrides: Partial<DesktopHostBridge> = {}): DesktopHostBridge {
  return {
    desktop: true,
    platform: "win32",
    motionManaged: true,
    onStartupState: vi.fn().mockReturnValue(() => {}),
    retry: vi.fn().mockResolvedValue(undefined),
    openLogs: vi.fn().mockResolvedValue(undefined),
    notifyWorkspaceReady: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function setDesktopHost(host: DesktopHostBridge | null) {
  const carrier = window as unknown as { superstringHost?: DesktopHostBridge };
  if (host) carrier.superstringHost = host;
  else delete carrier.superstringHost;
}

let frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

function stubControlledFrames() {
  frames = new Map();
  frameId = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frameId += 1;
    frames.set(frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    frames.delete(handle);
  });
}

const runFrame = () =>
  act(async () => {
    const due = [...frames.entries()];
    frames.clear();
    for (const [handle, callback] of due) callback(handle);
  });

function bootApp() {
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
  };
  store.getState().resetForTests(client as unknown as SuperstringApi);
  store.setState({ status: "ready", bootstrap: vi.fn().mockResolvedValue(undefined) });
  return client;
}

beforeEach(() => {
  stubControlledFrames();
});

afterEach(() => {
  cleanup();
  setDesktopHost(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("desktop workspace-ready notify lifecycle in the real App host", () => {
  it("notifies once after the active lazy workspace commits plus two frames", async () => {
    const host = createMockDesktopHost();
    setDesktopHost(host);
    bootApp();
    render(<App />);
    await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());
    await waitFor(() => expect(findLazyLeaf("leaf-conversations")).toBeTruthy());
    // Lazy content has committed but the ready notify is deferred to two frames.
    expect(host.notifyWorkspaceReady).not.toHaveBeenCalled();
    await runFrame();
    expect(host.notifyWorkspaceReady).not.toHaveBeenCalled();
    await runFrame();
    expect(host.notifyWorkspaceReady).toHaveBeenCalledTimes(1);
    // Idle afterwards: no further frames and no repeat notify.
    await runFrame();
    expect(host.notifyWorkspaceReady).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it("does not notify without a desktop host or without a managed motion controller", async () => {
    // Browser: no host at all. Lazy content still commits; ready stays silent.
    bootApp();
    const browser = render(<App />);
    await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());
    await waitFor(() => expect(findLazyLeaf("leaf-conversations")).not.toBeNull());
    await runFrame();
    await runFrame();
    expect(frames.size).toBe(0);
    browser.unmount();

    // Unmanaged desktop: the bridge exists but the main-process controller is not active.
    const host = createMockDesktopHost({ motionManaged: false });
    setDesktopHost(host);
    render(<App />);
    await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());
    await waitFor(() => expect(findLazyLeaf("leaf-conversations")).not.toBeNull());
    await runFrame();
    await runFrame();
    expect(host.notifyWorkspaceReady).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("keeps a visited but inactive workspace silent after switching spaces", async () => {
    const host = createMockDesktopHost();
    setDesktopHost(host);
    bootApp();
    render(<App />);
    await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());
    await waitFor(() => expect(findLazyLeaf("leaf-conversations")).not.toBeNull());
    await runFrame();
    await runFrame();
    expect(host.notifyWorkspaceReady).toHaveBeenCalledTimes(1);

    // Conversations stays mounted (visited) with active=false; only the newly
    // active assistants boundary is allowed to notify.
    await act(async () => {
      store.setState({ page: "settings", settingsView: "agents" });
    });
    await waitFor(() => expect(findLazyLeaf("leaf-assistants")).not.toBeNull());
    expect(host.notifyWorkspaceReady).toHaveBeenCalledTimes(1);
    await runFrame();
    await runFrame();
    expect(host.notifyWorkspaceReady).toHaveBeenCalledTimes(2);
    const conversations = findLazyLeaf("leaf-conversations");
    expect(conversations).not.toBeNull();
    expect(conversations?.getAttribute("data-active")).toBe("false");
    await runFrame();
    await runFrame();
    expect(host.notifyWorkspaceReady).toHaveBeenCalledTimes(2);
  });

  it("cancels the pending ready frame on unmount", async () => {
    const host = createMockDesktopHost();
    setDesktopHost(host);
    bootApp();
    const { unmount } = render(<App />);
    await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());
    await waitFor(() => expect(findLazyLeaf("leaf-conversations")).toBeTruthy());
    unmount();
    await runFrame();
    await runFrame();
    expect(host.notifyWorkspaceReady).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("warns stably when the host rejects the notify and leaves no unhandled rejection", async () => {
    const host = createMockDesktopHost({
      notifyWorkspaceReady: vi.fn().mockRejectedValue(new Error("SENDER_GONE")),
    });
    setDesktopHost(host);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      bootApp();
      render(<App />);
      await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());
      await waitFor(() => expect(findLazyLeaf("leaf-conversations")).toBeTruthy());
      await runFrame();
      await runFrame();
      await waitFor(() => expect(warn).toHaveBeenCalledWith("DESKTOP_WORKSPACE_READY_FAILED"));
      expect(host.notifyWorkspaceReady).toHaveBeenCalledTimes(1);
      await act(async () => {});
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      warn.mockRestore();
    }
  });
});

/** Probe for the committed lazy leaf content without string-matching markup. */
function findLazyLeaf(testId: string): Element | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}
