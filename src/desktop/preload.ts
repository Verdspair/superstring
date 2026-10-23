import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_MOTION_MANAGED,
  DESKTOP_STARTUP_LOGS,
  DESKTOP_STARTUP_RETRY,
  DESKTOP_STARTUP_STATE,
  DESKTOP_WORKSPACE_READY,
  type DesktopHostBridge,
  type DesktopStartupState,
} from "../shared/desktop-host";
import {
  DESKTOP_PREFERENCES_BOOTSTRAP_FAILED,
  DESKTOP_PREFERENCES_LOAD,
  DESKTOP_PREFERENCES_SAVE,
  type DesktopPreferencesBridge,
  isDesktopPreferenceSnapshot,
} from "../shared/desktop-preferences";

// This preload is bundled to CJS for sandboxed Electron. It exposes neither IPC nor Node APIs.
const preferences: DesktopPreferencesBridge = {
  load: () => ipcRenderer.invoke(DESKTOP_PREFERENCES_LOAD),
  bootstrapFailed: () => ipcRenderer.invoke(DESKTOP_PREFERENCES_BOOTSTRAP_FAILED),
  save: (snapshot) => {
    if (!isDesktopPreferenceSnapshot(snapshot))
      return Promise.reject(new Error("DESKTOP_PREFERENCE_INVALID"));
    return ipcRenderer.invoke(DESKTOP_PREFERENCES_SAVE, snapshot);
  },
};

const host: DesktopHostBridge = {
  desktop: true,
  platform: process.platform,
  motionManaged:
    process.platform === "win32" && ipcRenderer.sendSync(DESKTOP_MOTION_MANAGED) === true,
  onStartupState(listener) {
    const receive = (_event: Electron.IpcRendererEvent, state: DesktopStartupState) =>
      listener(state);
    ipcRenderer.on(DESKTOP_STARTUP_STATE, receive);
    return () => ipcRenderer.removeListener(DESKTOP_STARTUP_STATE, receive);
  },
  retry: () => ipcRenderer.invoke(DESKTOP_STARTUP_RETRY),
  openLogs: () => ipcRenderer.invoke(DESKTOP_STARTUP_LOGS),
  notifyWorkspaceReady: () => ipcRenderer.invoke(DESKTOP_WORKSPACE_READY),
};

contextBridge.exposeInMainWorld("superstringPreferences", preferences);
contextBridge.exposeInMainWorld("superstringHost", host);
