import {
  EXECUTION_MODULE_KEYS,
  executionPolicy,
  type PermissionsResponse,
} from "../../../shared/contracts/permissions";
import type { SuperstringApi } from "../../api";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import {
  type ExecutionDraft,
  type ExecutionDraftKey,
  executionDraftOf,
  executionPayload,
} from "../runs/execution-draft";
import { applyGrantEdits, type GrantDraft, grantDraftOf, sameGrantDraft } from "./permission-draft";

/** 执行草稿里可单独成组保存的字段：除模块映射与暂停表以外的全部键。 */
export type ExecutionFieldKey = Exclude<keyof ExecutionDraft, "modules" | "pausedTools">;
export type ExecutionModuleKey = keyof ExecutionDraft["modules"];
/**
 * 对象作用域：只覆盖显式列出的字段，未列出的字段既不算 dirty，也不会被保存或放弃。
 * 字符串 "execution"/"grants"/"all" 保持原有整域语义不变。
 */
export interface PermissionScopeSelection {
  executionKeys?: ExecutionFieldKey[];
  modules?: ExecutionModuleKey[];
  resources?: string[];
}
export type PermissionScope = "execution" | "grants" | "all" | PermissionScopeSelection;
/** 最近一次动作错误的归属面板，用于面板过滤：在修不了该错误的页面不再重复提示。 */
export type PermissionErrorScope = "" | "execution" | "grants";

export interface PermissionEditor {
  snapshot: PermissionsResponse;
  execution: ExecutionDraft;
  baseline: ExecutionDraft;
  grants: Record<string, GrantDraft>;
}
export interface PermissionReadOptions {
  refresh?: boolean;
  background?: boolean;
}

export interface PermissionSettingsState {
  permissionEditor: PermissionEditor | null;
  permissionLoading: boolean;
  permissionSaving: boolean;
  permissionError: string;
  permissionErrorScope: PermissionErrorScope;
  permissionNotice: string;
  permissionProblem: ExecutionDraftKey | null;
  loadPermissionSettings: (options?: boolean | PermissionReadOptions) => Promise<void>;
  patchExecutionSettings: (patch: Partial<ExecutionDraft>) => void;
  patchToolGrant: (resource: string, patch: Partial<GrantDraft>) => void;
  savePermissionSettings: (scope?: PermissionScope) => Promise<boolean>;
  discardPermissionSettings: (scope?: PermissionScope) => void;
}

export const permissionInitial = {
  permissionEditor: null as PermissionEditor | null,
  permissionLoading: false,
  permissionSaving: false,
  permissionError: "",
  permissionErrorScope: "" as PermissionErrorScope,
  permissionNotice: "",
  permissionProblem: null as ExecutionDraftKey | null,
};

export function permissionResources(snapshot: PermissionsResponse) {
  return [
    ...snapshot.resources,
    ...snapshot.policy.grants
      .filter(
        (grant) => !snapshot.resources.some((resource) => resource.resource === grant.resource),
      )
      .map((grant) => ({
        name: grant.resource,
        resource: grant.resource,
        description: "",
        effect: "write" as const,
        revision: grant.revision ?? "",
        approvalRequired: true,
        directories: grant.directories,
      })),
  ];
}

const editorOf = (snapshot: PermissionsResponse): PermissionEditor => {
  const execution = executionDraftOf(executionPolicy(snapshot.policy));
  return {
    snapshot,
    execution,
    baseline: execution,
    grants: Object.fromEntries(
      permissionResources(snapshot).map((resource) => [
        resource.resource,
        grantDraftOf(snapshot.policy, resource.resource, resource.revision),
      ]),
    ),
  };
};

interface ResolvedScope {
  allExecution: boolean;
  executionKeys: ReadonlySet<ExecutionFieldKey>;
  modules: ReadonlySet<ExecutionModuleKey>;
  allResources: boolean;
  resources: ReadonlySet<string>;
}

function scopeOf(scope: PermissionScope): ResolvedScope {
  if (scope === "all")
    return {
      allExecution: true,
      executionKeys: new Set(),
      modules: new Set(),
      allResources: true,
      resources: new Set(),
    };
  if (scope === "execution")
    return {
      allExecution: true,
      executionKeys: new Set(),
      modules: new Set(),
      allResources: false,
      resources: new Set(),
    };
  if (scope === "grants")
    return {
      allExecution: false,
      executionKeys: new Set(),
      modules: new Set(),
      allResources: true,
      resources: new Set(),
    };
  return {
    allExecution: false,
    executionKeys: new Set(scope.executionKeys ?? []),
    modules: new Set(scope.modules ?? []),
    allResources: false,
    resources: new Set(scope.resources ?? []),
  };
}

const NO_SELECTION: ResolvedScope = scopeOf({});

const fieldSelected = (scope: ResolvedScope, key: ExecutionFieldKey) =>
  scope.allExecution || scope.executionKeys.has(key);
const moduleSelected = (scope: ResolvedScope, module: ExecutionModuleKey) =>
  scope.allExecution || scope.modules.has(module);
const resourceSelected = (scope: ResolvedScope, resource: string) =>
  scope.allResources || scope.resources.has(resource);
const executionSelected = (scope: ResolvedScope) =>
  scope.allExecution || scope.executionKeys.size > 0 || scope.modules.size > 0;
const grantsSelected = (scope: ResolvedScope) => scope.allResources || scope.resources.size > 0;

export function permissionSettingsDirty(
  editor: PermissionEditor | null,
  scope: PermissionScope = "all",
) {
  if (!editor) return false;
  const resolved = scopeOf(scope);
  for (const key of Object.keys(editor.execution) as (keyof ExecutionDraft)[]) {
    if (key === "pausedTools") continue;
    if (key === "modules") {
      for (const module of EXECUTION_MODULE_KEYS) {
        if (!moduleSelected(resolved, module)) continue;
        if (editor.execution.modules[module] !== editor.baseline.modules[module]) return true;
      }
      continue;
    }
    if (fieldSelected(resolved, key) && editor.execution[key] !== editor.baseline[key]) return true;
  }
  if (!grantsSelected(resolved)) return false;
  return permissionResources(editor.snapshot).some((resource) => {
    if (!resourceSelected(resolved, resource.resource)) return false;
    const draft = editor.grants[resource.resource];
    return (
      draft &&
      !sameGrantDraft(
        draft,
        grantDraftOf(editor.snapshot.policy, resource.resource, resource.revision),
      )
    );
  });
}

/** 从快照基线构造提交载荷：只覆盖作用域内字段，作用域外的草稿（含非法数字）不提交。 */
function mergedExecutionDraft(
  base: ExecutionDraft,
  draft: ExecutionDraft,
  scope: ResolvedScope,
): ExecutionDraft {
  const merged: ExecutionDraft = { ...base, modules: { ...base.modules } };
  for (const key of Object.keys(draft) as (keyof ExecutionDraft)[]) {
    if (key === "pausedTools") continue;
    if (key === "modules") {
      for (const module of EXECUTION_MODULE_KEYS) {
        if (moduleSelected(scope, module)) merged.modules[module] = draft.modules[module];
      }
      continue;
    }
    if (fieldSelected(scope, key)) Object.assign(merged, { [key]: draft[key] });
  }
  return merged;
}

/** 保存/刷新/放弃后：作用域外的草稿原样保留，作用域内字段回落到新基线。 */
function preserveUnselectedDrafts(
  next: PermissionEditor,
  current: PermissionEditor,
  scope: ResolvedScope,
) {
  for (const key of Object.keys(current.execution) as (keyof ExecutionDraft)[]) {
    if (key === "pausedTools") continue;
    if (key === "modules") {
      for (const module of EXECUTION_MODULE_KEYS) {
        if (moduleSelected(scope, module)) continue;
        if (current.execution.modules[module] !== current.baseline.modules[module])
          next.execution = {
            ...next.execution,
            modules: { ...next.execution.modules, [module]: current.execution.modules[module] },
          };
      }
      continue;
    }
    if (!fieldSelected(scope, key) && current.execution[key] !== current.baseline[key])
      next.execution = { ...next.execution, [key]: current.execution[key] };
  }
  for (const resource of permissionResources(current.snapshot)) {
    if (resourceSelected(scope, resource.resource)) continue;
    const draft = current.grants[resource.resource];
    const baseline = grantDraftOf(current.snapshot.policy, resource.resource, resource.revision);
    if (!draft || sameGrantDraft(draft, baseline)) continue;
    const refreshed = permissionResources(next.snapshot).find(
      (item) => item.resource === resource.resource,
    );
    const merged = { ...(next.grants[resource.resource] ?? baseline) };
    for (const key of Object.keys(draft) as (keyof GrantDraft)[]) {
      if (JSON.stringify(draft[key]) !== JSON.stringify(baseline[key]))
        Object.assign(merged, { [key]: draft[key] });
    }
    if (refreshed && refreshed.revision !== resource.revision) merged.approved = false;
    next.grants[resource.resource] = merged;
  }
  return next;
}

export function createPermissionSettingsActions(set: StoreSet, get: StoreGet) {
  let sequence = 0;
  let read: AbortController | null = null;
  let permissionInFlight: { promise: Promise<void>; token: number; api: SuperstringApi } | null =
    null;
  return {
    loadPermissionSettings: async (options: boolean | PermissionReadOptions = false) => {
      const refresh = typeof options === "boolean" ? options : !!options.refresh;
      const background = typeof options === "object" ? !!options.background : false;
      const api = get().apiClient;

      if (get().permissionSaving) return;
      if (!refresh && permissionInFlight && permissionInFlight.api === api) {
        return permissionInFlight.promise;
      }

      const hasEditor = !!get().permissionEditor;
      if (!refresh && hasEditor && background) return;

      const isQuietRevalidate = !refresh && hasEditor;

      if (!isQuietRevalidate) {
        read?.abort();
      }
      const controller = new AbortController();
      read = controller;
      const token = ++sequence;

      if (!isQuietRevalidate) {
        set({ permissionLoading: true });
      }

      const execute = async () => {
        try {
          const snapshot = await api.getPermissions(controller.signal);
          if (token !== sequence || get().apiClient !== api) return;
          const next = editorOf(snapshot);
          const current = get().permissionEditor;
          set({
            permissionEditor: current
              ? preserveUnselectedDrafts(next, current, NO_SELECTION)
              : next,
            permissionError: "",
            permissionErrorScope: "",
            permissionNotice: "",
          });
        } catch (error) {
          if (token === sequence && !controller.signal.aborted && get().apiClient === api) {
            if (!background && !isQuietRevalidate) {
              set({ permissionError: errorText(error), permissionErrorScope: "" });
            }
          }
        } finally {
          if (token === sequence) {
            set({ permissionLoading: false });
          }
          if (permissionInFlight?.token === token) {
            permissionInFlight = null;
          }
        }
      };

      const promise = execute();
      permissionInFlight = { promise, token, api };
      return promise;
    },
    patchExecutionSettings: (patch: Partial<ExecutionDraft>) => {
      const editor = get().permissionEditor;
      if (!editor || get().permissionSaving) return;
      set({
        permissionEditor: { ...editor, execution: { ...editor.execution, ...patch } },
        permissionNotice: "",
        permissionProblem: null,
      });
    },
    patchToolGrant: (resource: string, patch: Partial<GrantDraft>) => {
      const editor = get().permissionEditor;
      if (!editor || get().permissionSaving || !editor.grants[resource]) return;
      set({
        permissionEditor: {
          ...editor,
          grants: { ...editor.grants, [resource]: { ...editor.grants[resource], ...patch } },
        },
        permissionNotice: "",
      });
    },
    savePermissionSettings: async (scope: PermissionScope = "all") => {
      if (get().permissionSaving || get().permissionLoading) return false;
      const editor = get().permissionEditor;
      if (!editor || !permissionSettingsDirty(editor, scope)) return true;
      const resolved = scopeOf(scope);
      const savesExecution = executionSelected(resolved);
      const savesGrants = grantsSelected(resolved);
      const errorScope: PermissionErrorScope =
        savesExecution && !savesGrants
          ? "execution"
          : savesGrants && !savesExecution
            ? "grants"
            : "";
      let policy = editor.snapshot.policy;
      if (savesGrants) {
        const resources = permissionResources(editor.snapshot).filter((resource) =>
          resourceSelected(resolved, resource.resource),
        );
        policy = applyGrantEdits(policy, resources, editor.grants);
      }
      if (savesExecution) {
        const payload = executionPayload(
          mergedExecutionDraft(editor.baseline, editor.execution, resolved),
        );
        if (!payload.ok) {
          set({
            permissionProblem: payload.problem,
            permissionError: "connections.execution.invalid",
            permissionErrorScope: "execution",
          });
          return false;
        }
        policy = {
          ...policy,
          execution: { ...payload.execution, pausedTools: executionPolicy(policy).pausedTools },
        };
      }
      read?.abort();
      ++sequence;
      permissionInFlight = null;
      const api = get().apiClient;
      set({
        permissionSaving: true,
        permissionError: "",
        permissionErrorScope: errorScope,
        permissionNotice: "",
      });
      try {
        const saved = await api.savePermissions({
          expectedRevision: editor.snapshot.revision,
          policy,
        });
        if (get().permissionEditor !== editor || get().apiClient !== api) return false;
        const next = preserveUnselectedDrafts(
          editorOf({ ...saved, resources: editor.snapshot.resources }),
          editor,
          resolved,
        );
        set({
          permissionEditor: next,
          permissionProblem: null,
          permissionErrorScope: "",
          permissionNotice:
            savesGrants && !savesExecution
              ? "connections.grants.saved"
              : "connections.execution.saved",
        });
        return true;
      } catch (error) {
        if (get().permissionEditor === editor && get().apiClient === api)
          set({ permissionError: errorText(error) });
        return false;
      } finally {
        if (get().apiClient === api) set({ permissionSaving: false });
      }
    },
    discardPermissionSettings: (scope: PermissionScope = "all") => {
      const editor = get().permissionEditor;
      if (!editor || get().permissionSaving) return;
      read?.abort();
      ++sequence;
      permissionInFlight = null;
      set({ permissionLoading: false });
      const next = preserveUnselectedDrafts(editorOf(editor.snapshot), editor, scopeOf(scope));
      set({
        permissionEditor: next,
        permissionProblem: null,
        permissionError: "",
        permissionErrorScope: "",
        permissionNotice: "",
      });
    },
  };
}
