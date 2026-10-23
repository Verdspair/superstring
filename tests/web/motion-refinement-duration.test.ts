import { readFileSync } from "node:fs";
import path from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { MotionConfig } from "motion/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MotionSurface, startMotionRenderer } from "../../src/desktop/motion-overlay-renderer";
import {
  type MotionBitmap,
  type MotionOperation,
  type MotionPrepare,
  type MotionReply,
  type MotionRun,
  SPRING,
} from "../../src/shared/window-motion";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";

function setup() {
  document.body.innerHTML = '<canvas id="surface"></canvas>';
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
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
    activeTexture: vi.fn(),
    texImage2D: vi.fn(),
    pixelStorei: vi.fn(),
    enable: vi.fn(),
    blendFuncSeparate: vi.fn(),
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    uniform1i: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    uniform1f: vi.fn(),
    uniform2fv: vi.fn(),
    uniform4fv: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    drawElements: vi.fn(),
    viewport: vi.fn(),
    getError: () => 0,
    isContextLost: () => false,
  };
  // Only the WebGL boundary is substituted; PREPARE/RUN guards and the RAF clock stay real.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    gl as unknown as WebGLRenderingContext,
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
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
  return {
    replies,
    prepare(payload: MotionPrepare) {
      if (!prepareListener) throw new Error("prepare listener missing");
      prepareListener(payload);
    },
    run(payload: MotionRun) {
      if (!runListener) throw new Error("run listener missing");
      runListener(payload);
    },
    tick(now: number) {
      const entry = frames.entries().next().value;
      if (!entry) throw new Error("frame missing");
      const [id, callback] = entry;
      frames.delete(id);
      callback(now);
    },
    pending() {
      return frames.size;
    },
  };
}

const bitmap = (): MotionBitmap => ({
  width: 2,
  height: 2,
  pixels: new Uint8Array([1, 2, 3, 255, 8, 9, 10, 255, 11, 12, 13, 255, 21, 22, 23, 255]),
});
const rect = { x: 100, y: 80, width: 600, height: 400 };
const prepare = (): MotionPrepare => ({
  token: "prepare-1",
  generation: 1,
  bitmap: bitmap(),
  from: rect,
  to: rect,
  origin: { x: 0, y: 0 },
  boundary: { x: 0, y: 0, width: 1920, height: 1080 },
});
const run = (operation: MotionOperation): MotionRun => ({
  token: "run-1",
  generation: 1,
  operation,
  spring: SPRING,
  ...(operation === "maximize" || operation === "unmaximize"
    ? { destinationBitmap: bitmap(), to: { x: 0, y: 0, width: 1920, height: 1040 } }
    : {}),
});

// Approved 2026-10-23 refinement: non-close desktop travel is 10% shorter; close is unchanged.
const DEFAULT_MS: Record<MotionOperation, number> = {
  startup: 225,
  close: 150,
  minimize: 225,
  restore: 225,
  maximize: 90,
  unmaximize: 90,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("refined desktop motion durations", () => {
  const entries = Object.entries(DEFAULT_MS) as Array<[MotionOperation, number]>;
  for (const [operation, duration] of entries) {
    it(`finishes ${operation} at its declared default duration (${duration}ms)`, () => {
      const fixture = setup();
      fixture.prepare(prepare());
      fixture.run(run(operation));
      expect(fixture.pending()).toBe(1);
      fixture.tick(1000);
      fixture.tick(1000 + duration - 1);
      expect(fixture.pending()).toBe(1);
      expect(fixture.replies.at(-1)?.kind).toBe("ready");
      fixture.tick(1000 + duration);
      expect(fixture.pending()).toBe(0);
      expect(fixture.replies.at(-1)).toEqual({ token: "run-1", generation: 1, kind: "done" });
    });
  }

  it("keeps the bounded close budget and explicit close duration unchanged", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/desktop/window-motion.ts"),
      "utf8",
    );
    expect(source).toContain("const CLOSE_ANIMATION_DURATION_MS = 150;");
    expect(source).toContain("const CLOSE_MAX_WAIT_MS = 500;");
  });
});

describe("refined finite UI motion tokens", () => {
  const css = readFileSync(path.resolve(process.cwd(), "src/web/styles.css"), "utf8");
  const duration = (name: string) => {
    const match = css.match(new RegExp(`--${name}:\\s*([0-9.]+)ms;`));
    if (!match) throw new Error(`missing duration token --${name}`);
    return Number(match[1]);
  };

  it("declares 10% shorter finite durations while keeping the token hierarchy", () => {
    expect(duration("motion-fast")).toBe(108);
    expect(duration("motion-base")).toBe(144);
    expect(duration("motion-slow")).toBe(216);
    expect(duration("motion-expand")).toBe(180);
    expect(duration("motion-fast")).toBeLessThan(duration("motion-base"));
    expect(duration("motion-base")).toBeLessThan(duration("motion-slow"));
  });

  it("preserves the shared curves and the sheet enter/exit ratio", () => {
    expect(css).toContain("--ease-standard: cubic-bezier(0.16, 1, 0.3, 1);");
    expect(css).toContain("--ease-exit: cubic-bezier(0.4, 0, 1, 1);");
    // sheet.tsx enters on --motion-slow and exits on --motion-base; 216/144 keeps 1.5.
    expect(duration("motion-slow") / duration("motion-base")).toBe(1.5);
  });

  it("routes default-duration transitions through the same refinement", () => {
    // Hover/focus utilities without a duration utility resolve this theme value.
    expect(css).toContain("--default-transition-duration: 135ms;");
  });
});

describe("shared finite UI motion configuration", () => {
  it("renders the design system with a 144ms finite default and user reduced motion", () => {
    const element = DesignSystemProvider({ children: createElement("span", null, "probe") });
    const props = element.props as {
      reducedMotion?: unknown;
      transition?: { duration?: unknown; ease?: unknown };
    };
    // Assert the provider's actual MotionConfig element, not a source-text match.
    expect(element.type).toBe(MotionConfig);
    expect(props.transition).toEqual({ duration: 0.144, ease: "easeOut" });
    expect(props.reducedMotion).toBe("user");
    render(element);
    expect(screen.getByText("probe")).toBeTruthy();
    cleanup();
  });
});
