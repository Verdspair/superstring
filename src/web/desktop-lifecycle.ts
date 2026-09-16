/**
 * Desktop-mode liveness client (browser side).
 *
 * The server only enables desktop mode when launched with a valid
 * SUPERSTRING_DESKTOP_TOKEN and advertises it to the page through an injected
 * `<meta name="desktop-mode" content="1">`. This module reads that meta and,
 * ONLY then, opens a same-origin WebSocket to /__desktop/lifetime. The page
 * never receives the control token; the socket is purely a liveness signal.
 *
 * Design guarantees:
 *   - Normal (non-desktop) mode is a complete no-op: no WebSocket, no timers,
 *     and crucially NO console errors, so existing tests are unaffected.
 *   - The socket is NOT subject to background-tab JS timer throttling, so a
 *     parked tab still counts as "alive".
 *   - On refresh / bfcache restore / waking from sleep we reconnect
 *     (pageshow + visibilitychange). On pagehide (incl. bfcache) we close the
 *     current socket so a parked snapshot does not hold a stale link.
 *   - A socket error is followed by close and a quiet reconnect; it is NEVER
 *     reported to the app as "the page closed".
 */

import type { AppearanceSnapshot } from "../shared/appearance";
import { encodeAppearanceMessage, MODE_STORAGE_KEY, THEME_STORAGE_KEY } from "../shared/appearance";

export interface WebSocketLike {
  close: (code?: number) => void;
  send: (data: string) => void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface DesktopLifecycleClientOptions {
  /** Inject a WebSocket factory (tests). Defaults to the global WebSocket. */
  makeWebSocket?: (url: string) => WebSocketLike;
  /** Relative liveness path; resolved against the page origin. */
  lifetimeUrl?: string;
  /** Reconnect backoff after an abnormal close (ms). */
  reconnectDelayMs?: number;
  /** Override document (tests / SSR safety). */
  documentRef?: Document | null;
  /** Override window (tests / SSR safety). */
  windowRef?: Window | null;
  /** Returns the current appearance pair to broadcast on (re)connect and on a
   * cross-tab storage change. Only used in desktop mode; omit to skip appearance
   * sync entirely (keeps normal mode a zero-connection, zero-disk no-op). */
  getAppearance?: () => AppearanceSnapshot;
}

const DEFAULT_LIFETIME_URL = "/__desktop/lifetime";

/**
 * Sink to the live liveness socket. Set on open, cleared on close. In normal
 * (non-desktop) mode it stays null, so appearance broadcast is a no-op and the
 * browser never opens a connection or writes anything to disk.
 */
let appearanceSink: ((snapshot: AppearanceSnapshot) => void) | null = null;

/** Broadcast the current appearance to the server. Desktop mode only; a no-op
 * before the liveness socket is open or in normal mode. Callers pass the latest
 * in-memory truth (the server is best-effort; the browser stays the source). */
export function broadcastAppearance(snapshot: AppearanceSnapshot): void {
  appearanceSink?.(snapshot);
}

export function initDesktopLifecycle(options: DesktopLifecycleClientOptions = {}): void {
  const doc =
    options.documentRef ?? (typeof document !== "undefined" ? (document as Document) : null);
  if (!doc) return;

  const meta = doc.querySelector('meta[name="desktop-mode"]');
  // Normal mode: do nothing at all. Never log, never connect.
  if (meta?.getAttribute("content") !== "1") return;

  const win = options.windowRef ?? (typeof window !== "undefined" ? (window as Window) : null);
  if (!win) return;

  const makeWebSocket =
    options.makeWebSocket ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
  const reconnectDelayMs = options.reconnectDelayMs ?? 2_000;
  const url = options.lifetimeUrl ?? DEFAULT_LIFETIME_URL;
  const getAppearance = options.getAppearance;

  let suspended = false;
  let socket: WebSocketLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function connect(): void {
    if (suspended) return;
    if (socket) {
      clearReconnect();
      return;
    }
    clearReconnect();
    try {
      const ws = makeWebSocket(url);
      socket = ws;
      ws.onopen = () => {
        // Identity check: a stale (superseded) socket must never drive sends.
        if (socket !== ws) return;
        // While this socket is the live one, broadcast appearance through it.
        appearanceSink = (snapshot: AppearanceSnapshot) => {
          if (socket !== ws) return;
          try {
            ws.send(encodeAppearanceMessage(snapshot));
          } catch {
            /* a failed write must never break liveness */
          }
        };
        // Re-read the CURRENT appearance (not stale in-memory) on (re)connect so
        // a tab restored from bfcache cannot roll the server back to an old value.
        if (getAppearance) {
          try {
            appearanceSink(getAppearance());
          } catch {
            /* ignore */
          }
        }
      };
      ws.onerror = () => {
        if (socket !== ws) return;
        // A socket error is always followed by close; never treat it as the
        // page having closed. Closing triggers our own reconnect path.
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        appearanceSink = null;
        if (!suspended) scheduleReconnect();
      };
    } catch {
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
  }

  function closeCurrent(): void {
    suspended = true;
    if (socket) {
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      socket = null;
    }
    clearReconnect();
    appearanceSink = null;
    if (win && getAppearance) {
      win.removeEventListener("storage", onStorage);
    }
  }

  // Cross-tab: when another tab changes appearance, the storage event fires
  // here (not in the writer tab) and we re-broadcast the latest pair. The writer
  // tab announces its own change directly via broadcastAppearance().
  function onStorage(event: StorageEvent): void {
    if (suspended) return;
    if (event.key !== null && event.key !== THEME_STORAGE_KEY && event.key !== MODE_STORAGE_KEY)
      return;
    if (!getAppearance) return;
    try {
      broadcastAppearance(getAppearance());
    } catch {
      /* ignore */
    }
  }

  // Resume / restore: refresh, bfcache restore, wake from sleep.
  win.addEventListener("pageshow", () => {
    suspended = false;
    if (getAppearance) win.addEventListener("storage", onStorage);
    connect();
  });
  win.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "visible") connect();
  });
  // Unload / bfcache: drop the current socket so a parked snapshot does not
  // keep a stale liveness link.
  win.addEventListener("pagehide", closeCurrent);

  if (win && getAppearance) {
    win.addEventListener("storage", onStorage);
  }

  connect();
}
