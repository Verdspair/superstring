import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
  /** Native snapshot of the last stable ordinary placement; absent for legacy saved files. */
  nativePlacement?: NativeWindowPlacement;
}

/**
 * Physical screen-pixel snapshot of the last stable ordinary (non-maximized) placement plus
 * the display facts needed to decide whether it can still be applied as-is. DIP fields carry
 * the same display's logical geometry. The shape is declared here, not imported from the
 * native binding, so the state file contract stays decoupled from the win32 module.
 */
export interface NativeWindowPlacement {
  bounds: Rect;
  displayId: number;
  scaleFactor: number;
  displayBounds: Rect;
  workArea: Rect;
}

export type WindowStateOperation = "load" | "save";

export interface WindowStateOptions {
  /** Trailing merge window for move/resize; the close-time flush always stays synchronous. */
  flushDelayMs?: number;
  /**
   * Reported for read/parse and write failures. Losing window state must never block startup, so
   * these surface through this callback instead of throwing or being swallowed.
   */
  onError?: (error: unknown, operation: WindowStateOperation) => void;
}

export interface WindowStateTrackOptions {
  /** True while the motion controller drives geometry; leg frames must never persist. */
  isProgrammatic?: () => boolean;
  /**
   * The controller's stable plain-OS normal. Only stored while no programmatic leg is in flight
   * (see isProgrammatic), so leg frames never reach the file.
   */
  normalBounds?: () => Rect;
  /**
   * Native physical placement of the current ordinary window, read through the native owner.
   * Null drops the stored snapshot so a logical-only change cannot keep stale physical pixels.
   */
  nativePlacement?: () => NativeWindowPlacement | null;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_SIZE = 480;
const DEFAULT_BOUNDS: WindowBounds = { width: 1280, height: 860, maximized: false };
/** Saved positions are kept only while this much of the window still sits in a work area. */
const MIN_VISIBLE_WIDTH = 80;
const MIN_VISIBLE_HEIGHT = 40;

function sameRect(left: Rect, right: Rect): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
}

function isRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const { x, y, width, height } = value as Partial<Rect>;
  return (
    isFiniteInt(x) &&
    isFiniteInt(y) &&
    isFiniteInt(width) &&
    isFiniteInt(height) &&
    width > 0 &&
    height > 0
  );
}

function normalizePlacement(value: unknown): NativeWindowPlacement | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { bounds, displayId, scaleFactor, displayBounds, workArea } =
    value as Partial<NativeWindowPlacement>;
  if (!isRect(bounds) || !isRect(displayBounds) || !isRect(workArea)) return undefined;
  if (
    !isFiniteInt(displayId) ||
    typeof scaleFactor !== "number" ||
    !Number.isFinite(scaleFactor) ||
    scaleFactor <= 0
  ) {
    return undefined;
  }
  // Copy the rects so stored state never aliases provider or parsed-file objects.
  return {
    bounds: { ...bounds },
    displayId,
    scaleFactor,
    displayBounds: { ...displayBounds },
    workArea: { ...workArea },
  };
}

function normalize(value: unknown): WindowBounds | null {
  if (typeof value !== "object" || value === null) return null;
  const { x, y, width, height, maximized, nativePlacement } = value as Partial<WindowBounds>;
  if (typeof width !== "number" || typeof height !== "number") return null;
  if (width < MIN_SIZE || height < MIN_SIZE) return null;
  const placement = normalizePlacement(nativePlacement);
  return {
    x: typeof x === "number" ? x : undefined,
    y: typeof y === "number" ? y : undefined,
    width,
    height,
    maximized: Boolean(maximized),
    ...(placement ? { nativePlacement: placement } : {}),
  };
}

function samePlacement(left: NativeWindowPlacement, right: NativeWindowPlacement): boolean {
  return (
    left.displayId === right.displayId &&
    left.scaleFactor === right.scaleFactor &&
    sameRect(left.bounds, right.bounds) &&
    sameRect(left.displayBounds, right.displayBounds) &&
    sameRect(left.workArea, right.workArea)
  );
}

function sameBounds(left: WindowBounds, right: WindowBounds): boolean {
  if (left.x !== right.x || left.y !== right.y) return false;
  if (left.width !== right.width || left.height !== right.height) return false;
  if (left.maximized !== right.maximized) return false;
  const leftPlacement = left.nativePlacement;
  const rightPlacement = right.nativePlacement;
  if (!leftPlacement || !rightPlacement) return leftPlacement === rightPlacement;
  return samePlacement(leftPlacement, rightPlacement);
}

function clonePlacement(placement: NativeWindowPlacement): NativeWindowPlacement {
  return {
    bounds: { ...placement.bounds },
    displayId: placement.displayId,
    scaleFactor: placement.scaleFactor,
    displayBounds: { ...placement.displayBounds },
    workArea: { ...placement.workArea },
  };
}

function visibleIn(rect: Rect, area: Rect): boolean {
  const width = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
  const height = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
  return width >= MIN_VISIBLE_WIDTH && height >= MIN_VISIBLE_HEIGHT;
}

export class WindowStateManager {
  private readonly filePath: string;
  private readonly flushDelayMs: number;
  private readonly onError?: (error: unknown, operation: WindowStateOperation) => void;
  private trackOptions: WindowStateTrackOptions = {};
  private state: WindowBounds;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(profileRoot: string, options: WindowStateOptions = {}) {
    const dir = path.join(profileRoot, "state");
    mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, "window-state.json");
    this.flushDelayMs = options.flushDelayMs ?? 200;
    this.onError = options.onError;
    this.state = this.load();
  }

  /**
   * In-memory state including `maximized`; the host restores the maximized window from this.
   * The native placement is the only nested field, so it is the only one cloned: callers cannot
   * mutate tracked state through `.bounds.nativePlacement`.
   */
  get bounds(): WindowBounds {
    const { nativePlacement, ...logical } = this.state;
    return nativePlacement
      ? { ...logical, nativePlacement: clonePlacement(nativePlacement) }
      : { ...logical };
  }

  /**
   * Restorable BrowserWindow fields. Sizes are clamped to the largest work area, and a position
   * that no longer overlaps a work area by enough to grab is dropped so the window opens on screen.
   */
  validateBounds(areas: readonly Rect[]): {
    x?: number;
    y?: number;
    width: number;
    height: number;
  } {
    const limitWidth = Math.max(...areas.map((area) => area.width));
    const limitHeight = Math.max(...areas.map((area) => area.height));
    const width = Math.max(MIN_SIZE, Math.min(this.state.width, limitWidth));
    const height = Math.max(MIN_SIZE, Math.min(this.state.height, limitHeight));
    const { x, y } = this.state;
    if (typeof x !== "number" || typeof y !== "number") return { width, height };
    if (!areas.some((area) => visibleIn({ x, y, width, height }, area))) return { width, height };
    return { x, y, width, height };
  }

  /** Update from the live window and write now, skipping the write when nothing changed. */
  save(win: BrowserWindow): void {
    this.remember(win);
    this.flush();
  }

  /**
   * move/resize only update memory and reset one trailing timer, so a drag costs one write instead
   * of one per event, with the physical capture deferred off the native event stack (a synchronous
   * GetWindowRect there is proven unsafe). `moved`/`resized` are left unused: they only fire on
   * Windows and macOS, while the merge timer plus the synchronous `close` flush already covers
   * every platform. The motion callbacks stay optional so the plain window path keeps today's
   * behavior.
   */
  track(win: BrowserWindow, options: WindowStateTrackOptions = {}): () => void {
    this.trackOptions = options;
    const onChange = () => {
      // Deferred native capture: a synchronous GetWindowRect on the native move/resize event
      // stack is proven unsafe (AV), so this callback stays FFI-free and the existing trailing
      // timer reads the window once, off the stack. Logical bounds still update here.
      this.remember(win, false);
      if (this.dirty || this.trackOptions.nativePlacement) this.schedule(win);
    };
    const onClose = () => {
      this.stopTimer();
      // Closing during a motion leg flushes the last stable state: remember() skips
      // programmatic legs, so no halfway rect can reach the file here. The close callback stays
      // free of native (Koffi) FFI: captureNative=false keeps the last snapshot only when the
      // normal rect did not change, instead of reading the window again while it tears down.
      this.remember(win, false);
      this.flush();
    };
    win.on("move", onChange);
    win.on("resize", onChange);
    win.on("close", onClose);
    return () => {
      win.off("move", onChange);
      win.off("resize", onChange);
      win.off("close", onClose);
      this.stopTimer();
      this.flush();
      this.trackOptions = {};
    };
  }

  private load(): WindowBounds {
    if (!existsSync(this.filePath)) return { ...DEFAULT_BOUNDS };
    try {
      return normalize(JSON.parse(readFileSync(this.filePath, "utf-8"))) ?? { ...DEFAULT_BOUNDS };
    } catch (error) {
      // A torn or hand-edited file falls back to defaults; the cause still reaches onError.
      this.onError?.(error, "load");
      return { ...DEFAULT_BOUNDS };
    }
  }

  private remember(win: BrowserWindow, captureNative = true): void {
    // Minimized windows report unreliable bounds, so they must not overwrite the stored state.
    if (win.isDestroyed() || win.isMinimized()) return;
    // Leg frames are intermediate geometry; the motion owner supplies the stable normal instead.
    if (this.trackOptions.isProgrammatic?.()) return;
    const normal = this.trackOptions.normalBounds?.() ?? win.getNormalBounds();
    const maximized = win.isMaximized();
    // A maximized window must never write maximized physical pixels: the snapshot keeps
    // describing the last stable ordinary placement, including the initial save on a
    // maximized launch where no ordinary frame was seen yet.
    const next: WindowBounds = maximized
      ? {
          x: normal.x,
          y: normal.y,
          width: normal.width,
          height: normal.height,
          maximized,
          // Keep the last stable ordinary snapshot; only an ordinary frame may refresh it.
          ...this.retainedSnapshot(),
        }
      : {
          x: normal.x,
          y: normal.y,
          width: normal.width,
          height: normal.height,
          maximized,
          ...(captureNative ? this.nativeSnapshot() : this.retainedSnapshot(normal)),
        };
    if (sameBounds(next, this.state)) return;
    this.state = next;
    this.dirty = true;
  }

  /** The stored snapshot without reading the window; used by the maximized branch and close. */
  private retainedSnapshot(normal?: Rect): { nativePlacement?: NativeWindowPlacement } {
    const stored = this.state;
    if (!stored.nativePlacement) return {};
    if (
      normal &&
      (stored.x !== normal.x ||
        stored.y !== normal.y ||
        stored.width !== normal.width ||
        stored.height !== normal.height)
    ) {
      return {};
    }
    return { nativePlacement: clonePlacement(stored.nativePlacement) };
  }

  private nativeSnapshot(): { nativePlacement?: NativeWindowPlacement } {
    const raw = this.trackOptions.nativePlacement?.();
    const placement = normalizePlacement(raw);
    // Null means the native read failed or the placement changed: drop the snapshot so the file
    // never keeps physical pixels that no longer match the logical bounds. A malformed shape is
    // ignored the same way, without discarding the valid logical bounds.
    return placement ? { nativePlacement: placement } : {};
  }

  private schedule(win: BrowserWindow): void {
    this.stopTimer();
    const timer = setTimeout(() => {
      this.timer = undefined;
      // Off the native event stack: the one place a fresh physical capture is safe. The
      // destroyed/minimized/programmatic guards in remember() still apply here.
      this.remember(win);
      this.flush();
    }, this.flushDelayMs);
    timer.unref();
    this.timer = timer;
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private flush(): void {
    if (!this.dirty) return;
    try {
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
      this.dirty = false;
    } catch (error) {
      // Keep dirty so a later close can retry the same state.
      this.onError?.(error, "save");
    }
  }
}
