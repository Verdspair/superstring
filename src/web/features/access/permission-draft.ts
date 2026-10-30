import {
  executionPolicy,
  type PermissionGrant,
  type PermissionPolicy,
  type PermissionResource,
} from "../../../shared/contracts/permissions";

export type AgentOverrideDraft = NonNullable<PermissionGrant["agentOverrides"]>[string];

export interface GrantDraft {
  enabled: boolean;
  approved: boolean;
  agentIds: string[] | null;
  directories: string[];
  agentOverrides?: Record<string, AgentOverrideDraft>;
}

export function grantDraftOfEntry(
  grant: PermissionGrant | undefined,
  paused: boolean,
  revision?: string,
): GrantDraft {
  const agentOverrides = grant?.agentOverrides
    ? Object.fromEntries(
        Object.entries(grant.agentOverrides).map(([id, override]) => [
          id,
          {
            ...override,
            directories: [...override.directories],
          },
        ]),
      )
    : undefined;
  return {
    enabled: !!grant && !paused,
    approved: !!grant?.approved && (revision === undefined || grant.revision === revision),
    agentIds: grant?.agentIds ? [...grant.agentIds] : null,
    directories: grant?.directories ? [...grant.directories] : [],
    ...(agentOverrides ? { agentOverrides } : {}),
  };
}
export function grantDraftOf(
  policy: PermissionPolicy,
  resource: string,
  revision?: string,
): GrantDraft {
  return grantDraftOfEntry(
    policy.grants.find((entry) => entry.resource === resource),
    executionPolicy(policy).pausedTools.includes(resource),
    revision,
  );
}

export function sameAgentOverrides(
  a?: Record<string, AgentOverrideDraft>,
  b?: Record<string, AgentOverrideDraft>,
): boolean {
  const keysA = Object.keys(a ?? {}).sort();
  const keysB = Object.keys(b ?? {}).sort();
  if (keysA.length !== keysB.length) return false;
  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    const key = keysA[i];
    const ovA = a![key];
    const ovB = b![key];
    if (ovA.enabled !== ovB.enabled) return false;
    if (ovA.approved !== ovB.approved) return false;
    if (ovA.revision !== ovB.revision) return false;
    if (JSON.stringify([...ovA.directories].sort()) !== JSON.stringify([...ovB.directories].sort()))
      return false;
  }
  return true;
}

export function sameGrantDraft(a: GrantDraft, b: GrantDraft): boolean {
  return (
    a.enabled === b.enabled &&
    a.approved === b.approved &&
    JSON.stringify(a.agentIds === null ? null : [...a.agentIds].sort()) ===
      JSON.stringify(b.agentIds === null ? null : [...b.agentIds].sort()) &&
    JSON.stringify([...a.directories].sort()) === JSON.stringify([...b.directories].sort()) &&
    sameAgentOverrides(a.agentOverrides, b.agentOverrides)
  );
}

export function applyGrantEdits(
  policy: PermissionPolicy,
  resources: readonly PermissionResource[],
  drafts: Readonly<Record<string, GrantDraft>>,
  agentOverrides?: readonly { resource: string; agentId: string }[],
): PermissionPolicy {
  const grants = [...policy.grants];
  const execution = executionPolicy(policy);
  const paused = new Set(execution.pausedTools);

  if (agentOverrides && agentOverrides.length > 0) {
    for (const target of agentOverrides) {
      const draft = drafts[target.resource];
      if (!draft) continue;
      let index = grants.findIndex((grant) => grant.resource === target.resource);
      if (index < 0) {
        const targetResource = resources.find((r) => r.resource === target.resource);
        const newGrant: PermissionGrant = {
          resource: target.resource,
          approved: false,
          agentIds: [],
          revision: targetResource?.revision,
          directories: [],
          agentOverrides: {},
        };
        grants.push(newGrant);
        index = grants.length - 1;
      }

      const currentOverrides = grants[index].agentOverrides
        ? { ...grants[index].agentOverrides }
        : {};
      const draftOverride = draft.agentOverrides?.[target.agentId];

      if (draftOverride === undefined) {
        delete currentOverrides[target.agentId];
      } else {
        currentOverrides[target.agentId] = {
          ...(draftOverride.enabled !== undefined ? { enabled: draftOverride.enabled } : {}),
          approved: draftOverride.approved,
          ...(draftOverride.revision !== undefined ? { revision: draftOverride.revision } : {}),
          directories: [...draftOverride.directories],
        };
      }

      grants[index] = {
        ...grants[index],
        agentOverrides: Object.keys(currentOverrides).length > 0 ? currentOverrides : undefined,
      };
    }
    return {
      ...policy,
      grants,
    };
  }
  for (const resource of resources) {
    const draft = drafts[resource.resource];
    const baseline = grantDraftOf(policy, resource.resource, resource.revision);
    if (!draft || sameGrantDraft(draft, baseline)) continue;
    const index = grants.findIndex((grant) => grant.resource === resource.resource);
    const onlyOverridesChanged = sameGrantDraft(
      { ...draft, agentOverrides: baseline.agentOverrides },
      baseline,
    );
    if (index >= 0 && onlyOverridesChanged) {
      const { agentOverrides: _previous, ...base } = grants[index];
      grants[index] = Object.keys(draft.agentOverrides ?? {}).length
        ? { ...base, agentOverrides: structuredClone(draft.agentOverrides) }
        : base;
      continue;
    }
    if (draft.enabled) paused.delete(resource.resource);
    else paused.add(resource.resource);
    // A soft pause does not change the permission fingerprint of a running task.
    if (index >= 0 && sameGrantDraft({ ...draft, enabled: baseline.enabled }, baseline)) continue;
    const rawOverrides =
      draft.agentOverrides !== undefined
        ? draft.agentOverrides
        : index >= 0
          ? grants[index]?.agentOverrides
          : undefined;
    const cleanedOverrides: Record<string, AgentOverrideDraft> = {};
    if (rawOverrides) {
      for (const [id, ov] of Object.entries(rawOverrides)) {
        cleanedOverrides[id] = {
          ...(ov.enabled !== undefined ? { enabled: ov.enabled } : {}),
          approved: ov.approved,
          ...(ov.revision !== undefined ? { revision: ov.revision } : {}),
          directories: [...ov.directories],
        };
      }
    }
    const hasOverrides = Object.keys(cleanedOverrides).length > 0;
    const grant: PermissionGrant = {
      resource: resource.resource,
      approved: draft.approved,
      revision:
        index < 0 || draft.enabled || draft.approved ? resource.revision : grants[index]?.revision,
      ...(draft.agentIds === null ? {} : { agentIds: [...new Set(draft.agentIds)].sort() }),
      directories: [...new Set(draft.directories)].sort(),
      ...(hasOverrides ? { agentOverrides: cleanedOverrides } : {}),
    };
    if (index < 0) grants.push(grant);
    else grants[index] = grant;
  }
  return { ...policy, grants, execution: { ...execution, pausedTools: [...paused].sort() } };
}
