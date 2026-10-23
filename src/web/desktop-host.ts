import type { DesktopHostBridge } from "../shared/desktop-host";

export function getDesktopHost(): DesktopHostBridge | undefined {
  return typeof window === "undefined" ? undefined : window.superstringHost;
}

export function isDesktopHost(): boolean {
  return getDesktopHost()?.desktop === true;
}
