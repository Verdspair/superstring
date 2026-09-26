import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { MODE_IDS, THEME_IDS } from "../shared/appearance";
import {
  DESKTOP_PREFERENCE_KEYS,
  DESKTOP_PREFERENCES_BOOTSTRAP_FAILED,
  DESKTOP_PREFERENCES_LOAD,
  DESKTOP_PREFERENCES_SAVE,
  type DesktopPreferenceSnapshot,
  isDesktopPreferenceKey,
} from "../shared/desktop-preferences";

export type DesktopPreferencesError =
  | "DESKTOP_PREFERENCES_READ_FAILED"
  | "DESKTOP_PREFERENCES_WRITE_FAILED";

export interface DesktopPreferencesOptions {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  profileDirectory: string;
  /** Live getters also reject the previous renderer after retry or sidecar replacement. */
  webContents: () => WebContents | null;
  origin: () => string | null;
  onError?: (code: DesktopPreferencesError) => void;
  onBootstrapError?: (code: "DESKTOP_PREFERENCES_BOOTSTRAP_FAILED") => void;
}

function assertSender(event: IpcMainInvokeEvent, options: DesktopPreferencesOptions): void {
  const owned = options.webContents();
  const origin = options.origin();
  if (
    !owned ||
    owned.isDestroyed() ||
    event.sender !== owned ||
    !event.senderFrame ||
    event.senderFrame !== owned.mainFrame ||
    !origin
  ) {
    throw new Error("DESKTOP_PREFERENCES_FORBIDDEN");
  }
  try {
    if (new URL(event.senderFrame.url).origin === origin) return;
  } catch {
    // A destroyed or not-yet-navigated frame is not an authorized app frame.
  }
  throw new Error("DESKTOP_PREFERENCES_FORBIDDEN");
}

/** Install before loading the app page; dispose when the owning main process is shutting down. */
export async function installDesktopPreferences(
  options: DesktopPreferencesOptions,
): Promise<() => void> {
  // Keep Electron Store in main: sandboxed preload must never import its filesystem dependency.
  const { default: Store } = await import("electron-store");
  const nullableEnum = (values: readonly string[]) => ({
    type: ["string", "null"] as const,
    enum: [...values, null],
  });
  const store = new Store<DesktopPreferenceSnapshot>({
    cwd: path.join(options.profileDirectory, "state"),
    name: "desktop-preferences",
    accessPropertiesByDotNotation: false,
    clearInvalidConfig: false,
    rootSchema: { additionalProperties: false },
    schema: {
      "superstring-appearance": nullableEnum(THEME_IDS),
      "superstring-appearance-mode": nullableEnum(MODE_IDS),
      "superstring-locale": nullableEnum(["zh-CN", "en"]),
      "superstring-session": { type: ["string", "null"] },
      "superstring-agent": { type: ["string", "null"] },
    },
  });
  const fail = (code: DesktopPreferencesError): never => {
    options.onError?.(code);
    throw new Error(code);
  };
  options.ipcMain.handle(DESKTOP_PREFERENCES_LOAD, (event, ...args: unknown[]) => {
    assertSender(event, options);
    if (args.length !== 0) throw new Error("DESKTOP_PREFERENCE_INVALID");
    try {
      const stored = store.store;
      const result: DesktopPreferenceSnapshot = {};
      for (const key of DESKTOP_PREFERENCE_KEYS) {
        if (Object.hasOwn(stored, key)) result[key] = stored[key];
      }
      return result;
    } catch {
      return fail("DESKTOP_PREFERENCES_READ_FAILED");
    }
  });
  options.ipcMain.handle(DESKTOP_PREFERENCES_SAVE, (event, ...args: unknown[]) => {
    assertSender(event, options);
    const [key, value] = args;
    if (
      args.length !== 2 ||
      !isDesktopPreferenceKey(key) ||
      (value !== null && typeof value !== "string")
    ) {
      throw new Error("DESKTOP_PREFERENCE_INVALID");
    }
    try {
      // A stored null is a tombstone. On another port it must clear an older local value.
      store.set(key, value);
    } catch {
      return fail("DESKTOP_PREFERENCES_WRITE_FAILED");
    }
  });
  options.ipcMain.handle(DESKTOP_PREFERENCES_BOOTSTRAP_FAILED, (event, ...args: unknown[]) => {
    assertSender(event, options);
    if (args.length !== 0) throw new Error("DESKTOP_PREFERENCE_INVALID");
    options.onBootstrapError?.("DESKTOP_PREFERENCES_BOOTSTRAP_FAILED");
  });
  return () => {
    options.ipcMain.removeHandler(DESKTOP_PREFERENCES_LOAD);
    options.ipcMain.removeHandler(DESKTOP_PREFERENCES_SAVE);
    options.ipcMain.removeHandler(DESKTOP_PREFERENCES_BOOTSTRAP_FAILED);
  };
}
