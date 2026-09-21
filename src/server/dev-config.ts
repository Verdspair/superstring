/** Loopback-only server defaults shared by source and installed launches. */

export const DEV_HOST = "127.0.0.1";
export const DEV_DEFAULT_PORT = 17861;
export const DESKTOP_PORT_MESSAGE = "SUPERSTRING_DESKTOP_PORT ";

/** Retry the real bind, not a probe-then-release race. Port 0 asks the OS to choose. */
export function bindWithDesktopFallback<T>(
  preferred: number,
  enabled: boolean,
  bind: (port: number) => T,
): T {
  try {
    return bind(preferred);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (!enabled || (code !== "EADDRINUSE" && code !== "EACCES")) throw error;
    return bind(0);
  }
}

/**
 * Resolve the bind port from SUPERSTRING_DEV_PORT. Falls back to the product
 * default when unset/empty; throws on anything that is not a legal TCP port
 * (integer in 1..65535).
 */
export function resolveDevPort(
  raw: string | undefined,
  fallback: number = DEV_DEFAULT_PORT,
): number {
  const s = (raw ?? "").trim();
  if (s === "") return fallback;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `Invalid SUPERSTRING_DEV_PORT: ${JSON.stringify(raw)} (expected integer 1-65535)`,
    );
  }
  return n;
}
