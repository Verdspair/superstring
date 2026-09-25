import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "bun";
import { spawn } from "bun";
import { bindWithDesktopFallback, DESKTOP_PORT_MESSAGE } from "../../src/server/dev-config";
import { MODE_IDS, THEME_IDS } from "../../src/shared/appearance";

type TestWsData = { alive: boolean };

import {
  createDesktopLifecycle,
  desktopDisabledResponse,
  injectDesktopMeta,
  isDesktopToken,
} from "../../src/server/desktop-lifecycle";

const TOKEN = "a".repeat(64);
const BAD_TOKEN = "b".repeat(64);

/** Deterministic virtual clock so timing tests never flake on real timers. */
class FakeTimers {
  now = 0;
  private seq = 0;
  private tasks = new Map<number, { fn: () => void; at: number }>();
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.tasks.set(id, { fn, at: this.now + ms });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.tasks.delete(handle as number);
  };
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let next: { id: number; at: number } | null = null;
      for (const [id, t] of this.tasks) {
        if (t.at <= target && (next === null || t.at < next.at)) next = { id, at: t.at };
      }
      if (next === null) break;
      this.now = next.at;
      const task = this.tasks.get(next.id);
      if (!task) continue;
      this.tasks.delete(next.id);
      task.fn();
    }
    this.now = target;
  }
}

/** Flush the microtask queued by triggerStop's `Promise.resolve().then(onStop)`. */
const flush = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

interface FakeWs {
  data: { alive: boolean };
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let lifecycle: ReturnType<typeof createDesktopLifecycle>;
let timers: FakeTimers;
let stopped: number;
/** The stored §12 preference the lifecycle reads when the last page closes. */
let closePreference: "background" | "exit";

/** Loosely-typed view of the WebSocket handler (bun's handler arity differs). */
function wsApi(): {
  open: (ws: unknown) => void;
  close: (ws: unknown) => void;
  pong: (ws: unknown) => void;
  message: (ws: unknown, message: unknown) => void;
} {
  return lifecycle.websocket as unknown as {
    open: (ws: unknown) => void;
    close: (ws: unknown) => void;
    pong: (ws: unknown) => void;
    message: (ws: unknown, message: unknown) => void;
  };
}

function makeFakeWs(autoPong = true): FakeWs {
  const ws: FakeWs = {
    data: { alive: true },
    ping: vi.fn(function (this: FakeWs) {
      // A real browser answers every server ping with a pong automatically.
      if (autoPong) wsApi().pong(this);
    }),
    terminate: vi.fn(function (this: FakeWs) {
      wsApi().close(this);
    }),
    close: vi.fn(),
  };
  return ws;
}

function buildLifecycle(overrides: Record<string, number> = {}): void {
  timers = new FakeTimers();
  stopped = 0;
  closePreference = "exit";
  lifecycle = createDesktopLifecycle({
    token: TOKEN,
    host: "127.0.0.1",
    port: 17861,
    onStop: () => {
      stopped++;
    },
    closeAction: () => closePreference,
    graceMs: overrides.graceMs ?? 40,
    startupWindowMs: overrides.startupWindowMs ?? 120,
    pingIntervalMs: overrides.pingIntervalMs ?? 10,
    pongTimeoutMs: overrides.pongTimeoutMs ?? 15,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });
}

const fakeServer = { upgrade: () => false } as unknown as Server<TestWsData>;

// The control surface answers either with a Response or by upgrading the socket;
// these tests always expect the Response branch, so failing loudly beats `!`.
function responseOf(result: { response?: Response }): Response {
  if (!result.response) throw new Error("desktop control returned no response");
  return result.response;
}

function status(token: string | null): Response {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return responseOf(
    lifecycle.handle(
      new Request("http://127.0.0.1:17861/__desktop/status", { headers }),
      fakeServer,
    ),
  );
}

describe("desktop port fallback", () => {
  it("keeps the preferred port on success", () => {
    const bind = vi.fn((port: number) => port);
    expect(bindWithDesktopFallback(17861, true, bind)).toBe(17861);
    expect(bind).toHaveBeenCalledTimes(1);
  });
  it("retries address-in-use and access-denied once with OS assignment", () => {
    for (const code of ["EADDRINUSE", "EACCES"]) {
      const ports: number[] = [];
      expect(
        bindWithDesktopFallback(17861, true, (port) => {
          ports.push(port);
          if (port) throw Object.assign(new Error(code), { code });
          return 24567;
        }),
      ).toBe(24567);
      expect(ports).toEqual([17861, 0]);
    }
  });
  it("does not mask non-desktop, unrelated, or fallback failures", () => {
    for (const [enabled, code] of [
      [false, "EADDRINUSE"],
      [true, "EINVAL"],
    ] as const) {
      const error = Object.assign(new Error(code), { code });
      const bind = vi.fn(() => {
        throw error;
      });
      expect(() => bindWithDesktopFallback(17861, enabled, bind)).toThrow(error);
      expect(bind).toHaveBeenCalledTimes(1);
    }
    const bind = vi.fn(() => {
      throw Object.assign(new Error("occupied"), { code: "EADDRINUSE" });
    });
    expect(() => bindWithDesktopFallback(17861, true, bind)).toThrow("occupied");
    expect(bind).toHaveBeenCalledTimes(2);
  });
});

describe("desktop token validation", () => {
  it("enables only on a 64-hex token", () => {
    expect(isDesktopToken("a".repeat(64))).toBe(true);
    expect(isDesktopToken("a".repeat(63))).toBe(false);
    expect(isDesktopToken("z".repeat(64))).toBe(false);
    expect(isDesktopToken(undefined)).toBe(false);
    expect(isDesktopToken("")).toBe(false);
  });
});

describe("desktop control surface (unit, deterministic clock)", () => {
  beforeEach(() => buildLifecycle());

  it("status requires a Bearer token and never echoes it", async () => {
    expect((await status(null)).status).toBe(401);
    expect((await status(BAD_TOKEN)).status).toBe(401);
    const ok = await status(TOKEN);
    expect(ok.status).toBe(200);
    const body = await ok.json();
    // The two extra fields are what the desktop host needs for §12's dialog: whether a page is
    // currently connected, and what the stored preference is. Adding them must not break the
    // launcher's identity check, which reads only app/desktop/state (Readiness.IsIdentityReady).
    expect(body).toEqual({
      app: "superstring",
      desktop: true,
      state: "ready",
      page_connections: 0,
      background_online: false,
      close_action: "exit",
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain(TOKEN);
  });

  it("stop requires the token then triggers shutdown", async () => {
    const missing = await lifecycle.handle(
      new Request("http://127.0.0.1:17861/__desktop/stop", { method: "POST" }),
      fakeServer,
    );
    expect(responseOf(missing).status).toBe(401);
    const wrong = await lifecycle.handle(
      new Request("http://127.0.0.1:17861/__desktop/stop", {
        method: "POST",
        headers: { authorization: `Bearer ${BAD_TOKEN}` },
      }),
      fakeServer,
    );
    expect(responseOf(wrong).status).toBe(401);
    const ok = await lifecycle.handle(
      new Request("http://127.0.0.1:17861/__desktop/stop", {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      fakeServer,
    );
    expect(responseOf(ok).status).toBe(200);
    expect(await responseOf(ok).json()).toEqual({ ok: true });
    await flush();
    expect(stopped).toBe(1);
  });

  it("rejects a non-POST stop with 405", async () => {
    const res = await lifecycle.handle(
      new Request("http://127.0.0.1:17861/__desktop/stop", {
        method: "GET",
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
      fakeServer,
    );
    expect(responseOf(res).status).toBe(405);
  });

  it("rejects a cross-site / missing Origin on the lifetime WS (never upgrades)", async () => {
    const evil = await lifecycle.handle(
      new Request("http://127.0.0.1:17861/__desktop/lifetime", {
        headers: { origin: "http://evil.example", upgrade: "websocket" },
      }),
      fakeServer,
    );
    expect(responseOf(evil).status).toBe(403);
    const missing = await lifecycle.handle(
      new Request("http://127.0.0.1:17861/__desktop/lifetime", {
        headers: { upgrade: "websocket" },
      }),
      fakeServer,
    );
    expect(responseOf(missing).status).toBe(403);
    const wrongPort = await lifecycle.handle(
      new Request("http://127.0.0.1:17861/__desktop/lifetime", {
        headers: { origin: "http://127.0.0.1:9999", upgrade: "websocket" },
      }),
      fakeServer,
    );
    expect(responseOf(wrongPort).status).toBe(403);
  });

  it("upgrades only when Origin exactly matches http://127.0.0.1:PORT", async () => {
    const upgrader = { upgrade: vi.fn(() => true) } as unknown as Server<TestWsData>;
    const res = await lifecycle.handle(
      new Request("http://127.0.0.1:17861/__desktop/lifetime", {
        headers: { origin: "http://127.0.0.1:17861", upgrade: "websocket" },
      }),
      upgrader,
    );
    expect(res.upgraded).toBe(true);
    expect(
      (upgrader as unknown as { upgrade: ReturnType<typeof vi.fn> }).upgrade,
    ).toHaveBeenCalled();
  });

  it("last connection close starts the grace, then stops", async () => {
    const ws = makeFakeWs();
    wsApi().open(ws);
    lifecycle.start();
    timers.advance(200); // well past startup window, but a connection exists
    expect(stopped).toBe(0);
    wsApi().close(ws);
    expect(stopped).toBe(0); // grace pending
    timers.advance(40); // graceMs
    await flush();
    expect(stopped).toBe(1);
  });

  it("a new connection during the grace cancels shutdown (refresh safe)", async () => {
    const ws = makeFakeWs();
    wsApi().open(ws);
    wsApi().close(ws);
    timers.advance(10); // inside grace
    const ws2 = makeFakeWs();
    wsApi().open(ws2 as unknown as never); // refresh / restored tab
    timers.advance(40); // grace would have elapsed
    await flush();
    expect(stopped).toBe(0); // cancelled
    wsApi().close(ws2 as unknown as never);
    timers.advance(40);
    await flush();
    expect(stopped).toBe(1);
  });

  it("multiple pages: closing one of several does not stop", async () => {
    const a = makeFakeWs();
    const b = makeFakeWs();
    wsApi().open(a as unknown as never);
    wsApi().open(b as unknown as never);
    wsApi().close(a as unknown as never);
    timers.advance(40);
    await flush();
    expect(stopped).toBe(0);
    wsApi().close(b as unknown as never);
    timers.advance(40);
    await flush();
    expect(stopped).toBe(1);
  });

  it("startup window stops when nothing ever connects", async () => {
    lifecycle.start();
    timers.advance(120); // startupWindowMs
    await flush();
    expect(stopped).toBe(1);
  });

  it("the startup window is not affected by a stored background preference", async () => {
    // "Nobody ever came" is a failed launch, not a user asking to stay online: the window exists
    // to avoid a dangling process, so the preference does not lift it.
    closePreference = "background";
    lifecycle.start();
    timers.advance(120);
    await flush();
    expect(stopped).toBe(1);
  });

  it("keeps running when the stored preference says to stay in the background", async () => {
    closePreference = "background";
    const ws = makeFakeWs();
    wsApi().open(ws);
    lifecycle.start();
    timers.advance(200);
    wsApi().close(ws);
    // No grace is armed at all: the process stays up until someone stops it explicitly.
    timers.advance(10_000);
    await flush();
    expect(stopped).toBe(0);
    expect(lifecycle.pageConnections()).toBe(0);
    expect(lifecycle.backgroundOnline()).toBe(true);
  });

  it("leaves background mode when a page comes back, and stops on the next close", async () => {
    closePreference = "background";
    const first = makeFakeWs();
    wsApi().open(first);
    wsApi().close(first);
    expect(lifecycle.backgroundOnline()).toBe(true);
    const second = makeFakeWs();
    wsApi().open(second);
    expect(lifecycle.backgroundOnline()).toBe(false);
    // The preference is read per close, so a change in settings applies immediately.
    closePreference = "exit";
    wsApi().close(second);
    timers.advance(40);
    await flush();
    expect(stopped).toBe(1);
  });

  it("quits on an explicit exit frame, whatever the stored preference is", async () => {
    closePreference = "background";
    const ws = makeFakeWs();
    wsApi().open(ws);
    wsApi().message(ws, JSON.stringify({ exit: true }));
    await flush();
    expect(stopped).toBe(1);
  });

  it("ignores frames that are not exactly the exit request", async () => {
    const ws = makeFakeWs();
    wsApi().open(ws);
    for (const frame of [
      "not json",
      JSON.stringify({}),
      JSON.stringify({ exit: false }),
      JSON.stringify({ exit: true, extra: 1 }),
      JSON.stringify({ exit: "true" }),
      JSON.stringify(["exit"]),
      JSON.stringify({ type: "appearance", theme: "slate", mode: "light", exit: true }),
      "x".repeat(4096),
    ]) {
      wsApi().message(ws, frame);
    }
    await flush();
    expect(stopped).toBe(0);
  });

  it("server ping/pong detects a dead link and triggers the grace", async () => {
    const ws = makeFakeWs(false); // no pong -> dead link
    wsApi().open(ws);
    timers.advance(10); // first ping sent
    expect(ws.ping).toHaveBeenCalledTimes(1);
    // No pong: watchdog fires -> terminate -> close -> grace.
    timers.advance(15);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    timers.advance(40);
    await flush();
    expect(stopped).toBe(1);
  });

  it("a healthy (auto-pong) connection survives many ping cycles without stopping", async () => {
    const ws = makeFakeWs(true);
    wsApi().open(ws);
    timers.advance(200); // many ping/pong cycles
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(stopped).toBe(0);
    // Closing it then starts the grace and stops.
    wsApi().close(ws);
    timers.advance(40);
    await flush();
    expect(stopped).toBe(1);
  });
});

describe("desktop meta injection", () => {
  it("injects the desktop-mode meta once and is idempotent", () => {
    const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
    const out = injectDesktopMeta(html);
    expect(out).toContain('<meta name="desktop-mode" content="1" />');
    expect(injectDesktopMeta(out)).toBe(out);
  });
});

describe("normal (non-desktop) mode hides the control surface", () => {
  it("returns 404 for every /__desktop path", () => {
    expect(desktopDisabledResponse().status).toBe(404);
  });
});

// Real isolated process: spawns the actual server entry, :memory: DB, temp
// browser-state dir, so no real database or secrets are touched. -------------------
const PROJECT_ROOT = path.resolve(__dirname, "../..");
const SERVER_ENTRY = path.resolve(PROJECT_ROOT, "src/server/index.ts");

interface Spawned {
  port: number;
  child: ReturnType<typeof spawn>;
  token: string;
  base: string;
  dir: string;
  cleanup: () => void;
}

async function spawnServer(
  opts: { token?: string; port?: number; autoPort?: boolean } = {},
): Promise<Spawned> {
  const token = opts.token ?? "c".repeat(64);
  let port = opts.port ?? 20000 + Math.floor(Math.random() * 15000);
  const dir = mkdtempSync(path.join(tmpdir(), "superstring-desktop-"));
  const child = spawn([process.execPath, "run", SERVER_ENTRY], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      SUPERSTRING_DESKTOP_TOKEN: opts.token === undefined ? "" : token,
      SUPERSTRING_DESKTOP_AUTO_PORT: opts.autoPort ? "1" : "0",
      SUPERSTRING_DB_PATH: ":memory:",
      SUPERSTRING_SERVE_WEB: "1",
      SUPERSTRING_DEV_PORT: String(port),
    },
  });
  if (opts.autoPort) {
    let output = "";
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    const timeout = setTimeout(() => child.kill(), 20_000);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error(`No actual port reported: ${output}`);
        output += decoder.decode(value, { stream: true });
        const line = output
          .split(/\r?\n/)
          .slice(0, -1)
          .find((entry) => entry.startsWith(DESKTOP_PORT_MESSAGE));
        if (line) {
          port = Number(line.slice(DESKTOP_PORT_MESSAGE.length));
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(line);
          break;
        }
      }
    } finally {
      clearTimeout(timeout);
      reader.releaseLock();
    }
  }
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("server did not become ready in time");
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    port,
    child,
    token,
    base,
    dir,
    cleanup: () => {
      try {
        child.kill();
      } catch {
        // The owned test process may already have exited.
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows may still hold the cwd handle briefly; leave it. */
      }
    },
  };
}

describe("desktop lifecycle over a real isolated process", () => {
  let s: Spawned | null = null;
  afterEach(() => {
    s?.cleanup();
    s = null;
  });

  it("normal mode (no token) answers 404 on the control surface", async () => {
    s = await spawnServer({ token: undefined });
    const res = await fetch(`${s.base}/__desktop/status`);
    expect(res.status).toBe(404);
  }, 40_000);

  it("occupied preferred port selects a real free port, authenticates, keeps WS alive and stops only its service", async () => {
    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("unrelated"),
    });
    let ws: WebSocket | undefined;
    try {
      s = await spawnServer({ token: TOKEN, port: blocker.port, autoPort: true });
      expect(s.port).not.toBe(blocker.port);
      const auth = { authorization: `Bearer ${TOKEN}` };
      expect((await fetch(`${s.base}/__desktop/status`)).status).toBe(401);
      expect(await (await fetch(`${s.base}/__desktop/status`, { headers: auth })).json()).toEqual({
        app: "superstring",
        desktop: true,
        state: "ready",
        page_connections: 0,
        background_online: false,
        close_action: "exit",
      });
      ws = await openAppearanceWs(s.base);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      const wrongOrigin = await fetch(`${s.base}/__desktop/lifetime`, {
        headers: { origin: `http://127.0.0.1:${blocker.port}`, upgrade: "websocket" },
      });
      expect(wrongOrigin.status).toBe(403);
      expect(
        (await fetch(`${s.base}/__desktop/stop`, { method: "POST", headers: auth })).status,
      ).toBe(200);
      expect(await s.child.exited).toBe(0);
      expect(await (await fetch(`http://127.0.0.1:${blocker.port}/`)).text()).toBe("unrelated");
    } finally {
      ws?.close();
      blocker.stop(true);
    }
  }, 40_000);

  it("desktop auto mode reports the preferred port when it is free", async () => {
    s = await spawnServer({ token: TOKEN, autoPort: true });
    expect(
      (await fetch(`${s.base}/__desktop/status`, { headers: { authorization: `Bearer ${TOKEN}` } }))
        .status,
    ).toBe(200);
  }, 40_000);

  it("desktop mode: status auth and stop exit cleanly", async () => {
    s = await spawnServer({ token: TOKEN });
    // 401 without token
    expect((await fetch(`${s.base}/__desktop/status`)).status).toBe(401);
    // 401 wrong token
    const wrong = await fetch(`${s.base}/__desktop/status`, {
      headers: { authorization: `Bearer ${BAD_TOKEN}` },
    });
    expect(wrong.status).toBe(401);
    // 200 with token, correct body, no token echoed
    const ok = await fetch(`${s.base}/__desktop/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      app: "superstring",
      desktop: true,
      state: "ready",
      page_connections: 0,
      background_online: false,
      close_action: "exit",
    });

    // POST /__desktop/stop with token terminates the process.
    const stopRes = await fetch(`${s.base}/__desktop/stop`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(stopRes.status).toBe(200);

    const exited = await new Promise<boolean>((resolve) => {
      const t = setInterval(() => {
        if ((s as Spawned).child.killed || (s as Spawned).child.exitCode !== null) {
          clearInterval(t);
          resolve(true);
        }
      }, 100);
      setTimeout(() => {
        clearInterval(t);
        resolve(false);
      }, 5_000);
    });
    expect(exited).toBe(true);
    // Mark cleaned without re-killing.
    (s as Spawned).cleanup = () => {};
  }, 40_000);
});

// Appearance persistence over a real isolated process
// The desktop launcher reads cwd/artifacts/state/desktop-appearance.json to
// restore the chosen theme + mode. These tests spawn the actual server with a
// valid token, drive the liveness WebSocket, and assert the file on disk. The
// server cwd is a temp dir, so no real database, secret, or user preference is
// touched.

function openAppearanceWs(base: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // Bun's runtime supports custom handshake headers; DOM's declaration does not.
    const BunWebSocket = WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const ws = new BunWebSocket(`${base.replace(/^http/, "ws")}/__desktop/lifetime`, {
      headers: { Origin: base },
    });
    ws.onopen = () => resolve(ws);
    ws.onerror = (event) => reject(event);
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("desktop appearance persistence over a real isolated process", () => {
  let s: Spawned | null = null;
  afterEach(() => {
    s?.cleanup();
    s = null;
  });

  it("persists all 48 theme×mode combinations to artifacts/state/desktop-appearance.json", async () => {
    s = await spawnServer({ token: TOKEN });
    const ws = await openAppearanceWs(s.base);
    for (const theme of THEME_IDS) {
      for (const mode of MODE_IDS) {
        ws.send(JSON.stringify({ type: "appearance", theme, mode }));
        await sleep(3);
      }
    }
    await sleep(150);
    ws.close();
    const file = path.join(s.dir, "artifacts", "state", "desktop-appearance.json");
    expect(existsSync(file)).toBe(true);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw).toEqual({
      version: 1,
      theme: THEME_IDS[THEME_IDS.length - 1],
      mode: MODE_IDS[MODE_IDS.length - 1],
    });
  }, 40_000);

  it("ignores invalid / out-of-contract / oversized frames and writes nothing", async () => {
    s = await spawnServer({ token: TOKEN });
    const ws = await openAppearanceWs(s.base);
    ws.send("not json at all");
    ws.send(JSON.stringify({ type: "appearance", theme: "neon", mode: "light" }));
    ws.send(JSON.stringify({ type: "appearance", theme: "slate", mode: "bright" }));
    ws.send(
      JSON.stringify({ type: "appearance", theme: "slate", mode: "light", pad: "x".repeat(500) }),
    );
    await sleep(150);
    ws.close();
    // Every frame was rejected, so the repository never created the file.
    expect(existsSync(path.join(s.dir, "artifacts", "state", "desktop-appearance.json"))).toBe(
      false,
    );
  }, 40_000);

  it("recovers from a corrupt file and then persists a valid appearance", async () => {
    s = await spawnServer({ token: TOKEN });
    // Pre-seed a corrupt file before any write.
    const file = path.join(s.dir, "artifacts", "state", "desktop-appearance.json");
    // The server creates the dir lazily; ensure the parent exists for the seed.
    const seeded = path.join(s.dir, "artifacts", "state");
    mkdirSync(seeded, { recursive: true });
    writeFileSync(file, "corrupt{", "utf8");
    const ws = await openAppearanceWs(s.base);
    ws.send(JSON.stringify({ type: "appearance", theme: "jade", mode: "light" }));
    await sleep(150);
    ws.close();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      theme: "jade",
      mode: "light",
    });
  }, 40_000);

  it("non-desktop mode writes nothing to disk", async () => {
    s = await spawnServer({ token: undefined });
    await sleep(200);
    expect(existsSync(path.join(s.dir, "artifacts", "state", "desktop-appearance.json"))).toBe(
      false,
    );
  }, 40_000);
});
