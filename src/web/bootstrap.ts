import { restoreDesktopPreferences } from "./desktop-preferences";

export async function bootstrapWebApplication(render: () => Promise<unknown>): Promise<void> {
  try {
    await restoreDesktopPreferences();
  } catch {
    // Storage failure does not disable chat; the current origin retains its existing behavior.
    console.warn("DESKTOP_PREFERENCES_READ_FAILED");
  }
  await render();
}
