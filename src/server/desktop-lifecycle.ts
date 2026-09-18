/**
 * Desktop-mode lifecycle controller.
 *
 * Desktop mode is enabled ONLY when the process is launched with a valid
 * `SUPERSTRING_DESKTOP_TOKEN` (64 hex chars). The desktop launcher generates
 * a token per launch and never shares it with the page. The page detects
 * desktop mode via a server-injected
 * `<meta name="desktop-mode" content="1">` and proves liveness with a
 * same-origin WebSocket, not with the token.
 *
 * Three fixed control surfaces, only reachable in desktop mode:
 *   GET  /__desktop/status   -> {app:'superstring',desktop:true,state:'ready'}
 *                               (Bearer token required; never echoes the token)
 *   POST /__desktop/stop     -> {ok:true} then graceful stop via onStop()
 *   WS   /__desktop/lifetime -> same-origin liveness channel. Strict Origin
 *                               check (Origin === http://127.0.0.1:PORT); a
 *                               missing or cross-site Origin is rejected with
 *                               403 and is never upgraded.
 *
 * Stop policy (keeps the "last superstring page closed -> stop" promise while
 * surviving refresh / multi-tab / sleep):
 *   - First connect has a startup window (default 120s); if no WebSocket ever
 *     connects, the server stops to avoid a dangling process.
 *   - When the last tracked connection closes, an 8s grace starts; a new
 *     connection (refresh, tab restored from bfcache, re-visible) cancels it.
 *   - Server-side ping/pong detects dead links (sleep / dropped network) so a
 *     silently-dead socket eventually triggers the same grace, but the browser
 *     reconnect on wake cancels it.
 *
 * Production timings cannot be overridden by environment variables.
 * Tests inject shorter intervals through options.
 */

import type { Server, WebSocketHandler } from "bun";
import type { AppearanceSnapshot } from "../shared/appearance";
import { APPEARANCE_MESSAGE_MAX_BYTES, parseAppearanceMessage } from "../shared/appearance";

/** 64 hex chars exactly. The launcher mints lowercase; accept either case. */
export const DESKTOP_TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;

export const DESKTOP_CONTROL_PATHS = new Set<string>([
  "/__desktop/status",
  "/__desktop/stop",
  "/__desktop/lifetime",
]);

export const DEFAULT_GRACE_MS = 8_000;
export const DEFAULT_STARTUP_WINDOW_MS = 120_000;
export const DEFAULT_PING_INTERVAL_MS = 15_000;
export const DEFAULT_PONG_TIMEOUT_MS = 10_000;

/** Minimum length so a test cannot drive the real server into instant-exit. */
export const MIN_GRACE_MS = 1_000;
export const MIN_STARTUP_WINDOW_MS = 1_000;

export interface DesktopLifecycleConfig {
  token: string;
  host: string;
  port: number;
  onStop: () => void | Promise<void>;
  /** Persist an appearance snapshot received from a desktop client. Optional but
   * always present when desktop mode is enabled; a rejection here must never
   * break the liveness socket or chat. */
  onAppearance?: (snapshot: AppearanceSnapshot) => void | Promise<void>;
  graceMs?: number;
  startupWindowMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface DesktopControlResult {
  upgraded: boolean;
  response?: Response;
}

/** Per-connection data attached at upgrade time. */
export type DesktopWsData = { alive: boolean };

type Timer = unknown;

interface ConnState {
  ping: Timer | null;
  watch: Timer | null;
  awaitingPong: boolean;
}

/** Minimal surface we touch on a (possibly faked) server-side WebSocket. */
interface WsLike {
  data: { alive: boolean };
  ping: (data?: string | Uint8Array) => void;
  terminate: () => void;
  close: (code?: number, reason?: string) => void;
}

function noStoreJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Returns the 404 response used in NORMAL (non-desktop) mode for every
 * `/__desktop/*` path. Keeping it in one place lets both `index.ts` and the
 * tests assert the "control surface is invisible unless explicitly enabled"
 * contract.
 */
export function desktopDisabledResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * Inject `<meta name="desktop-mode" content="1">` into an HTML document so the
 * frontend can read it without ever receiving the control token. Idempotent:
 * a document that already carries the meta is returned untouched.
 */
export function injectDesktopMeta(html: string): string {
  if (/<meta\s+[^>]*name=["']desktop-mode["']/i.test(html)) return html;
  return html.replace(/<\/head>/i, `  <meta name="desktop-mode" content="1" />\n</head>`);
}

export interface DesktopLifecycle {
  handle(req: Request, server: Server<DesktopWsData>): DesktopControlResult;
  websocket: WebSocketHandler<DesktopWsData>;
  start(): void;
}

export function createDesktopLifecycle(config: DesktopLifecycleConfig): DesktopLifecycle {
  const graceMs = Math.max(config.graceMs ?? DEFAULT_GRACE_MS, 0);
  const startupWindowMs = Math.max(config.startupWindowMs ?? DEFAULT_STARTUP_WINDOW_MS, 0);
  const pingIntervalMs = config.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
  const pongTimeoutMs = config.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
  const setTimeoutFn = (config.setTimeoutFn ?? setTimeout) as (
    fn: () => void,
    ms: number,
  ) => unknown;
  const clearTimeoutFn = (config.clearTimeoutFn ?? clearTimeout) as (handle: unknown) => void;

  const token = config.token;
  const expectedOrigin = `http://${config.host}:${config.port}`;

  const connections = new Set<WsLike>();
  const timers = new Map<WsLike, ConnState>();
  let graceTimer: Timer | null = null;
  let startupTimer: Timer | null = null;
  let stopping = false;
  let started = false;

  function clearGrace(): void {
    if (graceTimer !== null) {
      clearTimeoutFn(graceTimer);
      graceTimer = null;
    }
  }

  function clearStartup(): void {
    if (startupTimer !== null) {
      clearTimeoutFn(startupTimer);
      startupTimer = null;
    }
  }

  function clearConnTimers(conn: WsLike): void {
    const state = timers.get(conn);
    if (!state) return;
    if (state.ping !== null) clearTimeoutFn(state.ping);
    if (state.watch !== null) clearTimeoutFn(state.watch);
    timers.delete(conn);
  }

  function triggerStop(): void {
    if (stopping) return;
    stopping = true;
    clearGrace();
    clearStartup();
    for (const conn of connections) clearConnTimers(conn);
    connections.clear();
    // Defer to a macrotask so the in-flight control response (e.g. the
    // /__desktop/stop 200) is flushed to the socket before shutdown force-closes
    // it. A microtask would race Bun's write and reset the connection.
    setTimeout(() => {
      void config.onStop();
    }, 0);
  }

  function scheduleGrace(): void {
    if (stopping) return;
    clearGrace();
    graceTimer = setTimeoutFn(() => {
      graceTimer = null;
      triggerStop();
    }, graceMs);
  }

  function startStartupWindow(): void {
    if (startupTimer !== null || startupWindowMs <= 0 || connections.size > 0) return;
    startupTimer = setTimeoutFn(() => {
      startupTimer = null;
      // No connection ever established: stop to avoid a residue process.
      triggerStop();
    }, startupWindowMs);
  }

  function authOk(req: Request): boolean {
    const header = req.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return false;
    return constantTimeEqual(match[1].trim(), token);
  }

  function handle(req: Request, server: Server<DesktopWsData>): DesktopControlResult {
    const url = new URL(req.url);

    if (url.pathname === "/__desktop/status") {
      if (!authOk(req))
        return { upgraded: false, response: noStoreJson({ error: "unauthorized" }, 401) };
      return {
        upgraded: false,
        response: noStoreJson({ app: "superstring", desktop: true, state: "ready" }),
      };
    }

    if (url.pathname === "/__desktop/stop") {
      if (req.method !== "POST") {
        return { upgraded: false, response: new Response("Method Not Allowed", { status: 405 }) };
      }
      if (!authOk(req))
        return { upgraded: false, response: noStoreJson({ error: "unauthorized" }, 401) };
      triggerStop();
      return { upgraded: false, response: noStoreJson({ ok: true }) };
    }

    if (url.pathname === "/__desktop/lifetime") {
      const origin = req.headers.get("origin");
      if (!origin || origin !== expectedOrigin) {
        return {
          upgraded: false,
          response: new Response("Forbidden", {
            status: 403,
            headers: { "content-type": "text/plain; charset=utf-8" },
          }),
        };
      }
      if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
        return { upgraded: false, response: new Response("Upgrade Required", { status: 426 }) };
      }
      const upgraded = server.upgrade(req, { data: { alive: true } });
      if (!upgraded) {
        return { upgraded: false, response: new Response("Upgrade failed", { status: 500 }) };
      }
      return { upgraded: true };
    }

    return { upgraded: false, response: desktopDisabledResponse() };
  }

  function scheduleHeartbeat(conn: WsLike): void {
    let state = timers.get(conn);
    if (!state) {
      state = { ping: null, watch: null, awaitingPong: false };
      timers.set(conn, state);
    }
    // First ping after one interval; sending it instantly is unnecessary and
    // would race the watchdog window on open.
    state.ping = setTimeoutFn(() => sendPing(conn), pingIntervalMs);
  }

  function sendPing(conn: WsLike): void {
    if (stopping) return;
    const state = timers.get(conn);
    if (!state) return;
    // Mark that we are now awaiting a pong BEFORE sending, so a pong that
    // arrives (synchronously in tests, asynchronously in a browser) clears it.
    state.awaitingPong = true;
    try {
      conn.ping();
    } catch {
      conn.terminate();
      return;
    }
    scheduleWatchdog(conn);
  }

  function scheduleWatchdog(conn: WsLike): void {
    const state = timers.get(conn);
    if (!state) return;
    state.watch = setTimeoutFn(() => {
      if (stopping) return;
      // If no pong has answered the most recent ping within the window, the
      // link is dead (sleep / dropped network). Terminate so the grace runs.
      if (state.awaitingPong) {
        conn.terminate();
        return;
      }
    }, pongTimeoutMs);
  }

  const websocket: WebSocketHandler<DesktopWsData> = {
    maxPayloadLength: 4096,
    open(ws) {
      if (stopping) {
        ws.close();
        return;
      }
      // A new connection means the desktop is alive: cancel any pending
      // shutdown grace and the startup window.
      clearGrace();
      clearStartup();
      const conn = ws as unknown as WsLike;
      connections.add(conn);
      timers.set(conn, { ping: null, watch: null, awaitingPong: false });
      scheduleHeartbeat(conn);
    },
    message(ws, message) {
      // Liveness is server-driven (ping/pong). The single allowed client frame
      // is an appearance snapshot; everything else is dropped silently and NEVER
      // escalates to a shutdown.
      if (stopping) return;
      if (typeof message !== "string") return; // binary frames ignored
      if (message.length > APPEARANCE_MESSAGE_MAX_BYTES) return;
      const snapshot = parseAppearanceMessage(message);
      if (!snapshot) return; // invalid / out-of-contract frame: ignore
      // Identity check: only accept frames from a tracked, alive connection.
      const conn = ws as unknown as WsLike;
      if (!timers.has(conn)) return;
      if (config.onAppearance) {
        // Fire-and-forget; a persistence failure must not surface as a socket
        // error, break the liveness channel, or affect chat.
        try {
          void Promise.resolve(config.onAppearance(snapshot)).catch(() => {});
        } catch {
          /* Synchronous persistence errors must not break liveness either. */
        }
      }
    },
    pong(ws) {
      const conn = ws as unknown as WsLike;
      const state = timers.get(conn);
      if (state?.awaitingPong) {
        state.awaitingPong = false;
        if (state.watch !== null) clearTimeoutFn(state.watch);
        state.watch = null;
        scheduleHeartbeat(conn);
      }
    },
    close(ws) {
      const conn = ws as unknown as WsLike;
      clearConnTimers(conn);
      connections.delete(conn);
      if (connections.size === 0) scheduleGrace();
    },
    drain() {},
    ping() {},
  };

  function start(): void {
    if (started || stopping) return;
    started = true;
    startStartupWindow();
  }

  return { handle, websocket, start };
}

/** True when the supplied token enables desktop mode. */
export function isDesktopToken(value: string | undefined): value is string {
  return typeof value === "string" && DESKTOP_TOKEN_PATTERN.test(value);
}
