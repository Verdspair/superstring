import {
  EXECUTION_MODULE_KEYS,
  executionPolicy,
  type PermissionGrant,
  type PermissionsResponse,
  selectEffectivePermissionGrantEntry,
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
import {
  applyGrantEdits,
  type GrantDraft,
  grantDraftOf,
  grantDraftOfEntry,
  sameAgentOverrides,
  sameGrantDraft,
} from "./permission-draft";

/** 执行草稿里可单独成组保存的字段：除模块映射与暂停表以外的全部键。 */
export type ExecutionFieldKey = Exclude<keyof ExecutionDraft, "modules" | "pausedTools">;
export type ExecutionModuleKey = keyof ExecutionDraft["modules"];
/**
 * 对象作用域：只覆盖显式列出的字段，未列出的字段既不算 dirty，也不会被保存或放弃。
 * 字符串 "execution"/"grants"/"all" 保持原有整域语义不变。
 */
export interface AgentOverrideScopeSelection {
  resource: string;
  agentId: string;
}

export interface PermissionScopeSelection {
  executionKeys?: ExecutionFieldKey[];
  modules?: ExecutionModuleKey[];
  resources?: string[];
  agentOverrides?: AgentOverrideScopeSelection[];
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
  const known = new Set(snapshot.resources.map((resource) => resource.resource));
  return [
    ...snapshot.resources,
    ...snapshot.policy.grants
      .filter((grant) => !known.has(grant.resource))
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

/** Project the selected Agent once from saved grants and only its own override drafts. */
export function agentPermissionScope(
  editor: PermissionEditor | null,
  agentId: string,
): PermissionScopeSelection {
  if (!editor) return { agentOverrides: [] };
  const resources = new Set([
    ...editor.snapshot.policy.grants.map((entry) => entry.resource),
    ...Object.keys(editor.grants),
  ]);
  return { agentOverrides: [...resources].map((resource) => ({ resource, agentId })) };
}

export function projectAgentPermissionEdits(editor: PermissionEditor | null, agentId: string) {
  const result = new Map<
    string,
    {
      saved: PermissionGrant | undefined;
      base: import("./permission-draft").AgentOverrideDraft;
      override: import("./permission-draft").AgentOverrideDraft | undefined;
      enabled: boolean;
      approved: boolean;
      directories: string[];
      declaredDirectories: string[];
      dirty: boolean;
    }
  >();
  if (!editor) return result;
  const saved = new Map(editor.snapshot.policy.grants.map((entry) => [entry.resource, entry]));
  for (const resource of permissionResources(editor.snapshot)) {
    const entry = saved.get(resource.resource);
    // Base inheritance deliberately excludes overrides without cloning the override map.
    const baseEntry = entry ? { ...entry, agentOverrides: undefined } : undefined;
    const inherited = selectEffectivePermissionGrantEntry(baseEntry, agentId)?.grant;
    const base = {
      enabled:
        !!inherited &&
        inherited.enabled !== false &&
        (inherited.agentIds === undefined || inherited.agentIds.includes(agentId)),
      approved: inherited?.approved === true,
      revision: inherited?.revision ?? resource.revision,
      directories: [...(inherited?.directories ?? [])],
    };
    const override = editor.grants[resource.resource]?.agentOverrides?.[agentId];
    const effective = selectEffectivePermissionGrantEntry(
      entry || override
        ? {
            ...(entry ?? {
              resource: resource.resource,
              approved: false,
              agentIds: [],
              directories: [],
            }),
            agentOverrides: override ? { [agentId]: override } : undefined,
          }
        : undefined,
      agentId,
    )?.grant;
    result.set(resource.resource, {
      saved: entry,
      base,
      override,
      enabled:
        !!effective &&
        effective.enabled !== false &&
        (effective.agentIds === undefined || effective.agentIds.includes(agentId)),
      approved: effective?.approved === true && effective.revision === resource.revision,
      directories: [...(override?.directories ?? base.directories)],
      declaredDirectories: [...new Set(resource.directories ?? [])],
      dirty: !sameAgentOverrides(
        override ? { [agentId]: override } : undefined,
        entry?.agentOverrides?.[agentId] ? { [agentId]: entry.agentOverrides[agentId] } : undefined,
      ),
    });
  }
  return result;
}

const editorOf = (snapshot: PermissionsResponse): PermissionEditor => {
  const execution = executionDraftOf(executionPolicy(snapshot.policy));
  const grants = new Map(snapshot.policy.grants.map((entry) => [entry.resource, entry]));
  const paused = new Set(executionPolicy(snapshot.policy).pausedTools);
  return {
    snapshot,
    execution,
    baseline: execution,
    grants: Object.fromEntries(
      permissionResources(snapshot).map((resource) => [
        resource.resource,
        grantDraftOfEntry(
          grants.get(resource.resource),
          paused.has(resource.resource),
          resource.revision,
        ),
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
  agentOverrides: readonly AgentOverrideScopeSelection[];
}

function scopeOf(scope: PermissionScope): ResolvedScope {
  if (scope === "all")
    return {
      allExecution: true,
      executionKeys: new Set(),
      modules: new Set(),
      allResources: true,
      resources: new Set(),
      agentOverrides: [],
    };
  if (scope === "execution")
    return {
      allExecution: true,
      executionKeys: new Set(),
      modules: new Set(),
      allResources: false,
      resources: new Set(),
      agentOverrides: [],
    };
  if (scope === "grants")
    return {
      allExecution: false,
      executionKeys: new Set(),
      modules: new Set(),
      allResources: true,
      resources: new Set(),
      agentOverrides: [],
    };
  return {
    allExecution: false,
    executionKeys: new Set(scope.executionKeys ?? []),
    modules: new Set(scope.modules ?? []),
    allResources: false,
    resources: new Set(scope.resources ?? []),
    agentOverrides: [...(scope.agentOverrides ?? [])],
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
const grantsSelected = (scope: ResolvedScope) =>
  scope.allResources || scope.resources.size > 0 || scope.agentOverrides.length > 0;

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
  if (resolved.agentOverrides.length > 0) {
    const savedGrants = new Map(
      editor.snapshot.policy.grants.map((grant) => [grant.resource, grant]),
    );
    for (const pair of resolved.agentOverrides) {
      const draft = editor.grants[pair.resource];
      const draftOv = draft?.agentOverrides?.[pair.agentId];
      const baseOv = savedGrants.get(pair.resource)?.agentOverrides?.[pair.agentId];
      if (
        !sameAgentOverrides(
          draftOv ? { [pair.agentId]: draftOv } : undefined,
          baseOv ? { [pair.agentId]: baseOv } : undefined,
        )
      ) {
        return true;
      }
    }
    if (!resolved.allResources && resolved.resources.size === 0) return false;
  }
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
    if (!draft) continue;

    const targetedOverridesOnThisResource = scope.agentOverrides.filter(
      (item) => item.resource === resource.resource,
    );

    if (targetedOverridesOnThisResource.length > 0) {
      const merged = { ...(next.grants[resource.resource] ?? baseline) };
      for (const key of Object.keys(draft) as (keyof GrantDraft)[]) {
        if (key === "agentOverrides") continue;
        if (JSON.stringify(draft[key]) !== JSON.stringify(baseline[key])) {
          Object.assign(merged, {
            [key]:
              draft[key] !== null && typeof draft[key] === "object"
                ? structuredClone(draft[key])
                : draft[key],
          });
        }
      }
      const mergedOverrides = { ...(merged.agentOverrides ?? {}) };
      const allAgentKeys = new Set([
        ...Object.keys(baseline.agentOverrides ?? {}),
        ...Object.keys(draft.agentOverrides ?? {}),
      ]);
      for (const id of allAgentKeys) {
        const isTargetedInScope = targetedOverridesOnThisResource.some(
          (item) => item.agentId === id,
        );
        if (isTargetedInScope) continue;
        const draftOv = draft.agentOverrides?.[id];
        const baseOv = baseline.agentOverrides?.[id];
        const isDirty = !sameAgentOverrides(
          draftOv ? { [id]: draftOv } : undefined,
          baseOv ? { [id]: baseOv } : undefined,
        );
        if (isDirty) {
          if (draftOv === undefined) {
            delete mergedOverrides[id];
          } else {
            mergedOverrides[id] = structuredClone(draftOv);
          }
        }
      }
      merged.agentOverrides = Object.keys(mergedOverrides).length > 0 ? mergedOverrides : undefined;
      next.grants[resource.resource] = merged;
      continue;
    }
    if (sameGrantDraft(draft, baseline)) continue;
    const refreshed = permissionResources(next.snapshot).find(
      (item) => item.resource === resource.resource,
    );
    const merged = { ...(next.grants[resource.resource] ?? baseline) };
    for (const key of Object.keys(draft) as (keyof GrantDraft)[]) {
      if (JSON.stringify(draft[key]) !== JSON.stringify(baseline[key]))
        Object.assign(merged, {
          [key]:
            draft[key] !== null && typeof draft[key] === "object"
              ? structuredClone(draft[key])
              : draft[key],
        });
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
      if (!editor || get().permissionSaving) return;
      const targetGrant = editor.grants[resource] ?? grantDraftOf(editor.snapshot.policy, resource);
      set({
        permissionEditor: {
          ...editor,
          grants: { ...editor.grants, [resource]: { ...targetGrant, ...patch } },
        },
        permissionNotice: "",
        agentTaskResult: null,
      });
    },
    savePermissionSettings: async (scope: PermissionScope = "all") => {
      if (get().permissionSaving || get().permissionLoading) return false;
      const editor = get().permissionEditor;
      if (!editor) return false;
      if (!permissionSettingsDirty(editor, scope)) return true;
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
        if (
          resolved.agentOverrides.length > 0 &&
          (resolved.allResources || resolved.resources.size > 0)
        ) {
          const resources = permissionResources(editor.snapshot).filter((resource) =>
            resourceSelected(resolved, resource.resource),
          );
          policy = applyGrantEdits(policy, resources, editor.grants);
          const remainingOverrides = resolved.agentOverrides.filter(
            (item) => !resourceSelected(resolved, item.resource),
          );
          if (remainingOverrides.length > 0) {
            policy = applyGrantEdits(
              policy,
              permissionResources(editor.snapshot),
              editor.grants,
              remainingOverrides,
            );
          }
        } else if (resolved.agentOverrides.length > 0) {
          policy = applyGrantEdits(
            policy,
            permissionResources(editor.snapshot),
            editor.grants,
            resolved.agentOverrides,
          );
        } else {
          const resources = permissionResources(editor.snapshot).filter((resource) =>
            resourceSelected(resolved, resource.resource),
          );
          policy = applyGrantEdits(policy, resources, editor.grants);
        }
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
