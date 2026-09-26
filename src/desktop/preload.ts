import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_PREFERENCES_BOOTSTRAP_FAILED,
  DESKTOP_PREFERENCES_LOAD,
  DESKTOP_PREFERENCES_SAVE,
  type DesktopPreferencesBridge,
  isDesktopPreferenceKey,
} from "../shared/desktop-preferences";

// This preload is bundled to CJS for sandboxed Electron. It exposes neither IPC nor Node APIs.
const preferences: DesktopPreferencesBridge = {
  load: () => ipcRenderer.invoke(DESKTOP_PREFERENCES_LOAD),
  bootstrapFailed: () => ipcRenderer.invoke(DESKTOP_PREFERENCES_BOOTSTRAP_FAILED),
  save: (key, value) => {
    if (!isDesktopPreferenceKey(key) || (value !== null && typeof value !== "string")) {
      return Promise.reject(new Error("DESKTOP_PREFERENCE_INVALID"));
    }
    return ipcRenderer.invoke(DESKTOP_PREFERENCES_SAVE, key, value);
  },
};
contextBridge.exposeInMainWorld("superstringPreferences", preferences);
