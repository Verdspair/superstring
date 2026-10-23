import { afterEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { installDesktopPreferences } from "../../src/desktop/preferences";
import { INTERFACE_SIZE_STORAGE_KEY, TEXT_SIZE_STORAGE_KEY } from "../../src/shared/appearance";
import {
  CLOSE_ANIMATION_STORAGE_KEY,
  DESKTOP_PREFERENCES_BOOTSTRAP_FAILED,
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
  const bootstrapErrors: string[] = [];
  const presentations: unknown[] = [];
  const dispose = await installDesktopPreferences({
    ipcMain,
    profileDirectory,
    webContents: () => owned,
    origin: () => origin,
    onChange: (snapshot) => presentations.push(structuredClone(snapshot)),
    onError: (code) => {
      errors.push(code);
    },
    onBootstrapError: (code) => {
      bootstrapErrors.push(code);
    },
  });
  disposers.push(dispose);
  return {
    profileDirectory,
    frame,
    contents,
    event,
    errors,
    bootstrapErrors,
    presentations,
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
  it("persists the nine raw values across a new port and process store, without crossing profiles", async () => {
    const first = await fixture();
    const ciphertext = "YWFhYWFhYWFhYWFhYWFhYQ==:YmJiYmJiYmJiYmJiYmJiYg==";
    const values = {
      "superstring-appearance": "jade",
      "superstring-appearance-mode": "dark",
      "superstring-appearance-font": "elegant",
      [TEXT_SIZE_STORAGE_KEY]: "large",
      [INTERFACE_SIZE_STORAGE_KEY]: "compact",
      "superstring-locale": "en",
      "superstring-session": ciphertext,
      "superstring-agent": `${ciphertext}${"x".repeat(32_000)}`,
      [CLOSE_ANIMATION_STORAGE_KEY]: "off",
    };
    expect(first.presentations).toEqual([{}]);
    for (const [key, value] of Object.entries(values))
      first.call(DESKTOP_PREFERENCES_SAVE, key, value);
    expect(first.presentations.at(-1)).toEqual(values);
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

  it("preserves explicit removal as a tombstone and disposes all IPC handlers", async () => {
    const current = await fixture();
    // The font key joins the whitelist: permitted, saved, and still schema-checked.
    current.call(DESKTOP_PREFERENCES_SAVE, "superstring-appearance-font", "cute");
    expect(current.call(DESKTOP_PREFERENCES_LOAD)).toEqual({
      "superstring-appearance-font": "cute",
    });
    expect(() =>
      current.call(DESKTOP_PREFERENCES_SAVE, "superstring-appearance-font", "not-a-font"),
    ).toThrow("DESKTOP_PREFERENCES_WRITE_FAILED");
    expect(current.call(DESKTOP_PREFERENCES_LOAD)).toEqual({
      "superstring-appearance-font": "cute",
    });
    current.call(DESKTOP_PREFERENCES_SAVE, "superstring-appearance-font", null);
    current.call(DESKTOP_PREFERENCES_SAVE, "superstring-agent", "ciphertext");
    current.call(DESKTOP_PREFERENCES_SAVE, "superstring-agent", null);
    expect(current.call(DESKTOP_PREFERENCES_LOAD)).toEqual({
      "superstring-appearance-font": null,
      "superstring-agent": null,
    });
    current.dispose();
    expect(current.handlers.size).toBe(0);
  });

  it("round-trips both size keys and rejects ids outside the approved enums", async () => {
    const current = await fixture();
    current.call(DESKTOP_PREFERENCES_SAVE, TEXT_SIZE_STORAGE_KEY, "small");
    current.call(DESKTOP_PREFERENCES_SAVE, INTERFACE_SIZE_STORAGE_KEY, "comfortable");
    expect(current.call(DESKTOP_PREFERENCES_LOAD)).toEqual({
      [TEXT_SIZE_STORAGE_KEY]: "small",
      [INTERFACE_SIZE_STORAGE_KEY]: "comfortable",
    });
    for (const [key, value] of [
      [TEXT_SIZE_STORAGE_KEY, "huge"],
      [TEXT_SIZE_STORAGE_KEY, "normal"],
      [INTERFACE_SIZE_STORAGE_KEY, "spacious"],
    ]) {
      expect(() => current.call(DESKTOP_PREFERENCES_SAVE, key, value)).toThrow(
        "DESKTOP_PREFERENCES_WRITE_FAILED",
      );
    }
    expect(current.call(DESKTOP_PREFERENCES_LOAD)).toEqual({
      [TEXT_SIZE_STORAGE_KEY]: "small",
      [INTERFACE_SIZE_STORAGE_KEY]: "comfortable",
    });
    current.call(DESKTOP_PREFERENCES_SAVE, TEXT_SIZE_STORAGE_KEY, null);
    current.call(DESKTOP_PREFERENCES_SAVE, INTERFACE_SIZE_STORAGE_KEY, "standard");
    expect(current.call(DESKTOP_PREFERENCES_LOAD)).toEqual({
      [TEXT_SIZE_STORAGE_KEY]: null,
      [INTERFACE_SIZE_STORAGE_KEY]: "standard",
    });
  });

  it("accepts only the close fold's on/off tombstone and rejects booleans or arbitrary strings", async () => {
    const current = await fixture();
    current.call(DESKTOP_PREFERENCES_SAVE, CLOSE_ANIMATION_STORAGE_KEY, "off");
    expect(current.call(DESKTOP_PREFERENCES_LOAD)).toEqual({
      [CLOSE_ANIMATION_STORAGE_KEY]: "off",
    });
    current.call(DESKTOP_PREFERENCES_SAVE, CLOSE_ANIMATION_STORAGE_KEY, "on");
    expect(current.call(DESKTOP_PREFERENCES_LOAD)).toEqual({
      [CLOSE_ANIMATION_STORAGE_KEY]: "on",
    });
    for (const value of [true, false, 1, {}]) {
      expect(() =>
        current.call(DESKTOP_PREFERENCES_SAVE, CLOSE_ANIMATION_STORAGE_KEY, value),
      ).toThrow("DESKTOP_PREFERENCE_INVALID");
    }
    for (const value of ["true", "false", "garbage", ""]) {
      expect(() =>
        current.call(DESKTOP_PREFERENCES_SAVE, CLOSE_ANIMATION_STORAGE_KEY, value),
      ).toThrow("DESKTOP_PREFERENCES_WRITE_FAILED");
    }
    expect(current.call(DESKTOP_PREFERENCES_LOAD)).toEqual({
      [CLOSE_ANIMATION_STORAGE_KEY]: "on",
    });
    current.call(DESKTOP_PREFERENCES_SAVE, CLOSE_ANIMATION_STORAGE_KEY, null);
    expect(current.call(DESKTOP_PREFERENCES_LOAD)).toEqual({
      [CLOSE_ANIMATION_STORAGE_KEY]: null,
    });
  });

  it("accepts only a trusted zero-argument bootstrap-failure signal", async () => {
    const current = await fixture();
    expect(() => current.call(DESKTOP_PREFERENCES_BOOTSTRAP_FAILED, "private error")).toThrow(
      "DESKTOP_PREFERENCE_INVALID",
    );
    expect(() =>
      current.from(
        { ...current.event, sender: {} } as unknown as IpcMainInvokeEvent,
        DESKTOP_PREFERENCES_BOOTSTRAP_FAILED,
      ),
    ).toThrow("DESKTOP_PREFERENCES_FORBIDDEN");
    expect(current.bootstrapErrors).toEqual([]);
    current.call(DESKTOP_PREFERENCES_BOOTSTRAP_FAILED);
    expect(current.bootstrapErrors).toEqual(["DESKTOP_PREFERENCES_BOOTSTRAP_FAILED"]);
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
