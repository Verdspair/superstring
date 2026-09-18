import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { WebSocketHandler } from "bun";
import { serve } from "bun";
import type { Hono } from "hono";
import { isApiPath } from "../shared/api-routes";
import { createAppearanceRepository } from "./desktop-appearance";
import {
  createDesktopLifecycle,
  DESKTOP_CONTROL_PATHS,
  desktopDisabledResponse,
  injectDesktopMeta,
  isDesktopToken,
} from "./desktop-lifecycle";
import { DEV_HOST, resolveDevPort } from "./dev-config";
import { createRuntime, resolveBusinessDbPath } from "./runtime";
import { acquireServiceLease } from "./service-lease";
import { loadStartupLayout } from "./startup-layout";

// Open the business database, mount API routes and run the memory worker.
// The server only binds to loopback.
const PORT = resolveDevPort(process.env.SUPERSTRING_DEV_PORT);
const SERVE_WEB = process.env.SUPERSTRING_SERVE_WEB === "1";
const layout = loadStartupLayout(process.env);
const WEB_ROOT = layout?.paths.webDir ?? path.resolve("dist/web");
const BUSINESS_DB_PATH = layout?.paths.database ?? resolveBusinessDbPath();

// Installed deployments hold a shared maintenance lease for the whole process
// lifetime, acquired BEFORE the database is opened. The installer takes the same
// file exclusively, so it can only replace/back up a fully stopped installation —
// even if the native launcher crashed while this service kept running.
// Development launches (start.cmd) have no lease and behave exactly as before.
const serviceLease =
  layout && layout.paths.mode === "installed" ? acquireServiceLease(layout.paths.root) : null;

if (BUSINESS_DB_PATH !== ":memory:") {
  mkdirSync(path.dirname(BUSINESS_DB_PATH), { recursive: true });
}

const runtimeFactory = createRuntime;
const runtime = runtimeFactory({
  businessDbPath: BUSINESS_DB_PATH,
  browserStateSecretPath: layout?.paths.browserStateKey,
  businessMigrationSql: layout?.businessMigrationSql,
});

// Desktop mode is opt-in: only when SUPERSTRING_DESKTOP_TOKEN is a valid 64-hex
// value. In every other launch (the normal start.cmd path) `desktop` is null and
// the /__desktop/* control surface is invisible (404). The token is never sent
// to the browser; the page learns it is desktop mode from an injected meta tag.
// The appearance repository is likewise created only in desktop mode; in normal
// mode nothing is written to disk and no connection is opened.
const appearanceRepo = isDesktopToken(process.env.SUPERSTRING_DESKTOP_TOKEN)
  ? createAppearanceRepository({
      stateDir: layout?.paths.stateDir ?? path.resolve("artifacts", "state"),
    })
  : null;
const desktop = isDesktopToken(process.env.SUPERSTRING_DESKTOP_TOKEN)
  ? createDesktopLifecycle({
      token: process.env.SUPERSTRING_DESKTOP_TOKEN,
      host: DEV_HOST,
      port: PORT,
      onStop: () => void shutdown(),
      onAppearance: appearanceRepo ? (snapshot) => void appearanceRepo.save(snapshot) : undefined,
    })
  : null;

if (SERVE_WEB && existsSync(WEB_ROOT)) {
  // Registered after business routes so the SPA fallback cannot shadow an API.
  appStaticFallback(runtime.app, WEB_ROOT);
}

// In-flight request tracking
// On shutdown we wait (bounded) for active requests to finish before closing
// the socket and the databases, so a request mid-write is not truncated purely
// because the port closed. This protects both SIGINT and desktop-triggered stop.
let inFlight = 0;
const drainTimeoutMs = 5_000;
const activeReaders = new Set<ReadableStreamDefaultReader<Uint8Array>>();
const idleWaiters: Array<() => void> = [];

function releaseInFlight(): void {
  inFlight--;
  if (inFlight <= 0) {
    inFlight = 0;
    const waiters = idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }
}

function wrapForDrain(res: Response): Response {
  if (!res.body) {
    releaseInFlight();
    return res;
  }
  const reader = res.body.getReader();
  activeReaders.add(reader);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    activeReaders.delete(reader);
    releaseInFlight();
  };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      return reader.read().then(
        ({ done, value }) => {
          if (done) {
            controller.close();
            release();
          } else {
            controller.enqueue(value);
          }
        },
        (error) => {
          controller.error(error);
          release();
        },
      );
    },
    cancel() {
      return reader.cancel().then(release, release);
    },
  });
  return new Response(stream, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
}

async function dispatch(req: Request): Promise<Response> {
  inFlight++;
  try {
    const res = await runtime.app.fetch(req);
    return wrapForDrain(res);
  } catch (error) {
    releaseInFlight();
    throw error;
  }
}

function waitForIdle(timeoutMs: number): Promise<void> {
  if (inFlight <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    idleWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Give in-flight requests up to drainTimeoutMs to finish/persist, then close.
  await waitForIdle(drainTimeoutMs);
  // Explicitly await stream cancellation/persistence before closing SQLite.
  // Refuse new requests below; pending pre-response requests must also settle.
  await Promise.allSettled([...activeReaders].map((reader) => reader.cancel()));
  await waitForIdle(drainTimeoutMs);
  if (inFlight > 0) {
    console.error("[superstring] shutdown is waiting for active requests to settle");
    while (inFlight > 0) await waitForIdle(drainTimeoutMs);
  }
  // Flush the desktop appearance queue (rejects new writes, awaits the in-flight
  // save) before we stop listening. A appearance write failure is already
  // swallowed by the repository, so this never rejects shutdown.
  if (appearanceRepo) await appearanceRepo.close();
  server.stop(true);
  await runtime.stop();
  // Release only after the runtime (and the SQLite handle) is fully closed, so
  // "installation is unlocked" always implies "no database writer remains".
  serviceLease?.release();
  process.exit(0);
}

const noopWebsocket: WebSocketHandler<{ alive: boolean }> = {
  open() {},
  message() {},
  close() {},
  drain() {},
};

const server = (() => {
  try {
    const created = serve({
      fetch: (req, srv) => {
        if (shuttingDown) return new Response("Shutting down", { status: 503 });
        const url = new URL(req.url);
        if (DESKTOP_CONTROL_PATHS.has(url.pathname)) {
          if (!desktop) return desktopDisabledResponse();
          const result = desktop.handle(req, srv);
          if (result.upgraded) return undefined;
          return result.response ?? desktopDisabledResponse();
        }
        return dispatch(req);
      },
      websocket: desktop ? desktop.websocket : noopWebsocket,
      hostname: DEV_HOST,
      port: PORT,
    });
    runtime.start();
    desktop?.start();
    return created;
  } catch (error) {
    void runtime.stop();
    serviceLease?.release();
    throw error;
  }
})();

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

console.log(
  `[superstring:R3] server on http://${DEV_HOST}:${PORT} (businessReady=true, serveWeb=${SERVE_WEB}, db=${BUSINESS_DB_PATH}, desktop=${desktop ? "on" : "off"})`,
);

function appStaticFallback(app: Hono, root: string): void {
  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    if (isApiPath(url.pathname)) {
      return c.notFound();
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const filePath = path.resolve(root, rel);
    const relative = path.relative(root, filePath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return c.notFound();
    }
    const file = Bun.file(filePath);
    if (!(await file.exists())) return c.notFound();
    const contentType = contentTypeFor(filePath);
    // In desktop mode, advertise it to the page (so the WS liveness client can
    // start) without ever exposing the control token to the browser.
    if (desktop && contentType.startsWith("text/html")) {
      const html = await file.text();
      return new Response(injectDesktopMeta(html), {
        headers: { "content-type": contentType },
      });
    }
    return new Response(file, {
      headers: { "content-type": contentType },
    });
  });
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  return map[ext] ?? "application/octet-stream";
}
