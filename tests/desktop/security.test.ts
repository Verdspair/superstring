import { describe, expect, test } from "bun:test";
import type { Session, WebContents } from "electron";
import { externalHttpUrl, installSessionSecurity, isServiceUrl } from "../../src/desktop/security";

describe("desktop session boundary", () => {
  test("matches exact service origin for HTTP and lifetime socket", () => {
    const origin = "http://127.0.0.1:17861";
    expect(isServiceUrl(`${origin}/agents`, origin)).toBe(true);
    expect(isServiceUrl("ws://127.0.0.1:17861/__desktop/lifetime", origin)).toBe(true);
    expect(isServiceUrl("http://localhost:17861/agents", origin)).toBe(false);
    expect(isServiceUrl("http://127.0.0.1:17862/agents", origin)).toBe(false);
    expect(isServiceUrl("http://user@127.0.0.1:17861/agents", origin)).toBe(false);
    expect(isServiceUrl("blob:http://127.0.0.1:17861/html", origin)).toBe(false);
    expect(externalHttpUrl("file:///etc/passwd")).toBeNull();
    expect(externalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(externalHttpUrl("https://user:secret@example.com")).toBeNull();
    expect(externalHttpUrl("https://github.com/Verdspair/superstring")).toBe(
      "https://github.com/Verdspair/superstring",
    );
  });

  test("credentials cannot escape via redirects, forged headers or foreign contents", () => {
    let listener:
      | ((
          details: Electron.OnBeforeSendHeadersListenerDetails,
          callback: (response: Electron.BeforeSendResponse) => void,
        ) => void)
      | null = null;
    const session = {
      webRequest: {
        onBeforeSendHeaders: (handler: typeof listener) => {
          listener = handler;
        },
      },
      setPermissionCheckHandler() {},
      setPermissionRequestHandler() {},
      on() {},
    } as unknown as Session;
    let currentUrl = "";
    const contents = { id: 7, isDestroyed: () => false, getURL: () => currentUrl } as WebContents;
    const origin = "http://127.0.0.1:17861";
    installSessionSecurity(
      session,
      () => ({ origin, token: "host-credential" }),
      () => contents,
    );
    const headers = (changes: Partial<Electron.OnBeforeSendHeadersListenerDetails>) => {
      let result: Record<string, string | string[]> = {};
      const details = {
        webContentsId: 7,
        url: `${origin}/agents`,
        resourceType: "xhr",
        frame: { url: origin },
        requestHeaders: { "x-SUPERSTRING-desktop": "forged" },
        ...changes,
      } as Electron.OnBeforeSendHeadersListenerDetails;
      if (!listener) throw new Error("not installed");
      listener(details, (response) => {
        result = response.requestHeaders ?? {};
      });
      return result;
    };
    expect(headers({})).toEqual({ "X-Superstring-Desktop": "host-credential" });
    expect(headers({ url: "https://outside.example/" })).toEqual({});
    expect(headers({ webContentsId: 8 })).toEqual({});
    expect(headers({ frame: null })).toEqual({});
    expect(headers({ resourceType: "mainFrame", frame: null })).toEqual({
      "X-Superstring-Desktop": "host-credential",
    });
    expect(
      headers({
        resourceType: "mainFrame",
        frame: undefined,
        initiatorOrigin: "https://outside.example",
      }),
    ).toEqual({});
    expect(headers({ frame: { url: "https://outside.example" } as Electron.WebFrameMain })).toEqual(
      {},
    );
    expect(
      headers({
        resourceType: "mainFrame",
        frame: { url: "about:blank" } as Electron.WebFrameMain,
      }),
    ).toEqual({ "X-Superstring-Desktop": "host-credential" });
    currentUrl = "https://outside.example/";
    expect(headers({ resourceType: "mainFrame", frame: null })).toEqual({});
  });
});
