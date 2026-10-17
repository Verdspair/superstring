import type { GlobalAuxiliaryAllocation } from "../../../shared/contracts/context-allocation";
import { OrganizationSettingsUpdateSchema } from "../../../shared/contracts/organization";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import { type KnowledgeState, organizationDirty } from "./types";

/** 与已存基线比较分配草稿：草稿未打开（undefined）或与基线等值都视为不脏。 */
function allocationDirty(editor: {
  auxiliaryAllocation?: GlobalAuxiliaryAllocation;
  source: { auxiliary_allocation?: GlobalAuxiliaryAllocation };
}): boolean {
  if (editor.auxiliaryAllocation === undefined) return false;
  return (
    JSON.stringify(editor.auxiliaryAllocation) !==
    JSON.stringify(editor.source.auxiliary_allocation ?? undefined)
  );
}

export function createOrganizationActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  KnowledgeState,
  | "loadOrganization"
  | "patchOrganization"
  | "patchOrganizationPurposes"
  | "patchOrganizationAllocation"
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
      const api = get().apiClient;
      const previous = get().organizationEditor;
      set({ organizationLoading: true, organizationError: null });
      try {
        const source = await api.getOrganizationSettings();
        if (request !== read || get().apiClient !== api) return;
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
            // 分配草稿与模型草稿分开记脏：基线刷新不覆盖未提交的分配编辑。
            auxiliaryAllocation:
              previous && allocationDirty(previous)
                ? previous.auxiliaryAllocation
                : (source.auxiliary_allocation ?? undefined),
          },
          error: null,
        });
      } catch (error) {
        if (request === read && get().apiClient === api)
          set({ organizationError: errorText(error) });
      } finally {
        if (request === read && get().apiClient === api) set({ organizationLoading: false });
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
    patchOrganizationAllocation: (next) => {
      const editor = get().organizationEditor;
      if (!editor || get().organizationLoading || get().settingsSaving) return;
      set({ organizationEditor: { ...editor, auxiliaryAllocation: next }, feedback: "" });
    },
    saveOrganization: async (scope = "models") => {
      const editor = get().organizationEditor;
      const saveModels = scope === "models" || scope === "all";
      const saveAllocation = scope === "allocation" || scope === "all";
      if (
        saveAllocation &&
        Object.keys(get().allocationInvalidInputs).some((key) => key.startsWith("global:aux:"))
      ) {
        set({ error: msg("请先修正方案中的无效数字，再保存。") });
        return false;
      }
      // 目标作用域都不脏＝无事可做；部分脏（all）也按已有草稿照常提交各自字段。
      const modelsDirty = saveModels && organizationDirty(editor, "models");
      const allocationDirtyForSave = saveAllocation && organizationDirty(editor, "allocation");
      if (!editor || (!modelsDirty && !allocationDirtyForSave)) return true;
      if (get().settingsSaving || get().organizationLoading || get().knowledgeBusy) return false;
      set({ settingsSaving: true, error: null, feedback: "" });
      try {
        // 分配组整组来或整组不动：模型三项缺席＝服务端保留现值（0068 起 update 契约可选）。
        const saved = await get().apiClient.saveOrganizationSettings(
          OrganizationSettingsUpdateSchema.parse({
            expected_revision: editor.source.revision,
            ...(saveModels
              ? {
                  model_name: editor.modelName,
                  vision_model_name: editor.visionModelName,
                  transcription_model_name: editor.transcriptionModelName,
                }
              : {}),
            ...(saveAllocation ? { auxiliary_allocation: editor.auxiliaryAllocation ?? {} } : {}),
          }),
        );
        if (get().organizationEditor?.token !== editor.token) return false;
        // 接受已保存修订到共享基线；未提交的模型/分配草稿字段原样保留。
        set({
          organizationEditor: {
            ...editor,
            source: saved,
            ...(saveModels
              ? {
                  modelName: saved.model_name,
                  visionModelName: saved.vision_model_name,
                  transcriptionModelName: saved.transcription_model_name,
                }
              : {}),
            ...(saveAllocation
              ? { auxiliaryAllocation: saved.auxiliary_allocation ?? undefined }
              : {}),
          },
          // 反馈只用已登记的 notices 键：「{0} 分区已保存」+ 已登记的「上下文」标签；
          // 分配组专用文案的注册需改 notices.json（非本轮授权文件），已在交付报告申请。
          feedback: saveAllocation
            ? msg("{0} 分区已保存", msg("上下文"))
            : msg("默认模型已保存；已有明确覆盖和其他草稿保持不变。"),
        });
        return true;
      } catch (error) {
        // CAS 冲突等失败：保留原稿（含分配草稿），不伪装保存成功。
        if (get().organizationEditor?.token === editor.token) set({ error: errorText(error) });
        return false;
      } finally {
        set({ settingsSaving: false });
      }
    },
    discardOrganization: (scope) => {
      if (get().settingsSaving) return;
      if (scope === "allocation") {
        set({
          allocationInvalidInputs: Object.fromEntries(
            Object.entries(get().allocationInvalidInputs).filter(
              ([key]) => !key.startsWith("global:aux:"),
            ),
          ),
        });
        const editor = get().organizationEditor;
        if (!editor) return;
        read++;
        set({
          organizationEditor: {
            ...editor,
            auxiliaryAllocation: editor.source.auxiliary_allocation ?? undefined,
          },
          organizationError: null,
        });
        return;
      }
      read++;
      set({
        organizationEditor: null,
        organizationLoading: false,
        organizationError: null,
      });
    },
  };
}
