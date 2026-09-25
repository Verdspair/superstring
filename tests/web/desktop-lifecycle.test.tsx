import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppearanceSnapshot } from "../../src/shared/appearance";
import type { DesktopLifecycleClientOptions, WebSocketLike } from "../../src/web/desktop-lifecycle";
import {
  broadcastAppearance,
  initDesktopLifecycle,
  isDesktopMode,
  requestDesktopExit,
} from "../../src/web/desktop-lifecycle";

class FakeWebSocket implements WebSocketLike {
  url: string;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    created.push(this);
  }
  close(): void {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
}

let created: FakeWebSocket[] = [];

function makeWindow() {
  const listeners: Record<string, Array<(event: unknown) => void>> = {};
  return {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] ??= [];
      listeners[type].push(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    dispatch: (type: string, event: unknown = {}) => {
      for (const fn of listeners[type] ?? []) fn(event);
    },
    _listeners: listeners,
  };
}

function makeDoc(desktop: boolean) {
  const meta = desktop
    ? { getAttribute: (name: string) => (name === "content" ? "1" : null) }
    : null;
  return {
    querySelector: () => meta,
    visibilityState: "visible",
  } as unknown as Document;
}

function run(desktop: boolean, win = makeWindow()) {
  created = [];
  const doc = makeDoc(desktop);
  const options: DesktopLifecycleClientOptions = {
    makeWebSocket: (url) => new FakeWebSocket(url),
    documentRef: doc,
    windowRef: win as unknown as Window,
  };
  initDesktopLifecycle(options);
  return win;
}

describe("desktop liveness client", () => {
  afterEach(() => {
    created = [];
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does nothing in normal mode and never logs", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    run(false);
    expect(created).toHaveLength(0);
    expect(error).not.toHaveBeenCalled();
  });

  it("connects with the relative same-origin lifetime path in desktop mode", () => {
    run(true);
    expect(created).toHaveLength(1);
    expect(created[0].url).toBe("/__desktop/lifetime");
  });

  it("closes the current socket on pagehide (bfcache safe)", () => {
    const win = run(true);
    expect(created[0].closed).toBe(false);
    win.dispatch("pagehide");
    expect(created[0].closed).toBe(true);
  });

  it("reconnects on pageshow after the socket was closed", () => {
    const win = run(true);
    win.dispatch("pagehide");
    win.dispatch("pageshow");
    expect(created).toHaveLength(2);
    expect(created[1].url).toBe("/__desktop/lifetime");
  });

  it("reconnects on visibilitychange after an unexpected socket close", () => {
    const win = run(true);
    created[0].close();
    win.dispatch("visibilitychange");
    expect(created).toHaveLength(2);
  });

  it("does not reconnect a pagehide snapshot until pageshow", () => {
    vi.useFakeTimers();
    const win = run(true);
    const old = created[0];
    win.dispatch("pagehide");
    old.onclose?.({ code: 1000 }); // real close can arrive asynchronously
    win.dispatch("visibilitychange");
    vi.advanceTimersByTime(10000);
    expect(created).toHaveLength(1);
    win.dispatch("pageshow");
    old.onclose?.({ code: 1000 }); // stale callback cannot clear the new socket
    vi.advanceTimersByTime(10000);
    expect(created).toHaveLength(2);
  });

  it("treats a socket error as a quiet reconnect, never a page-close report", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    run(true);
    const ws = created[0];
    expect(() => ws.onerror?.({})).not.toThrow();
    expect(error).not.toHaveBeenCalled();
    // The error handler closed the socket, which schedules a quiet reconnect.
    expect(ws.closed).toBe(true);
  });
});

// Appearance sync (desktop mode only)
class SendingFakeWebSocket implements WebSocketLike {
  url: string;
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    appearanceCreated.push(this);
  }
  close(): void {
    this.closed = true;
    this.onclose?.({ code: 1000 });
  }
  send(data: string): void {
    this.sent.push(data);
  }
}

let appearanceCreated: SendingFakeWebSocket[] = [];

function runAppearance(
  desktop: boolean,
  getAppearance?: () => AppearanceSnapshot,
  win: ReturnType<typeof makeWindow> = makeWindow(),
) {
  appearanceCreated = [];
  const doc = makeDoc(desktop);
  initDesktopLifecycle({
    makeWebSocket: (url) => new SendingFakeWebSocket(url),
    documentRef: doc,
    windowRef: win as unknown as Window,
    getAppearance,
  });
  return win;
}

describe("desktop appearance sync (client)", () => {
  afterEach(() => {
    appearanceCreated = [];
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sends the current appearance on open in desktop mode", () => {
    runAppearance(true, () => ({ theme: "rose", mode: "dark" }));
    expect(appearanceCreated).toHaveLength(1);
    const ws = appearanceCreated[0];
    expect(ws.sent).toHaveLength(0);
    ws.onopen?.({});
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: "appearance",
      theme: "rose",
      mode: "dark",
    });
  });

  it("does not open a connection or send in normal mode even with getAppearance", () => {
    runAppearance(false, () => ({ theme: "rose", mode: "dark" }));
    expect(appearanceCreated).toHaveLength(0);
  });

  it("broadcastAppearance sends the latest pair through the live socket", () => {
    runAppearance(true, () => ({ theme: "slate", mode: "system" }));
    const ws = appearanceCreated[0];
    ws.onopen?.({});
    ws.sent.length = 0;
    broadcastAppearance({ theme: "forest", mode: "light" });
    expect(ws.sent).toEqual([
      JSON.stringify({ type: "appearance", theme: "forest", mode: "light" }),
    ]);
  });

  it("re-broadcasts on a cross-tab storage event", () => {
    const win = runAppearance(true, () => ({ theme: "violet", mode: "dark" }));
    const ws = appearanceCreated[0];
    ws.onopen?.({});
    ws.sent.length = 0;
    win.dispatch("storage", { key: "superstring-appearance" });
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({
      type: "appearance",
      theme: "violet",
      mode: "dark",
    });
  });

  it("old socket identity check: a stale onopen must not send", () => {
    const win = runAppearance(true, () => ({ theme: "slate", mode: "system" }));
    const old = appearanceCreated[0];
    const staleOnOpen = old.onopen;
    // Close + reconnect creates a fresh live socket.
    win.dispatch("pagehide");
    win.dispatch("pageshow");
    const fresh = appearanceCreated[1];
    // A late-arriving open from the stale (superseded) socket must be ignored.
    staleOnOpen?.({});
    expect(old.sent).toHaveLength(0);
    // The live socket sends when it opens.
    fresh.onopen?.({});
    expect(fresh.sent).toHaveLength(1);
    expect(JSON.parse(fresh.sent[0]).theme).toBe("slate");
  });

  it("restores storage sync after bfcache without stale sockets", () => {
    const win = runAppearance(true, () => ({ theme: "jade", mode: "dark" }));
    const old = appearanceCreated[0];
    old.onopen?.({});
    win.dispatch("pagehide");
    win.dispatch("pageshow");
    const fresh = appearanceCreated[1];
    fresh.onopen?.({});
    fresh.sent.length = 0;
    old.onerror?.({});
    old.onclose?.({ code: 1000 });
    win.dispatch("storage", { key: "superstring-appearance-mode" });
    expect(fresh.closed).toBe(false);
    expect(fresh.sent).toEqual([
      JSON.stringify({ type: "appearance", theme: "jade", mode: "dark" }),
    ]);
    win.dispatch("pagehide");
  });

  it("stops sending after pagehide (closeCurrent drops the sink)", () => {
    runAppearance(true, () => ({ theme: "slate", mode: "system" }));
    const ws = appearanceCreated[0];
    ws.onopen?.({});
    ws.sent.length = 0;
    // Simulate the window unloading / bfcache: the sink is cleared.
    ws.onclose?.({ code: 1000 });
    broadcastAppearance({ theme: "ocean", mode: "dark" });
    expect(ws.sent).toHaveLength(0);
  });
});

describe("explicit exit through the liveness socket", () => {
  afterEach(() => {
    created = [];
    appearanceCreated = [];
  });

  it("reports that the desktop meta is what enables the mode", () => {
    expect(isDesktopMode(makeDoc(true))).toBe(true);
    expect(isDesktopMode(makeDoc(false))).toBe(false);
    expect(isDesktopMode(null)).toBe(false);
  });

  it("has no way to ask outside desktop mode", () => {
    run(false);
    expect(requestDesktopExit()).toBe(false);
  });

  it("writes the exact frame the server accepts, once the socket is open", () => {
    run(true);
    const ws = created[0];
    // Before open there is no sink: the request must not be reported as sent.
    expect(requestDesktopExit()).toBe(false);
    ws.onopen?.({});
    expect(requestDesktopExit()).toBe(true);
    expect(ws.sent).toEqual(['{"exit":true}']);
  });

  it("stops claiming to have asked after the socket closes", () => {
    run(true);
    const ws = created[0];
    ws.onopen?.({});
    ws.onclose?.({ code: 1006 });
    expect(requestDesktopExit()).toBe(false);
  });
});
