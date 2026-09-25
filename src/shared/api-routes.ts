/**
 * The HTTP surface of the app, declared once.
 *
 * Two consumers must agree on it, and they used to disagree:
 *
 *  1. `src/server/index.ts` — the optional static host (`SUPERSTRING_SERVE_WEB=1`)
 *     uses this list to refuse serving `index.html` for an API path, so the SPA
 *     fallback can never shadow a real route.
 *  2. `vite.config.ts` — the dev server must forward every one of these to the
 *     Bun process on 17861. The web client (`src/web/api.ts`) calls them with
 *     relative paths, so without a proxy entry a dev request would hit :5173 and
 *     fail with an HTML 404 instead of the API's JSON envelope.
 *
 * Keeping one list (plus `tests/integration/dev-proxy.test.ts`, which reads the
 * client source and asserts every path it calls is covered) is what stops the
 * second consumer from silently falling behind the first.
 *
 * Pure module: no imports, no side effects, safe for the Vite config bundle.
 */

/** Paths matched anywhere below the prefix (`/agents/...`, `/sessions/...`). */
export const API_PREFIXES = [
  "/__dev",
  "/agents",
  "/sessions",
  "/models",
  "/knowledge",
  "/organization",
  "/browser-state",
  // QQ routes existed since P5a, but nothing in the web client called them until the sticker
  // library page (P5e) — so this entry only became necessary now, and the proxy-coverage test
  // is what pointed at it rather than a browser seeing an HTML 404.
  "/qq",
  // The desktop close preference (§12): the settings page reads and writes it, so the dev proxy
  // has to forward it even though the value only matters in desktop mode.
  "/desktop",
] as const;

/** Paths that match exactly — `/chat` must not swallow `/chatty`. */
export const API_EXACT_PATHS = ["/chat", "/health"] as const;

export type ApiPrefix = (typeof API_PREFIXES)[number];
export type ApiExactPath = (typeof API_EXACT_PATHS)[number];

/** True when `pathname` belongs to the API rather than the SPA. */
export function isApiPath(pathname: string): boolean {
  if ((API_EXACT_PATHS as readonly string[]).includes(pathname)) return true;
  return API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Vite `server.proxy` keys. Vite matches a key by prefix, so the exact paths are
 * listed verbatim as well — that is the documented spelling and keeps the config
 * readable next to the list above.
 */
export const API_PROXY_KEYS: readonly string[] = [...API_PREFIXES, ...API_EXACT_PATHS];
