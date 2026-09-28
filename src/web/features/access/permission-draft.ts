import {
  executionPolicy,
  type PermissionPolicy,
  type PermissionResource,
} from "../../../shared/contracts/permissions";

export interface GrantDraft {
  enabled: boolean;
  approved: boolean;
  agentIds: string[] | null;
  directories: string[];
}

export function grantDraftOf(
  policy: PermissionPolicy,
  resource: string,
  revision?: string,
): GrantDraft {
  const grant = policy.grants.find((entry) => entry.resource === resource);
  return {
    enabled: !!grant && !executionPolicy(policy).pausedTools.includes(resource),
    approved: !!grant?.approved && (revision === undefined || grant.revision === revision),
    agentIds: grant?.agentIds ? [...grant.agentIds] : null,
    directories: grant?.directories ? [...grant.directories] : [],
  };
}

export function sameGrantDraft(a: GrantDraft, b: GrantDraft): boolean {
  return (
    a.enabled === b.enabled &&
    a.approved === b.approved &&
    JSON.stringify(a.agentIds === null ? null : [...a.agentIds].sort()) ===
      JSON.stringify(b.agentIds === null ? null : [...b.agentIds].sort()) &&
    JSON.stringify([...a.directories].sort()) === JSON.stringify([...b.directories].sort())
  );
}

export function applyGrantEdits(
  policy: PermissionPolicy,
  resources: readonly PermissionResource[],
  drafts: Readonly<Record<string, GrantDraft>>,
): PermissionPolicy {
  const grants = [...policy.grants];
  const execution = executionPolicy(policy);
  const paused = new Set(execution.pausedTools);
  for (const resource of resources) {
    const draft = drafts[resource.resource];
    const baseline = grantDraftOf(policy, resource.resource, resource.revision);
    if (!draft || sameGrantDraft(draft, baseline)) continue;
    const index = grants.findIndex((grant) => grant.resource === resource.resource);
    if (draft.enabled) paused.delete(resource.resource);
    else paused.add(resource.resource);
    // A soft pause does not change the permission fingerprint of a running task.
    if (index >= 0 && sameGrantDraft({ ...draft, enabled: baseline.enabled }, baseline)) continue;
    const grant = {
      resource: resource.resource,
      approved: draft.approved,
      revision:
        index < 0 || draft.enabled || draft.approved ? resource.revision : grants[index]?.revision,
      ...(draft.agentIds === null ? {} : { agentIds: [...new Set(draft.agentIds)].sort() }),
      directories: [...new Set(draft.directories)].sort(),
    };
    if (index < 0) grants.push(grant);
    else grants[index] = grant;
  }
  return { ...policy, grants, execution: { ...execution, pausedTools: [...paused].sort() } };
}
