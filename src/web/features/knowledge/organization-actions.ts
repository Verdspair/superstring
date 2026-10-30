import type { GlobalAuxiliaryAllocation } from "../../../shared/contracts/context-allocation";
import { OrganizationSettingsUpdateSchema } from "../../../shared/contracts/organization";
import { msg } from "../../i18n";
import { type ReadTask, startRead } from "../../services/read-task";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import {
  type GlobalAuxiliaryRole,
  type KnowledgeState,
  knowledgeFieldConflict,
  type OrganizationSaveScope,
  organizationDirty,
} from "./types";

const equalProfile = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Only roles changed against the previous saved source survive a refresh. */
function mergeAllocationDraft(
  previous: {
    auxiliaryAllocation?: GlobalAuxiliaryAllocation;
    source: { auxiliary_allocation?: GlobalAuxiliaryAllocation };
  },
  fresh: GlobalAuxiliaryAllocation | undefined,
): GlobalAuxiliaryAllocation | undefined {
  const draft = previous.auxiliaryAllocation;
  if (draft === undefined) return fresh;
  const baseline = previous.source.auxiliary_allocation ?? {};
  const merged: Record<string, unknown> = { ...fresh };
  for (const role of new Set([...Object.keys(baseline), ...Object.keys(draft)])) {
    const key = role as keyof GlobalAuxiliaryAllocation;
    const edited = draft[key];
    const saved = baseline[key];
    if (equalProfile(edited, saved)) continue;
    if (edited === undefined) {
      delete merged[key];
      continue;
    }
    if (saved === undefined) {
      merged[key] = edited;
      continue;
    }
    const next: Record<string, unknown> = { ...(fresh?.[key] ?? edited) };
    for (const field of ["mode", "input_limit", "output_reserved"] as const) {
      if (edited[field] === saved[field]) continue;
      if (edited[field] === undefined) delete next[field];
      else Object.assign(next, { [field]: edited[field] });
    }
    merged[key] = next;
  }
  return Object.keys(merged).length || fresh !== undefined || Object.keys(draft).length === 0
    ? (merged as GlobalAuxiliaryAllocation)
    : undefined;
}

function allocationConflict(
  previous: import("./types").OrganizationEditor,
  fresh: GlobalAuxiliaryAllocation | undefined,
): boolean {
  const draft = previous.auxiliaryAllocation;
  if (draft === undefined) return false;
  const baseline = previous.source.auxiliary_allocation ?? {};
  return [...new Set([...Object.keys(baseline), ...Object.keys(draft)])].some((role) => {
    const key = role as keyof GlobalAuxiliaryAllocation;
    const saved = baseline[key],
      edited = draft[key],
      remote = fresh?.[key];
    if (equalProfile(saved, edited)) return false;
    if (saved === undefined || edited === undefined || remote === undefined)
      return !equalProfile(remote, saved) && !equalProfile(remote, edited);
    return (["mode", "input_limit", "output_reserved"] as const).some((field) =>
      knowledgeFieldConflict(saved[field], edited[field], remote[field]),
    );
  });
}

export function createOrganizationActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  KnowledgeState,
  | "acquireOrganizationRead"
  | "releaseOrganizationRead"
  | "cancelOrganizationRead"
  | "loadOrganization"
  | "patchOrganization"
  | "patchOrganizationPurposes"
  | "patchOrganizationAllocation"
  | "saveOrganization"
  | "discardOrganization"
> {
  let read = 0;
  let activeApi: ReturnType<StoreGet>["apiClient"] | null = null;
  let requestTask: ReadTask | null = null;
  let settleRead: (() => void) | null = null;
  let inFlight: Promise<void> | null = null;
  let suspended = false;
  const consumers = new Map<object, ReturnType<StoreGet>["apiClient"]>();
  const cancelRead = () => {
    suspended = document.visibilityState === "hidden";
    read++;
    requestTask?.cancel();
    requestTask = null;
    inFlight = null;
    settleRead?.();
    settleRead = null;
    set({ organizationLoading: false });
  };
  return {
    acquireOrganizationRead: (owner: object) => {
      const api = get().apiClient;
      if (activeApi && activeApi !== api) {
        consumers.clear();
        cancelRead();
      }
      consumers.set(owner, api);
      return get().loadOrganization();
    },
    releaseOrganizationRead: (owner: object) => {
      const api = consumers.get(owner);
      if (!api) return;
      consumers.delete(owner);
      if (api !== get().apiClient || api !== activeApi) return;
      if (![...consumers.values()].some((consumerApi) => consumerApi === api)) cancelRead();
    },
    cancelOrganizationRead: () => {
      consumers.clear();
      cancelRead();
    },
    loadOrganization: async (refresh = false) => {
      const explicitRefresh = refresh;
      const api = get().apiClient;
      const sameApi = activeApi === api;
      if (activeApi && !sameApi) {
        for (const [owner, ownerApi] of consumers) if (ownerApi !== api) consumers.delete(owner);
      }
      refresh = refresh || (sameApi && suspended);
      if (sameApi && get().organizationLoading && !refresh) {
        if (inFlight) return inFlight;
        return;
      }
      if (get().settingsSaving || (sameApi && get().organizationEditor && !refresh)) return;
      const previous = sameApi ? get().organizationEditor : null;
      requestTask?.cancel();
      requestTask = null;
      inFlight = null;
      settleRead?.();
      activeApi = api;
      suspended = false;
      const request = ++read;
      const matches = () => request === read && get().apiClient === api;
      set({
        organizationLoading: true,
        organizationError: null,
        ...(!sameApi ? { organizationEditor: null } : {}),
      });
      const promise = new Promise<void>((resolve) => {
        settleRead = resolve;
        const task = startRead((signal) => api.getOrganizationSettings(signal), {
          success: (source) => {
            if (!matches()) return;
            if (
              !explicitRefresh &&
              previous &&
              (knowledgeFieldConflict(
                previous.source.model_name,
                previous.modelName,
                source.model_name,
              ) ||
                knowledgeFieldConflict(
                  previous.source.vision_model_name,
                  previous.visionModelName,
                  source.vision_model_name,
                ) ||
                knowledgeFieldConflict(
                  previous.source.transcription_model_name,
                  previous.transcriptionModelName,
                  source.transcription_model_name,
                ) ||
                allocationConflict(previous, source.auxiliary_allocation))
            ) {
              set({
                organizationError: msg(
                  "远端设置已更改；本地草稿保留，未自动推进保存版本。请显式刷新并核对后重试。",
                ),
              });
              return;
            }
            set({
              organizationEditor: {
                token: previous?.token ?? {},
                source,
                modelName:
                  previous && previous.modelName !== previous.source.model_name
                    ? previous.modelName
                    : source.model_name,
                visionModelName:
                  previous && previous.visionModelName !== previous.source.vision_model_name
                    ? previous.visionModelName
                    : source.vision_model_name,
                transcriptionModelName:
                  previous &&
                  previous.transcriptionModelName !== previous.source.transcription_model_name
                    ? previous.transcriptionModelName
                    : source.transcription_model_name,
                auxiliaryAllocation: previous
                  ? mergeAllocationDraft(previous, source.auxiliary_allocation)
                  : source.auxiliary_allocation,
              },
              organizationError: null,
            });
          },
          failure: (error) => {
            if (matches()) set({ organizationError: errorText(error) });
          },
          settled: () => {
            if (requestTask === task) {
              requestTask = null;
              inFlight = null;
            }
            if (settleRead === resolve) settleRead = null;
            if (matches()) set({ organizationLoading: false });
            resolve();
          },
        });
        requestTask = task;
      });
      inFlight = promise;
      return promise;
    },
    patchOrganization: (modelName) => {
      if (activeApi && activeApi !== get().apiClient) return;
      const editor = get().organizationEditor;
      if (!editor || get().organizationLoading || get().settingsSaving) return;
      set({ organizationEditor: { ...editor, modelName }, feedback: "" });
    },
    patchOrganizationPurposes: (patch) => {
      if (activeApi && activeApi !== get().apiClient) return;
      const editor = get().organizationEditor;
      if (!editor || get().organizationLoading || get().settingsSaving) return;
      set({ organizationEditor: { ...editor, ...patch }, feedback: "" });
    },
    patchOrganizationAllocation: (next) => {
      if (activeApi && activeApi !== get().apiClient) return;
      const editor = get().organizationEditor;
      if (!editor || get().organizationLoading || get().settingsSaving) return;
      set({ organizationEditor: { ...editor, auxiliaryAllocation: next }, feedback: "" });
    },
    saveOrganization: async (
      scope: OrganizationSaveScope = "models",
      allocationRoles?: readonly GlobalAuxiliaryRole[],
    ) => {
      if (activeApi && activeApi !== get().apiClient) return false;
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
          set({ organizationError: msg("请先修正方案中的无效数字，再保存。") });
          return false;
        }
      }
      // 目标作用域都不脏＝无事可做；部分脏（all）也按已有草稿照常提交各自字段。
      const modelsDirty = (saveOrgModel || saveQqModels) && organizationDirty(editor, scope);
      const allocationDirtyForSave =
        saveAllocation && organizationDirty(editor, "allocation", allocationRoles);
      if (!editor || (!modelsDirty && !allocationDirtyForSave)) return true;
      if (get().settingsSaving || get().organizationLoading || get().knowledgeBusy) return false;
      const operation = {};
      set({
        settingsSaving: true,
        settingsSaveOwner: operation,
        organizationError: null,
        feedback: "",
      });
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
          feedback: saveAllocation
            ? msg("{0} 分区已保存", msg("上下文"))
            : msg("默认模型已保存；已有明确覆盖和其他草稿保持不变。"),
        });
        return true;
      } catch (error) {
        // CAS 冲突等失败：保留原稿（含分配草稿），不伪装保存成功。
        if (get().organizationEditor?.token === editor.token && get().apiClient === api)
          set({ organizationError: errorText(error) });
        return false;
      } finally {
        if (get().settingsSaveOwner === operation)
          set({ settingsSaving: false, settingsSaveOwner: null });
      }
    },
    discardOrganization: (
      scope?: OrganizationSaveScope,
      allocationRoles?: readonly GlobalAuxiliaryRole[],
    ) => {
      if (get().settingsSaving) return;
      requestTask?.cancel();
      requestTask = null;
      inFlight = null;
      settleRead?.();
      settleRead = null;
      set({ organizationLoading: false });
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
