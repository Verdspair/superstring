import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_MOTION_MANAGED,
  DESKTOP_STARTUP_RETRY,
  DESKTOP_STARTUP_STATE,
  DESKTOP_WORKSPACE_READY,
} from "../../src/shared/desktop-host";
import { DESKTOP_APP_ID } from "../../src/shared/window-motion";

type Handler = (...args: unknown[]) => unknown;
type Mock = ReturnType<typeof vi.fn>;
type MotionFactory = typeof import("../../src/desktop/window-motion").createWindowMotion;
type BackendOptions = import("../../src/desktop/backend").BackendOptions;

const harness = vi.hoisted(() => {
  type Callback = (...args: unknown[]) => void;
  const appEvents = new Map<string, Callback>();
  const windowEvents = new Map<string, Callback>();
  const webContentsEvents = new Map<string, Callback>();
  const exit = vi.fn();
  const terminate = vi.fn();
  const stop = vi.fn();
  const start = vi.fn(async () => "http://127.0.0.1:17861");
  const startupLoad: { pending: Promise<void> | null } = { pending: null };
  const installPreferences = vi.fn(async () => vi.fn());
  const ipcInvokes = new Map<string, Handler>();
  const ipcSyncs = new Map<string, Handler>();
  /** Native adapter returned by the mocked win32 attachment; null is the non-managed base. */
  const nativeState: { adapter: unknown } = { adapter: null };
  /** Saved window-state fixture: the mocked manager initializes from it and exposes itself. */
  const windowState = {
    initial: {
      bounds: { width: 1280, height: 860, maximized: false } as Record<string, unknown>,
      nativePlacement: null as Record<string, unknown> | null,
    },
    latest: undefined as
      | {
          saved: {
            bounds: Record<string, unknown>;
            nativePlacement: Record<string, unknown> | null;
          };
          save: Mock;
        }
      | undefined,
  };
  const attachNativeWindowMotion = vi.fn(() => nativeState.adapter);
  const createWindowMotion = vi.fn(
    (
      win: Parameters<MotionFactory>[0],
      options: Parameters<MotionFactory>[1],
      actual: MotionFactory,
    ) => actual(win, options),
  );

  // Mock main window: DIP fields only, never a fake native read; the fakeNative adapter
  // supplies the physical-placement surface for the managed cases.
  class Window {
    static latest: Window | undefined;
    static all: Window[] = [];
    private url = "";
    opacity = 1;
    visible = false;
    webContents = {
      setWindowOpenHandler: vi.fn(),
      on: (name: string, fn: Callback) => webContentsEvents.set(name, fn),
      once: (name: string, fn: Callback) => webContentsEvents.set(name, fn),
      send: vi.fn(),
      getURL: () => this.url,
      executeJavaScript: vi.fn(async () => false),
      isDestroyed: () => false,
      capturePage: vi.fn(async () => ({
        isEmpty: () => true,
        getSize: () => ({ width: 0, height: 0 }),
        toBitmap: () => Buffer.alloc(0),
      })),
      mainFrame: { url: "" },
    };
    constructor() {
      Window.latest = this;
      Window.all.push(this);
    }
    on(name: string, fn: Callback) {
      windowEvents.set(name, fn);
    }
    once(name: string, fn: Callback) {
      windowEvents.set(name, fn);
    }
    loadURL = vi.fn(async (url: string) => {
      this.url = url;
      if (url === "superstring://startup/") await startupLoad.pending;
    });
    getNormalBounds = () => ({ x: 10, y: 10, width: 1280, height: 860 });
    isDestroyed = () => false;
    isMinimized = () => false;
    isMaximized = () => false;
    maximize = vi.fn();
    show = vi.fn(() => {
      this.visible = true;
    });
    showInactive = vi.fn(() => {
      this.visible = true;
    });
    hide = vi.fn(() => {
      this.visible = false;
    });
    focus = vi.fn();
    restore = vi.fn();
    loadFile = vi.fn(async () => undefined);
    getOpacity = () => this.opacity;
    setOpacity = vi.fn((value: number) => {
      this.opacity = value;
    });
    isVisible = () => this.visible;
    getBounds = () => ({ x: 10, y: 10, width: 1280, height: 860 });
    getContentBounds = () => ({ x: 10, y: 10, width: 1280, height: 860 });
    setBounds = vi.fn();
    setAlwaysOnTop = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setTitleBarOverlay = vi.fn();
    destroy = vi.fn();
  }

  class Backend {
    static latest: Backend | undefined;
    origin = "http://127.0.0.1:17861";
    exitCode: number | null = null;
    token = "fixture";
    constructor(readonly options: BackendOptions) {
      Backend.latest = this;
    }
    start = start;
    stop = stop;
    terminate = terminate;
    status = vi.fn();
  }

  const app = {
    setName: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    isPackaged: false,
    getAppPath: () => "C:/fixture/app",
    getPath: () => "C:/fixture",
    setPath: vi.fn(),
    setAppLogsPath: vi.fn(),
    // Real Electron app API used by src/desktop/main.ts (single AUMID literal source
    // DESKTOP_APP_ID from src/shared/window-motion.ts); mocked with its real shape.
    setAppUserModelId: vi.fn(),
    getLocale: () => "en",
    getVersion: () => "0.0.0-fixture",
    requestSingleInstanceLock: () => true,
    on: (name: string, fn: Callback) => appEvents.set(name, fn),
    whenReady: () => Promise.resolve(),
    exit,
    quit: vi.fn(),
  };
  const desktopSession = { protocol: { handle: vi.fn() } };
  const nativeTheme = { themeSource: "system", shouldUseDarkColors: false, on: vi.fn() };
  type DisplayRect = { x: number; y: number; width: number; height: number };
  // The main-process placement contract reads id/scaleFactor/bounds/workArea: the fixture
  // exposes two real-shaped displays so a physical restore can match or mismatch exactly.
  const displayFor = (id: number, scaleFactor: number, bounds: DisplayRect) => ({
    id,
    scaleFactor,
    bounds: { ...bounds },
    workArea: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height - 40 },
  });
  const screen = {
    getAllDisplays: () => [
      displayFor(3, 2, { x: 0, y: 0, width: 2560, height: 1440 }),
      displayFor(7, 1, { x: 2560, y: 0, width: 1920, height: 1080 }),
    ],
    getDisplayMatching: (rect: DisplayRect) =>
      rect.x >= 2560
        ? displayFor(7, 1, { x: 2560, y: 0, width: 1920, height: 1080 })
        : displayFor(3, 2, { x: 0, y: 0, width: 2560, height: 1440 }),
    screenToDipRect: (_win: unknown, rect: unknown) => rect,
  };
  return {
    app,
    Backend,
    Window,
    attachNativeWindowMotion,
    windowState,
    createWindowMotion,
    desktopSession,
    exit,
    installPreferences,
    ipcInvokes,
    ipcSyncs,
    nativeState,
    nativeTheme,
    screen,
    start,
    startupLoad,
    stop,
    terminate,
    webContentsEvents,
    windowEvents,
    appEvents,
  };
});

vi.mock("electron", () => ({
  app: harness.app,
  BrowserWindow: harness.Window,
  ipcMain: {
    handle: (name: string, fn: Handler) => {
      harness.ipcInvokes.set(name, fn);
    },
    on: (name: string, fn: Handler) => {
      harness.ipcSyncs.set(name, fn);
    },
    removeListener: vi.fn(),
  },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: vi.fn() },
  nativeTheme: harness.nativeTheme,
  protocol: { registerSchemesAsPrivileged: vi.fn() },
  screen: harness.screen,
  session: { fromPartition: () => harness.desktopSession },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));
vi.mock("node:fs", () => {
  const fs = {
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => Buffer.from("")),
    realpathSync: (value: string) => value,
    writeFileSync: vi.fn(),
  };
  return { ...fs, default: fs };
});
vi.mock("electron-log/main", () => ({
  default: {
    transports: { file: {}, console: {} },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock("i18next", () => ({
  default: {
    init: vi.fn().mockResolvedValue(undefined),
    t: (key: string) => key,
    changeLanguage: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../../src/desktop/backend", () => ({
  DesktopBackend: harness.Backend,
  localRequest: vi.fn(),
}));
vi.mock("../../src/desktop/preferences", () => ({
  installDesktopPreferences: harness.installPreferences,
}));
vi.mock("../../src/desktop/native/win32", () => ({
  attachNativeWindowMotion: harness.attachNativeWindowMotion,
}));
vi.mock("../../src/desktop/window-motion", async () => {
  const actual = await vi.importActual<typeof import("../../src/desktop/window-motion")>(
    "../../src/desktop/window-motion",
  );
  return {
    createWindowMotion: (
      win: Parameters<MotionFactory>[0],
      options: Parameters<MotionFactory>[1],
    ) => harness.createWindowMotion(win, options, actual.createWindowMotion),
  };
});
vi.mock("../../src/desktop/security", () => ({
  externalHttpUrl: vi.fn(),
  installSessionSecurity: vi.fn(),
  isServiceUrl: (url: string, origin: string) => url === origin || url.startsWith(`${origin}/`),
}));
vi.mock("../../src/desktop/host-layout", () => ({
  resolveHostLayout: () => ({
    mode: "development-legacy",
    profileRoot: "C:/fixture/profile",
    projectRoot: "C:/fixture/project",
    executable: "C:/fixture/bun.exe",
    args: [],
    cwd: "C:/fixture/project",
    resourceRoot: "C:/fixture/project",
  }),
}));
vi.mock("../../src/desktop/window-state", () => ({
  WindowStateManager: class {
    saved = {
      bounds: { ...harness.windowState.initial.bounds },
      nativePlacement: harness.windowState.initial.nativePlacement
        ? { ...harness.windowState.initial.nativePlacement }
        : null,
    };
    constructor() {
      harness.windowState.latest = this;
    }
    get bounds() {
      return {
        ...this.saved.bounds,
        ...(this.saved.nativePlacement
          ? { nativePlacement: { ...this.saved.nativePlacement } }
          : {}),
      };
    }
    get nativePlacement() {
      return this.saved.nativePlacement ? { ...this.saved.nativePlacement } : null;
    }
    validateBounds = () => {
      const { x, y, width, height } = this.saved.bounds as {
        x?: number;
        y?: number;
        width: number;
        height: number;
      };
      return { ...(typeof x === "number" && typeof y === "number" ? { x, y } : {}), width, height };
    };
    /** The mocked save mirrors the real contract: refresh the ordinary snapshot on save. */
    save = vi.fn((win: { getNormalBounds: () => unknown; isMaximized: () => boolean }) => {
      this.saved.bounds = {
        ...(win.getNormalBounds() as Record<string, unknown>),
        maximized: win.isMaximized(),
        ...(this.saved.nativePlacement
          ? { nativePlacement: { ...this.saved.nativePlacement } }
          : {}),
      };
    });
    track = () => () => undefined;
  },
}));

const settle = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function holdStartup(presentation: Promise<void>) {
  const presentStartup = vi.fn(() => presentation);
  const navigate = vi.fn(async (_url: string) => undefined);
  harness.createWindowMotion.mockImplementationOnce((win, options, actual) => ({
    ...actual(win, options),
    presentStartup,
    navigate,
  }));
  return { presentStartup, navigate };
}

/** Minimal native-motion surface for the managed fixture; the controller owns all legs. */
const fakeNative = () => ({
  setHandler: vi.fn(),
  bypass: <T>(run: () => T) => run(),
  setTransitionsDisabled: vi.fn(),
  resolveTarget: vi.fn(() => null),
  getPhysicalBounds: vi.fn(() => null),
  setPhysicalBounds: vi.fn(() => true),
  dispose: vi.fn(),
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  harness.appEvents.clear();
  harness.windowEvents.clear();
  harness.webContentsEvents.clear();
  harness.Window.latest = undefined;
  harness.Window.all = [];
  harness.Backend.latest = undefined;
  harness.ipcInvokes.clear();
  harness.ipcSyncs.clear();
  harness.nativeState.adapter = null;
  harness.startupLoad.pending = null;
  harness.start.mockReset().mockResolvedValue("http://127.0.0.1:17861");
  harness.windowState.latest = undefined;
  harness.windowState.initial.bounds = { width: 1280, height: 860, maximized: false };
  harness.windowState.initial.nativePlacement = null;
  harness.installPreferences.mockReset().mockResolvedValue(vi.fn());
  process.env.SUPERSTRING_DESKTOP_PROJECT_ROOT = "C:/fixture/project";
  delete process.env.SUPERSTRING_DESKTOP_INSTALL_ROOT;
});

afterEach(() => {
  delete process.env.SUPERSTRING_DESKTOP_PROJECT_ROOT;
  delete process.env.SUPERSTRING_DESKTOP_INSTALL_ROOT;
  vi.restoreAllMocks();
});

describe("native Electron window close", () => {
  it.each(["backend", "presentation"])(
    "starts the backend during startup presentation and waits for both (%s first)",
    async (first) => {
      const presentation = deferred<void>();
      const backend = deferred<string>();
      const motion = holdStartup(presentation.promise);
      harness.start.mockReturnValueOnce(backend.promise);
      await import("../../src/desktop/main");
      await settle();

      expect(motion.presentStartup).toHaveBeenCalledTimes(1);
      expect(harness.start).toHaveBeenCalledTimes(1);
      expect(motion.navigate).not.toHaveBeenCalled();
      if (first === "backend") backend.resolve("http://127.0.0.1:17861");
      else presentation.resolve(undefined);
      await settle();
      expect(motion.navigate).not.toHaveBeenCalled();

      if (first === "backend") presentation.resolve(undefined);
      else backend.resolve("http://127.0.0.1:17861");
      await settle();
      expect(motion.navigate).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:17861");
    },
  );

  it("does not start the backend when closed during the initial document load", async () => {
    const loaded = deferred<void>();
    harness.startupLoad.pending = loaded.promise;
    await import("../../src/desktop/main");
    await settle();
    expect(harness.Window.latest?.loadURL).toHaveBeenCalledWith("superstring://startup/");
    expect(harness.start).not.toHaveBeenCalled();

    harness.windowEvents.get("close")?.({});
    loaded.resolve(undefined);
    await settle();
    expect(harness.start).not.toHaveBeenCalled();
    expect(harness.exit).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"])(
    "ignores a late backend %s after close during overlapping startup",
    async (outcome) => {
      const presentation = deferred<void>();
      const backend = deferred<string>();
      const motion = holdStartup(presentation.promise);
      harness.start.mockReturnValueOnce(backend.promise);
      await import("../../src/desktop/main");
      await settle();
      const current = harness.Window.latest;
      expect(harness.start).toHaveBeenCalledTimes(1);
      harness.windowEvents.get("close")?.({});
      const sendsAtClose = current?.webContents.send.mock.calls.length;
      presentation.resolve(undefined);
      if (outcome === "resolve") backend.resolve("http://127.0.0.1:17861");
      else backend.reject(new Error("CLOSED_DURING_STARTUP"));
      await settle();

      expect(harness.start).toHaveBeenCalledTimes(1);
      expect(harness.terminate).toHaveBeenCalledTimes(1);
      expect(harness.exit).toHaveBeenCalledTimes(1);
      expect(motion.navigate).not.toHaveBeenCalled();
      expect(current?.webContents.send).toHaveBeenCalledTimes(sendsAtClose ?? 0);
    },
  );

  it.each([0, 1, null])(
    "does not navigate after backend exit %s during presentation",
    async (code) => {
      const presentation = deferred<void>();
      const motion = holdStartup(presentation.promise);
      await import("../../src/desktop/main");
      await settle();
      const backend = harness.Backend.latest;
      if (!backend) throw new Error("missing backend");
      backend.exitCode = code;
      backend.options.onExit(false, code, code === null ? "SIGTERM" : null);
      await settle();
      const current = harness.Window.latest;
      if (code !== 0)
        expect(current?.webContents.send).toHaveBeenLastCalledWith(
          DESKTOP_STARTUP_STATE,
          expect.objectContaining({ phase: "failed" }),
        );
      presentation.resolve(undefined);
      await settle();

      expect(motion.navigate).not.toHaveBeenCalled();
      expect(harness.start).toHaveBeenCalledTimes(1);
      expect(harness.terminate).toHaveBeenCalledTimes(1);
      if (code === 0) expect(harness.exit).toHaveBeenCalledTimes(1);
      else expect(harness.exit).not.toHaveBeenCalled();
    },
  );

  it("shows an early backend failure without waiting for presentation and retries once", async () => {
    const presentation = deferred<void>();
    const backend = deferred<string>();
    const motion = holdStartup(presentation.promise);
    harness.start.mockReturnValueOnce(backend.promise);
    await import("../../src/desktop/main");
    await settle();
    backend.reject(new Error("STARTUP_FAILED"));
    await settle();

    const current = harness.Window.latest;
    if (!current) throw new Error("missing startup window");
    expect(current.webContents.send).toHaveBeenLastCalledWith(
      DESKTOP_STARTUP_STATE,
      expect.objectContaining({ phase: "failed" }),
    );
    expect(harness.terminate).toHaveBeenCalledTimes(1);
    expect(motion.navigate).not.toHaveBeenCalled();
    current.webContents.mainFrame.url = "superstring://startup/";
    const event = { sender: current.webContents, senderFrame: current.webContents.mainFrame };
    const retry = harness.ipcInvokes.get(DESKTOP_STARTUP_RETRY);
    retry?.(event);
    retry?.(event);
    await settle();
    expect(harness.start).toHaveBeenCalledTimes(2);
    expect(motion.navigate).not.toHaveBeenCalled();

    presentation.resolve(undefined);
    await settle();
    expect(motion.navigate).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:17861");
    expect(harness.start).toHaveBeenCalledTimes(2);
  });

  it("closes through terminate, destroy, and exit without a graceful stop", async () => {
    await import("../../src/desktop/main");
    await settle();

    const current = harness.Window.latest;
    expect(current).toBeDefined();
    expect(harness.terminate).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();

    const close = harness.windowEvents.get("close");
    expect(close).toBeDefined();
    close?.({});

    expect(harness.terminate).toHaveBeenCalledTimes(1);
    expect(current?.destroy).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(0);
    expect(harness.stop).not.toHaveBeenCalled();
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0];
    expect(order(harness.terminate)).toBeLessThan(order(current?.destroy ?? harness.exit));
    expect(order(current?.destroy ?? harness.exit)).toBeLessThan(order(harness.exit));

    close?.({});
    expect(harness.terminate).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledTimes(1);
  });

  it("keeps running when a reload aborts the load or the renderer exits cleanly", async () => {
    await import("../../src/desktop/main");
    await settle();

    harness.webContentsEvents.get("did-fail-load")?.(
      {},
      -3,
      "ERR_ABORTED",
      "superstring://startup/",
      true,
    );
    harness.webContentsEvents.get("render-process-gone")?.({}, { reason: "clean-exit" });
    await settle();

    expect(harness.terminate).not.toHaveBeenCalled();
    expect(harness.exit).not.toHaveBeenCalled();
  });

  it("exits with code 1 when startup fails before a window exists", async () => {
    harness.installPreferences.mockRejectedValueOnce(new Error("BOOTSTRAP_FAILED"));

    await import("../../src/desktop/main");
    await settle();

    expect(harness.Window.latest).toBeUndefined();
    expect(harness.exit).toHaveBeenCalledTimes(1);
    expect(harness.exit).toHaveBeenCalledWith(1);
    expect(harness.terminate).not.toHaveBeenCalled();
  });

  it("sets the real AppUserModelID from the shared constant at startup", async () => {
    await import("../../src/desktop/main");
    await settle();

    expect(harness.app.setAppUserModelId).toHaveBeenCalledTimes(1);
    expect(harness.app.setAppUserModelId).toHaveBeenCalledWith(DESKTOP_APP_ID);
  });

  it("creates the motion controller with the returned native adapter", async () => {
    await import("../../src/desktop/main");
    await settle();

    const current = harness.Window.latest;
    expect(current).toBeDefined();
    expect(harness.createWindowMotion).toHaveBeenCalledTimes(1);
    const [win, options] = harness.createWindowMotion.mock.calls[0];
    expect(win).toBe(current);
    expect((options as { native: unknown }).native).toBeNull();
    expect((options as { quit: () => void }).quit).toBeTypeOf("function");
  });

  it("performs the one initialization save and keeps the close callback free of the native read", async () => {
    harness.nativeState.adapter = fakeNative();
    await import("../../src/desktop/main");
    await settle();

    // The state owner is created once and performs exactly one explicit initialization save
    // of the ordinary window; a maximized launch never overwrites that snapshot because the
    // state owner retains it and no provider read runs inside a maximized remember.
    const manager = harness.windowState.latest;
    const mainWindow = harness.Window.all[0];
    expect(manager).toBeDefined();
    expect(manager?.save).toHaveBeenCalledTimes(1);
    expect(manager?.save.mock.calls[0]?.[0]).toBe(mainWindow);

    // The close flush is logical-only: no native (Koffi) FFI inside the close callback.
    const close = harness.windowEvents.get("close");
    expect(close).toBeDefined();
    const native = harness.nativeState.adapter as { getPhysicalBounds: Mock };
    native.getPhysicalBounds.mockClear();
    close?.({ defaultPrevented: false, preventDefault: vi.fn() });
    await new Promise((resolve) => setImmediate(resolve));
    expect(native.getPhysicalBounds).not.toHaveBeenCalled();
    expect(harness.exit).toHaveBeenCalledWith(0);
  });

  it("applies the saved physical rect before the initial maximize and skips on display mismatch", async () => {
    const physical = { x: 480, y: 240, width: 2560, height: 2800 };
    const placement = {
      bounds: physical,
      displayId: 3,
      scaleFactor: 2,
      displayBounds: { x: 0, y: 0, width: 2560, height: 1440 },
      workArea: { x: 0, y: 0, width: 2560, height: 1400 },
    };
    const adapter = { ...fakeNative(), setPhysicalBounds: vi.fn(() => true) };
    harness.nativeState.adapter = adapter;

    // Positive path: matching display metadata plus matching validated logical DIP applies the
    // exact saved physical rect through the native owner, then the maximize runs bypassed.
    harness.windowState.initial.bounds = {
      x: 10,
      y: 10,
      width: 1280,
      height: 860,
      maximized: true,
    };
    harness.windowState.initial.nativePlacement = placement;
    await import("../../src/desktop/main");
    await settle();
    // The main window is the first fixture window; the overlay/presentation surfaces come later.
    const positiveWindow = harness.Window.all[0];
    expect(positiveWindow).toBeDefined();
    if (!positiveWindow) throw new Error("fixture missing main window");
    expect(adapter.setPhysicalBounds).toHaveBeenCalledTimes(1);
    expect(adapter.setPhysicalBounds).toHaveBeenCalledWith(physical);
    expect(positiveWindow.maximize).toHaveBeenCalledTimes(1);
    // The exact physical restore lands before the initial maximize, both through the bypass.
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0];
    expect(order(adapter.setPhysicalBounds)).toBeLessThan(order(positiveWindow.maximize));

    // Mismatch path: the same placement on the wrong display (id/scale/bounds) writes no
    // physical pixels, and the saved maximize still applies.
    vi.resetModules();
    const mismatched = { ...fakeNative(), setPhysicalBounds: vi.fn(() => true) };
    harness.nativeState.adapter = mismatched;
    const mainCountBefore = harness.Window.all.length;
    harness.windowState.initial.nativePlacement = { ...placement, displayId: 7, scaleFactor: 1 };
    await import("../../src/desktop/main");
    await settle();
    expect(mismatched.setPhysicalBounds).not.toHaveBeenCalled();
    const mismatchedWindow = harness.Window.all[mainCountBefore];
    expect(mismatchedWindow).toBeDefined();
    expect(mismatchedWindow?.maximize).toHaveBeenCalledTimes(1);
  });

  it("answers the managed probe true only for the own main frame with zero args", async () => {
    harness.nativeState.adapter = fakeNative();
    await import("../../src/desktop/main");
    await settle();

    const current = harness.Window.all[0];
    expect(current).toBeDefined();
    const managed = harness.ipcSyncs.get(DESKTOP_MOTION_MANAGED);
    expect(managed).toBeDefined();

    const ownEvent = {
      sender: current?.webContents,
      senderFrame: current?.webContents.mainFrame,
      returnValue: undefined as unknown,
    };
    (current?.webContents.mainFrame as { url: string }).url = "superstring://startup/";
    managed?.(ownEvent as never);
    expect(ownEvent.returnValue).toBe(true);

    const frame = current?.webContents.mainFrame;
    const probe = (sender: unknown, senderFrame: unknown, ...args: unknown[]) => {
      const event = { sender, senderFrame, returnValue: undefined as unknown };
      managed?.(event as never, ...args);
      return event.returnValue;
    };
    expect(probe(current?.webContents, frame)).toBe(true);
    expect(probe({}, frame)).toBe(false);
    expect(probe(current?.webContents, {})).toBe(false);
    expect(probe(current?.webContents, frame, "extra")).toBe(false);
    (frame as { url: string }).url = "https://evil.example/";
    expect(probe(current?.webContents, frame)).toBe(false);
  });

  it("rejects the workspace-ready invoke handler off the backend origin main frame", async () => {
    await import("../../src/desktop/main");
    await settle();

    const current = harness.Window.latest;
    expect(current).toBeDefined();
    const ready = harness.ipcInvokes.get(DESKTOP_WORKSPACE_READY);
    expect(ready).toBeDefined();

    const frame = current?.webContents.mainFrame as { url: string };
    const call = () => ready?.({ sender: current?.webContents, senderFrame: frame } as never);

    frame.url = "http://127.0.0.1:17861/";
    expect(call()).toBeUndefined();

    frame.url = "https://evil.example/";
    expect(() => call()).toThrow("DESKTOP_WORKSPACE_READY_FORBIDDEN");
  });
});
