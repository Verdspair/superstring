import type { EventEmitter } from "node:events";
import path from "node:path";
import type { Event as ElectronEvent, IpcMainEvent, WebContents } from "electron";
import { app, BrowserWindow, ipcMain, screen } from "electron";
import {
  MOTION_OVERLAY_URL,
  MOTION_PREPARE,
  MOTION_REPLY,
  MOTION_RUN,
  type MotionBitmap,
  type MotionOperation,
  type MotionPrepare,
  type MotionReply,
  type MotionRun,
  SPRING,
} from "../shared/window-motion";
import type { NativeWindowMotion, Rect, WindowIntent } from "./native/win32";

export interface WindowMotionOptions {
  /** Win32 own-window interception + taskbar target; null keeps today's plain window behavior. */
  native: NativeWindowMotion | null;
  log: (code: string) => void;
  quit: () => void;
  /**
   * Live closing policy. Absent keeps the closing fold on; false exits with no animation
   * (the user chose "exit immediately").
   */
  shouldAnimateClose?: () => boolean;
  /** One settled leg (or successful fallback) reached its real end state, window still open. */
  onSettled?: () => void;
}

export interface WindowMotionController {
  presentStartup(): Promise<void>;
  navigate(url: string): Promise<void>;
  workspaceReady(sender: WebContents): void;
  request(intent: WindowIntent): void;
  close(event: ElectronEvent): void;
  dispose(): void;
  isProgrammatic(): boolean;
  normalBounds(): Rect;
}

const STARTUP_ORIGIN = { width: 140, height: 84 };
const OVERLAY_REPLY_TIMEOUT_MS = 10_000;
const HANDOFF_TIMEOUT_MS = 8_000;
const SETTLE_WATCHDOG_MS = 1_000;
/** Closing fold duration booked to the shared timed runner; the user did not pick the value. */
const CLOSE_ANIMATION_DURATION_MS = 150;
/** Whole bounded close budget: capture + prepare + fold + teardown, never the 10s reply wait. */
const CLOSE_MAX_WAIT_MS = 500;

const snapRect = (rect: Rect): Rect => ({
  x: Math.round(rect.x),
  y: Math.round(rect.y),
  width: Math.round(rect.width),
  height: Math.round(rect.height),
});

function clampRect(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width);
  const height = Math.min(rect.height, area.height);
  return snapRect({
    x: Math.max(area.x, Math.min(rect.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(rect.y, area.y + area.height - height)),
    width,
    height,
  });
}

/**
 * Startup unfolds from a panel-sized origin displaced toward the content's right side
 * at the lower display edge, rather than a centered wide funnel. Close has a separate
 * local withdrawal profile and does not use this origin as a visual destination.
 */
const foldGeometry = (content: Rect) => {
  const display = screen.getDisplayMatching(content).bounds;
  const target = clampRect(
    {
      x: content.x + content.width * 0.7 - STARTUP_ORIGIN.width / 2,
      y: display.y + display.height - STARTUP_ORIGIN.height - 48,
      width: STARTUP_ORIGIN.width,
      height: STARTUP_ORIGIN.height,
    },
    display,
  );
  return { display, target };
};

/**
 * One owner of the whole-window motion: the startup unfold, the workspace handoff cover,
 * and the serialized minimize/maximize/restore legs. The overlay carries already-rendered
 * own pixels; the real window keeps its native WCO buttons and state. Real max/unmax
 * geometry comes only from the OS: no setBounds morph and no pre-max normal cache, so the
 * state file can trust win.getNormalBounds() again. No motion state is persisted, and the
 * window state file is still written only by WindowStateManager.
 */
export function createWindowMotion(
  win: BrowserWindow,
  options: WindowMotionOptions,
): WindowMotionController {
  let overlay: BrowserWindow | null = null;
  let overlayReady = Promise.resolve();
  /** The overlay document loaded; a missing/failed surface closes without a fold. */
  let overlayLoaded = false;
  const waiters = new Map<string, (reply: MotionReply) => void>();
  /** Cancel hooks for in-flight waitEvent listeners; close/dispose drain them. */
  const waitEventCancels = new Set<() => void>();
  let tokenSeq = 0;
  let generation = 0;
  let disposed = false;
  let closed = false;
  /** The deferred close worker already disposed and asked the host to quit. */
  let closeCommitted = false;
  let running = false;
  let pendingIntent: WindowIntent | null = null;
  let programmaticDepth = 0;
  /** The OS owns placement; restore only needs the pre-minimize maximize state. */
  let beforeMin: { wasMaximized: boolean } | null = null;
  let startupPromise: Promise<void> | null = null;
  /** True while the single presentation (startup unfold or handoff) owns the overlay. */
  let presenting = false;
  /** Resolves a presentation that arrived while a leg was still finishing. */
  let drainIdle: (() => void) | null = null;
  /** Cancels the active handoff wait: resolves the navigation waiter and clears its timers. */
  let cancelHandoffWait: (() => void) | null = null;
  let workspaceReadyResolver: (() => void) | null = null;

  const isOpen = (atGeneration: number) =>
    !closed && !disposed && generation === atGeneration && !win.isDestroyed();
  /** Make the live window visible with real pixels again; safe on every cancel/failure path. */
  const revealWindow = () => {
    if (win.isDestroyed()) return;
    if (win.getOpacity() < 1) win.setOpacity(1);
    if (!win.isMinimized() && !win.isVisible()) win.show();
  };
  const reducedMotion = async () => {
    if (win.isDestroyed()) return true;
    try {
      return (
        (await win.webContents.executeJavaScript(
          "matchMedia('(prefers-reduced-motion: reduce)').matches",
          true,
        )) === true
      );
    } catch {
      return false;
    }
  };
  const isTerminal = (action: "minimize" | "maximize" | "restore" | "unmaximize") => {
    if (win.isDestroyed()) return true;
    if (action === "minimize") return win.isMinimized();
    if (action === "maximize") return win.isMaximized();
    if (action === "restore") return !win.isMinimized();
    return !win.isMaximized();
  };
  const waitEvent = (event: "minimize" | "maximize" | "restore" | "unmaximize") =>
    new Promise<void>((resolve, reject) => {
      // The state may already be terminal from an earlier leg; waiting would burn the timeout.
      if (isTerminal(event)) {
        resolve();
        return;
      }
      if (win.isDestroyed()) {
        reject(new Error("MOTION_WINDOW_DESTROYED"));
        return;
      }
      const timer = setTimeout(() => {
        waitEventCancels.delete(cancel);
        try {
          (win as unknown as EventEmitter).off(event, handler);
        } catch {
          // A destroyed window already dropped its listeners.
        }
        reject(new Error("MOTION_EVENT_TIMEOUT"));
      }, 5000);
      const handler = () => {
        waitEventCancels.delete(cancel);
        clearTimeout(timer);
        resolve();
      };
      const cancel = () => {
        clearTimeout(timer);
        try {
          (win as unknown as EventEmitter).off(event, handler);
        } catch {
          // A destroyed window already dropped its listeners.
        }
        reject(new Error("MOTION_CANCELLED"));
      };
      waitEventCancels.add(cancel);
      (win as unknown as EventEmitter).once(event, handler);
    });
  const applyNative = async (action: "minimize" | "maximize" | "restore" | "unmaximize") => {
    if (isTerminal(action)) return;
    const event = waitEvent(action);
    options.native?.bypass(() => {
      if (win.isDestroyed()) return;
      win[action]();
    });
    await event;
  };
  const settleVisible = async (target = win) => {
    if (target.isDestroyed()) return;
    // Fonts and two rAF callbacks provide a paint opportunity, not a presentation fence.
    const settle = target.webContents
      .executeJavaScript(
        "new Promise((resolve) => { document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))) })",
        true,
      )
      .then(() => undefined)
      .catch(() => undefined);
    // The watchdog only guards a hung renderer: it is cleared on settle, and a timeout
    // logs rather than stalling every leg.
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        settle,
        new Promise<void>((resolve) => {
          watchdog = setTimeout(() => {
            options.log("DESKTOP_MOTION_SETTLE_WATCHDOG");
            resolve();
          }, SETTLE_WATCHDOG_MS);
        }),
      ]);
    } finally {
      if (watchdog) clearTimeout(watchdog);
    }
  };
  const captureOwn = async (): Promise<MotionBitmap | null> => {
    if (win.isDestroyed()) return null;
    try {
      const image = await win.webContents.capturePage(undefined, { stayHidden: true });
      if (image.isEmpty()) return null;
      const { width, height } = image.getSize();
      const pixels = image.toBitmap();
      if (
        !Number.isInteger(width) ||
        !Number.isInteger(height) ||
        width <= 0 ||
        height <= 0 ||
        pixels.byteLength !== width * height * 4
      ) {
        return null;
      }
      return {
        width,
        height,
        pixels: new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
      };
    } catch {
      return null;
    }
  };
  const cancelWaiters = () => {
    for (const waiter of Array.from(waiters.values()))
      waiter({ token: "", generation, kind: "error", message: "MOTION_CANCELLED" });
    waiters.clear();
    for (const cancel of Array.from(waitEventCancels)) cancel();
    waitEventCancels.clear();
  };

  const onReply = (event: IpcMainEvent, message: unknown) => {
    if (!overlay || overlay.isDestroyed() || event.sender !== overlay.webContents) return;
    if (event.senderFrame !== overlay.webContents.mainFrame) return;
    if (!message || typeof message !== "object") return;
    const reply = message as MotionReply;
    if (typeof reply.token !== "string" || reply.generation !== generation) return;
    const waiter = waiters.get(reply.token);
    if (waiter) waiter(reply);
  };

  const askOverlay = (channel: "prepare" | "run", payload: object) =>
    new Promise<MotionReply>((resolve, reject) => {
      if (!overlay || overlay.isDestroyed()) return reject(new Error("MOTION_OVERLAY_UNAVAILABLE"));
      const token = `t${++tokenSeq}`;
      const timer = setTimeout(() => {
        waiters.delete(token);
        reject(new Error("MOTION_OVERLAY_TIMEOUT"));
      }, OVERLAY_REPLY_TIMEOUT_MS);
      waiters.set(token, (reply) => {
        clearTimeout(timer);
        waiters.delete(token);
        if (reply.kind === "error") reject(new Error(reply.message || "MOTION_OVERLAY_ERROR"));
        else resolve(reply);
      });
      overlay.webContents.send(channel === "prepare" ? MOTION_PREPARE : MOTION_RUN, {
        ...payload,
        token,
        generation,
      });
    });

  const resolveTargetDip = (): Rect | null => {
    const physical = options.native?.resolveTarget();
    if (!physical || win.isDestroyed()) return null;
    try {
      return screen.screenToDipRect(win, physical);
    } catch {
      return null;
    }
  };

  /**
   * One overlay leg for every real state change. The prepared image carries already-rendered
   * own pixels; a leg that must read its destination after the native action (max/unmax)
   * prepares a static cover from = to and then supplies actual bounds and final-layout
   * pixels in one RUN, so the cover never resets during destination upload. Covered handoffs
   * give each visible surface a paint opportunity before removing the other one.
   */
  const runOverlayLeg = async (
    atGeneration: number,
    bitmap: MotionBitmap,
    from: Rect,
    to: Rect,
    operation: MotionOperation,
    phase: {
      /** Native state change and final-layout capture under the unchanged prepared cover. */
      beforeRun?: () => Promise<{ rect: Rect; destinationBitmap: MotionBitmap } | null>;
      /** Terminal action after the run reply (minimize or restore focus). */
      afterRun?: () => Promise<void>;
      /** Additional settling for other operations; covered handoffs always settle visibly. */
      settle?: boolean;
    } = {},
  ) => {
    // A local reference: a dispose during any await can never reuse a destroyed global.
    const surface = overlay;
    if (!surface || surface.isDestroyed()) throw new Error("MOTION_OVERLAY_UNAVAILABLE");
    const display = screen.getDisplayMatching(from).bounds;
    const coveredHandoff =
      operation === "maximize" || operation === "unmaximize" || operation === "restore";
    try {
      surface.setBounds(snapRect(display));
      await askOverlay("prepare", {
        bitmap,
        from,
        to,
        origin: { x: display.x, y: display.y },
        boundary: display,
      } satisfies Omit<MotionPrepare, "token" | "generation">);
      if (!isOpen(atGeneration)) throw new Error("MOTION_CANCELLED");
      if (surface.isDestroyed()) throw new Error("MOTION_OVERLAY_UNAVAILABLE");
      surface.showInactive();
      surface.setAlwaysOnTop(true, "floating");
      // Keep the old surface until the visible cover has had a paint opportunity.
      if (coveredHandoff) {
        await settleVisible(surface);
        if (!isOpen(atGeneration)) throw new Error("MOTION_CANCELLED");
        if (surface.isDestroyed()) throw new Error("MOTION_OVERLAY_UNAVAILABLE");
      }
      // Only the overlay carries pixels during travel, including its transparent regions.
      if (!win.isDestroyed()) win.setOpacity(0);
      const retarget = (await phase.beforeRun?.()) ?? null;
      if (!isOpen(atGeneration)) throw new Error("MOTION_CANCELLED");
      if (surface.isDestroyed()) throw new Error("MOTION_OVERLAY_UNAVAILABLE");
      await askOverlay("run", {
        operation,
        spring: SPRING,
        reducedMotion: false,
        ...(retarget ? { to: retarget.rect, destinationBitmap: retarget.destinationBitmap } : {}),
      } satisfies Omit<MotionRun, "token" | "generation">);
      if (!isOpen(atGeneration)) throw new Error("MOTION_CANCELLED");
      if (phase.afterRun && !surface.isDestroyed()) await phase.afterRun();
      if (coveredHandoff) {
        if (!isOpen(atGeneration)) throw new Error("MOTION_CANCELLED");
        if (surface.isDestroyed()) throw new Error("MOTION_OVERLAY_UNAVAILABLE");
        // Submit the live reveal and cover removal together; no post-animation paint wait.
        win.setOpacity(1);
        surface.hide();
        if (!isOpen(atGeneration)) throw new Error("MOTION_CANCELLED");
        if (surface.isDestroyed()) throw new Error("MOTION_OVERLAY_UNAVAILABLE");
      } else if (phase.settle !== false && isOpen(atGeneration) && !surface.isDestroyed()) {
        await settleVisible();
      }
    } finally {
      // Opacity is restored only on a still-open window; a cancelled/closed leg never
      // touches a destroyed target.
      if (!win.isDestroyed() && !closed && !disposed && win.getOpacity() < 1) win.setOpacity(1);
      if (!surface.isDestroyed()) {
        surface.hide();
        surface.setAlwaysOnTop(false);
      }
    }
  };

  const withProgrammaticGeometry = async (run: () => Promise<void>) => {
    programmaticDepth += 1;
    try {
      await run();
    } finally {
      programmaticDepth -= 1;
    }
  };

  /** Reported once per settled intent, after leg frames and with the live window open. */
  const notifySettled = (atGeneration: number) => {
    if (!isOpen(atGeneration) || programmaticDepth > 0) return;
    options.onSettled?.();
  };

  const legMinimize = async (atGeneration: number) => {
    try {
      await overlayReady;
    } catch {
      options.log("DESKTOP_MOTION_OVERLAY_UNAVAILABLE");
      await applyNative("minimize");
      return;
    }
    const content = win.getContentBounds();
    beforeMin = { wasMaximized: win.isMaximized() };
    const target = resolveTargetDip();
    if (!target) {
      options.log("DESKTOP_MOTION_TARGET_UNAVAILABLE");
      await applyNative("minimize");
      return;
    }
    const capture = await captureOwn();
    if (!isOpen(atGeneration)) return;
    if (!capture) {
      options.log("DESKTOP_MOTION_CAPTURE_UNAVAILABLE");
      await applyNative("minimize");
      return;
    }
    await withProgrammaticGeometry(() =>
      runOverlayLeg(atGeneration, capture, content, target, "minimize", {
        afterRun: () => applyNative("minimize"),
        settle: false,
      }),
    );
  };

  const restoreFromMin = async (atGeneration: number, wasMaximized: boolean) => {
    if (!isOpen(atGeneration)) return;
    if (win.isMinimized()) {
      await applyNative("restore");
      if (!isOpen(atGeneration)) return;
    }
    if (wasMaximized && !win.isMaximized()) {
      await applyNative("maximize");
      if (!isOpen(atGeneration)) return;
    }
  };

  const legRestore = async (atGeneration: number) => {
    const saved = beforeMin;
    const restoreNative = () => restoreFromMin(atGeneration, saved?.wasMaximized ?? false);
    const cleanup = () => {
      beforeMin = null;
    };
    if (!saved) {
      options.log("DESKTOP_MOTION_PLACEMENT_UNAVAILABLE");
      await withProgrammaticGeometry(restoreNative);
      if (!isOpen(atGeneration)) return;
      win.focus();
      cleanup();
      return;
    }
    try {
      await overlayReady;
    } catch {
      options.log("DESKTOP_MOTION_OVERLAY_UNAVAILABLE");
      await withProgrammaticGeometry(restoreNative);
      if (!isOpen(atGeneration)) return;
      win.focus();
      cleanup();
      return;
    }
    if (!isOpen(atGeneration)) return;
    const target = resolveTargetDip();
    if (!target) {
      options.log("DESKTOP_MOTION_TARGET_UNAVAILABLE");
      await withProgrammaticGeometry(restoreNative);
      if (!isOpen(atGeneration)) return;
      win.focus();
      cleanup();
      return;
    }
    await withProgrammaticGeometry(async () => {
      try {
        // Capture the restored layout before PREPARE so the fold never replays old content.
        win.setOpacity(0);
        await restoreNative();
        if (!isOpen(atGeneration)) return;
        await settleVisible();
        if (!isOpen(atGeneration)) return;
        const content = win.getContentBounds();
        const capture = await captureOwn();
        if (!isOpen(atGeneration)) return;
        if (!capture) throw new Error("MOTION_CAPTURE_UNAVAILABLE");
        await runOverlayLeg(atGeneration, capture, target, content, "restore", {
          afterRun: async () => {
            if (isOpen(atGeneration)) win.focus();
          },
          settle: false,
        });
      } finally {
        // Capture can fail before runOverlayLeg owns visibility cleanup.
        if (isOpen(atGeneration)) revealWindow();
      }
    });
    if (isOpen(atGeneration)) cleanup();
  };

  /**
   * Maximize/unmaximize travel entirely on the overlay: the prepared image is a static cover
   * of the current surface (from = to), the real native action runs under it, and the RUN
   * receives actual content bounds and a fresh final-layout capture from the window.
   * No setBounds morph or work-area derivation can accumulate invisible-border DIP drift.
   */
  const legBounds = async (atGeneration: number, action: "maximize" | "unmaximize") => {
    try {
      await overlayReady;
    } catch {
      options.log("DESKTOP_MOTION_OVERLAY_UNAVAILABLE");
      await withProgrammaticGeometry(() => applyNative(action));
      return;
    }
    const content = win.getContentBounds();
    const capture = await captureOwn();
    if (!isOpen(atGeneration)) return;
    if (!capture) {
      options.log("DESKTOP_MOTION_CAPTURE_UNAVAILABLE");
      await withProgrammaticGeometry(() => applyNative(action));
      return;
    }
    await withProgrammaticGeometry(() =>
      runOverlayLeg(atGeneration, capture, content, content, action, {
        beforeRun: async () => {
          await applyNative(action);
          if (!isOpen(atGeneration)) return null;
          await settleVisible();
          if (!isOpen(atGeneration)) return null;
          // Native geometry and its already-reflowed pixels are the only destination truth.
          const rect = win.getContentBounds();
          const destinationBitmap = await captureOwn();
          if (!isOpen(atGeneration)) return null;
          if (!destinationBitmap) throw new Error("MOTION_DESTINATION_CAPTURE_UNAVAILABLE");
          return { rect, destinationBitmap };
        },
        // The destination capture already waited for the final native layout to paint.
        settle: false,
      }),
    );
  };

  const applyReduced = async (intent: WindowIntent, atGeneration: number) => {
    if (!isOpen(atGeneration)) return;
    if (intent === "minimize") {
      beforeMin = { wasMaximized: win.isMaximized() };
      await applyNative("minimize");
      return;
    }
    if (intent === "maximize") {
      await applyNative("maximize");
      return;
    }
    if (win.isMinimized()) {
      await restoreFromMin(atGeneration, beforeMin?.wasMaximized ?? false);
      if (!isOpen(atGeneration)) return;
      win.focus();
    } else {
      await applyNative("unmaximize");
      if (!isOpen(atGeneration)) return;
    }
    beforeMin = null;
  };

  const runIntent = async (intent: WindowIntent, atGeneration: number) => {
    const state = win.isMinimized() ? "min" : win.isMaximized() ? "max" : "normal";
    if (intent === "minimize" && state === "min") return;
    if (intent === "maximize" && state === "max") return;
    if (intent === "restore" && state === "normal") return;
    if (await reducedMotion()) {
      if (!isOpen(atGeneration)) return;
      await applyReduced(intent, atGeneration);
      return;
    }
    if (!isOpen(atGeneration)) return;
    options.native?.setTransitionsDisabled(true);
    try {
      if (intent === "minimize") await legMinimize(atGeneration);
      else if (intent === "maximize") await legBounds(atGeneration, "maximize");
      else if (state === "min") await legRestore(atGeneration);
      else await legBounds(atGeneration, "unmaximize");
    } catch (error) {
      if (!isOpen(atGeneration)) return;
      options.log("DESKTOP_MOTION_LEG_FAILED");
      throw error;
    } finally {
      // The native surface is gone after close/dispose: the finally never re-enters it.
      if (!closed && !disposed) options.native?.setTransitionsDisabled(false);
      const surface = overlay;
      if (surface && !surface.isDestroyed()) {
        surface.hide();
        surface.setAlwaysOnTop(false);
      }
    }
  };

  const drain = async () => {
    if (running || presenting) return;
    running = true;
    try {
      for (;;) {
        if (!isOpen(generation)) {
          pendingIntent = null;
          break;
        }
        // A reserved presentation takes the surface after the current leg: no further
        // intent is started once it is set.
        if (presenting) break;
        const intent = pendingIntent;
        pendingIntent = null;
        if (!intent) break;
        const atGeneration = generation;
        const restoringFromMin = intent === "restore" && win.isMinimized();
        const restoreMaximized = restoringFromMin && (beforeMin?.wasMaximized ?? false);
        const fallback =
          intent === "restore" && !restoringFromMin && win.isMaximized()
            ? ("unmaximize" as const)
            : intent;
        let settled = false;
        try {
          await runIntent(intent, atGeneration);
          settled = true;
        } catch {
          if (!isOpen(atGeneration)) break;
          // Early restore may already have reached max before the overlay fails.
          // The original intent, not that intermediate state, owns fallback behavior.
          try {
            await withProgrammaticGeometry(async () => {
              if (restoringFromMin) {
                await restoreFromMin(atGeneration, restoreMaximized);
                if (!isOpen(atGeneration)) return;
                win.focus();
                beforeMin = null;
              } else {
                await applyNative(fallback);
              }
            });
            settled = true;
          } catch {
            options.log("DESKTOP_MOTION_FALLBACK_FAILED");
          }
        }
        // A failed fallback reports nothing: only a real end state is offered to the owner.
        if (settled) notifySettled(atGeneration);
      }
    } finally {
      running = false;
      // The presentation waiter resolves on every exit, including the reserved handoff.
      if (drainIdle) {
        drainIdle();
        drainIdle = null;
      }
      if (pendingIntent && isOpen(generation) && !presenting) void drain();
    }
  };

  /** One serialized owner for the presentation and the minimize/maximize/restore legs. */
  const present = async (run: () => Promise<void>) => {
    // The reservation happens before the wait: an active leg finishes, then the
    // presentation owns the surface exclusively until it completes.
    presenting = true;
    try {
      if (running) await new Promise<void>((resolve) => (drainIdle = resolve));
      if (!isOpen(generation)) return;
      await run();
    } finally {
      presenting = false;
      if (pendingIntent && !running && isOpen(generation)) void drain();
    }
  };

  const request = (intent: WindowIntent) => {
    if (!options.native || closed || disposed || win.isDestroyed()) return;
    const desired = intent === "minimize" ? "min" : intent === "maximize" ? "max" : "normal";
    const current = win.isMinimized() ? "min" : win.isMaximized() ? "max" : "normal";
    // Idle-only dedupe: while a leg runs or a presentation owns the surface the window
    // state is not the last word, so the intent is recorded and re-checked when applied.
    if (!running && !presenting && !pendingIntent && desired === current) return;
    pendingIntent = intent;
    if (!presenting) void drain();
  };

  const presentStartup = (): Promise<void> => {
    if (startupPromise) return startupPromise;
    // Presentation runs on the same serialized owner as the legs.
    startupPromise = present(async () => {
      if (closed || disposed || !options.native || !overlay) {
        revealWindow();
        return;
      }
      if (await reducedMotion()) {
        if (closed || disposed) return;
        revealWindow();
        return;
      }
      try {
        await overlayReady;
      } catch {
        options.log("DESKTOP_MOTION_OVERLAY_UNAVAILABLE");
        if (closed || disposed) return;
        revealWindow();
        return;
      }
      if (!isOpen(generation)) return;
      // Paint while transparent (a hidden window throttles rAF), then capture the panel.
      if (win.getOpacity() !== 0) win.setOpacity(0);
      if (!win.isVisible()) win.showInactive();
      // Wait for the handoff-settled document so the capture is the final panel.
      await settleVisible();
      if (!isOpen(generation)) return;
      const content = win.getContentBounds();
      const { target: origin } = foldGeometry(content);
      const capture = await captureOwn();
      if (!isOpen(generation)) return;
      if (!capture) {
        options.log("DESKTOP_MOTION_CAPTURE_UNAVAILABLE");
        revealWindow();
        return;
      }
      try {
        await runOverlayLeg(generation, capture, origin, content, "startup", {
          afterRun: async () => {
            if (!win.isDestroyed()) win.setOpacity(1);
          },
        });
      } catch {
        if (!isOpen(generation)) return;
        options.log("DESKTOP_STARTUP_MOTION_FAILED");
        revealWindow();
      }
    });
    return startupPromise;
  };

  const loadPlain = async (url: string) => {
    if (closed || disposed) return;
    await win.loadURL(url);
  };
  const navigate = async (url: string) => {
    // A closed controller never touches the window; a plain one just loads.
    if (closed || disposed) return;
    if (!options.native || !overlay) {
      await loadPlain(url);
      return;
    }
    if (await reducedMotion()) {
      await loadPlain(url);
      return;
    }
    // Same serialized owner as the legs: no leg runs against the capture cover.
    await present(async () => {
      try {
        await overlayReady;
      } catch {
        options.log("DESKTOP_MOTION_OVERLAY_UNAVAILABLE");
        await loadPlain(url);
        return;
      }
      if (closed || disposed) return;
      const surface = overlay;
      if (!surface || surface.isDestroyed()) {
        await loadPlain(url);
        return;
      }
      const content = win.getContentBounds();
      const display = screen.getDisplayMatching(content).bounds;
      const capture = await captureOwn();
      if (closed || disposed) return;
      if (!capture) {
        options.log("DESKTOP_MOTION_CAPTURE_UNAVAILABLE");
        await loadPlain(url);
        return;
      }
      // The waiter is installed before loadURL and cancellable in plain JS.
      let handoffTimedOut = false;
      const ready = new Promise<void>((resolve) => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          workspaceReadyResolver = null;
          if (deadline) clearTimeout(deadline);
          resolve();
        };
        workspaceReadyResolver = finish;
        deadline = setTimeout(() => {
          handoffTimedOut = true;
          finish();
        }, HANDOFF_TIMEOUT_MS);
        cancelHandoffWait = finish;
      });
      try {
        surface.setBounds(snapRect(display));
        await askOverlay("prepare", {
          bitmap: capture,
          from: content,
          to: content,
          origin: { x: display.x, y: display.y },
          boundary: display,
        } satisfies Omit<MotionPrepare, "token" | "generation">);
        if (closed || disposed) return;
        if (surface.isDestroyed()) return;
        surface.showInactive();
        surface.setAlwaysOnTop(true, "floating");
        await win.loadURL(url);
        if (closed || disposed) return;
        await ready;
        // A timeout is bounded cleanup only.
        if (handoffTimedOut) options.log("DESKTOP_MOTION_HANDOFF_TIMEOUT");
        // The overlay hides only after the workspace actually presented.
        if (!disposed && !closed) await settleVisible();
      } finally {
        cancelHandoffWait?.();
        cancelHandoffWait = null;
        if (!surface.isDestroyed()) {
          surface.hide();
          surface.setAlwaysOnTop(false);
        }
      }
    });
  };

  const workspaceReady = (sender: WebContents) => {
    if (win.isDestroyed() || sender !== win.webContents) return;
    workspaceReadyResolver?.();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    pendingIntent = null;
    beforeMin = null;
    // The handler drops first: no queued physical command reaches a disposing controller.
    options.native?.setHandler(null);
    cancelWaiters();
    if (drainIdle) {
      drainIdle();
      drainIdle = null;
    }
    // A close during the handoff resolves the navigation waiter in plain JS.
    cancelHandoffWait?.();
    cancelHandoffWait = null;
    ipcMain.removeListener(MOTION_REPLY, onReply);
    if (overlay && !overlay.isDestroyed()) overlay.destroy();
    overlay = null;
    options.native?.dispose();
  };

  /**
   * One bounded closing fold on the same overlay renderer as every other leg. It runs after
   * the close event was already prevented and the controller marked closed, so it checks its
   * own local surface/generation instead of isOpen. The RUN carries the timed closing branch
   * (durationMs); the overlay keeps the shared pixel cover. No native FFI runs in this path:
   * dispose happens once, in the deferred worker's final step.
   */
  const foldClosed = async (surface: BrowserWindow, atGeneration: number) => {
    const alive = () =>
      !disposed &&
      generation === atGeneration &&
      overlay === surface &&
      !surface.isDestroyed() &&
      !win.isDestroyed();
    if (await reducedMotion()) return;
    if (!alive()) return;
    const content = win.getContentBounds();
    const capture = await captureOwn();
    if (!capture || !alive()) return;
    const { display, target } = foldGeometry(content);
    surface.setBounds(snapRect(display));
    await askOverlay("prepare", {
      bitmap: capture,
      from: content,
      to: target,
      origin: { x: display.x, y: display.y },
      boundary: display,
    } satisfies Omit<MotionPrepare, "token" | "generation">);
    if (!alive()) return;
    surface.showInactive();
    surface.setAlwaysOnTop(true, "floating");
    win.setOpacity(0);
    await askOverlay("run", {
      operation: "close",
      spring: SPRING,
      reducedMotion: false,
      durationMs: CLOSE_ANIMATION_DURATION_MS,
    } satisfies Omit<MotionRun, "token" | "generation">);
  };

  /** The single terminal step for a native close: native/COM teardown, then host quit. */
  const finishClose = () => {
    if (closeCommitted) return;
    closeCommitted = true;
    dispose();
    options.quit();
  };

  /**
   * The deferred close worker. The whole fold is raced against one close budget so a stalled
   * renderer cannot hold teardown for the ordinary 10s overlay reply wait; a finished fold,
   * a cancelled fold and a timeout all end in the same single finish.
   */
  const closeWorker = async (fold: boolean, atGeneration: number) => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const surface = overlay;
      if (fold && overlayLoaded && surface && !surface.isDestroyed()) {
        await Promise.race([
          foldClosed(surface, atGeneration),
          new Promise<void>((resolve) => {
            deadline = setTimeout(() => resolve(), CLOSE_MAX_WAIT_MS);
          }),
        ]);
      }
    } catch {
      // A fold that failed on its own is diagnostic only; teardown is identical.
      if (!disposed) options.log("DESKTOP_CLOSE_MOTION_FAILED");
    } finally {
      if (deadline) clearTimeout(deadline);
      finishClose();
    }
  };

  const close = (event: ElectronEvent) => {
    if (disposed || closeCommitted) return;
    if (!options.native) {
      options.quit();
      return;
    }
    // Pure JS only, before any bookkeeping: a native close must never run teardown on the
    // OS close-dispatch stack, where a synchronous FFI call is a known crash path.
    if (!event.defaultPrevented) event.preventDefault();
    // A second X while the bounded fold/teardown runs must keep the surface alive too;
    // otherwise the OS destroys the window under the animation and the deferred teardown.
    if (closed) return;
    // Marking closed invalidates presentations, legs and handoff waiters in plain JS; the
    // native handler stays attached but request() already rejects on closed.
    closed = true;
    beforeMin = null;
    generation += 1;
    const atGeneration = generation;
    // The closing policy and the in-flight snapshot are decided here, in plain JS: an
    // active presentation/leg exits directly. The worker adds the overlay-ready check,
    // because a surface still loading is "not ready" rather than something to wait for.
    const fold =
      (options.shouldAnimateClose?.() ?? true) && !presenting && !running && !win.isDestroyed();
    pendingIntent = null;
    cancelWaiters();
    if (drainIdle) {
      drainIdle();
      drainIdle = null;
    }
    cancelHandoffWait?.();
    cancelHandoffWait = null;
    setImmediate(() => {
      void closeWorker(fold, atGeneration);
    });
  };

  const createOverlay = () => {
    const surface = new BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(app.getAppPath(), "motion-overlay-preload.cjs"),
        // The overlay reuses the main window's session so the startup protocol handler
        // that serves MOTION_OVERLAY_URL is the one this surface loads through.
        session: win.webContents.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    surface.setIgnoreMouseEvents(true);
    surface.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    overlay = surface;
    overlayReady = surface.loadURL(MOTION_OVERLAY_URL).then(() => {
      overlayLoaded = true;
    });
    overlayReady.catch(() => options.log("DESKTOP_MOTION_OVERLAY_UNAVAILABLE"));
    ipcMain.on(MOTION_REPLY, onReply);
  };

  if (options.native) createOverlay();

  // Physical SC_ commands route into the serialized owner; unhooked forwards to the OS.
  options.native?.setHandler(request);

  return {
    presentStartup,
    navigate,
    workspaceReady,
    request,
    close,
    dispose,
    isProgrammatic: () => programmaticDepth > 0,
    // The OS now owns the normal placement (no bounds morph), so the native read is exact;
    // a destroyed window can still be asked during teardown, hence the static fallback.
    normalBounds: () =>
      win.isDestroyed() ? { x: 0, y: 0, width: 480, height: 480 } : win.getNormalBounds(),
  };
}
