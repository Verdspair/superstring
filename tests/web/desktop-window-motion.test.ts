import { EventEmitter } from "node:events";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeWindowMotion, Rect, WindowIntent } from "../../src/desktop/native/win32";
import {
  MOTION_PREPARE,
  MOTION_REPLY,
  MOTION_RUN,
  type MotionBitmap,
  SPRING,
} from "../../src/shared/window-motion";

type Listener = (...args: unknown[]) => void;
type Mock = ReturnType<typeof vi.fn>;
type MotionMessage = {
  token: string;
  generation: number;
  spring?: unknown;
  bitmap?: MotionBitmap;
  destinationBitmap?: MotionBitmap;
  [key: string]: unknown;
};

interface FixtureContents extends EventEmitter {
  mainFrame: { url: string };
  send: Mock;
  capturePage: Mock;
  executeJavaScript: Mock;
  setWindowOpenHandler: Mock;
  getURL: () => string;
  isDestroyed: () => boolean;
}

/**
 * Minimal real main-process surface: EventEmitter windows/webContents (no WndProc/COM copy),
 * recorded ipcMain listeners, and a native adapter with the frozen NativeWindowMotion API.
 * The controller under test is the real src/desktop/window-motion.ts.
 */
function createHarness() {
  const windows: FixtureWindow[] = [];
  const listeners = new Map<string, Set<Listener>>();
  const state = {
    reducedMotion: false,
    capture: null as null | (() => Promise<unknown>),
  };
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 2, height: 1 }),
    toBitmap: () => Buffer.from([4, 8, 12, 255, 16, 24, 32, 128]),
  };
  const display = {
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };

  class FixtureWindow extends EventEmitter {
    static all = windows;
    destroyed = false;
    visible = false;
    opacity = 1;
    minimized = false;
    maximized = false;
    bounds: Rect = { x: 100, y: 80, width: 1200, height: 820 };
    mainFrame = { url: "http://127.0.0.1:17861/" };
    webContents: FixtureContents;

    constructor(_options: Record<string, unknown>) {
      super();
      FixtureWindow.all.push(this);
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: this.mainFrame,
        send: vi.fn(),
        getURL: () => this.mainFrame.url,
        setWindowOpenHandler: vi.fn(),
        isDestroyed: () => this.destroyed,
        capturePage: vi.fn(() => (state.capture ? state.capture() : Promise.resolve(image))),
        executeJavaScript: vi.fn(async (script: string) =>
          script.includes("matchMedia") ? state.reducedMotion : true,
        ),
      }) as unknown as FixtureContents;
    }

    isDestroyed() {
      return this.destroyed;
    }
    isMaximized() {
      return this.maximized;
    }
    isMinimized() {
      return this.minimized;
    }
    getNormalBounds() {
      return { ...this.bounds };
    }
    getBounds() {
      return { ...this.bounds };
    }
    getContentBounds() {
      return { ...this.bounds };
    }
    getOpacity() {
      return this.opacity;
    }
    isVisible() {
      return this.visible;
    }
    setBounds = vi.fn((rect: Rect) => {
      this.bounds = { ...rect };
    });
    setOpacity = vi.fn((value: number) => {
      this.opacity = value;
    });
    show = vi.fn(() => {
      this.visible = true;
    });
    showInactive = vi.fn(() => {
      this.visible = true;
    });
    hide = vi.fn(() => {
      this.visible = false;
    });
    setAlwaysOnTop = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    focus = vi.fn();
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    loadFile = vi.fn(async () => undefined);
    loadURL = vi.fn(async (_url: string) => undefined);
    minimize = vi.fn(() => {
      this.minimized = true;
      this.emit("minimize");
    });
    maximize = vi.fn(() => {
      this.maximized = true;
      this.emit("maximize");
    });
    unmaximize = vi.fn(() => {
      this.maximized = false;
      this.emit("unmaximize");
    });
    restore = vi.fn(() => {
      this.minimized = false;
      this.maximized = false;
      this.emit("restore");
    });
  }

  const ipcMain = {
    on(name: string, listener: Listener) {
      const set = listeners.get(name) ?? new Set<Listener>();
      listeners.set(name, set);
      set.add(listener);
    },
    removeListener(name: string, listener: Listener) {
      listeners.get(name)?.delete(listener);
    },
    handle: vi.fn(),
    removeHandler: vi.fn(),
  };

  const app = { getAppPath: () => "C:/fixture/app" };
  const screen = {
    getDisplayMatching: (_rect: Rect) => display,
    screenToDipRect: (_win: unknown, rect: Rect) => rect,
  };

  const reset = () => {
    windows.length = 0;
    for (const set of listeners.values()) set.clear();
    state.reducedMotion = false;
    state.capture = null;
  };

  const emitIpc = (channel: string, event: unknown, message?: unknown) => {
    for (const listener of listeners.get(channel) ?? []) listener(event, message);
  };

  return {
    app,
    display,
    emitIpc,
    FixtureWindow,
    image,
    ipcMain,
    listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0,
    reset,
    screen,
    state,
    windows,
  };
}

const harness = createHarness();

vi.mock("electron", () => ({
  app: harness.app,
  BrowserWindow: harness.FixtureWindow,
  ipcMain: harness.ipcMain,
  screen: harness.screen,
}));

type MotionModule = typeof import("../../src/desktop/window-motion");
let createWindowMotion: MotionModule["createWindowMotion"];

beforeAll(async () => {
  ({ createWindowMotion } = await import("../../src/desktop/window-motion"));
});

beforeEach(() => {
  harness.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function nativeAdapter() {
  const adapter = {
    handler: null as ((intent: WindowIntent) => void) | null,
    setHandler: vi.fn((handler: ((intent: WindowIntent) => void) | null) => {
      adapter.handler = handler;
    }),
    bypass: vi.fn(<T>(run: () => T): T => run()) as NativeWindowMotion["bypass"] & Mock,
    setTransitionsDisabled: vi.fn(),
    resolveTarget: vi.fn((): Rect | null => null),
    getPhysicalBounds: vi.fn((): Rect | null => null),
    setPhysicalBounds: vi.fn((): boolean => true),
    dispose: vi.fn(),
  };
  return adapter;
}

function setup(
  options: {
    reduced?: boolean;
    capture?: (() => Promise<unknown>) | null;
    onSettled?: () => void;
    /** The legacy close cases pin the immediate exit; the fold is opted into per case. */
    animateClose?: boolean;
  } = {},
) {
  harness.state.reducedMotion = options.reduced ?? false;
  harness.state.capture = options.capture ?? null;
  const native = nativeAdapter();
  const log = vi.fn();
  const quit = vi.fn();
  const win = new harness.FixtureWindow({});
  const controller = createWindowMotion(win as never, {
    native,
    log,
    quit,
    onSettled: options.onSettled,
    shouldAnimateClose: () => options.animateClose ?? false,
  });
  const overlay = harness.windows[1];
  if (!overlay) throw new Error("fixture missing overlay window");
  return { controller, log, native, overlay, quit, win };
}

const flush = async (turns = 40) => {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
};

const until = async (check: () => boolean, turns = 400) => {
  for (let turn = 0; turn < turns; turn += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("fixture wait exceeded");
};

const macrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const sent = (win: { webContents: FixtureContents }, channel: string) =>
  win.webContents.send.mock.calls
    .filter(([name]) => name === channel)
    .map(([, payload]) => payload as MotionMessage);

const reply = (
  overlay: { webContents: FixtureContents },
  payload: MotionMessage,
  overrides: Record<string, unknown> = {},
) =>
  harness.emitIpc(
    MOTION_REPLY,
    { sender: overlay.webContents, senderFrame: overlay.webContents.mainFrame, ...overrides },
    payload,
  );

const closeEvent = () => ({ defaultPrevented: false, preventDefault: vi.fn() });

async function minimizeForRestore({ win, overlay, native, controller }: ReturnType<typeof setup>) {
  native.resolveTarget.mockReturnValue({ x: 900, y: 1000, width: 48, height: 40 });
  controller.request("minimize");
  await until(() => sent(overlay, MOTION_PREPARE).length === 1);
  const [prepare] = sent(overlay, MOTION_PREPARE);
  reply(overlay, { ...prepare, kind: "ready" });
  await until(() => sent(overlay, MOTION_RUN).length === 1);
  reply(overlay, { ...sent(overlay, MOTION_RUN)[0], kind: "done" });
  await until(() => win.isMinimized() && !controller.isProgrammatic());
  await flush();
  // The native minimized state has no maximize flag; beforeMin retains the saved flag.
  win.maximized = false;
  overlay.webContents.send.mockClear();
  overlay.showInactive.mockClear();
  overlay.hide.mockClear();
  win.setOpacity.mockClear();
  win.webContents.capturePage.mockClear();
  return prepare.bitmap;
}

describe("desktop window motion controller", () => {
  it("routes the intercepted native intent through one bypassed native action", async () => {
    const { win, native, quit, controller } = setup({ reduced: true });
    expect(native.setHandler).toHaveBeenCalledTimes(1);
    const [registration] = native.setHandler.mock.calls;
    const handler = registration?.[0] ?? null;
    expect(handler).toBeTypeOf("function");
    if (!handler) throw new Error("native handler not registered");

    handler("minimize");
    await flush();
    expect(native.bypass).toHaveBeenCalledTimes(1);
    expect(win.minimize).toHaveBeenCalledTimes(1);
    expect(win.isMinimized()).toBe(true);

    native.bypass.mockClear();
    const event = closeEvent();
    controller.close(event as never);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(native.dispose).not.toHaveBeenCalled();
    expect(native.bypass).not.toHaveBeenCalled();
    expect(native.setTransitionsDisabled).not.toHaveBeenCalled();

    await macrotask();
    expect(native.dispose).toHaveBeenCalledTimes(1);
    expect(native.setHandler).toHaveBeenLastCalledWith(null);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("keeps the last settled save when closed mid-leg or on a failed fallback", async () => {
    const settled: WindowIntent[] = [];
    let capture = deferred<unknown>();
    // The first leg settles: the last real end state the owner saw is maximize.
    // The callback snapshots the real window flag at settle time, never a constant.
    const flags: boolean[] = [];
    const { win, overlay, native, controller } = setup({
      capture: () => capture.promise,
      onSettled: () => {
        flags.push(win.isMaximized());
        settled.push("restore");
      },
    });
    // The first capture must resolve before the leg can prepare its cover.
    capture.resolve(harness.image);
    controller.request("maximize");
    await until(() => sent(overlay, MOTION_PREPARE).length === 1);
    const [prepare] = sent(overlay, MOTION_PREPARE);
    reply(overlay, { ...prepare, kind: "ready" });
    await until(() => sent(overlay, MOTION_RUN).length === 1);
    // legBounds' beforeRun already applied the native maximize under the cover: the flag is
    // the real end state while the overlay run is still unfinished, and no save may land mid-leg.
    expect(win.isMaximized()).toBe(true);
    expect(controller.isProgrammatic()).toBe(true);
    expect(settled).toEqual([]);
    reply(overlay, { ...sent(overlay, MOTION_RUN)[0], kind: "done" });
    await until(() => settled.length === 1);
    expect(win.isMaximized()).toBe(true);
    expect(flags).toEqual([true]);

    // A restore request starts, but the window is closed while its fresh capture is pending.
    capture = deferred();
    const capturesBeforeRestore = win.webContents.capturePage.mock.calls.length;
    controller.request("restore");
    await until(() => win.webContents.capturePage.mock.calls.length === capturesBeforeRestore + 1);
    controller.close(closeEvent() as never);
    // Dispose runs first so the still-pending capture cannot reach the overlay after close.
    await macrotask();
    const baseline = {
      bypass: native.bypass.mock.calls.length,
      transitions: native.setTransitionsDisabled.mock.calls.length,
    };
    capture.resolve(harness.image);
    await flush();

    // The late resolver finishes a cancelled leg: no post-close report and no native FFI.
    expect(settled).toEqual(["restore"]);
    expect(native.bypass).toHaveBeenCalledTimes(baseline.bypass);
    expect(native.setTransitionsDisabled).toHaveBeenCalledTimes(baseline.transitions);
    expect(win.loadURL).not.toHaveBeenCalled();
    expect(win.isMaximized()).toBe(true);
  });

  it.each([
    { intent: "minimize", captureResult: "empty" },
    { intent: "minimize", captureResult: "reject" },
    { intent: "minimize", captureResult: "image" },
    { intent: "maximize", captureResult: "empty" },
    { intent: "maximize", captureResult: "reject" },
    { intent: "maximize", captureResult: "image" },
  ])(
    "abandons $intent capture $captureResult before deferred close teardown",
    async ({ intent, captureResult }) => {
      const capture = deferred<unknown>();
      const onSettled = vi.fn();
      const { win, overlay, native, quit, controller } = setup({
        capture: () => capture.promise,
        onSettled,
      });
      native.resolveTarget.mockReturnValue({ x: 900, y: 1000, width: 48, height: 40 });
      controller.request(intent as WindowIntent);
      await until(() => win.webContents.capturePage.mock.calls.length === 1);
      controller.close(closeEvent() as never);
      const repeated = closeEvent();
      controller.close(repeated as never);
      const nativeCalls = native.bypass.mock.calls.length;
      const transitionCalls = native.setTransitionsDisabled.mock.calls.length;

      if (captureResult === "reject") capture.reject(new Error("CAPTURE_FAILED"));
      else capture.resolve(captureResult === "empty" ? { isEmpty: () => true } : harness.image);
      await flush();
      expect(native.dispose).not.toHaveBeenCalled();
      expect(native.bypass).toHaveBeenCalledTimes(nativeCalls);
      expect(native.setTransitionsDisabled).toHaveBeenCalledTimes(transitionCalls);
      expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);
      expect(sent(overlay, MOTION_RUN)).toHaveLength(0);
      expect(onSettled).not.toHaveBeenCalled();
      expect(repeated.preventDefault).toHaveBeenCalledTimes(1);

      await macrotask();
      expect(native.dispose).toHaveBeenCalledTimes(1);
      expect(quit).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { intent: "minimize", failure: "empty", destination: false },
    { intent: "minimize", failure: "reject", destination: false },
    { intent: "maximize", failure: "throw", destination: false },
    { intent: "maximize", failure: "zero-size", destination: false },
    { intent: "unmaximize", failure: "byte-length", destination: false },
    { intent: "restore-max", failure: "fractional-size", destination: false },
    { intent: "maximize", failure: "empty", destination: true },
  ] as const)(
    "falls back to the original $intent for $failure bitmap (destination: $destination)",
    async ({ intent, failure, destination }) => {
      const settled = vi.fn();
      const fixture = setup({ onSettled: settled });
      const { win, overlay, native, controller } = fixture;
      win.visible = true;
      if (intent === "unmaximize" || intent === "restore-max") win.maximized = true;
      if (intent === "restore-max") {
        await minimizeForRestore(fixture);
        settled.mockClear();
      }
      native.resolveTarget.mockReturnValue({ x: 900, y: 1000, width: 48, height: 40 });
      let captures = 0;
      harness.state.capture = async () => {
        captures += 1;
        if (destination && captures === 1) return harness.image;
        if (failure === "reject") throw new Error("CAPTURE_FAILED");
        return {
          isEmpty: () => failure === "empty",
          getSize: () => ({
            width: failure === "zero-size" ? 0 : failure === "fractional-size" ? 1.5 : 2,
            height: 1,
          }),
          toBitmap: () => {
            if (failure === "throw") throw new Error("BITMAP_FAILED");
            return failure === "byte-length" ? Buffer.alloc(7) : harness.image.toBitmap();
          },
        };
      };
      const request = intent === "unmaximize" || intent === "restore-max" ? "restore" : intent;
      controller.request(request);
      if (destination) {
        await until(() => sent(overlay, MOTION_PREPARE).length === 1);
        reply(overlay, { ...sent(overlay, MOTION_PREPARE)[0], kind: "ready" });
      }
      await until(() => settled.mock.calls.length === 1);
      expect(win.webContents.capturePage).toHaveBeenCalledTimes(destination ? 2 : 1);
      expect(sent(overlay, MOTION_PREPARE)).toHaveLength(destination ? 1 : 0);
      expect(sent(overlay, MOTION_RUN)).toHaveLength(0);
      expect(win.isMinimized()).toBe(intent === "minimize");
      expect(win.isMaximized()).toBe(intent === "maximize" || intent === "restore-max");
      expect(win.minimize).toHaveBeenCalledTimes(
        intent === "minimize" || intent === "restore-max" ? 1 : 0,
      );
      expect(win.maximize).toHaveBeenCalledTimes(
        intent === "maximize" || intent === "restore-max" ? 1 : 0,
      );
      expect(win.unmaximize).toHaveBeenCalledTimes(intent === "unmaximize" ? 1 : 0);
      expect(win.restore).toHaveBeenCalledTimes(intent === "restore-max" ? 1 : 0);
      expect(win.getOpacity()).toBe(1);
      expect(win.setBounds).not.toHaveBeenCalled();
      expect(native.setPhysicalBounds).not.toHaveBeenCalled();
      expect(overlay.isVisible()).toBe(false);
      expect(controller.isProgrammatic()).toBe(false);
      controller.dispose();
    },
  );

  it("keeps unmanaged behavior when no native adapter is attached", async () => {
    const win = new harness.FixtureWindow({});
    const quit = vi.fn();
    const controller = createWindowMotion(win as never, { native: null, log: vi.fn(), quit });
    expect(harness.windows).toHaveLength(1);
    expect(harness.listenerCount(MOTION_REPLY)).toBe(0);

    await controller.navigate("http://127.0.0.1:17861/");
    expect(win.loadURL).toHaveBeenCalledTimes(1);

    const event = closeEvent();
    controller.close(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("accepts overlay replies only from the overlay frame at the current generation", async () => {
    const { win, overlay, controller } = setup();
    const presentation = controller.presentStartup();
    await until(() => sent(overlay, MOTION_PREPARE).length === 1);
    const [prepare] = sent(overlay, MOTION_PREPARE);
    let settled = false;
    void presentation.then(() => {
      settled = true;
    });

    reply(overlay, { ...prepare, kind: "ready" }, { sender: win.webContents });
    reply(overlay, { ...prepare, kind: "ready" }, { senderFrame: {} });
    reply(overlay, { token: prepare.token, generation: prepare.generation + 1, kind: "ready" });
    await flush();
    expect(settled).toBe(false);
    expect(sent(overlay, MOTION_RUN)).toHaveLength(0);

    reply(overlay, { ...prepare, kind: "ready" });
    await until(() => sent(overlay, MOTION_RUN).length === 1);
    const [run] = sent(overlay, MOTION_RUN);
    expect(run.spring).toEqual(SPRING);
    reply(overlay, { ...run, kind: "done" });
    await presentation;
    expect(win.getOpacity()).toBe(1);
    expect(overlay.hide).toHaveBeenCalled();
    controller.dispose();
  });

  it("queues presentation-time intents and keeps only the latest", async () => {
    const capture = deferred<unknown>();
    const { win, overlay, native, controller } = setup({ capture: () => capture.promise });
    const presentation = controller.presentStartup();
    await until(() => win.webContents.capturePage.mock.calls.length === 1);

    controller.request("minimize");
    controller.request("restore");
    await flush();
    expect(win.minimize).not.toHaveBeenCalled();
    expect(native.bypass).not.toHaveBeenCalled();
    expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);

    capture.resolve(harness.image);
    await until(() => sent(overlay, MOTION_PREPARE).length === 1);
    const [prepare] = sent(overlay, MOTION_PREPARE);
    reply(overlay, { ...prepare, kind: "ready" });
    await until(() => sent(overlay, MOTION_RUN).length === 1);
    const [run] = sent(overlay, MOTION_RUN);
    reply(overlay, { ...run, kind: "done" });
    await presentation;
    await flush();

    expect(win.isMinimized()).toBe(false);
    expect(win.minimize).not.toHaveBeenCalled();
    expect(sent(overlay, MOTION_PREPARE)).toHaveLength(1);
    controller.dispose();
  });

  it("abandons a navigation closed during its capture without loading or native FFI", async () => {
    const capture = deferred<unknown>();
    const { win, overlay, native, quit, controller } = setup({ capture: () => capture.promise });
    const navigation = controller.navigate("http://127.0.0.1:17861/");
    await until(() => win.webContents.capturePage.mock.calls.length === 1);

    controller.close(closeEvent() as never);
    await macrotask();
    const baseline = {
      bypass: native.bypass.mock.calls.length,
      target: native.resolveTarget.mock.calls.length,
      transitions: native.setTransitionsDisabled.mock.calls.length,
    };

    capture.resolve(harness.image);
    const outcome = await navigation.then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeNull();
    expect(win.loadURL).not.toHaveBeenCalled();
    expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);
    expect(native.bypass).toHaveBeenCalledTimes(baseline.bypass);
    expect(native.resolveTarget).toHaveBeenCalledTimes(baseline.target);
    expect(native.setTransitionsDisabled).toHaveBeenCalledTimes(baseline.transitions);
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("does not load a navigation URL after the controller is closed", async () => {
    const { win, controller } = setup();
    controller.close(closeEvent() as never);
    await macrotask();

    await controller.navigate("http://127.0.0.1:17861/");
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it("adds no event timeout for terminal or duplicate native intents", async () => {
    vi.useFakeTimers();
    const { win, native, controller } = setup({ reduced: true });
    win.minimized = true;

    controller.request("minimize");
    await vi.advanceTimersByTimeAsync(0);
    expect(win.minimize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    controller.request("restore");
    await vi.advanceTimersByTimeAsync(0);
    expect(native.bypass).toHaveBeenCalledTimes(1);
    expect(win.restore).toHaveBeenCalledTimes(1);
    expect(win.isMinimized()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    controller.request("restore");
    await vi.advanceTimersByTimeAsync(0);
    expect(native.bypass).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });

  it("folds the closing window for the short duration, then disposes and quits once", async () => {
    const { win, overlay, native, quit, controller } = setup({ animateClose: true });
    const event = closeEvent();
    controller.close(event as never);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    // The repeated close stays prevented while the one animated exit is still running.
    const repeated = closeEvent();
    controller.close(repeated as never);
    expect(repeated.preventDefault).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();

    await macrotask();
    await until(() => sent(overlay, MOTION_PREPARE).length === 1);
    expect(win.webContents.capturePage).toHaveBeenCalledTimes(1);
    const [prepare] = sent(overlay, MOTION_PREPARE);
    reply(overlay, { ...prepare, kind: "ready" });
    await macrotask();
    await until(() => sent(overlay, MOTION_RUN).length === 1);
    const [run] = sent(overlay, MOTION_RUN);
    expect(run.durationMs).toBe(150);
    expect(quit).not.toHaveBeenCalled();
    reply(overlay, { ...run, kind: "done" });
    await macrotask();
    await macrotask();
    await until(() => quit.mock.calls.length === 1);
    expect(native.dispose).toHaveBeenCalledTimes(1);
    expect(native.bypass).not.toHaveBeenCalled();
    expect(native.setTransitionsDisabled).not.toHaveBeenCalled();
    expect(overlay.destroy).toHaveBeenCalledTimes(1);
  });

  it("caps a stalled closing capture at 500ms and ignores its late bitmap", async () => {
    vi.useFakeTimers();
    const capture = deferred<unknown>();
    const { win, overlay, native, quit, controller } = setup({
      animateClose: true,
      capture: () => capture.promise,
    });
    await flush();
    controller.close(closeEvent() as never);
    expect(native.dispose).not.toHaveBeenCalled();
    expect(native.bypass).not.toHaveBeenCalled();
    expect(native.setTransitionsDisabled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(win.webContents.capturePage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(native.dispose).toHaveBeenCalledTimes(1);
    expect(overlay.destroy).toHaveBeenCalledTimes(1);
    capture.resolve(harness.image);
    await flush();
    expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);
    expect(sent(overlay, MOTION_RUN)).toHaveLength(0);
    expect(win.setOpacity).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
    expect(native.bypass).not.toHaveBeenCalled();
    expect(native.setTransitionsDisabled).not.toHaveBeenCalled();
    expect(quit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exits directly without capture or an overlay run when the fold is off or motion is reduced", async () => {
    const cases: Array<{ animateClose: boolean; reduced?: boolean }> = [
      { animateClose: false },
      { animateClose: true, reduced: true },
    ];
    for (const options of cases) {
      const { win, overlay, native, quit, controller } = setup(options);
      const event = closeEvent();
      controller.close(event as never);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      await macrotask();
      await macrotask();
      await until(() => quit.mock.calls.length === 1);
      expect(win.webContents.capturePage).not.toHaveBeenCalled();
      expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);
      expect(sent(overlay, MOTION_RUN)).toHaveLength(0);
      expect(native.dispose).toHaveBeenCalledTimes(1);
      expect(native.bypass).not.toHaveBeenCalled();
      expect(native.setTransitionsDisabled).not.toHaveBeenCalled();
      harness.reset();
    }
  });

  it("quits directly when a motion leg is already in flight", async () => {
    const capture = deferred<unknown>();
    const { win, overlay, native, quit, controller } = setup({
      animateClose: true,
      capture: () => capture.promise,
    });
    capture.resolve(harness.image);
    controller.request("maximize");
    await until(() => sent(overlay, MOTION_PREPARE).length === 1);
    const event = closeEvent();
    controller.close(event as never);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    await macrotask();
    await macrotask();
    await until(() => quit.mock.calls.length === 1);
    expect(win.webContents.capturePage).toHaveBeenCalledTimes(1);
    expect(sent(overlay, MOTION_PREPARE)).toHaveLength(1);
    expect(sent(overlay, MOTION_RUN)).toHaveLength(0);
    expect(native.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "captures the restored window before one PREPARE and focuses after RUN (maximized: %s)",
    async (startMaximized) => {
      const settled = vi.fn(() => expect(controller.isProgrammatic()).toBe(false));
      const fixture = setup({ onSettled: settled });
      const { win, overlay, native, controller } = fixture;
      win.visible = true;
      win.maximized = startMaximized;
      const minimizedBitmap = await minimizeForRestore(fixture);
      expect(minimizedBitmap).toEqual({
        ...harness.image.getSize(),
        pixels: new Uint8Array(harness.image.toBitmap()),
      });
      expect(settled).toHaveBeenCalledTimes(1);
      settled.mockClear();

      const coverPaint = deferred<unknown>();
      const paint = deferred<unknown>();
      const capture = deferred<unknown>();
      const unexpectedTailPaint = deferred<unknown>();
      const currentBitmap = {
        width: 1,
        height: 2,
        pixels: new Uint8Array([40, 48, 56, 255, 2, 4, 6, 64]),
      };
      const actualBounds = { x: 110, y: 90, width: 1220, height: 840 };
      harness.state.capture = () => capture.promise;
      overlay.webContents.executeJavaScript.mockImplementationOnce(() => coverPaint.promise);
      win.webContents.executeJavaScript.mockClear();
      win.webContents.executeJavaScript
        .mockResolvedValueOnce(false)
        .mockImplementationOnce(() => paint.promise)
        .mockImplementationOnce(() => unexpectedTailPaint.promise);
      win.restore.mockImplementationOnce(() => undefined);
      controller.request("restore");
      await until(() => win.restore.mock.calls.length === 1);
      const order = (fn: Mock) => fn.mock.invocationCallOrder[0];
      expect(order(win.setOpacity)).toBeLessThan(order(win.restore));
      expect(win.getOpacity()).toBe(0);
      expect(overlay.isVisible()).toBe(false);
      expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);
      expect(sent(overlay, MOTION_RUN)).toHaveLength(0);
      expect(win.webContents.capturePage).not.toHaveBeenCalled();
      expect(win.focus).not.toHaveBeenCalled();

      win.minimized = false;
      win.bounds = { ...actualBounds };
      win.emit("restore");
      await until(() => win.webContents.executeJavaScript.mock.calls.length === 2);
      expect(win.isMaximized()).toBe(startMaximized);
      expect(win.maximize).toHaveBeenCalledTimes(startMaximized ? 1 : 0);
      expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);
      expect(win.webContents.capturePage).not.toHaveBeenCalled();
      paint.resolve(true);
      await until(() => win.webContents.capturePage.mock.calls.length === 1);
      expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);
      expect(win.getOpacity()).toBe(0);
      capture.resolve({
        isEmpty: () => false,
        getSize: () => ({ width: currentBitmap.width, height: currentBitmap.height }),
        toBitmap: () => Buffer.from(currentBitmap.pixels),
      });
      await until(() => sent(overlay, MOTION_PREPARE).length === 1);
      const [prepare] = sent(overlay, MOTION_PREPARE);
      expect(prepare.bitmap).toEqual(currentBitmap);
      expect(prepare.bitmap).not.toEqual(minimizedBitmap);
      expect(prepare.to).toEqual(actualBounds);
      reply(overlay, { ...prepare, kind: "ready" });
      await until(() => overlay.webContents.executeJavaScript.mock.calls.length === 1);
      expect(overlay.isVisible()).toBe(true);
      expect(win.isMinimized()).toBe(false);
      expect(win.getOpacity()).toBe(0);
      expect(order(win.webContents.capturePage)).toBeLessThan(order(overlay.showInactive));
      expect(sent(overlay, MOTION_RUN)).toHaveLength(0);
      expect(win.focus).not.toHaveBeenCalled();
      coverPaint.resolve(true);
      await until(() => sent(overlay, MOTION_RUN).length === 1);
      const [run] = sent(overlay, MOTION_RUN);
      expect(run.operation).toBe("restore");
      expect(run.spring).toEqual(SPRING);
      expect(win.isMinimized()).toBe(false);
      expect(win.webContents.capturePage).toHaveBeenCalledExactlyOnceWith(undefined, {
        stayHidden: true,
      });
      expect(sent(overlay, MOTION_PREPARE)).toHaveLength(1);
      expect(settled).not.toHaveBeenCalled();
      expect(controller.isProgrammatic()).toBe(true);
      expect(win.focus).not.toHaveBeenCalled();
      const nativeCallsAtRun = native.bypass.mock.calls.length;
      const paintCallsAtRun = win.webContents.executeJavaScript.mock.calls.length;
      let hiddenBeforeNextMicrotask = false;
      win.setOpacity.mockImplementationOnce((value: number) => {
        win.opacity = value;
        queueMicrotask(() => {
          hiddenBeforeNextMicrotask = !overlay.isVisible();
        });
      });
      reply(overlay, { ...run, kind: "done" });
      await until(() => settled.mock.calls.length === 1);
      expect(hiddenBeforeNextMicrotask).toBe(true);
      expect(win.getOpacity()).toBe(1);
      expect(win.focus).toHaveBeenCalledTimes(1);
      const opacityOrder = win.setOpacity.mock.invocationCallOrder.at(-1);
      expect(opacityOrder).toBeLessThan(overlay.hide.mock.invocationCallOrder[0]);
      expect(native.bypass).toHaveBeenCalledTimes(nativeCallsAtRun);
      expect(win.webContents.executeJavaScript).toHaveBeenCalledTimes(paintCallsAtRun);
      expect(win.getOpacity()).toBe(1);
      expect(overlay.isVisible()).toBe(false);
      expect(win.focus).toHaveBeenCalledTimes(1);
      expect(win.webContents.capturePage).toHaveBeenCalledTimes(1);
      expect(sent(overlay, MOTION_PREPARE)).toHaveLength(1);
      expect(sent(overlay, MOTION_RUN)).toHaveLength(1);
      expect(win.setBounds).not.toHaveBeenCalled();
      expect(native.setPhysicalBounds).not.toHaveBeenCalled();
      controller.dispose();
    },
  );

  it.each([false, true])(
    "keeps the restored state when RUN fails after prewarm (maximized: %s)",
    async (startMaximized) => {
      const settled = vi.fn(() => expect(controller.isProgrammatic()).toBe(false));
      const fixture = setup({ onSettled: settled });
      const { win, overlay, controller } = fixture;
      win.visible = true;
      win.maximized = startMaximized;
      const normalBounds = win.getNormalBounds();
      await minimizeForRestore(fixture);
      expect(settled).toHaveBeenCalledTimes(1);
      settled.mockClear();

      controller.request("restore");
      await until(() => sent(overlay, MOTION_PREPARE).length === 1);
      reply(overlay, { ...sent(overlay, MOTION_PREPARE)[0], kind: "ready" });
      await until(() => sent(overlay, MOTION_RUN).length === 1);
      expect(win.isMinimized()).toBe(false);
      expect(win.isMaximized()).toBe(startMaximized);
      expect(settled).not.toHaveBeenCalled();
      reply(overlay, { ...sent(overlay, MOTION_RUN)[0], kind: "error" });
      await until(() => settled.mock.calls.length === 1);

      expect(win.isMinimized()).toBe(false);
      expect(win.isMaximized()).toBe(startMaximized);
      expect(win.unmaximize).not.toHaveBeenCalled();
      expect(win.restore).toHaveBeenCalledTimes(1);
      expect(win.getNormalBounds()).toEqual(normalBounds);
      expect(win.getOpacity()).toBe(1);
      expect(win.isVisible()).toBe(true);
      expect(overlay.isVisible()).toBe(false);
      expect(controller.isProgrammatic()).toBe(false);
      expect(settled).toHaveBeenCalledTimes(1);
      controller.dispose();
    },
  );

  it.each([
    { stage: "query", reduced: false },
    { stage: "prepare", reduced: false },
    { stage: "restore", reduced: false },
    { stage: "maximize", reduced: false },
    { stage: "paint", reduced: false },
    { stage: "capture", reduced: false },
    { stage: "run", reduced: false },
    { stage: "restore", reduced: true },
    { stage: "maximize", reduced: true },
  ] as const)(
    "abandons a resolved $stage continuation after close (reduced: $reduced)",
    async ({ stage, reduced }) => {
      const settled = vi.fn();
      const fixture = setup({ onSettled: settled });
      const { win, overlay, native, quit, controller } = fixture;
      win.visible = true;
      win.maximized = true;
      await minimizeForRestore(fixture);
      expect(settled).toHaveBeenCalledTimes(1);
      settled.mockClear();

      const query = deferred<unknown>();
      const paint = deferred<unknown>();
      const capture = deferred<unknown>();
      if (stage === "capture") harness.state.capture = () => capture.promise;
      win.webContents.executeJavaScript
        .mockImplementationOnce(() =>
          stage === "query" ? query.promise : Promise.resolve(reduced),
        )
        .mockImplementationOnce(() => paint.promise);
      const queriesBefore = win.webContents.executeJavaScript.mock.calls.length;
      if (stage === "restore") win.restore.mockImplementationOnce(() => undefined);
      if (stage === "maximize") win.maximize.mockImplementationOnce(() => undefined);
      controller.request("restore");
      await until(() => win.webContents.executeJavaScript.mock.calls.length > queriesBefore);

      let release: () => void;
      if (stage === "query") {
        release = () => query.resolve(false);
      } else if (stage === "restore") {
        await until(() => win.restore.mock.calls.length === 1);
        expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);
        release = () => {
          win.minimized = false;
          win.emit("restore");
        };
      } else if (stage === "maximize") {
        await until(() => win.maximize.mock.calls.length === 1);
        expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);
        release = () => {
          win.maximized = true;
          win.emit("maximize");
        };
      } else {
        await until(
          () => win.webContents.executeJavaScript.mock.calls.length === queriesBefore + 2,
        );
        expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);
        if (stage === "paint") {
          release = () => paint.resolve(true);
        } else {
          paint.resolve(true);
          if (stage === "capture") {
            await until(() => win.webContents.capturePage.mock.calls.length === 1);
            expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);
            release = () => capture.resolve(harness.image);
          } else {
            await until(() => sent(overlay, MOTION_PREPARE).length === 1);
            const [prepare] = sent(overlay, MOTION_PREPARE);
            if (stage === "prepare") {
              release = () => reply(overlay, { ...prepare, kind: "ready" });
            } else {
              reply(overlay, { ...prepare, kind: "ready" });
              await until(() => sent(overlay, MOTION_RUN).length === 1);
              release = () => reply(overlay, { ...sent(overlay, MOTION_RUN)[0], kind: "done" });
            }
          }
        }
      }

      // Resolve first, close in the same turn, then allow the queued continuation to run.
      release();
      controller.close(closeEvent() as never);
      const afterClose = {
        bypass: native.bypass.mock.calls.length,
        transitions: native.setTransitionsDisabled.mock.calls.length,
        target: native.resolveTarget.mock.calls.length,
        opacity: win.setOpacity.mock.calls.length,
        prepare: sent(overlay, MOTION_PREPARE).length,
        run: sent(overlay, MOTION_RUN).length,
      };
      await flush();
      expect(native.bypass).toHaveBeenCalledTimes(afterClose.bypass);
      expect(native.setTransitionsDisabled).toHaveBeenCalledTimes(afterClose.transitions);
      expect(native.resolveTarget).toHaveBeenCalledTimes(afterClose.target);
      expect(native.setPhysicalBounds).not.toHaveBeenCalled();
      expect(win.setOpacity).toHaveBeenCalledTimes(afterClose.opacity);
      expect(win.focus).not.toHaveBeenCalled();
      expect(sent(overlay, MOTION_PREPARE)).toHaveLength(afterClose.prepare);
      expect(sent(overlay, MOTION_RUN)).toHaveLength(afterClose.run);
      expect(settled).not.toHaveBeenCalled();
      expect(native.dispose).not.toHaveBeenCalled();
      await macrotask();
      expect(native.dispose).toHaveBeenCalledTimes(1);
      expect(quit).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["capture", "prepare"] as const)(
    "ignores a late restore %s after the window is destroyed and disposed",
    async (stage) => {
      const settled = vi.fn();
      const fixture = setup({ onSettled: settled });
      const { win, overlay, native, quit, controller } = fixture;
      win.visible = true;
      win.maximized = true;
      await minimizeForRestore(fixture);
      settled.mockClear();
      const capture = deferred<unknown>();
      if (stage === "capture") harness.state.capture = () => capture.promise;
      controller.request("restore");
      if (stage === "capture") {
        await until(() => win.webContents.capturePage.mock.calls.length === 1);
        expect(sent(overlay, MOTION_PREPARE)).toHaveLength(0);
      } else {
        await until(() => sent(overlay, MOTION_PREPARE).length === 1);
      }
      expect(win.getOpacity()).toBe(0);
      win.destroy();
      controller.dispose();
      const afterDispose = {
        bypass: native.bypass.mock.calls.length,
        transitions: native.setTransitionsDisabled.mock.calls.length,
        target: native.resolveTarget.mock.calls.length,
        opacity: win.setOpacity.mock.calls.length,
        show: win.show.mock.calls.length,
        prepare: sent(overlay, MOTION_PREPARE).length,
      };
      if (stage === "capture") capture.resolve(harness.image);
      else reply(overlay, { ...sent(overlay, MOTION_PREPARE)[0], kind: "ready" });
      await flush();
      expect(native.bypass).toHaveBeenCalledTimes(afterDispose.bypass);
      expect(native.setTransitionsDisabled).toHaveBeenCalledTimes(afterDispose.transitions);
      expect(native.resolveTarget).toHaveBeenCalledTimes(afterDispose.target);
      expect(win.setOpacity).toHaveBeenCalledTimes(afterDispose.opacity);
      expect(win.show).toHaveBeenCalledTimes(afterDispose.show);
      expect(win.focus).not.toHaveBeenCalled();
      expect(sent(overlay, MOTION_PREPARE)).toHaveLength(afterDispose.prepare);
      expect(sent(overlay, MOTION_RUN)).toHaveLength(0);
      expect(settled).not.toHaveBeenCalled();
      expect(native.dispose).toHaveBeenCalledTimes(1);
      expect(overlay.destroy).toHaveBeenCalledTimes(1);
      expect(quit).not.toHaveBeenCalled();
    },
  );

  it.each(["cover", "destination-prewarm"] as const)(
    "abandons a late %s paint wait after close without touching the closed owner",
    async (stage) => {
      const settled = vi.fn();
      const { win, overlay, native, quit, controller } = setup({ onSettled: settled });
      const paint = deferred<unknown>();
      win.visible = true;
      if (stage === "cover") {
        overlay.webContents.executeJavaScript.mockImplementationOnce(() => paint.promise);
      } else {
        win.webContents.executeJavaScript
          .mockResolvedValueOnce(false)
          .mockImplementationOnce(() => paint.promise);
      }
      controller.request("maximize");
      await until(() => sent(overlay, MOTION_PREPARE).length === 1);
      reply(overlay, { ...sent(overlay, MOTION_PREPARE)[0], kind: "ready" });
      if (stage === "cover") {
        await until(() => overlay.webContents.executeJavaScript.mock.calls.length === 1);
        expect(win.maximize).not.toHaveBeenCalled();
        expect(sent(overlay, MOTION_RUN)).toHaveLength(0);
      } else {
        await until(() => win.webContents.executeJavaScript.mock.calls.length === 2);
        expect(win.maximize).toHaveBeenCalledTimes(1);
        expect(sent(overlay, MOTION_RUN)).toHaveLength(0);
      }
      expect(win.getOpacity()).toBe(stage === "cover" ? 1 : 0);
      expect(overlay.isVisible()).toBe(true);
      expect(settled).not.toHaveBeenCalled();

      paint.resolve(true);
      controller.close(closeEvent() as never);
      const afterClose = {
        bypass: native.bypass.mock.calls.length,
        transitions: native.setTransitionsDisabled.mock.calls.length,
        opacity: win.setOpacity.mock.calls.length,
        run: sent(overlay, MOTION_RUN).length,
      };
      await flush();
      expect(native.bypass).toHaveBeenCalledTimes(afterClose.bypass);
      expect(native.setTransitionsDisabled).toHaveBeenCalledTimes(afterClose.transitions);
      expect(win.setOpacity).toHaveBeenCalledTimes(afterClose.opacity);
      expect(sent(overlay, MOTION_RUN)).toHaveLength(afterClose.run);
      expect(overlay.isVisible()).toBe(false);
      expect(controller.isProgrammatic()).toBe(false);
      expect(settled).not.toHaveBeenCalled();
      expect(native.dispose).not.toHaveBeenCalled();
      await macrotask();
      expect(native.dispose).toHaveBeenCalledTimes(1);
      expect(quit).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { label: "maximize", intent: "maximize", operation: "maximize", startMaximized: false },
    { label: "unmaximize", intent: "restore", operation: "unmaximize", startMaximized: true },
  ])(
    "sends one RUN with the post-native destination capture and actual bounds for $label",
    async ({ intent, operation, startMaximized }) => {
      const coverPixels = Buffer.from([99, 98, 4, 8, 12, 255, 16, 24, 32, 128, 97]).subarray(2, 10);
      const destinationPixels = Buffer.from([96, 40, 48, 56, 255, 2, 4, 6, 64, 95]).subarray(1, 9);
      const images = [
        {
          isEmpty: () => false,
          getSize: () => ({ width: 2, height: 1 }),
          toBitmap: () => coverPixels,
        },
        {
          isEmpty: () => false,
          getSize: () => ({ width: 1, height: 2 }),
          toBitmap: () => destinationPixels,
        },
      ];
      let captures = 0;
      const settled = vi.fn();
      const { win, overlay, controller } = setup({
        onSettled: settled,
        capture: async () => images[captures++],
      });
      const coverBitmap = {
        width: 2,
        height: 1,
        pixels: new Uint8Array([4, 8, 12, 255, 16, 24, 32, 128]),
      };
      const destinationBitmap = {
        width: 1,
        height: 2,
        pixels: new Uint8Array([40, 48, 56, 255, 2, 4, 6, 64]),
      };
      const actualBounds = startMaximized
        ? { x: 120, y: 90, width: 1180, height: 800 }
        : { x: 0, y: 0, width: 1920, height: 1040 };
      const nativeAction = startMaximized ? win.unmaximize : win.maximize;
      nativeAction.mockImplementationOnce(() => {
        win.maximized = !startMaximized;
        win.bounds = { ...actualBounds };
        win.emit(operation);
      });
      if (startMaximized) win.maximized = true;
      const sourceBounds = win.getContentBounds();
      controller.request(intent as WindowIntent);
      await until(() => sent(overlay, MOTION_PREPARE).length === 1);
      const [prepare] = sent(overlay, MOTION_PREPARE);
      expect(coverPixels.byteOffset).toBeGreaterThan(0);
      expect(destinationPixels.byteOffset).toBeGreaterThan(0);
      expect(prepare.bitmap).toEqual(coverBitmap);
      expect(prepare.bitmap?.pixels).toBeInstanceOf(Uint8Array);
      expect(prepare.bitmap?.pixels.byteLength).toBe(8);
      expect(prepare.from).toEqual(sourceBounds);
      expect(prepare.to).toEqual(sourceBounds);
      expect(win.webContents.capturePage).toHaveBeenCalledExactlyOnceWith(undefined, {
        stayHidden: true,
      });
      expect(nativeAction).not.toHaveBeenCalled();
      reply(overlay, { ...prepare, kind: "ready" });
      await until(() => sent(overlay, MOTION_RUN).length === 1);

      // One PREPARE + one RUN: the prepared cover is never reset for a second prepare, and
      // the native action is the only geometry writer (no pre-render SetBounds on the window).
      expect(sent(overlay, MOTION_PREPARE)).toHaveLength(1);
      expect(win.setBounds).not.toHaveBeenCalled();
      const [run] = sent(overlay, MOTION_RUN);
      expect(run.operation).toBe(operation);
      expect(run.spring).toEqual(SPRING);
      // The destination is the post-native final-layout capture at the actual bounds.
      expect(run.destinationBitmap).toEqual(destinationBitmap);
      expect(run.destinationBitmap?.pixels).toBeInstanceOf(Uint8Array);
      expect(run.destinationBitmap?.pixels.byteLength).toBe(8);
      expect(run.destinationBitmap).not.toEqual(prepare.bitmap);
      expect(run.to).toEqual(actualBounds);
      expect(run.to).not.toEqual(sourceBounds);
      expect(nativeAction).toHaveBeenCalledTimes(1);
      expect(win.webContents.capturePage).toHaveBeenCalledTimes(2);
      const paintWaits = () =>
        win.webContents.executeJavaScript.mock.calls.filter(([script]) =>
          String(script).includes("document.fonts.ready"),
        );
      expect(paintWaits()).toHaveLength(1);
      expect(settled).not.toHaveBeenCalled();

      let hiddenBeforeNextMicrotask = false;
      win.setOpacity.mockImplementationOnce((value: number) => {
        win.opacity = value;
        queueMicrotask(() => {
          hiddenBeforeNextMicrotask = !overlay.isVisible();
        });
      });
      reply(overlay, { ...run, kind: "done" });
      await until(() => settled.mock.calls.length === 1);
      expect(hiddenBeforeNextMicrotask).toBe(true);
      expect(win.setOpacity.mock.invocationCallOrder.at(-1)).toBeLessThan(
        overlay.hide.mock.invocationCallOrder[0],
      );
      expect(controller.isProgrammatic()).toBe(false);
      expect(paintWaits()).toHaveLength(1);
      expect(overlay.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
      expect(win.getOpacity()).toBe(1);
      expect(overlay.isVisible()).toBe(false);
    },
  );
});
