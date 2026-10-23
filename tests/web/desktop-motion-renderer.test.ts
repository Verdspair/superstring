import { afterEach, describe, expect, it, vi } from "vitest";
import { type MotionSurface, startMotionRenderer } from "../../src/desktop/motion-overlay-renderer";
import {
  type MotionBitmap,
  type MotionPrepare,
  type MotionReply,
  type MotionRun,
  SPRING,
} from "../../src/shared/window-motion";

function setup() {
  document.body.innerHTML = '<canvas id="surface"></canvas>';
  const events: string[] = [];
  const uploads: Array<{ unit: number; pixels: number[] }> = [];
  const uniforms = new Map<string, number[]>();
  const frames = new Map<number, FrameRequestCallback>();
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  let activeUnit = 0;
  let uploadFailure = false;
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    ARRAY_BUFFER: 5,
    ELEMENT_ARRAY_BUFFER: 6,
    STATIC_DRAW: 7,
    FLOAT: 8,
    TEXTURE0: 10,
    TEXTURE_2D: 11,
    TEXTURE_MIN_FILTER: 12,
    TEXTURE_MAG_FILTER: 13,
    LINEAR: 14,
    TEXTURE_WRAP_S: 15,
    TEXTURE_WRAP_T: 16,
    CLAMP_TO_EDGE: 17,
    RGBA: 18,
    UNSIGNED_BYTE: 19,
    UNPACK_FLIP_Y_WEBGL: 20,
    BLEND: 21,
    SRC_ALPHA: 22,
    ONE_MINUS_SRC_ALPHA: 23,
    ONE: 24,
    COLOR_BUFFER_BIT: 25,
    TRIANGLES: 26,
    UNSIGNED_SHORT: 27,
    NO_ERROR: 0,
    createShader: () => ({}),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: () => true,
    getShaderInfoLog: () => null,
    deleteShader: vi.fn(),
    createProgram: () => ({}),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: () => true,
    getProgramInfoLog: () => null,
    useProgram: vi.fn(),
    createBuffer: () => ({}),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    getAttribLocation: () => 0,
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    createTexture: () => ({}),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    activeTexture: (unit: number) => {
      activeUnit = unit - 10;
    },
    texImage2D: (
      _target: number,
      _level: number,
      _internal: number,
      width: number,
      height: number,
      _border: number,
      _format: number,
      _type: number,
      pixels: Uint8Array,
    ) => {
      events.push(`upload:${activeUnit}:${width}x${height}`);
      if (uploadFailure) throw new Error("fixture upload failure");
      uploads.push({ unit: activeUnit, pixels: Array.from(pixels) });
    },
    pixelStorei: vi.fn(),
    enable: vi.fn(),
    blendFuncSeparate: vi.fn(),
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    uniform1i: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    uniform1f: (location: { name: string }, value: number) => uniforms.set(location.name, [value]),
    uniform2fv: (location: { name: string }, value: number[]) =>
      uniforms.set(location.name, [...value]),
    uniform4fv: (location: { name: string }, value: number[]) =>
      uniforms.set(location.name, [...value]),
    clearColor: vi.fn(),
    clear: () => events.push("clear"),
    drawElements: () => events.push("draw"),
    viewport: vi.fn(),
    getError: () => 0,
    isContextLost: () => false,
  };
  // Only the browser WebGL boundary is substituted; payload guards and renderer code are real.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    gl as unknown as WebGLRenderingContext,
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  let prepareListener: ((payload: MotionPrepare) => void) | undefined;
  let runListener: ((payload: MotionRun) => void) | undefined;
  const replies: MotionReply[] = [];
  const bridge: MotionSurface = {
    onPrepare(listener) {
      prepareListener = listener;
    },
    onRun(listener) {
      runListener = listener;
    },
    reply(message) {
      replies.push(message);
    },
  };
  startMotionRenderer(bridge);
  events.length = 0;
  uploads.length = 0;
  return {
    events,
    uploads,
    uniforms,
    frames,
    callbacks,
    replies,
    prepare(payload: MotionPrepare) {
      if (!prepareListener) throw new Error("prepare listener missing");
      prepareListener(payload);
    },
    run(payload: MotionRun) {
      if (!runListener) throw new Error("run listener missing");
      runListener(payload);
    },
    failUpload() {
      uploadFailure = true;
    },
    tick(now: number) {
      const entry = frames.entries().next().value;
      if (!entry) throw new Error("frame missing");
      const [id, callback] = entry;
      frames.delete(id);
      callback(now);
    },
  };
}

const rect = { x: 100, y: 80, width: 600, height: 400 };
// Half of the 90ms default unmaximize profile: the interpolation assertions below sample p=0.5.
const UNMAXIMIZE_HALF_TRAVEL_MS = 45;
const bitmap = (): MotionBitmap => ({
  width: 2,
  height: 2,
  pixels: new Uint8Array([1, 2, 3, 255, 8, 9, 10, 255, 11, 12, 13, 255, 21, 22, 23, 255]),
});
const silhouetteBitmap = (internalHole = false): MotionBitmap => {
  const width = 8,
    height = 8;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const corner = (y === 0 || y === height - 1) && (x === 0 || x === width - 1);
      const alpha = corner || (internalHole && x === 4 && y === 4) ? 0 : 255;
      pixels.set(alpha ? [30, 60, 90, alpha] : [0, 0, 0, 0], i);
    }
  }
  return { width, height, pixels };
};
const prepare = (generation = 1): MotionPrepare => ({
  token: `prepare-${generation}`,
  generation,
  bitmap: bitmap(),
  from: rect,
  to: rect,
  origin: { x: 0, y: 0 },
  boundary: { x: 0, y: 0, width: 1920, height: 1080 },
});
const run = (generation = 1): MotionRun => ({
  token: `run-${generation}`,
  generation,
  operation: "maximize",
  spring: SPRING,
  destinationBitmap: bitmap(),
  to: { x: 0, y: 0, width: 1920, height: 1040 },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("isolated motion renderer", () => {
  it("prepares native bitmap bytes with the retained BGRA conversion and physical row flip", () => {
    const fixture = setup();
    const payload = prepare();
    payload.bitmap.pixels[7] = 0;
    fixture.prepare(payload);
    expect(fixture.uploads).toEqual([
      { unit: 0, pixels: [13, 12, 11, 255, 23, 22, 21, 255, 3, 2, 1, 255, 0, 0, 0, 0] },
    ]);
    expect(fixture.events).toEqual(["upload:0:2x2", "clear", "draw"]);
    expect(fixture.uniforms.get("C")).toEqual([100, 80, 600, 400]);
    expect(fixture.replies).toEqual([{ token: "prepare-1", generation: 1, kind: "ready" }]);
  });

  it("rejects malformed byte length without drawing or declaring the prepare ready", () => {
    const fixture = setup();
    const payload = prepare();
    payload.bitmap.pixels = new Uint8Array(3);
    fixture.prepare(payload);
    expect(fixture.events).toEqual([]);
    expect(fixture.replies).toEqual([
      { token: "prepare-1", generation: 1, kind: "error", message: "Error: MOTION_BITMAP_INVALID" },
    ]);
    fixture.run(run());
    expect(fixture.replies.at(-1)?.message).toBe("MOTION_PREPARE_NOT_READY");
    expect(fixture.frames.size).toBe(0);
  });

  it("uploads the destination before clearing the prepared source and completes one bounds run", () => {
    const fixture = setup();
    fixture.prepare(prepare());
    fixture.events.length = 0;
    fixture.run(run());
    expect(fixture.events).toEqual(["upload:1:2x2", "clear", "draw"]);
    expect(fixture.uniforms.get("M")).toEqual([3]);
    expect(fixture.replies).toHaveLength(1);
    fixture.tick(1000);
    fixture.tick(1100);
    expect(fixture.replies.at(-1)).toEqual({ token: "run-1", generation: 1, kind: "done" });
    expect(fixture.frames.size).toBe(0);
    expect(fixture.uniforms.get("C")).toEqual([0, 0, 1920, 1040]);
  });

  it("keeps source-screen coordinates and destination extent independent throughout an unmaximize", () => {
    const fixture = setup();
    const source = { x: 40, y: 30, width: 1200, height: 800 };
    const destination = { x: 180, y: 120, width: 600, height: 400 };
    fixture.prepare({ ...prepare(), from: source, to: source });
    fixture.run({ ...run(), operation: "unmaximize", to: destination });
    // A stays fixed for same-screen source fallback; F supplies only the destination extent.
    expect(fixture.uniforms.get("A")).toEqual([40, 30, 1200, 800]);
    expect(fixture.uniforms.get("F")).toEqual([180, 120, 600, 400]);
    expect(fixture.uniforms.get("C")).toEqual([40, 30, 1200, 800]);
    fixture.tick(1000);
    fixture.tick(1000 + UNMAXIMIZE_HALF_TRAVEL_MS);
    expect(fixture.uniforms.get("M")).toEqual([3]);
    expect(fixture.uniforms.get("A")).toEqual([40, 30, 1200, 800]);
    expect(fixture.uniforms.get("F")).toEqual([180, 120, 600, 400]);
    expect(fixture.uniforms.get("C")).toEqual([110, 75, 900, 600]);
    fixture.tick(1100);
    expect(fixture.uniforms.get("A")).toEqual([40, 30, 1200, 800]);
    expect(fixture.uniforms.get("C")).toEqual([180, 120, 600, 400]);
    expect(fixture.replies.at(-1)?.kind).toBe("done");
  });

  it("retains the prepared source drawing when destination upload fails", () => {
    const fixture = setup();
    fixture.prepare(prepare());
    fixture.events.length = 0;
    fixture.failUpload();
    fixture.run(run());
    expect(fixture.events).toEqual(["upload:1:2x2"]);
    expect(fixture.replies.at(-1)).toEqual({
      token: "run-1",
      generation: 1,
      kind: "error",
      message: "Error: fixture upload failure",
    });
    expect(fixture.frames.size).toBe(0);
  });

  it("cancels an older epoch and ignores even an already dequeued animation callback", () => {
    const fixture = setup();
    fixture.prepare(prepare());
    fixture.run(run());
    const oldCallback = fixture.callbacks.values().next().value;
    if (!oldCallback) throw new Error("old callback missing");
    fixture.prepare(prepare(2));
    expect(fixture.frames.size).toBe(0);
    fixture.events.length = 0;
    oldCallback(2000);
    expect(fixture.events).toEqual([]);
    expect(fixture.replies.some((reply) => reply.kind === "done")).toBe(false);
    fixture.run(run());
    expect(fixture.replies.at(-1)?.message).toBe("MOTION_RUN_WITHOUT_PREPARE");
    expect(fixture.events).toEqual([]);
    fixture.run({ ...run(2), reducedMotion: true });
    expect(fixture.replies.at(-1)).toEqual({ token: "run-2", generation: 2, kind: "done" });
    expect(fixture.frames.size).toBe(0);
  });

  it("accepts corner-only alpha for bounds and keeps the exact endpoint geometry", () => {
    const fixture = setup();
    fixture.prepare({ ...prepare(), bitmap: silhouetteBitmap() });
    fixture.run({ ...run(), destinationBitmap: silhouetteBitmap() });
    expect(fixture.replies).toEqual([{ token: "prepare-1", generation: 1, kind: "ready" }]);
    expect(fixture.uniforms.get("P")).toEqual([0]);
    fixture.tick(1000);
    fixture.tick(1100);
    expect(fixture.uniforms.get("P")).toEqual([1]);
    expect(fixture.uniforms.get("C")).toEqual([0, 0, 1920, 1040]);
    expect(fixture.replies.at(-1)?.kind).toBe("done");
  });

  it("rejects destination internal alpha before upload or clearing the prepared cover", () => {
    const fixture = setup();
    fixture.prepare({ ...prepare(), bitmap: silhouetteBitmap() });
    fixture.events.length = 0;
    fixture.run({ ...run(), destinationBitmap: silhouetteBitmap(true) });
    expect(fixture.events).toEqual([]);
    expect(fixture.replies.at(-1)).toEqual({
      token: "run-1",
      generation: 1,
      kind: "error",
      message: "Error: MOTION_BITMAP_NON_CORNER_ALPHA",
    });
    expect(fixture.frames.size).toBe(0);
    fixture.run({ ...run(), destinationBitmap: silhouetteBitmap(), reducedMotion: true });
    expect(fixture.replies.at(-1)?.kind).toBe("done");
  });

  it("records unsupported source alpha without rejecting non-bounds operations", () => {
    const fixture = setup();
    fixture.prepare({ ...prepare(), bitmap: silhouetteBitmap(true) });
    expect(fixture.replies.at(-1)?.kind).toBe("ready");
    fixture.events.length = 0;
    fixture.run(run());
    expect(fixture.events).toEqual([]);
    expect(fixture.replies.at(-1)?.message).toBe("Error: MOTION_BITMAP_NON_CORNER_ALPHA");
    fixture.run({ ...run(), operation: "startup", reducedMotion: true });
    expect(fixture.replies.at(-1)?.kind).toBe("done");
    expect(fixture.events).toEqual(["clear", "draw"]);
    expect(fixture.frames.size).toBe(0);
  });

  it.each([
    { name: "fully opaque", variant: "opaque", accepted: true },
    { name: "antialiased corners", variant: "aa", accepted: true },
    { name: "single-row internal gap", variant: "gap", accepted: false },
    { name: "two separated edge runs", variant: "split", accepted: false },
    { name: "nonmonotonic corner run", variant: "nonmonotonic", accepted: false },
  ])("validates sparse alpha runs like the complete scan: $name", ({ variant, accepted }) => {
    const fixture = setup();
    const input = silhouetteBitmap();
    const alphaAt = (x: number, y: number, alpha: number) => {
      const i = (y * input.width + x) * 4;
      input.pixels.set(alpha ? [5, 10, 15, alpha] : [0, 0, 0, 0], i);
    };
    if (variant === "opaque") {
      for (let y = 0; y < input.height; y++)
        for (let x = 0; x < input.width; x++) alphaAt(x, y, 255);
    } else if (variant === "aa") {
      for (const y of [0, 7]) for (const x of [0, 7]) alphaAt(x, y, 128);
    } else if (variant === "gap") alphaAt(4, 3, 128);
    else if (variant === "split") {
      alphaAt(3, 1, 0);
      alphaAt(7, 1, 0);
    } else if (variant === "nonmonotonic") {
      alphaAt(0, 0, 255);
      alphaAt(0, 1, 0);
    }
    fixture.prepare({ ...prepare(), bitmap: silhouetteBitmap() });
    fixture.events.length = 0;
    fixture.run({ ...run(), destinationBitmap: input, reducedMotion: true });
    expect(fixture.replies.at(-1)?.kind).toBe(accepted ? "done" : "error");
    if (accepted) expect(fixture.events).toEqual(["upload:1:8x8", "clear", "draw"]);
    else {
      expect(fixture.replies.at(-1)?.message).toBe("Error: MOTION_BITMAP_NON_CORNER_ALPHA");
      expect(fixture.events).toEqual([]);
    }
    expect(fixture.frames.size).toBe(0);
  });

  it("rejects a missing bounds destination without clearing the source cover", () => {
    const fixture = setup();
    fixture.prepare(prepare());
    fixture.events.length = 0;
    fixture.run({ ...run(), destinationBitmap: undefined });
    expect(fixture.events).toEqual([]);
    expect(fixture.replies.at(-1)?.message).toBe("MOTION_DESTINATION_REQUIRED");
    expect(fixture.frames.size).toBe(0);
  });
});
