import {
  DESKTOP_PREFERENCE_KEYS,
  type DesktopPreferencesBridge,
  isDesktopPreferenceKey,
} from "../shared/desktop-preferences";

function bridge(): DesktopPreferencesBridge | undefined {
  return typeof window === "undefined" ? undefined : window.superstringPreferences;
}

/** Called only by existing preference mutations; never forwards unrelated localStorage keys. */
export async function persistDesktopPreference(key: string, value: string | null): Promise<void> {
  const preferences = bridge();
  if (!preferences || !isDesktopPreferenceKey(key)) return;
  try {
    await preferences.save(key, value);
  } catch {
    // Keep the current local preference usable. Main records its stable write-failure code.
    console.warn("DESKTOP_PREFERENCES_WRITE_FAILED");
  }
}

/** Run before importing any module that reads initial locale, appearance or selected IDs. */
export async function restoreDesktopPreferences(): Promise<void> {
  const preferences = bridge();
  if (!preferences) return;
  const values = await preferences.load();
  for (const key of DESKTOP_PREFERENCE_KEYS) {
    if (Object.hasOwn(values, key)) {
      const value = values[key];
      if (value === null) localStorage.removeItem(key);
      else if (typeof value === "string") localStorage.setItem(key, value);
    } else {
      // One-time adoption of these known preferences in an existing desktop origin. Never scan
      // browser profiles or copy unrelated keys, credentials, chats or third-party page data.
      const local = localStorage.getItem(key);
      if (local !== null) await persistDesktopPreference(key, local);
    }
  }
}
