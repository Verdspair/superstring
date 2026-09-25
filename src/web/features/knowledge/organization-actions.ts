import { OrganizationSettingsUpdateSchema } from "../../../shared/contracts/organization";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import { type KnowledgeState, organizationDirty } from "./types";

export function createOrganizationActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  KnowledgeState,
  | "loadOrganization"
  | "patchOrganization"
  | "patchOrganizationPurposes"
  | "saveOrganization"
  | "discardOrganization"
> {
  let read = 0;
  return {
    loadOrganization: async (refresh = false) => {
      if (
        get().organizationLoading ||
        get().settingsSaving ||
        (get().organizationEditor && !refresh)
      )
        return;
      const request = ++read;
      const previous = get().organizationEditor;
      set({ organizationLoading: true, organizationError: null });
      try {
        const source = await get().apiClient.getOrganizationSettings();
        if (request !== read) return;
        set({
          organizationEditor: {
            token: previous?.token ?? {},
            source,
            modelName:
              previous && organizationDirty(previous) ? previous.modelName : source.model_name,
            visionModelName:
              previous && organizationDirty(previous)
                ? previous.visionModelName
                : source.vision_model_name,
            transcriptionModelName:
              previous && organizationDirty(previous)
                ? previous.transcriptionModelName
                : source.transcription_model_name,
          },
          error: null,
        });
      } catch (error) {
        if (request === read) set({ organizationError: errorText(error) });
      } finally {
        if (request === read) set({ organizationLoading: false });
      }
    },
    patchOrganization: (modelName) => {
      const editor = get().organizationEditor;
      if (!editor || get().organizationLoading || get().settingsSaving) return;
      set({ organizationEditor: { ...editor, modelName }, feedback: "" });
    },
    patchOrganizationPurposes: (patch) => {
      const editor = get().organizationEditor;
      if (!editor || get().organizationLoading || get().settingsSaving) return;
      set({ organizationEditor: { ...editor, ...patch }, feedback: "" });
    },
    saveOrganization: async () => {
      const editor = get().organizationEditor;
      if (!organizationDirty(editor)) return true;
      if (!editor || get().settingsSaving || get().organizationLoading || get().knowledgeBusy)
        return false;
      set({ settingsSaving: true, error: null, feedback: "" });
      try {
        const saved = await get().apiClient.saveOrganizationSettings(
          OrganizationSettingsUpdateSchema.parse({
            expected_revision: editor.source.revision,
            model_name: editor.modelName,
            vision_model_name: editor.visionModelName,
            transcription_model_name: editor.transcriptionModelName,
          }),
        );
        if (get().organizationEditor?.token !== editor.token) return false;
        set({
          organizationEditor: {
            ...editor,
            source: saved,
            modelName: saved.model_name,
            visionModelName: saved.vision_model_name,
            transcriptionModelName: saved.transcription_model_name,
          },
          feedback: msg("默认模型已保存；已有明确覆盖和其他草稿保持不变。"),
        });
        return true;
      } catch (error) {
        if (get().organizationEditor?.token === editor.token) set({ error: errorText(error) });
        return false;
      } finally {
        set({ settingsSaving: false });
      }
    },
    discardOrganization: () => {
      if (get().settingsSaving) return;
      read++;
      set({
        organizationEditor: null,
        organizationLoading: false,
        organizationError: null,
      });
    },
  };
}
