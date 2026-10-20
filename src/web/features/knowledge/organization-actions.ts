import type { GlobalAuxiliaryAllocation } from "../../../shared/contracts/context-allocation";
import { OrganizationSettingsUpdateSchema } from "../../../shared/contracts/organization";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import {
  type GlobalAuxiliaryRole,
  type KnowledgeState,
  type OrganizationSaveScope,
  organizationDirty,
} from "./types";

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
    saveOrganization: async (
      scope: OrganizationSaveScope = "models",
      allocationRoles?: readonly GlobalAuxiliaryRole[],
    ) => {
      const editor = get().organizationEditor;
      const saveOrgModel = scope === "organization-model" || scope === "models" || scope === "all";
      const saveQqModels = scope === "qq-models" || scope === "models" || scope === "all";
      const saveAllocation = scope === "allocation" || scope === "all";
      if (saveAllocation) {
        const invalidKeys = Object.keys(get().allocationInvalidInputs);
        const hasBlockedInvalid =
          allocationRoles !== undefined
            ? invalidKeys.some((key) =>
                allocationRoles.some((role) => key.startsWith(`global:aux:${role}_`)),
              )
            : invalidKeys.some((key) => key.startsWith("global:aux:"));
        if (hasBlockedInvalid) {
          set({ error: msg("请先修正方案中的无效数字，再保存。") });
          return false;
        }
      }
      // 目标作用域都不脏＝无事可做；部分脏（all）也按已有草稿照常提交各自字段。
      const modelsDirty = (saveOrgModel || saveQqModels) && organizationDirty(editor, scope);
      const allocationDirtyForSave =
        saveAllocation && organizationDirty(editor, "allocation", allocationRoles);
      if (!editor || (!modelsDirty && !allocationDirtyForSave)) return true;
      if (get().settingsSaving || get().organizationLoading || get().knowledgeBusy) return false;
      set({ settingsSaving: true, error: null, feedback: "" });
      const api = get().apiClient;
      try {
        let payloadAllocation: GlobalAuxiliaryAllocation | undefined;
        if (saveAllocation) {
          if (allocationRoles !== undefined) {
            // Scoped merge: 以 editor.source.auxiliary_allocation 为基线，仅叠加所选 roles 的草稿
            const baseAlloc: Record<string, unknown> = editor.source.auxiliary_allocation
              ? { ...editor.source.auxiliary_allocation }
              : {};
            for (const role of allocationRoles) {
              const draftRole = editor.auxiliaryAllocation?.[role];
              if (draftRole !== undefined) {
                baseAlloc[role] = draftRole;
              } else {
                delete baseAlloc[role];
              }
            }
            payloadAllocation = baseAlloc as GlobalAuxiliaryAllocation;
          } else {
            payloadAllocation = editor.auxiliaryAllocation ?? {};
          }
        }
        // 分配组整组来或整组不动：未选模型字段缺席＝服务端保留现值（0068 起 update 契约可选）。
        const saved = await api.saveOrganizationSettings(
          OrganizationSettingsUpdateSchema.parse({
            expected_revision: editor.source.revision,
            ...(saveOrgModel ? { model_name: editor.modelName } : {}),
            ...(saveQqModels
              ? {
                  vision_model_name: editor.visionModelName,
                  transcription_model_name: editor.transcriptionModelName,
                }
              : {}),
            ...(saveAllocation ? { auxiliary_allocation: payloadAllocation } : {}),
          }),
        );
        if (get().organizationEditor?.token !== editor.token || get().apiClient !== api)
          return false;

        // 成功推进完整 source/revision，确保 same-editor 连续保存使用新 revision
        let nextAuxiliaryAllocation = editor.auxiliaryAllocation;
        if (saveAllocation) {
          if (allocationRoles !== undefined) {
            // 仅将已成功提交的 selectedRoles 的 draft 还原对齐为最新 saved 值，
            // 未选 roles 的本地 dirty draft 依然完整保留（含删除或未提交的修改）
            const merged: Record<string, unknown> = editor.auxiliaryAllocation
              ? { ...editor.auxiliaryAllocation }
              : {};
            for (const role of allocationRoles) {
              const savedRole = saved.auxiliary_allocation?.[role];
              if (savedRole !== undefined) {
                merged[role] = savedRole;
              } else {
                delete merged[role];
              }
            }
            nextAuxiliaryAllocation = merged as GlobalAuxiliaryAllocation;
          } else {
            nextAuxiliaryAllocation = saved.auxiliary_allocation ?? undefined;
          }
        }

        set({
          organizationEditor: {
            ...editor,
            source: saved,
            modelName: saveOrgModel ? saved.model_name : editor.modelName,
            visionModelName: saveQqModels ? saved.vision_model_name : editor.visionModelName,
            transcriptionModelName: saveQqModels
              ? saved.transcription_model_name
              : editor.transcriptionModelName,
            auxiliaryAllocation: nextAuxiliaryAllocation,
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
        if (get().organizationEditor?.token === editor.token && get().apiClient === api)
          set({ error: errorText(error) });
        return false;
      } finally {
        if (get().apiClient === api) set({ settingsSaving: false });
      }
    },
    discardOrganization: (
      scope?: OrganizationSaveScope,
      allocationRoles?: readonly GlobalAuxiliaryRole[],
    ) => {
      if (get().settingsSaving) return;
      if (scope === "organization-model") {
        const editor = get().organizationEditor;
        if (!editor) return;
        read++;
        set({
          organizationEditor: {
            ...editor,
            modelName: editor.source.model_name,
          },
          organizationError: null,
        });
        return;
      }
      if (scope === "qq-models") {
        const editor = get().organizationEditor;
        if (!editor) return;
        read++;
        set({
          organizationEditor: {
            ...editor,
            visionModelName: editor.source.vision_model_name,
            transcriptionModelName: editor.source.transcription_model_name,
          },
          organizationError: null,
        });
        return;
      }
      if (scope === "models") {
        const editor = get().organizationEditor;
        if (!editor) return;
        read++;
        set({
          organizationEditor: {
            ...editor,
            modelName: editor.source.model_name,
            visionModelName: editor.source.vision_model_name,
            transcriptionModelName: editor.source.transcription_model_name,
          },
          organizationError: null,
        });
        return;
      }
      if (scope === "allocation") {
        if (allocationRoles !== undefined) {
          // 仅清理 selectedRoles 相关的无效输入
          set({
            allocationInvalidInputs: Object.fromEntries(
              Object.entries(get().allocationInvalidInputs).filter(
                ([key]) => !allocationRoles.some((role) => key.startsWith(`global:aux:${role}_`)),
              ),
            ),
          });
          const editor = get().organizationEditor;
          if (!editor) return;
          read++;
          const nextAux: Record<string, unknown> = editor.auxiliaryAllocation
            ? { ...editor.auxiliaryAllocation }
            : {};
          for (const role of allocationRoles) {
            const baseRole = editor.source.auxiliary_allocation?.[role];
            if (baseRole !== undefined) {
              nextAux[role] = structuredClone(baseRole);
            } else {
              delete nextAux[role];
            }
          }
          set({
            organizationEditor: {
              ...editor,
              auxiliaryAllocation: nextAux as GlobalAuxiliaryAllocation,
            },
            organizationError: null,
          });
          return;
        }

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
