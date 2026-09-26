import { afterEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { installDesktopPreferences } from "../../src/desktop/preferences";
import {
  DESKTOP_PREFERENCES_LOAD,
  DESKTOP_PREFERENCES_SAVE,
} from "../../src/shared/desktop-preferences";

// Electron itself is not downloaded or launched. Persistence uses the real electron-store/Conf
// implementation against temporary profiles, while this replaces only Electron process APIs.
mock.module("electron", () => ({
  default: {
    app: { getPath: () => tmpdir(), getVersion: () => "0.2.1" },
    ipcMain: new EventEmitter(),
  },
}));

const directories: string[] = [];
const disposers: Array<() => void> = [];
const directory = () => {
  const value = mkdtempSync(path.join(tmpdir(), "superstring-preferences-"));
  directories.push(value);
  return value;
};
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true });
});

async function fixture(profileDirectory = directory()) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipcMain: Pick<IpcMain, "handle" | "removeHandler"> = {
    handle: (name, handler) => {
      handlers.set(name, handler);
    },
    removeHandler: (name) => {
      handlers.delete(name);
    },
  };
  let origin: string | null = "http://127.0.0.1:19111";
  const frame = { url: `${origin}/` };
  let destroyed = false;
  const contents = { mainFrame: frame, isDestroyed: () => destroyed } as unknown as WebContents;
  let owned: WebContents | null = contents;
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const errors: string[] = [];
  const dispose = await installDesktopPreferences({
    ipcMain,
    profileDirectory,
    webContents: () => owned,
    origin: () => origin,
    onError: (code) => {
      errors.push(code);
    },
  });
  disposers.push(dispose);
  return {
    profileDirectory,
    frame,
    contents,
    event,
    errors,
    dispose,
    handlers,
    call(name: string, ...args: unknown[]) {
      const handler = handlers.get(name);
      if (!handler) throw new Error("TEST_HANDLER_MISSING");
      return handler(event, ...args);
    },
    from(sender: IpcMainInvokeEvent, name: string, ...args: unknown[]) {
      const handler = handlers.get(name);
      if (!handler) throw new Error("TEST_HANDLER_MISSING");
      return handler(sender, ...args);
    },
    replaceOrigin(value: string | null) {
      origin = value;
    },
    replaceOwned(value: WebContents | null) {
      owned = value;
    },
    destroy() {
      destroyed = true;
    },
  };
}

describe("desktop profile preference IPC", () => {
  it("persists the five raw values across a new port and process store, without crossing profiles", async () => {
    const first = await fixture();
    const ciphertext = "YWFhYWFhYWFhYWFhYWFhYQ==:YmJiYmJiYmJiYmJiYmJiYg==";
    const values = {
      "superstring-appearance": "jade",
      "superstring-appearance-mode": "dark",
      "superstring-locale": "en",
      "superstring-session": ciphertext,
      "superstring-agent": `${ciphertext}${"x".repeat(32_000)}`,
    };
    for (const [key, value] of Object.entries(values))
      first.call(DESKTOP_PREFERENCES_SAVE, key, value);
    first.dispose();

    const restarted = await fixture(first.profileDirectory);
    restarted.replaceOrigin("http://127.0.0.1:19222");
    restarted.frame.url = "http://127.0.0.1:19222/";
    expect(restarted.call(DESKTOP_PREFERENCES_LOAD)).toEqual(values);
    expect((await fixture()).call(DESKTOP_PREFERENCES_LOAD)).toEqual({});
    const file = path.join(first.profileDirectory, "state", "desktop-preferences.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(values);
  });

  it("rejects foreign contents, subframes, navigated pages, stale origins and destroyed senders", async () => {
    const current = await fixture();
    current.call(DESKTOP_PREFERENCES_SAVE, "superstring-locale", "en");
    for (const event of [
      { ...current.event, sender: {} },
      { ...current.event, senderFrame: { url: current.frame.url } },
      { ...current.event, senderFrame: null },
    ]) {
      expect(() =>
        current.from(event as unknown as IpcMainInvokeEvent, DESKTOP_PREFERENCES_LOAD),
      ).toThrow("DESKTOP_PREFERENCES_FORBIDDEN");
      expect(() =>
        current.from(
          event as unknown as IpcMainInvokeEvent,
          DESKTOP_PREFERENCES_SAVE,
          "superstring-locale",
          "zh-CN",
        ),
      ).toThrow("DESKTOP_PREFERENCES_FORBIDDEN");
    }
    for (const url of [
      "about:blank",
      "https://example.test",
      "http://127.0.0.1:19111.evil.test/",
    ]) {
      current.frame.url = url;
      expect(() => current.call(DESKTOP_PREFERENCES_LOAD)).toThrow("DESKTOP_PREFERENCES_FORBIDDEN");
    }
    current.frame.url = "http://127.0.0.1:19111/";
    current.replaceOrigin("http://127.0.0.1:19222");
    expect(() => current.call(DESKTOP_PREFERENCES_LOAD)).toThrow("DESKTOP_PREFERENCES_FORBIDDEN");
    current.replaceOrigin(null);
    expect(() => current.call(DESKTOP_PREFERENCES_LOAD)).toThrow("DESKTOP_PREFERENCES_FORBIDDEN");
    current.replaceOrigin("http://127.0.0.1:19111");
    current.replaceOwned(null);
    expect(() => current.call(DESKTOP_PREFERENCES_LOAD)).toThrow("DESKTOP_PREFERENCES_FORBIDDEN");
    current.replaceOwned(current.contents);
    current.destroy();
    expect(() => current.call(DESKTOP_PREFERENCES_LOAD)).toThrow("DESKTOP_PREFERENCES_FORBIDDEN");
  });

  it("rejects unrelated keys, path access and malformed payloads without mutating saved settings", async () => {
    const current = await fixture();
    current.call(DESKTOP_PREFERENCES_SAVE, "superstring-locale", "en");
    for (const args of [
      ["token", "secret"],
      ["superstring-locale.nested", "en"],
      ["__proto__", "x"],
      ["superstring-session", {}],
      ["superstring-agent"],
      ["superstring-locale", "en", "extra"],
    ]) {
      expect(() => current.call(DESKTOP_PREFERENCES_SAVE, ...args)).toThrow(
        "DESKTOP_PREFERENCE_INVALID",
      );
    }
    expect(() => current.call(DESKTOP_PREFERENCES_LOAD, "any-key")).toThrow(
      "DESKTOP_PREFERENCE_INVALID",
    );
    expect(() => current.call(DESKTOP_PREFERENCES_SAVE, "superstring-locale", "arbitrary")).toThrow(
      "DESKTOP_PREFERENCES_WRITE_FAILED",
    );
    expect(current.call(DESKTOP_PREFERENCES_LOAD)).toEqual({ "superstring-locale": "en" });
    expect(current.errors).toEqual(["DESKTOP_PREFERENCES_WRITE_FAILED"]);
  });

  it("preserves explicit removal as a tombstone and disposes both IPC handlers", async () => {
    const current = await fixture();
    current.call(DESKTOP_PREFERENCES_SAVE, "superstring-agent", "ciphertext");
    current.call(DESKTOP_PREFERENCES_SAVE, "superstring-agent", null);
    expect(current.call(DESKTOP_PREFERENCES_LOAD)).toEqual({ "superstring-agent": null });
    current.dispose();
    expect(current.handlers.size).toBe(0);
  });

  it("does not silently reset a corrupt profile store", async () => {
    const first = await fixture();
    first.call(DESKTOP_PREFERENCES_SAVE, "superstring-locale", "en");
    first.dispose();
    const file = path.join(first.profileDirectory, "state", "desktop-preferences.json");
    writeFileSync(file, "corrupt preference data");
    await expect(fixture(first.profileDirectory)).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe("corrupt preference data");
  });
});
