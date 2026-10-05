// §12's close preference (ADR0018/U07): the state the 通用 settings page reads and writes.

import type { SuperstringApi } from "../../api";
import type { StoreGet, StoreSet } from "../../state/types";

export interface DesktopReadOptions {
  refresh?: boolean;
  background?: boolean;
}

export interface DesktopSettingsState {
  desktopCloseAction: "background" | "exit" | null;
  desktopCloseRevision: number;
  desktopSettingsLoading: boolean;
  desktopSettingsSaving: boolean;
  loadDesktopSettings: (options?: boolean | DesktopReadOptions) => Promise<void>;
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
  let readGeneration = 0;
  let desktopInFlight: { promise: Promise<void>; generation: number; api: SuperstringApi } | null =
    null;
  return {
    loadDesktopSettings: async (options = false) => {
      const refresh = typeof options === "boolean" ? options : !!options?.refresh;
      const background = typeof options === "object" && !!options?.background;
      const api = get().apiClient;

      if (!refresh && desktopInFlight && desktopInFlight.api === api) {
        return desktopInFlight.promise;
      }

      const isLoaded = get().desktopCloseAction !== null || get().desktopCloseRevision > 0;
      if (!refresh && isLoaded && background) return;

      const isQuietRevalidate = !refresh && isLoaded;

      if (get().desktopSettingsSaving) return;
      const generation = ++readGeneration;
      if (!isQuietRevalidate && !background) {
        set({ desktopSettingsLoading: true, error: null });
      } else if (!isQuietRevalidate) {
        set({ desktopSettingsLoading: true });
      }

      const execute = async () => {
        try {
          const settings = await api.getDesktopSettings();
          if (generation !== readGeneration || get().apiClient !== api) return;
          set({
            desktopCloseAction: settings.close_action,
            desktopCloseRevision: settings.revision,
          });
        } catch (error) {
          if (generation !== readGeneration || get().apiClient !== api) return;
          if (!background && !isQuietRevalidate) {
            set({ error: error instanceof Error ? error.message : String(error), feedback: "" });
          }
        } finally {
          if (generation === readGeneration) {
            set({ desktopSettingsLoading: false });
          }
          if (desktopInFlight?.generation === generation) {
            desktopInFlight = null;
          }
        }
      };

      const promise = execute();
      desktopInFlight = { promise, generation, api };
      return promise;
    },
    updateDesktopCloseAction: async (action) => {
      if (get().desktopSettingsSaving) return false;
      readGeneration += 1;
      desktopInFlight = null;
      set({
        desktopSettingsSaving: true,
        desktopSettingsLoading: false,
        error: null,
        feedback: "",
      });
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
