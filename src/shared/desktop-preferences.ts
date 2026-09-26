/** The desktop bridge preserves these existing localStorage values, not arbitrary browser data. */
export const DESKTOP_PREFERENCE_KEYS = [
  "superstring-appearance",
  "superstring-appearance-mode",
  "superstring-locale",
  "superstring-session",
  "superstring-agent",
] as const;

export type DesktopPreferenceKey = (typeof DESKTOP_PREFERENCE_KEYS)[number];
export type DesktopPreferenceSnapshot = Partial<Record<DesktopPreferenceKey, string | null>>;
export interface DesktopPreferencesBridge {
  load(): Promise<DesktopPreferenceSnapshot>;
  save(key: DesktopPreferenceKey, value: string | null): Promise<void>;
}

export const DESKTOP_PREFERENCES_LOAD = "superstring:preferences:load";
export const DESKTOP_PREFERENCES_SAVE = "superstring:preferences:save";

export function isDesktopPreferenceKey(value: unknown): value is DesktopPreferenceKey {
  return typeof value === "string" && DESKTOP_PREFERENCE_KEYS.some((key) => key === value);
}

declare global {
  interface Window {
    /** Only the isolated, sandboxed Electron preload installs this optional capability. */
    superstringPreferences?: DesktopPreferencesBridge;
  }
}
