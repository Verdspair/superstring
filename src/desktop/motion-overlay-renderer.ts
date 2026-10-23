import type {
  MotionBitmap,
  MotionPrepare,
  MotionRect,
  MotionReply,
  MotionRun,
} from "../shared/window-motion";

export interface MotionSurface {
  onPrepare(listener: (payload: MotionPrepare) => void): void;
  onRun(listener: (payload: MotionRun) => void): void;
  reply(message: MotionReply): void;
}

interface MotionRenderer {
  gl: WebGLRenderingContext;
  uniforms: Record<string, WebGLUniformLocation | null>;
  textures: [WebGLTexture, WebGLTexture];
  count: number;
}

// Run beside ipcRenderer in the sandbox's isolated world: bitmap bytes cross IPC only once.
export function startMotionRenderer(bridge: MotionSurface): void {
  const canvas = document.getElementById("surface");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("MOTION_CANVAS_UNAVAILABLE");
  const MESH_ROWS = 96;
  const MESH_COLUMNS = 32;
  // Initial event profiles, not timings measured from macOS.
  const DURATIONS = {
    startup: 225,
    close: 150,
    minimize: 225,
    restore: 225,
    maximize: 90,
    unmaximize: 90,
  };
  let prepared: { payload: Omit<MotionPrepare, "bitmap">; ready: boolean } | null = null;
  // Decode, upload and animation callbacks all belong to one PREPARE/RUN epoch.
  let epoch = 0;
  let raf = 0;
  let renderer: MotionRenderer;
  let rendererError: string | null = null;
  let sourceCornerAlpha = false;
  const reply = (
    message: Pick<MotionReply, "token" | "generation">,
    kind: MotionReply["kind"],
    detail?: string,
  ) => {
    const body: MotionReply = { token: message.token, generation: message.generation, kind };
    if (detail !== undefined) body.message = detail;
    bridge.reply(body);
  };
  const cancel = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };
  const local = (
    rect: MotionRect,
    payload: MotionPrepare | Omit<MotionPrepare, "bitmap">,
  ): MotionRect => ({
    x: rect.x - payload.origin.x,
    y: rect.y - payload.origin.y,
    width: rect.width,
    height: rect.height,
  });
  const rectArray = (rect: MotionRect) => [rect.x, rect.y, rect.width, rect.height];
  const q = (value: number) => {
    const x = Math.min(1, Math.max(0, value));
    return x * x * x * (x * (x * 6 - 15) + 10);
  };
  const mix = (a: number, b: number, p: number) => a + (b - a) * p;
  const interpolate = (a: MotionRect, b: MotionRect, p: number): MotionRect => ({
    x: mix(a.x, b.x, p),
    y: mix(a.y, b.y, p),
    width: mix(a.width, b.width, p),
    height: mix(a.height, b.height, p),
  });

  try {
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
    });
    if (!gl) throw new Error("MOTION_WEBGL_UNAVAILABLE");
    const vertexSource = `precision highp float;
attribute vec2 a;
uniform vec2 R;
uniform vec4 A;
uniform vec4 F;
uniform vec4 C;
uniform vec2 E;
uniform vec3 G;
uniform float P;
uniform float M;
varying vec2 uv;
varying vec2 pixel;
float q(float x){float t=clamp(x,0.,1.);return t*t*t*(t*(t*6.-15.)+10.);}
void main(){
  float row=1.-a.y;
  vec2 point=vec2(C.x+a.x*C.z,C.y+row*C.w);
  if(M>.5&&M<1.5){
    // A is the target and F the full surface. Rotate the field toward any taskbar edge.
    vec2 axis=E;
    float horizontal=abs(axis.x);
    vec2 crossAxis=horizontal>.5?vec2(0.,1.):vec2(1.,0.);
    vec2 fc=F.xy+F.zw*.5;
    vec2 ac=A.xy+A.zw*.5;
    float fh=dot(abs(axis),F.zw),ah=dot(abs(axis),A.zw);
    float fw=dot(crossAxis,F.zw),aw=dot(crossAxis,A.zw);
    float ftop=dot(fc,axis)-fh*.5,atop=dot(ac,axis)-ah*.5;
    float fbottom=ftop+fh,abottom=atop+ah;
    float curve=G.z;
    float v=horizontal>.5?(axis.x>0.?a.x:1.-a.x):(axis.y>0.?row:1.-row);
    float across=horizontal>.5?row:a.x;
    float y=mix(mix(ftop,atop,G.x),mix(fbottom,abottom,G.y),v);
    float span=max(1.,atop-ftop);
    float bend=curve*q((y-ftop)/span);
    float center=mix(dot(fc,crossAxis),dot(ac,crossAxis),bend);
    point=axis*y+crossAxis*(center+(across-.5)*mix(fw,aw,bend));
  }else if(M>1.5&&M<2.5){
    // Startup extracts immediately; the displaced origin prevents a centered funnel.
    float lift=1.-pow(1.-P,2.1);
    float top=mix(A.y,F.y,lift);
    float bottom=mix(A.y+A.w,F.y+F.w,q(P));
    float opened=mix(q(P/.52),q((P-.34)/.66),q(row));
    float left=mix(A.x,F.x,opened),right=mix(A.x+A.z,F.x+F.z,opened);
    point=vec2(mix(left,right,a.x),mix(top,bottom,row));
  }
  uv=a;
  pixel=point;
  gl_Position=vec4(point.x/R.x*2.-1.,1.-point.y/R.y*2.,0.,1.);
}`;
    const fragmentSource = `precision highp float;
uniform sampler2D T;
uniform sampler2D D;
uniform vec4 A;
uniform vec4 F;
uniform vec4 C;
uniform vec4 B;
uniform float P;
uniform float M;
uniform float O;
varying vec2 uv;
varying vec2 pixel;
float q(float x){float t=clamp(x,0.,1.);return t*t*t*(t*(t*6.-15.)+10.);}
vec4 nativePixel(sampler2D image,vec2 at,vec2 size,vec4 background){
  if(at.x<0.||at.y<0.||at.x>=size.x||at.y>=size.y)return background;
  return texture2D(image,vec2(at.x/size.x,1.-at.y/size.y));
}
void main(){
  if(pixel.x<B.x||pixel.y<B.y||pixel.x>B.x+B.z||pixel.y>B.y+B.w)discard;
  vec4 color;
  if(M>2.5&&M<3.5){
    vec2 at=pixel-C.xy;
    vec4 source=nativePixel(T,pixel-A.xy,A.zw,vec4(0.));
    vec4 destination=nativePixel(D,at,F.zw,vec4(0.));
    if(P<=0.){
      color=texture2D(T,uv);
    }else if(P>=1.){
      color=texture2D(D,uv);
    }else{
      // Keep native corner distances while moving only the current outer contour.
      vec2 edge=min(at,C.zw-at);
      vec2 sourceEdge=min(edge,A.zw*.5);
      vec2 targetEdge=min(edge,F.zw*.5);
      vec2 sourceAt=vec2(at.x<C.z*.5?sourceEdge.x:A.z-sourceEdge.x,
        at.y<C.w*.5?sourceEdge.y:A.w-sourceEdge.y);
      vec2 targetAt=vec2(at.x<C.z*.5?targetEdge.x:F.z-targetEdge.x,
        at.y<C.w*.5?targetEdge.y:F.w-targetEdge.y);
      float sourceOutline=nativePixel(T,sourceAt,A.zw,vec4(0.)).a;
      float targetOutline=nativePixel(D,targetAt,F.zw,vec4(0.)).a;
      float outline=mix(sourceOutline,targetOutline,q(P));
      // Composite only alpha-missing destination content, not two complete layouts.
      float coverage=destination.a+source.a*(1.-destination.a);
      vec3 rgb=coverage>0.?(destination.rgb*destination.a+
        source.rgb*source.a*(1.-destination.a))/coverage:vec3(0.);
      color=vec4(rgb,outline);
    }
  }else if(M>3.5){
    vec2 at=pixel-F.xy;
    color=nativePixel(T,at,F.zw,vec4(0.));
  }else{color=texture2D(T,uv);}
  gl_FragColor=color*vec4(1.,1.,1.,O);
}`;
    const shader = (type: number, source: string) => {
      const value = gl.createShader(type);
      if (!value) throw new Error("MOTION_SHADER_UNAVAILABLE");
      gl.shaderSource(value, source);
      gl.compileShader(value);
      if (!gl.getShaderParameter(value, gl.COMPILE_STATUS)) {
        const detail = gl.getShaderInfoLog(value);
        gl.deleteShader(value);
        throw new Error(detail || "MOTION_SHADER_COMPILE_FAILED");
      }
      return value;
    };
    const program = gl.createProgram();
    if (!program) throw new Error("MOTION_PROGRAM_UNAVAILABLE");
    const vertex = shader(gl.VERTEX_SHADER, vertexSource);
    const fragment = shader(gl.FRAGMENT_SHADER, fragmentSource);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program) || "MOTION_PROGRAM_LINK_FAILED");
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram is not a React hook.
    gl.useProgram(program);
    const vertices: number[] = [],
      indices: number[] = [];
    for (let row = 0; row <= MESH_ROWS; row++)
      for (let column = 0; column <= MESH_COLUMNS; column++)
        vertices.push(column / MESH_COLUMNS, row / MESH_ROWS);
    for (let row = 0; row < MESH_ROWS; row++) {
      for (let column = 0; column < MESH_COLUMNS; column++) {
        const start = row * (MESH_COLUMNS + 1) + column;
        const below = start + MESH_COLUMNS + 1;
        indices.push(start, start + 1, below, start + 1, below + 1, below);
      }
    }
    const vertexBuffer = gl.createBuffer(),
      indexBuffer = gl.createBuffer();
    if (!vertexBuffer || !indexBuffer) throw new Error("MOTION_GPU_RESOURCE_UNAVAILABLE");
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
    const attribute = gl.getAttribLocation(program, "a");
    gl.enableVertexAttribArray(attribute);
    gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    const textures = [0, 1].map((unit) => {
      const texture = gl.createTexture();
      if (!texture) throw new Error("MOTION_GPU_RESOURCE_UNAVAILABLE");
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(4),
      );
      return texture;
    });
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const uniforms: MotionRenderer["uniforms"] = {};
    for (const name of ["R", "A", "F", "C", "B", "E", "G", "P", "M", "O", "T", "D"])
      uniforms[name] = gl.getUniformLocation(program, name);
    gl.uniform1i(uniforms.T, 0);
    gl.uniform1i(uniforms.D, 1);
    renderer = { gl, uniforms, textures: [textures[0], textures[1]], count: indices.length };
  } catch (error) {
    rendererError = String(error);
  }

  const bitmapPixels = (bitmap: MotionBitmap, requireCornerAlpha = false) => {
    if (
      !bitmap ||
      !Number.isInteger(bitmap.width) ||
      !Number.isInteger(bitmap.height) ||
      bitmap.width <= 0 ||
      bitmap.height <= 0 ||
      !(bitmap.pixels instanceof Uint8Array) ||
      bitmap.pixels.byteLength !== bitmap.width * bitmap.height * 4
    )
      throw new Error("MOTION_BITMAP_INVALID");
    const { width, height, pixels } = bitmap;
    const f = Math.fround,
      byteScale = f(1 / 255);
    // Match the PNG path's float32 unpremultiply and nearest-even byte rounding.
    const channel = (value: number, inverseAlpha: number) => {
      const scaled = Math.min(255, Math.max(0, f(f(f(value * byteScale) * inverseAlpha) * 255)));
      const integer = Math.floor(scaled),
        fraction = scaled - integer;
      return integer + (fraction > 0.5 || (fraction === 0.5 && integer % 2 === 1) ? 1 : 0);
    };
    const left = new Uint32Array(requireCornerAlpha ? height : 0);
    const right = new Uint32Array(requireCornerAlpha ? height : 0);
    let cornerAlpha = true;
    let alphaRow = -1,
      rightStarted = false,
      lastAlphaX = -1;
    for (let i = 0; i < pixels.length; i += 4) {
      const b = pixels[i],
        g = pixels[i + 1],
        r = pixels[i + 2],
        a = pixels[i + 3];
      if (a === 255) {
        pixels[i] = r;
        pixels[i + 2] = b;
        continue;
      }
      if (requireCornerAlpha) {
        const index = i / 4,
          x = index % width,
          y = Math.floor(index / width);
        if (y !== alphaRow) {
          if (rightStarted && lastAlphaX !== width - 1) cornerAlpha = false;
          alphaRow = y;
          rightStarted = false;
          lastAlphaX = -1;
        }
        if (!rightStarted && x === left[y]) left[y]++;
        else {
          if (rightStarted && x !== lastAlphaX + 1) cornerAlpha = false;
          rightStarted = true;
          right[y]++;
          lastAlphaX = x;
        }
      }
      if (a === 0) {
        pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
        continue;
      }
      const inverseAlpha = f(1 / f(a * byteScale));
      pixels[i] = channel(r, inverseAlpha);
      pixels[i + 1] = channel(g, inverseAlpha);
      pixels[i + 2] = channel(b, inverseAlpha);
    }
    if (rightStarted && lastAlphaX !== width - 1) cornerAlpha = false;
    if (requireCornerAlpha) {
      const middle = Math.floor(height / 2);
      for (const edges of [left, right]) {
        if (edges[middle] !== 0) cornerAlpha = false;
        for (let y = 0; y < height; y++) {
          if (edges[y] >= width / 2) cornerAlpha = false;
          if (y > 0 && y <= middle && edges[y] > edges[y - 1]) cornerAlpha = false;
          if (y > middle && edges[y] < edges[y - 1]) cornerAlpha = false;
        }
      }
      // The caller decides whether this operation requires an opaque client silhouette.
    }
    // Physical row order must match Image upload; a shader UV flip changes filtered pixels.
    const rowBytes = width * 4,
      row = new Uint8Array(rowBytes);
    for (let y = 0; y < Math.floor(height / 2); y++) {
      const top = y * rowBytes,
        bottom = (height - 1 - y) * rowBytes;
      row.set(pixels.subarray(top, top + rowBytes));
      pixels.copyWithin(top, bottom, bottom + rowBytes);
      pixels.set(row, bottom);
    }
    return { pixels, cornerAlpha };
  };
  const upload = (unit: number, bitmap: MotionBitmap, requireCornerAlpha = false) => {
    const { gl, textures } = renderer;
    if (gl.isContextLost()) throw new Error("MOTION_WEBGL_CONTEXT_LOST");
    const { pixels, cornerAlpha } = bitmapPixels(bitmap, requireCornerAlpha);
    if (requireCornerAlpha && unit === 1 && !cornerAlpha)
      throw new Error("MOTION_BITMAP_NON_CORNER_ALPHA");
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, textures[unit]);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      bitmap.width,
      bitmap.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error("MOTION_WEBGL_UPLOAD_" + error);
    return cornerAlpha;
  };
  const makeTrack = (knots: Array<[number, number]>, travel: number) => {
    const count = knots.length;
    const points = knots.map(([time, value]) => [time / 500, value / travel]);
    const intervals: number[] = [],
      slopes: number[] = [],
      tangents = new Float64Array(count);
    for (let i = 0; i < count - 1; i++) {
      const interval = points[i + 1][0] - points[i][0];
      intervals.push(interval);
      slopes.push((points[i + 1][1] - points[i][1]) / interval);
    }
    for (let i = 1; i < count - 1; i++) {
      if (slopes[i - 1] > 0 && slopes[i] > 0) {
        const left = 2 * intervals[i] + intervals[i - 1];
        const right = intervals[i] + 2 * intervals[i - 1];
        tangents[i] = (left + right) / (left / slopes[i - 1] + right / slopes[i]);
      }
    }
    return (progress: number) => {
      if (progress <= 0) return points[0][1];
      if (progress >= 1) return points[count - 1][1];
      let i = 0;
      while (points[i + 1][0] < progress) i++;
      const u = (progress - points[i][0]) / intervals[i],
        u2 = u * u,
        u3 = u2 * u;
      return (
        (2 * u3 - 3 * u2 + 1) * points[i][1] +
        (u3 - 2 * u2 + u) * intervals[i] * tangents[i] +
        (-2 * u3 + 3 * u2) * points[i + 1][1] +
        (u3 - u2) * intervals[i] * tangents[i + 1]
      );
    };
  };
  // Reference active-PTS displacements, normalized to the actual taskbar-facing span.
  // The final lower-edge landing and bend values are fitted estimates, not exact contours.
  const topProgress = makeTrack(
    [
      [0, 0],
      [100, 0],
      [116.667, 13],
      [150, 92],
      [183.334, 151],
      [216.667, 318],
      [233.334, 408],
      [300, 774],
      [316.667, 905],
      [333.334, 1034],
      [383.334, 1332],
      [433.334, 1492],
      [483.334, 1616],
      [500, 1666],
    ],
    1666,
  );
  const bottomProgress = makeTrack(
    [
      [0, 0],
      [100, 0],
      [116.667, 12],
      [150, 91],
      [183.334, 151],
      [216.667, 267],
      [300, 372],
      [500, 372],
    ],
    372,
  );
  const bendProgress = makeTrack(
    [
      [0, 0],
      [16.667, 0.027],
      [33.334, 0.1],
      [66.667, 0.2],
      [100, 0.49],
      [116.667, 0.63],
      [150, 0.85],
      [183.334, 1],
      [500, 1],
    ],
    1,
  );
  const targetAxis = (target: MotionRect, boundary: MotionRect) => {
    // The taskbar edge, not the offset between window and icon centers, owns the axis.
    const edges = [
      { distance: Math.abs(target.x - boundary.x), axis: [-1, 0] },
      { distance: Math.abs(boundary.x + boundary.width - target.x - target.width), axis: [1, 0] },
      { distance: Math.abs(target.y - boundary.y), axis: [0, -1] },
      { distance: Math.abs(boundary.y + boundary.height - target.y - target.height), axis: [0, 1] },
    ];
    return edges.reduce((nearest, edge) => (edge.distance < nearest.distance ? edge : nearest))
      .axis;
  };
  const draw = (
    rect: MotionRect,
    boundary: MotionRect,
    a: MotionRect,
    f: MotionRect,
    progress = 0,
    mode = 0,
    opacity = 1,
    axis = [0, 1],
  ) => {
    const { gl, uniforms, count } = renderer;
    if (gl.isContextLost()) throw new Error("MOTION_WEBGL_CONTEXT_LOST");
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform4fv(uniforms.C, rectArray(rect));
    gl.uniform4fv(uniforms.B, rectArray(boundary));
    gl.uniform4fv(uniforms.A, rectArray(a));
    gl.uniform4fv(uniforms.F, rectArray(f));
    gl.uniform2fv(uniforms.E, axis);
    gl.uniform3f(
      uniforms.G,
      topProgress(progress),
      bottomProgress(progress),
      bendProgress(progress),
    );
    gl.uniform1f(uniforms.P, progress);
    gl.uniform1f(uniforms.M, mode);
    gl.uniform1f(uniforms.O, opacity);
    gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
  };

  bridge.onPrepare(({ bitmap, ...payload }) => {
    const prepareEpoch = ++epoch;
    cancel();
    const entry = { payload, ready: false };
    prepared = entry;
    if (rendererError) {
      reply(payload, "error", rendererError);
      return;
    }
    try {
      const { gl, uniforms } = renderer;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
      canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.R, window.innerWidth, window.innerHeight);
      if (prepared !== entry || prepareEpoch !== epoch) return;
      sourceCornerAlpha = upload(0, bitmap, true);
      const from = local(payload.from, payload);
      draw(from, local(payload.boundary, payload), from, from);
      entry.ready = true;
      reply(payload, "ready");
    } catch (error) {
      if (prepared !== entry || prepareEpoch !== epoch) return;
      reply(payload, "error", String(error));
    }
  });

  bridge.onRun(({ destinationBitmap, ...run }) => {
    if (!prepared || prepared.payload.generation !== run.generation) {
      reply(run, "error", "MOTION_RUN_WITHOUT_PREPARE");
      return;
    }
    if (!prepared.ready) {
      reply(run, "error", "MOTION_PREPARE_NOT_READY");
      return;
    }
    if (!Object.hasOwn(DURATIONS, run.operation)) {
      reply(run, "error", "MOTION_OPERATION_INVALID");
      return;
    }
    const spring = run.spring;
    if (
      !spring ||
      !Number.isFinite(spring.stiffness) ||
      !Number.isFinite(spring.damping) ||
      !Number.isFinite(spring.mass) ||
      spring.mass <= 0
    ) {
      reply(run, "error", "MOTION_SPRING_INVALID");
      return;
    }
    const duration = run.durationMs ?? DURATIONS[run.operation];
    if (!Number.isFinite(duration) || duration <= 0) {
      reply(run, "error", "MOTION_DURATION_INVALID");
      return;
    }
    const bounds = run.operation === "maximize" || run.operation === "unmaximize";
    if (bounds && (!destinationBitmap || typeof destinationBitmap !== "object")) {
      reply(run, "error", "MOTION_DESTINATION_REQUIRED");
      return;
    }
    cancel();
    const entry = prepared,
      runEpoch = ++epoch;
    const from = local(entry.payload.from, entry.payload);
    const to = local(run.to ?? entry.payload.to, entry.payload);
    const boundary = local(entry.payload.boundary, entry.payload);
    const sheetAxis = targetAxis(run.operation === "restore" ? from : to, boundary);
    const current = () => prepared === entry && runEpoch === epoch;
    const fail = (error: unknown) => {
      if (!current()) return;
      cancel();
      reply(run, "error", String(error));
    };
    const frame = (p: number) => {
      if (bounds) {
        draw(interpolate(from, to, q(p)), boundary, from, to, p, 3);
      } else if (run.operation === "minimize" || run.operation === "restore") {
        const restore = run.operation === "restore";
        const collapse = restore ? 1 - p : p;
        draw(from, boundary, restore ? from : to, restore ? to : from, collapse, 1, 1, sheetAxis);
      } else if (run.operation === "startup") {
        draw(from, boundary, from, to, p, 2);
      } else {
        const travel = q(p),
          height = from.height * (1 - q((p - 0.18) / 0.82));
        const clip = {
          x: from.x,
          y: from.y + 10 * travel + (from.height - height) * 0.53,
          width: from.width,
          height,
        };
        const source = { ...from, y: from.y + 10 * travel };
        draw(clip, boundary, from, source, p, 4, 1 - q((p - 0.28) / 0.72));
      }
    };
    const begin = () => {
      if (!current()) return;
      let started: number | null = null;
      const tick = (now: number) => {
        if (!current()) return;
        try {
          if (started === null) started = now;
          const p = Math.min(1, (now - started) / duration);
          frame(p);
          if (p >= 1) {
            cancel();
            reply(run, "done");
          } else raf = requestAnimationFrame(tick);
        } catch (error) {
          fail(error);
        }
      };
      try {
        if (run.reducedMotion) {
          frame(1);
          reply(run, "done");
          return;
        }
        frame(0);
        raf = requestAnimationFrame(tick);
      } catch (error) {
        fail(error);
      }
    };
    if (bounds) {
      // Upload the destination without clearing or re-preparing the source cover.
      try {
        if (!current()) return;
        if (!destinationBitmap) throw new Error("MOTION_DESTINATION_REQUIRED");
        if (!sourceCornerAlpha) throw new Error("MOTION_BITMAP_NON_CORNER_ALPHA");
        upload(1, destinationBitmap, true);
        destinationBitmap = undefined;
        begin();
      } catch (error) {
        fail(error);
      }
    } else begin();
  });
}
