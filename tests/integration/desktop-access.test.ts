import { describe, expect, it } from "bun:test";
import type { Server } from "bun";
import {
  createDesktopAccess,
  DESKTOP_ACCESS_HEADER,
  type DesktopAccessOptions,
} from "../../src/server/desktop-access";
import { createDesktopLifecycle } from "../../src/server/desktop-lifecycle";

const TOKEN = "a1".repeat(32);
const ORIGIN = "http://127.0.0.1:17861";
const managed = {
  SUPERSTRING_APP_MODE: "desktop",
  SUPERSTRING_DESKTOP_MANAGED: "1",
  SUPERSTRING_DESKTOP_TOKEN: TOKEN,
};

function gate(env: DesktopAccessOptions["env"] = managed) {
  return createDesktopAccess({ env, origin: () => ORIGIN });
}

function request(path: string, headers: HeadersInit = {}, method = "GET") {
  return new Request(`${ORIGIN}${path}`, { headers, method });
}

describe("managed desktop access", () => {
  it("leaves browser and legacy Windows launches on their existing protocol", () => {
    for (const env of [
      {},
      { SUPERSTRING_APP_MODE: "development" },
      { SUPERSTRING_APP_MODE: "installed", SUPERSTRING_DESKTOP_TOKEN: TOKEN },
      { SUPERSTRING_DESKTOP_TOKEN: TOKEN },
    ]) {
      expect(gate(env)(request("/v2/conversations"))).toBeNull();
      expect(
        gate(env)(request("/__desktop/lifetime", { origin: "https://example.test" })),
      ).toBeNull();
    }
  });

  it("refuses to start a new desktop mode with missing or malformed managed credentials", () => {
    for (const overrides of [
      { SUPERSTRING_DESKTOP_MANAGED: undefined },
      { SUPERSTRING_DESKTOP_MANAGED: "0" },
      { SUPERSTRING_DESKTOP_TOKEN: undefined },
      { SUPERSTRING_DESKTOP_TOKEN: "" },
      { SUPERSTRING_DESKTOP_TOKEN: "a".repeat(63) },
      { SUPERSTRING_DESKTOP_TOKEN: "g".repeat(64) },
    ]) {
      expect(() => gate({ ...managed, ...overrides })).toThrow(
        "DESKTOP_ACCESS_CONFIGURATION_INVALID",
      );
    }
  });

  it("requires the credential for static files, API reads, SSE, mutations and WS upgrades", async () => {
    const access = gate();
    for (const path of [
      "/",
      "/assets/index.js",
      "/browser-state/config",
      "/v2/conversations",
      "/v2/chat",
      "/__desktop/lifetime",
    ]) {
      const headers = {
        origin: ORIGIN,
        upgrade: "websocket",
        accept: "text/event-stream",
      };
      const denied = access(request(path, headers));
      expect(denied?.status).toBe(403);
      expect(await denied?.text()).toBe("Forbidden");
      expect(denied?.headers.get("cache-control")).toBe("no-store");
      expect(denied?.headers.has("access-control-allow-origin")).toBe(false);
      expect(access(request(path, { ...headers, [DESKTOP_ACCESS_HEADER]: TOKEN }))).toBeNull();
    }
    expect(access(request("/v2/chat", { "content-type": "text/plain" }, "POST"))?.status).toBe(403);
    expect(access(request("/v2/chat", { [DESKTOP_ACCESS_HEADER]: TOKEN }, "POST"))).toBeNull();
    expect(access(request("/v2/chat", { origin: ORIGIN }, "OPTIONS"))?.status).toBe(403);
  });

  it("does not accept URL, cookie, malformed, duplicate or unrelated bearer credentials", () => {
    const access = gate();
    for (const headers of [
      { [DESKTOP_ACCESS_HEADER]: "b2".repeat(32) },
      { [DESKTOP_ACCESS_HEADER]: `${TOKEN}, ${TOKEN}` },
      { [DESKTOP_ACCESS_HEADER]: "é".repeat(64) },
      { authorization: `Bearer ${TOKEN}` },
      { cookie: `${DESKTOP_ACCESS_HEADER}=${TOKEN}` },
    ]) {
      expect(access(request(`/browser-state/config?token=${TOKEN}`, headers))?.status).toBe(403);
    }
  });

  it("matches the bound origin and Host rather than a localhost-looking prefix", () => {
    const access = gate();
    for (const origin of [
      "http://localhost:17861",
      "http://127.0.0.1:17862",
      "http://127.0.0.1.evil.test:17861",
      "https://127.0.0.1:17861",
    ]) {
      expect(
        access(new Request(`${origin}/`, { headers: { [DESKTOP_ACCESS_HEADER]: TOKEN } }))?.status,
      ).toBe(403);
    }
    expect(
      access(request("/", { [DESKTOP_ACCESS_HEADER]: TOKEN, host: "evil.test" }))?.status,
    ).toBe(403);
    expect(
      access(request("/", { [DESKTOP_ACCESS_HEADER]: TOKEN, host: "127.0.0.1:17861" })),
    ).toBeNull();
    for (const origin of ["null", "https://example.test", `${ORIGIN}/`, "http://127.0.0.1:17862"]) {
      expect(access(request("/", { [DESKTOP_ACCESS_HEADER]: TOKEN, origin }))?.status).toBe(403);
    }
  });

  it("reads the actual bound port lazily and accepts equivalent WS transport origin", () => {
    let port = 0;
    const access = createDesktopAccess({ env: managed, origin: () => `http://127.0.0.1:${port}` });
    port = 17861;
    expect(access(request("/", { [DESKTOP_ACCESS_HEADER]: TOKEN }))).toBeNull();
    expect(
      access(
        new Request("ws://127.0.0.1:17861/__desktop/lifetime", {
          headers: { [DESKTOP_ACCESS_HEADER]: TOKEN, origin: ORIGIN, upgrade: "websocket" },
        }),
      ),
    ).toBeNull();
    port = 17862;
    expect(access(request("/", { [DESKTOP_ACCESS_HEADER]: TOKEN }))?.status).toBe(403);
  });

  it("permits native control Bearer without Origin but retains route method and WS checks", () => {
    const access = gate();
    const desktop = createDesktopLifecycle({
      token: TOKEN,
      host: "127.0.0.1",
      port: 17861,
      onStop() {},
    });
    let upgrades = 0;
    const server = {
      upgrade: () => {
        upgrades++;
        return true;
      },
    } as unknown as Server<{ alive: boolean }>;
    const dispatch = (req: Request) => access(req) ?? desktop.handle(req, server).response;

    const nativeHeaders = { authorization: `Bearer ${TOKEN}` };
    expect(dispatch(request("/__desktop/status", nativeHeaders))?.status).toBe(200);
    expect(dispatch(request("/__desktop/stop", nativeHeaders))?.status).toBe(405);
    expect(
      dispatch(
        request("/__desktop/lifetime", { [DESKTOP_ACCESS_HEADER]: TOKEN, upgrade: "websocket" }),
      )?.status,
    ).toBe(403);
    expect(upgrades).toBe(0);
    const websocket = request("/__desktop/lifetime", {
      [DESKTOP_ACCESS_HEADER]: TOKEN,
      origin: ORIGIN,
      upgrade: "websocket",
    });
    expect(access(websocket)).toBeNull();
    expect(desktop.handle(websocket, server).upgraded).toBe(true);
    expect(upgrades).toBe(1);
  });
});
