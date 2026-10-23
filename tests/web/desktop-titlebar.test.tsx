import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopHostBridge } from "../../src/shared/desktop-host";
import { getDesktopHost, isDesktopHost } from "../../src/web/desktop-host";
import { WorkspaceShell } from "../../src/web/workspace/WorkspaceShell";
import { render } from "./helpers/render-with-providers";

function createMockDesktopHost(): DesktopHostBridge {
  return {
    desktop: true,
    platform: "win32",
    motionManaged: false,
    onStartupState: vi.fn().mockReturnValue(() => {}),
    retry: vi.fn().mockResolvedValue(undefined),
    openLogs: vi.fn().mockResolvedValue(undefined),
    notifyWorkspaceReady: vi.fn().mockResolvedValue(undefined),
  };
}

describe("desktop-host bridge detection", () => {
  beforeEach(() => {
    delete (window as unknown as { superstringHost?: unknown }).superstringHost;
  });

  afterEach(() => {
    delete (window as unknown as { superstringHost?: unknown }).superstringHost;
    cleanup();
  });

  it("reports not desktop when window.superstringHost is absent", () => {
    expect(getDesktopHost()).toBeUndefined();
    expect(isDesktopHost()).toBe(false);
  });

  it("reports desktop when window.superstringHost is present with desktop: true", () => {
    const mock = createMockDesktopHost();
    (window as unknown as { superstringHost?: DesktopHostBridge }).superstringHost = mock;

    expect(getDesktopHost()).toBe(mock);
    expect(isDesktopHost()).toBe(true);
  });

  it("reports not desktop if superstringHost.desktop is not true", () => {
    (window as unknown as { superstringHost?: unknown }).superstringHost = {
      desktop: false,
      platform: "win32",
    };

    expect(isDesktopHost()).toBe(false);
  });
});

describe("WorkspaceShell desktop titlebar and WCO overlay integration", () => {
  beforeEach(() => {
    delete (window as unknown as { superstringHost?: unknown }).superstringHost;
  });

  afterEach(() => {
    delete (window as unknown as { superstringHost?: unknown }).superstringHost;
    cleanup();
  });

  it("renders standard web header without desktop drag or WCO padding in web mode", () => {
    render(
      <WorkspaceShell>
        <div data-testid="test-content">Content</div>
      </WorkspaceShell>,
    );

    const header = document.querySelector('header[data-slot="app-header"]') as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.getAttribute("data-desktop-host")).toBeNull();
    expect(header.style.getPropertyValue("-webkit-app-region")).toBeFalsy();
    expect(screen.getByTestId("test-content")).toBeDefined();
  });

  it("renders WCO titlebar drag region and zoom compensation in desktop mode", () => {
    (window as unknown as { superstringHost?: DesktopHostBridge }).superstringHost =
      createMockDesktopHost();

    render(
      <WorkspaceShell>
        <div data-testid="test-content">Content</div>
      </WorkspaceShell>,
    );

    const header = document.querySelector('header[data-slot="app-header"]') as HTMLElement;
    expect(header).not.toBeNull();
    expect(header.getAttribute("data-desktop-host")).toBe("true");

    // jsdom does not implement app-region; Electron checks the actual drag geometry.

    // Header has zoom-compensated minHeight and paddingRight for WCO overlay buttons
    expect(header.style.minHeight).toContain("env(titlebar-area-height, 36px)");
    expect(header.style.minHeight).toContain("var(--app-interface-scale, 1)");
    expect(header.style.paddingRight).toContain("148px");
    expect(header.style.paddingRight).toContain("var(--app-interface-scale, 1)");

    const language = screen.getByRole("button", { name: "切换界面文字语言；选择后立即生效。" });
    expect(language).toBeDefined();
    expect(header.contains(language ?? null)).toBe(true);
    expect((language as HTMLButtonElement).disabled).toBe(false);
  });
});
