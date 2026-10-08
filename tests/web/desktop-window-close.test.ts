import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  type Callback = (...args: unknown[]) => void;
  const appEvents = new Map<string, Callback>();
  const windowEvents = new Map<string, Callback>();
  let resolveStop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  const quit = vi.fn();
  const stop = vi.fn(() => stopped);
  const status = vi.fn();
  class Window {
    static latest: Window;
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
      isDestroyed: () => false,
    };
    constructor() {
      Window.latest = this;
    }
    on(name: string, fn: Callback) {
      windowEvents.set(name, fn);
    }
    once(name: string, fn: Callback) {
      windowEvents.set(name, fn);
    }
    loadURL = vi.fn().mockResolvedValue(undefined);
    isDestroyed() {
      return false;
    }
    isMinimized() {
      return false;
    }
    show() {}
    focus() {}
    restore() {}
    destroy() {}
  }
  class Backend {
    origin = "http://127.0.0.1:17861";
    token = "fixture";
    start = vi.fn().mockResolvedValue(undefined);
    stop = stop;
    status = status;
  }
  class Tray {
    setToolTip() {}
    setContextMenu() {}
    on() {}
    destroy() {}
  }
  const app = {
    setName: vi.fn(),
    getPath: () => "/fixture",
    setPath: vi.fn(),
    setAppLogsPath: vi.fn(),
    requestSingleInstanceLock: () => true,
    on: (name: string, fn: Callback) => appEvents.set(name, fn),
    whenReady: () => Promise.resolve(),
    getLocale: () => "en",
    quit,
  };
  return { app, Window, Backend, Tray, quit, stop, status, windowEvents, resolveStop };
});
vi.mock("electron", () => ({
  app: harness.app,
  BrowserWindow: harness.Window,
  Tray: harness.Tray,
  dialog: { showMessageBox: vi.fn() },
  ipcMain: {},
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: vi.fn() },
  nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
  session: { fromPartition: () => ({}) },
  shell: {},
}));
vi.mock("node:fs", () => {
  const fs = { mkdirSync: vi.fn(), realpathSync: (path: string) => path, writeFileSync: vi.fn() };
  return { ...fs, default: fs };
});
vi.mock("electron-log/main", () => ({
  default: { transports: { file: {}, console: {} }, info: vi.fn(), error: vi.fn() },
}));
vi.mock("i18next", () => ({
  default: { init: vi.fn().mockResolvedValue(undefined), t: (key: string) => key },
}));
vi.mock("../../src/desktop/backend", () => ({
  DesktopBackend: harness.Backend,
  localRequest: vi.fn(),
}));
vi.mock("../../src/desktop/preferences", () => ({
  installDesktopPreferences: vi.fn().mockResolvedValue(vi.fn()),
}));
vi.mock("../../src/desktop/security", () => ({
  externalHttpUrl: vi.fn(),
  installSessionSecurity: vi.fn(),
  isServiceUrl: () => true,
}));
afterEach(() => {
  vi.restoreAllMocks();
});

describe("native Electron window close", () => {
  it("does not stop on reload, starts one stop on close, and quits only after it settles", async () => {
    const resources = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/fixture/resources",
    });
    try {
      await import("../../src/desktop/main");
      for (let i = 0; i < 12; i++) await Promise.resolve();
      expect(harness.Window.latest).toBeDefined();
      await harness.Window.latest.loadURL("http://127.0.0.1:17861");
      expect(harness.stop).not.toHaveBeenCalled();
      const close = harness.windowEvents.get("close");
      expect(close).toBeDefined();
      const preventDefault = vi.fn();
      close?.({ preventDefault });
      close?.({ preventDefault });
      expect(harness.stop).toHaveBeenCalledTimes(1);
      expect(harness.status).not.toHaveBeenCalled();
      expect(harness.quit).not.toHaveBeenCalled();
      harness.resolveStop();
      for (let i = 0; i < 6; i++) await Promise.resolve();
      expect(harness.quit).toHaveBeenCalledTimes(1);
    } finally {
      if (resources) Object.defineProperty(process, "resourcesPath", resources);
      else Reflect.deleteProperty(process, "resourcesPath");
    }
  });
});
