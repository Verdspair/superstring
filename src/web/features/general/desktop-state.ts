// §12's close preference (ADR0018/U07): the state the 通用 settings page reads and writes.

import type { StoreGet, StoreSet } from "../../state/types";

export interface DesktopSettingsState {
  desktopCloseAction: "background" | "exit" | null;
  desktopCloseRevision: number;
  desktopSettingsLoading: boolean;
  desktopSettingsSaving: boolean;
  loadDesktopSettings: () => Promise<void>;
  updateDesktopCloseAction: (action: "background" | "exit") => Promise<boolean>;
}

export const desktopSettingsInitial = {
  desktopCloseAction: null as DesktopSettingsState["desktopCloseAction"],
  desktopCloseRevision: 0,
  desktopSettingsLoading: false,
  desktopSettingsSaving: false,
};

export function createDesktopSettingsActions(
  set: StoreSet,
  get: StoreGet,
): Pick<DesktopSettingsState, "loadDesktopSettings" | "updateDesktopCloseAction"> {
  return {
    loadDesktopSettings: async () => {
      if (get().desktopSettingsLoading) return;
      set({ desktopSettingsLoading: true, error: null });
      try {
        const settings = await get().apiClient.getDesktopSettings();
        set({
          desktopCloseAction: settings.close_action,
          desktopCloseRevision: settings.revision,
        });
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error), feedback: "" });
      } finally {
        set({ desktopSettingsLoading: false });
      }
    },
    updateDesktopCloseAction: async (action) => {
      if (get().desktopSettingsSaving) return false;
      set({ desktopSettingsSaving: true, error: null, feedback: "" });
      try {
        const settings = await get().apiClient.updateDesktopSettings({
          close_action: action,
          expected_revision: get().desktopCloseRevision,
        });
        set({
          desktopCloseAction: settings.close_action,
          desktopCloseRevision: settings.revision,
          feedback: action === "background" ? "关闭窗口后将保持后台在线" : "关闭窗口后将完全退出",
        });
        return true;
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error), feedback: "" });
        return false;
      } finally {
        set({ desktopSettingsSaving: false });
      }
    },
  };
}
