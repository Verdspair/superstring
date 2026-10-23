export interface MotionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MotionSpring {
  stiffness: number;
  damping: number;
  mass: number;
}

/** Native Windows capture pixels: top-down BGRA8, premultiplied alpha, sRGB. */
export interface MotionBitmap {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface MotionPrepare {
  token: string;
  generation: number;
  bitmap: MotionBitmap;
  from: MotionRect;
  to: MotionRect;
  origin: { x: number; y: number };
  boundary: MotionRect;
}

export type MotionOperation =
  | "startup"
  | "close"
  | "minimize"
  | "restore"
  | "maximize"
  | "unmaximize";

export interface MotionRun {
  token: string;
  generation: number;
  operation: MotionOperation;
  spring: MotionSpring;
  /** Final-layout pixels, uploaded within this RUN while the prepared cover stays visible. */
  destinationBitmap?: MotionBitmap;
  /** Final rect in screen DIP; overrides the prepared target without a second PREPARE. */
  to?: MotionRect;
  /**
   * A finite positive duration in ms overrides the event profile on the same epoch runner.
   * Close supplies its existing bounded duration; other operations use renderer defaults.
   */
  durationMs?: number;
  reducedMotion?: boolean;
}

export interface MotionReply {
  token: string;
  generation: number;
  kind: "ready" | "done" | "error";
  message?: string;
}

export const DESKTOP_APP_ID = "io.github.verdspair.superstring";
export const SPRING: MotionSpring = { stiffness: 260, damping: 18, mass: 0.85 };
// The overlay document is served through the existing startup protocol, not a file URL.
export const MOTION_OVERLAY_URL = "superstring://startup/motion-overlay.html";

export const MOTION_PREPARE = "superstring:motion:prepare";
export const MOTION_RUN = "superstring:motion:run";
export const MOTION_REPLY = "superstring:motion:reply";
