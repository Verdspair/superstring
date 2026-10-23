/** Desktop-only closing behavior; stored as text because the preference store holds strings. */
export const CLOSE_ANIMATION_STORAGE_KEY = "superstring-close-animation";

/** The desktop bridge preserves these existing localStorage values, not arbitrary browser data. */
export const DESKTOP_PREFERENCE_KEYS = [
  "superstring-appearance",
  "superstring-appearance-mode",
  "superstring-appearance-font",
  "superstring-appearance-text-size",
  "superstring-appearance-interface-size",
  "superstring-locale",
  "superstring-session",
  "superstring-agent",
  CLOSE_ANIMATION_STORAGE_KEY,
] as const;

export type DesktopPreferenceKey = (typeof DESKTOP_PREFERENCE_KEYS)[number];
export type DesktopPreferenceSnapshot = Partial<Record<DesktopPreferenceKey, string | null>>;
export interface DesktopPreferencesBridge {
  load(): Promise<DesktopPreferenceSnapshot>;
  save(key: DesktopPreferenceKey, value: string | null): Promise<void>;
  bootstrapFailed(): Promise<void>;
}

export const DESKTOP_PREFERENCES_LOAD = "superstring:preferences:load";
export const DESKTOP_PREFERENCES_SAVE = "superstring:preferences:save";
export const DESKTOP_PREFERENCES_BOOTSTRAP_FAILED = "superstring:preferences:bootstrap-failed";

export function isDesktopPreferenceKey(value: unknown): value is DesktopPreferenceKey {
  return typeof value === "string" && DESKTOP_PREFERENCE_KEYS.some((key) => key === value);
}

/**
 * The close fold is on unless the user explicitly turned it off; absent and null keep it
 * enabled, so existing profiles gain the default without a stored migration.
 */
export function isCloseAnimationEnabled(value: unknown): boolean {
  return value !== "off";
}

declare global {
  interface Window {
    /** Only the isolated, sandboxed Electron preload installs this optional capability. */
    superstringPreferences?: DesktopPreferencesBridge;
  }
}
