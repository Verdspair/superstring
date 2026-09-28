import { executionPolicy, type PermissionsResponse } from "../../../shared/contracts/permissions";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import {
  type ExecutionDraft,
  type ExecutionDraftKey,
  executionDraftOf,
  executionPayload,
} from "../runs/execution-draft";
import { applyGrantEdits, type GrantDraft, grantDraftOf, sameGrantDraft } from "./permission-draft";

export type PermissionScope = "execution" | "grants" | "all";
export interface PermissionEditor {
  snapshot: PermissionsResponse;
  execution: ExecutionDraft;
  baseline: ExecutionDraft;
  grants: Record<string, GrantDraft>;
}
export interface PermissionSettingsState {
  permissionEditor: PermissionEditor | null;
  permissionLoading: boolean;
  permissionSaving: boolean;
  permissionError: string;
  permissionNotice: string;
  permissionProblem: ExecutionDraftKey | null;
  loadPermissionSettings: (refresh?: boolean) => Promise<void>;
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

export function permissionSettingsDirty(
  editor: PermissionEditor | null,
  scope: PermissionScope = "all",
) {
  if (!editor) return false;
  return (
    (scope !== "grants" && JSON.stringify(editor.execution) !== JSON.stringify(editor.baseline)) ||
    (scope !== "execution" &&
      permissionResources(editor.snapshot).some((resource) => {
        const draft = editor.grants[resource.resource];
        return (
          draft &&
          !sameGrantDraft(
            draft,
            grantDraftOf(editor.snapshot.policy, resource.resource, resource.revision),
          )
        );
      }))
  );
}

function preserveDrafts(next: PermissionEditor, current: PermissionEditor, scope: PermissionScope) {
  if (scope !== "grants") {
    for (const key of Object.keys(current.execution) as (keyof ExecutionDraft)[]) {
      if (key === "pausedTools") continue;
      if (key === "modules") {
        for (const module of Object.keys(
          current.execution.modules,
        ) as (keyof ExecutionDraft["modules"])[]) {
          if (current.execution.modules[module] !== current.baseline.modules[module])
            next.execution = {
              ...next.execution,
              modules: { ...next.execution.modules, [module]: current.execution.modules[module] },
            };
        }
      } else if (current.execution[key] !== current.baseline[key]) {
        next.execution = { ...next.execution, [key]: current.execution[key] };
      }
    }
  }
  if (scope !== "execution") {
    for (const resource of permissionResources(current.snapshot)) {
      const draft = current.grants[resource.resource];
      const baseline = grantDraftOf(current.snapshot.policy, resource.resource, resource.revision);
      if (draft && !sameGrantDraft(draft, baseline)) {
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
    }
  }
  return next;
}

export function createPermissionSettingsActions(set: StoreSet, get: StoreGet) {
  let sequence = 0;
  let read: AbortController | null = null;
  return {
    loadPermissionSettings: async (refresh = false) => {
      if (
        get().permissionSaving ||
        (!refresh && (get().permissionEditor || get().permissionLoading))
      )
        return;
      read?.abort();
      const controller = new AbortController();
      read = controller;
      const token = ++sequence;
      const api = get().apiClient;
      set({ permissionLoading: true });
      try {
        const snapshot = await api.getPermissions(controller.signal);
        if (token !== sequence || get().apiClient !== api) return;
        const next = editorOf(snapshot);
        const current = get().permissionEditor;
        set({
          permissionEditor: current ? preserveDrafts(next, current, "all") : next,
          permissionError: "",
          permissionNotice: "",
        });
      } catch (error) {
        if (token === sequence && !controller.signal.aborted && get().apiClient === api)
          set({ permissionError: errorText(error) });
      } finally {
        if (token === sequence && get().apiClient === api) set({ permissionLoading: false });
      }
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
      const resources = permissionResources(editor.snapshot);
      let policy =
        scope === "execution"
          ? editor.snapshot.policy
          : applyGrantEdits(editor.snapshot.policy, resources, editor.grants);
      if (scope !== "grants") {
        const payload = executionPayload(editor.execution);
        if (!payload.ok) {
          set({
            permissionProblem: payload.problem,
            permissionError: "connections.execution.invalid",
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
      const api = get().apiClient;
      set({ permissionSaving: true, permissionError: "", permissionNotice: "" });
      try {
        const saved = await api.savePermissions({
          expectedRevision: editor.snapshot.revision,
          policy,
        });
        if (get().permissionEditor !== editor || get().apiClient !== api) return false;
        let next = editorOf({ ...saved, resources: editor.snapshot.resources });
        if (scope !== "all")
          next = preserveDrafts(next, editor, scope === "execution" ? "grants" : "execution");
        set({
          permissionEditor: next,
          permissionProblem: null,
          permissionNotice:
            scope === "grants" ? "connections.grants.saved" : "connections.execution.saved",
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
      set({ permissionLoading: false });
      const next = editorOf(editor.snapshot);
      set({
        permissionEditor:
          scope === "all"
            ? next
            : preserveDrafts(next, editor, scope === "execution" ? "grants" : "execution"),
        permissionProblem: null,
        permissionError: "",
        permissionNotice: "",
      });
    },
  };
}
