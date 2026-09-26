import { restoreDesktopPreferences } from "./desktop-preferences";

export async function bootstrapWebApplication(render: () => Promise<unknown>): Promise<void> {
  try {
    await restoreDesktopPreferences();
    await render();
  } catch (error) {
    const preferences = typeof window === "undefined" ? undefined : window.superstringPreferences;
    if (!preferences) throw error;
    // A managed window must surface startup failure through native UI, even when React/i18n
    // could not load. The bridge transmits no raw exception or renderer-provided message.
    await preferences.bootstrapFailed();
  }
}
