import { timingSafeEqual } from "node:crypto";
import { DESKTOP_CONTROL_PATHS, DESKTOP_TOKEN_PATTERN } from "./desktop-lifecycle";

/** Injected by the Electron main process, never exposed to renderer JavaScript. */
export const DESKTOP_ACCESS_HEADER = "X-Superstring-Desktop";

export interface DesktopAccessOptions {
  env: {
    SUPERSTRING_APP_MODE?: string;
    SUPERSTRING_DESKTOP_MANAGED?: string;
    SUPERSTRING_DESKTOP_TOKEN?: string;
  };
  /** The actual bound HTTP origin, including the OS-selected port. */
  origin: () => string;
}

/** Null permits dispatch. A response must be returned before routing or WebSocket upgrade. */
export type DesktopAccess = (request: Request) => Response | null;

function forbidden(): Response {
  return new Response("Forbidden", {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** An upgrade may be represented as HTTP by Bun or WS by an upstream request adapter. */
function httpOrigin(url: URL): string {
  if (url.protocol === "ws:") url.protocol = "http:";
  if (url.protocol === "wss:") url.protocol = "https:";
  return url.origin;
}

/**
 * Authentication for the managed shell only. Legacy Windows uses its existing control-token
 * protocol, and normal browser launches remain untouched. A partially configured new desktop
 * mode is a startup error, not an unauthenticated fallback.
 *
 * This gate does not replace route authorization, method checks or the lifetime socket's Origin
 * requirement. It covers static files, business APIs, streams and every WebSocket upgrade alike.
 */
export function createDesktopAccess(options: DesktopAccessOptions): DesktopAccess {
  if (options.env.SUPERSTRING_APP_MODE !== "desktop") return () => null;

  const token = options.env.SUPERSTRING_DESKTOP_TOKEN;
  if (
    options.env.SUPERSTRING_DESKTOP_MANAGED !== "1" ||
    !token ||
    !DESKTOP_TOKEN_PATTERN.test(token)
  ) {
    throw new Error("DESKTOP_ACCESS_CONFIGURATION_INVALID");
  }
  const expectedToken = Buffer.from(token, "ascii");
  const matchesToken = (candidate: string | null): boolean => {
    if (candidate === null || !DESKTOP_TOKEN_PATTERN.test(candidate)) return false;
    return timingSafeEqual(Buffer.from(candidate, "ascii"), expectedToken);
  };

  return (request) => {
    const url = new URL(request.url);
    const expectedOrigin = options.origin();
    const host = request.headers.get("host");
    const origin = request.headers.get("origin");
    if (
      httpOrigin(url) !== expectedOrigin ||
      (host !== null && host !== url.host) ||
      (origin !== null && origin !== expectedOrigin)
    ) {
      return forbidden();
    }

    if (matchesToken(request.headers.get(DESKTOP_ACCESS_HEADER))) return null;

    // Retain the native launcher's status/stop credential. Bearer auth does not authorize
    // business routes; control handlers still enforce their original methods and WS Origin.
    if (DESKTOP_CONTROL_PATHS.has(url.pathname)) {
      const authorization = request.headers.get("authorization") ?? "";
      const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
      if (bearer && matchesToken(bearer[1].trim())) return null;
    }
    return forbidden();
  };
}
