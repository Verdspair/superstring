import {
  DESKTOP_PREFERENCE_KEYS,
  type DesktopPreferenceSnapshot,
  type DesktopPreferencesBridge,
  isDesktopPreferenceKey,
} from "../shared/desktop-preferences";

function bridge(): DesktopPreferencesBridge | undefined {
  return typeof window === "undefined" ? undefined : window.superstringPreferences;
}

/** One bridge write for one snapshot; never forwards unrelated localStorage keys. */
async function saveSnapshot(snapshot: DesktopPreferenceSnapshot): Promise<void> {
  const preferences = bridge();
  if (!preferences || Object.keys(snapshot).length === 0) return;
  try {
    await preferences.save(snapshot);
  } catch {
    // Keep the current local preference usable. Main records its stable write-failure code.
    console.warn("DESKTOP_PREFERENCES_WRITE_FAILED");
  }
}

/** Called only by existing preference mutations; never forwards unrelated localStorage keys. */
export async function persistDesktopPreference(key: string, value: string | null): Promise<void> {
  if (!isDesktopPreferenceKey(key)) return;
  await saveSnapshot({ [key]: value });
}

/** Run before importing any module that reads initial locale, appearance or selected IDs. */
export async function restoreDesktopPreferences(): Promise<void> {
  const preferences = bridge();
  if (!preferences) return;
  const values = await preferences.load();
  // One-time adoption of known preferences in an existing desktop origin: collected into a
  // single snapshot so an upgraded profile writes once. Never scan browser profiles or copy
  // unrelated keys, credentials, chats or third-party page data.
  const adoption: DesktopPreferenceSnapshot = {};
  for (const key of DESKTOP_PREFERENCE_KEYS) {
    if (Object.hasOwn(values, key)) {
      const value = values[key];
      if (value === null) localStorage.removeItem(key);
      else if (typeof value === "string") localStorage.setItem(key, value);
    } else {
      const local = localStorage.getItem(key);
      if (local !== null) adoption[key] = local;
    }
  }
  await saveSnapshot(adoption);
}
