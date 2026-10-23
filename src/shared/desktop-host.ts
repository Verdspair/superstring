import type { AppearanceMode, FontId, InterfaceSizeId, TextSizeId, ThemeId } from "./appearance";

export interface DesktopStartupPresentation {
  locale: "zh-CN" | "en";
  theme: ThemeId;
  mode: AppearanceMode;
  font: FontId;
  textSize: TextSizeId;
  interfaceSize: InterfaceSizeId;
  dark: boolean;
  css: string;
}
export type DesktopStartupState = {
  phase: "starting" | "failed" | "handoff";
  message: string;
  presentation?: DesktopStartupPresentation;
};

export interface DesktopHostBridge {
  readonly desktop: true;
  readonly platform: string;
  /** True only when the main-process window-motion controller is actually active. */
  readonly motionManaged: boolean;
  onStartupState(listener: (state: DesktopStartupState) => void): () => void;
  retry(): Promise<void>;
  openLogs(): Promise<void>;
  notifyWorkspaceReady(): Promise<void>;
}

export const DESKTOP_STARTUP_STATE = "superstring:startup:state";
export const DESKTOP_STARTUP_RETRY = "superstring:startup:retry";
export const DESKTOP_STARTUP_LOGS = "superstring:startup:logs";
export const DESKTOP_WORKSPACE_READY = "superstring:workspace:ready";
export const DESKTOP_MOTION_MANAGED = "superstring:motion:managed";

declare global {
  interface Window {
    readonly superstringHost?: DesktopHostBridge;
  }
}
