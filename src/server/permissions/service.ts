import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import {
  type ExecutionMode,
  type PermissionDecision,
  type PermissionPolicy,
  PermissionPolicySchema,
  type PermissionRequirement,
} from "../../shared/contracts/permissions";

export class PermissionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function containsPath(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function evaluatePermission(
  policy: PermissionPolicy,
  requirement: PermissionRequirement | undefined,
  owner: RunOwner,
  mode: ExecutionMode,
  effect: "read" | "write",
  sandboxCallable: boolean,
  approvedOnce = false,
): PermissionDecision {
  if ((mode !== "direct" && effect !== "read") || (mode === "sandbox" && !sandboxCallable))
    return { allowed: false, code: "PERMISSION_MODE_DENIED" };
  if (!requirement) return { allowed: true };
  const grant = policy.grants.find((entry) => entry.resource === requirement.resource);
  if (!grant || (grant.agentIds && (!owner.agentId || !grant.agentIds.includes(owner.agentId))))
    return { allowed: false, code: "PERMISSION_DENIED" };
  if (requirement.approvalRequired && !grant.approved && !approvedOnce)
    return { allowed: false, code: "PERMISSION_APPROVAL_REQUIRED" };
  if (
    (requirement.approvalRequired || grant.revision !== undefined) &&
    grant.revision !== requirement.revision
  )
    return { allowed: false, code: "PERMISSION_REVISION_CHANGED" };
  if (
    requirement.directories?.some(
      (requested) =>
        !grant.directories.some(
          (directory) =>
            path.isAbsolute(directory) &&
            path.isAbsolute(requested) &&
            containsPath(directory, requested),
        ),
    )
  )
    return { allowed: false, code: "PERMISSION_DIRECTORY_DENIED" };
  return { allowed: true };
}

export interface PermissionSnapshot {
  revision: string;
  policy: PermissionPolicy;
}
export interface PermissionStore {
  read(): PermissionSnapshot;
  replace(expectedRevision: string, policy: PermissionPolicy): PermissionSnapshot;
}

export class FilePermissionStore implements PermissionStore {
  constructor(private readonly file: string) {}
  read(): PermissionSnapshot {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { revision: "", policy: { version: 1, grants: [] } };
      throw new PermissionError("PERMISSION_POLICY_UNAVAILABLE");
    }
    try {
      return {
        revision: createHash("sha256").update(text).digest("hex"),
        policy: PermissionPolicySchema.parse(JSON.parse(text)),
      };
    } catch {
      throw new PermissionError("PERMISSION_POLICY_INVALID");
    }
  }
  replace(expectedRevision: string, policy: PermissionPolicy): PermissionSnapshot {
    const parsed = PermissionPolicySchema.parse(policy);
    if (this.read().revision !== expectedRevision)
      throw new PermissionError("PERMISSION_POLICY_CONFLICT");
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* Preserve the original write failure. */
      }
      throw error;
    }
    return this.read();
  }
}

export class PermissionService {
  /** 策略保存后的变更订阅：写入已经成功，订阅回调的异常不能反过来让保存失败。 */
  private readonly policyListeners = new Set<() => void>();
  constructor(private readonly store: PermissionStore) {}
  snapshot(): PermissionSnapshot {
    return this.store.read();
  }
  replace(expectedRevision: string, policy: PermissionPolicy): PermissionSnapshot {
    const snapshot = this.store.replace(expectedRevision, policy);
    for (const listener of [...this.policyListeners]) {
      try {
        listener();
      } catch {
        console.warn("permission policy listener failed");
      }
    }
    return snapshot;
  }
  /** 订阅策略保存；返回退订。CAS 失败时 replace() 抛错，不触发通知。 */
  subscribe(listener: () => void): () => void {
    this.policyListeners.add(listener);
    return () => this.policyListeners.delete(listener);
  }
  private grantRevision(policy: PermissionPolicy, requirement: PermissionRequirement): string {
    const grant = policy.grants.find((entry) => entry.resource === requirement.resource);
    if (!grant) throw new PermissionError("PERMISSION_DENIED");
    return createHash("sha256").update(JSON.stringify(grant)).digest("hex");
  }
  source(requirement: PermissionRequirement): SourceRef {
    return {
      kind: "tool_permission",
      id: requirement.resource,
      revision: this.grantRevision(this.store.read().policy, requirement),
    };
  }
  sourceAccess(source: SourceRef, owner: RunOwner): "available" | "revoked" | undefined {
    if (source.kind !== "tool_permission") return undefined;
    let policy: PermissionPolicy;
    try {
      policy = this.store.read().policy;
    } catch {
      return "revoked";
    }
    const grant = policy.grants.find((entry) => entry.resource === source.id);
    if (!grant || (grant.agentIds && (!owner.agentId || !grant.agentIds.includes(owner.agentId))))
      return "revoked";
    return createHash("sha256").update(JSON.stringify(grant)).digest("hex") === source.revision
      ? "available"
      : "revoked";
  }
  private approvalKeyFromPolicy(
    policy: PermissionPolicy,
    requirement: PermissionRequirement,
    owner: RunOwner,
  ): string {
    return createHash("sha256")
      .update(JSON.stringify([requirement, owner, this.grantRevision(policy, requirement)]))
      .digest("hex");
  }
  approvalKey(requirement: PermissionRequirement, owner: RunOwner): string {
    return this.approvalKeyFromPolicy(this.store.read().policy, requirement, owner);
  }
  decide(
    requirement: PermissionRequirement | undefined,
    owner: RunOwner,
    mode: ExecutionMode,
    effect: "read" | "write",
    sandboxCallable: boolean,
    approvalKey?: string,
  ): PermissionDecision {
    if (!requirement)
      return evaluatePermission(
        { version: 1, grants: [] },
        undefined,
        owner,
        mode,
        effect,
        sandboxCallable,
      );
    // 同一入场边界只取一次策略快照：批准键与权限判定必须用同一份 policy。
    const policy = this.store.read().policy;
    return evaluatePermission(
      policy,
      requirement,
      owner,
      mode,
      effect,
      sandboxCallable,
      !!(approvalKey && approvalKey === this.approvalKeyFromPolicy(policy, requirement, owner)),
    );
  }
  assert(
    requirement: PermissionRequirement | undefined,
    owner: RunOwner,
    mode: ExecutionMode,
    effect: "read" | "write",
    sandboxCallable: boolean,
    approvalKey?: string,
  ): void {
    const decision = this.decide(requirement, owner, mode, effect, sandboxCallable, approvalKey);
    if (!decision.allowed) throw new PermissionError(decision.code);
  }
}

export const unconfiguredPermissions = new PermissionService({
  read: () => ({ revision: "", policy: { version: 1, grants: [] } }),
  replace() {
    throw new PermissionError("PERMISSION_MANAGEMENT_UNAVAILABLE");
  },
});
