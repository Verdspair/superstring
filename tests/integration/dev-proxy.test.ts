import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { APP_VERSION } from "../../src/server/api/health";
import { resolveDevPort } from "../../src/server/dev-config";
import {
  API_EXACT_PATHS,
  API_PREFIXES,
  API_PROXY_KEYS,
  isApiPath,
} from "../../src/shared/api-routes";

const projectRoot = path.join(import.meta.dir, "../..");

function read(relative: string): string {
  return readFileSync(path.join(projectRoot, relative), "utf8");
}

/**
 * Every API path the browser client requests. The client uses RELATIVE paths,
 * so in dev they only work if `vite.config.ts` forwards them to the Bun server.
 * Extracting them from the source (rather than hard-coding a list that would
 * rot) is the point of this test.
 */
function clientApiPaths(): string[] {
  const source = read("src/web/api.ts");
  const found = new Set<string>();
  // Template paths keep their `${...}` placeholders: only the leading segment
  // matters for proxy coverage, and keeping the literal makes the set useful
  // for counting too.
  for (const match of source.matchAll(/["`](\/[A-Za-z0-9_\-/.${}]*)["`]/g)) {
    const literal = match[1];
    // A trailing "/" means the literal ended at a segment boundary.
    const cleaned = literal.replace(/\/$/, "");
    if (cleaned.length > 1) found.add(cleaned);
  }
  return [...found].sort();
}

describe("loopback port validation", () => {
  it("uses the default or a valid explicit port", () => {
    expect(resolveDevPort(undefined)).toBe(17861);
    expect(resolveDevPort("")).toBe(17861);
    expect(resolveDevPort("3000")).toBe(3000);
    expect(resolveDevPort("65535")).toBe(65535);
  });
  it("rejects invalid TCP ports", () => {
    for (const value of ["0", "70000", "abc", "-1", "1.5"]) {
      expect(() => resolveDevPort(value)).toThrow();
    }
  });
});

describe("dev API proxy coverage (#101)", () => {
  it("finds the client's API paths at all", () => {
    // Guards the extractor itself: if this drops to zero the assertions below
    // would pass vacuously and stop protecting anything.
    const paths = clientApiPaths();
    expect(paths.length).toBeGreaterThanOrEqual(18);
    expect(paths).toContain("/chat");
    expect(paths).toContain("/sessions");
    expect(paths).toContain("/agents");
  });

  it("covers every path the web client calls", () => {
    const uncovered: string[] = [];
    for (const clientPath of clientApiPaths()) {
      const firstSegment = `/${clientPath.split("/")[1]}`;
      if (!API_PROXY_KEYS.includes(firstSegment)) uncovered.push(clientPath);
      // The static host must refuse the SPA fallback for the same paths.
      if (!isApiPath(clientPath)) uncovered.push(`${clientPath} (isApiPath)`);
    }
    expect(uncovered).toEqual([]);
  });

  it("keeps the static-host whitelist and the proxy keys on one list", () => {
    // The whole reason `api-routes.ts` exists: both consumers read it instead of
    // repeating the prefixes. If someone inlines the list again, this fails.
    const viteConfig = read("vite.config.ts");
    expect(viteConfig).toContain("API_PROXY_KEYS");
    expect(viteConfig).not.toMatch(/["']\/(agents|sessions|models|browser-state)["']/);

    const serverIndex = read("src/server/index.ts");
    expect(serverIndex).toContain("isApiPath");
    expect(serverIndex).not.toMatch(/startsWith\(["']\/(agents|sessions|models)["']\)/);
  });

  it("matches exact paths exactly and prefixes by prefix", () => {
    expect(isApiPath("/chat")).toBe(true);
    expect(isApiPath("/health")).toBe(true);
    // `/chat` is an exact path: it must not swallow an unrelated SPA route.
    expect(isApiPath("/chatty")).toBe(false);
    expect(isApiPath("/agents/abc/memory/policy")).toBe(true);
    expect(isApiPath("/sessions")).toBe(true);
    expect(isApiPath("/models/local")).toBe(true);
    expect(isApiPath("/browser-state/config")).toBe(true);
    // SPA routes must stay SPA routes.
    expect(isApiPath("/")).toBe(false);
    expect(isApiPath("/index.html")).toBe(false);

    expect([...API_EXACT_PATHS]).toEqual(["/chat", "/health"]);
    expect(API_PREFIXES).toContain("/agents");
  });

  it("declares the proxy keys the Vite config expects", () => {
    for (const key of ["/__dev", "/agents", "/sessions", "/models", "/browser-state"]) {
      expect(API_PROXY_KEYS).toContain(key);
    }
    for (const key of API_EXACT_PATHS) expect(API_PROXY_KEYS).toContain(key);
  });
});

describe("build version consistency (#101)", () => {
  it("package.json names the same release /health reports", () => {
    // package.json must hold legal semver, so the alpha prerelease is spelled
    // "0.1.0-alpha" while the user-facing product string drops the separator:
    // "0.1.0alpha". Normalise by removing the hyphen and compare, so the two can
    // never drift into different releases.
    const pkg = JSON.parse(read("package.json")) as { version: string };
    expect(pkg.version.replace("-", "")).toBe(APP_VERSION);
    expect(APP_VERSION).toBe("0.1.0alpha");
    const lock = JSON.parse(read("package-lock.json"));
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
    expect(read("src/web/App.tsx")).toContain(`const VERSION = "${APP_VERSION}";`);
  });
});
