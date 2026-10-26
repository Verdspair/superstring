import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import type { ActionContext, BuiltInAction } from "../../src/server/agent/built-in-actions";
import {
  evaluatePermission,
  FilePermissionStore,
  PermissionError,
  PermissionService,
  type PermissionSnapshot,
  type PermissionStore,
} from "../../src/server/permissions/service";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import {
  executionPolicy,
  type PermissionPolicy,
  PermissionPolicySchema,
  type PermissionRequirement,
  selectEffectivePermissionGrant,
  toolExecutionEnabled,
} from "../../src/shared/contracts/permissions";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempStore(initialPolicy?: PermissionPolicy): {
  dir: string;
  file: string;
  service: PermissionService;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "perm-overrides-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, "permissions.json");
  if (initialPolicy) {
    const parsed = PermissionPolicySchema.parse(initialPolicy);
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
  const service = new PermissionService(new FilePermissionStore(file));
  return { dir, file, service };
}

class MemoryPermissionStore implements PermissionStore {
  private snapshot: PermissionSnapshot;

  constructor(initialPolicy: PermissionPolicy = { version: 1, grants: [] }) {
    const parsed = PermissionPolicySchema.parse(initialPolicy);
    const text = `${JSON.stringify(parsed, null, 2)}\n`;
    this.snapshot = {
      revision: createHash("sha256").update(text).digest("hex"),
      policy: parsed,
    };
  }

  read(): PermissionSnapshot {
    return this.snapshot;
  }

  replace(expectedRevision: string, policy: PermissionPolicy): PermissionSnapshot {
    if (this.snapshot.revision !== expectedRevision) {
      throw new PermissionError("PERMISSION_POLICY_CONFLICT");
    }
    const parsed = PermissionPolicySchema.parse(policy);
    const text = `${JSON.stringify(parsed, null, 2)}\n`;
    this.snapshot = {
      revision: createHash("sha256").update(text).digest("hex"),
      policy: parsed,
    };
    return this.snapshot;
  }
}

function makeAction(
  permission: PermissionRequirement,
  effect: "read" | "write" = "read",
): BuiltInAction {
  return {
    permission,
    description: {
      name: permission.resource,
      description: `Execute ${permission.resource}`,
      capability: "test.capability",
      parameters: {},
      effect,
    },
    async execute() {
      return { value: "ok", sources: [] };
    },
  };
}

describe("new agent canonical permission overrides", () => {
  it("grants full installed resource overrides to new agent while preserving old base behavior", async () => {
    const { dir, service } = createTempStore();
    const allowedDir = path.resolve(dir, "workspace");

    const initialPolicy: PermissionPolicy = {
      version: 1,
      grants: [
        {
          resource: "mcp.global.read",
          approved: false,
          directories: [],
        },
        {
          resource: "mcp.scoped.read",
          approved: true,
          revision: "rev-scoped-1",
          agentIds: ["old-agent-1"],
          directories: [allowedDir],
        },
        {
          resource: "mcp.denied.read",
          approved: false,
          revision: "rev-denied-1",
          agentIds: [],
          directories: [],
        },
      ],
    };
    service.replace("", initialPolicy);

    const oldOwner1: RunOwner = { kind: "run", id: "run-old-1", agentId: "old-agent-1" };
    const oldOwner2: RunOwner = { kind: "run", id: "run-old-2", agentId: "old-agent-2" };
    const newOwner: RunOwner = { kind: "run", id: "run-new-1", agentId: "new-agent-1" };

    const requirements: readonly PermissionRequirement[] = [
      {
        resource: "mcp.global.read",
        revision: "rev-global-1",
        approvalRequired: false,
        directories: [],
      },
      {
        resource: "mcp.scoped.read",
        revision: "rev-scoped-1",
        approvalRequired: false,
        directories: [allowedDir],
      },
      {
        resource: "mcp.denied.read",
        revision: "rev-denied-1",
        approvalRequired: false,
        directories: [],
      },
      {
        resource: "mcp.absent.tool",
        revision: "rev-absent-1",
        approvalRequired: false,
        directories: [allowedDir],
      },
    ];

    const updatedSnapshot = service.grantForNewAgent("new-agent-1", requirements);

    expect(updatedSnapshot.policy.grants).toHaveLength(4);
    const absentGrant = updatedSnapshot.policy.grants.find((g) => g.resource === "mcp.absent.tool");
    expect(absentGrant).toBeDefined();
    expect(absentGrant?.approved).toBe(false);
    expect(absentGrant?.agentIds).toEqual([]);
    expect(absentGrant?.agentOverrides?.["new-agent-1"]).toEqual({
      enabled: true,
      approved: true,
      revision: "rev-absent-1",
      directories: [allowedDir],
    });

    const executor = new ActionExecutor(service);

    const newCtx: ActionContext = { owner: newOwner, signal: new AbortController().signal };
    for (const req of requirements) {
      const act = makeAction(req, "read");
      expect(executor.allowed(act, newCtx)).toBe(true);
      expect(() => executor.assert(act, newCtx)).not.toThrow();
    }

    const oldCtx1: ActionContext = { owner: oldOwner1, signal: new AbortController().signal };
    const oldCtx2: ActionContext = { owner: oldOwner2, signal: new AbortController().signal };

    expect(
      executor.allowed(
        makeAction({
          resource: "mcp.global.read",
          revision: "rev-global-1",
          approvalRequired: true,
        }),
        oldCtx1,
      ),
    ).toBe(false);

    expect(
      executor.allowed(
        makeAction({
          resource: "mcp.scoped.read",
          revision: "rev-scoped-1",
          approvalRequired: false,
          directories: [allowedDir],
        }),
        oldCtx1,
      ),
    ).toBe(true);
    expect(
      executor.allowed(
        makeAction({
          resource: "mcp.scoped.read",
          revision: "rev-scoped-1",
          approvalRequired: false,
          directories: [allowedDir],
        }),
        oldCtx2,
      ),
    ).toBe(false);

    expect(
      executor.allowed(
        makeAction({
          resource: "mcp.denied.read",
          revision: "rev-denied-1",
          approvalRequired: false,
        }),
        oldCtx1,
      ),
    ).toBe(false);

    expect(
      executor.allowed(
        makeAction({
          resource: "mcp.absent.tool",
          revision: "rev-absent-1",
          approvalRequired: false,
        }),
        oldCtx1,
      ),
    ).toBe(false);
  });

  it("ensures old agent source revision and approval key remain byte-equal without in-flight revocation", () => {
    const memStore = new MemoryPermissionStore();
    const service = new PermissionService(memStore);

    const initialPolicy: PermissionPolicy = {
      version: 1,
      grants: [
        {
          resource: "mcp.tool.alpha",
          approved: true,
          revision: "rev-alpha-1",
          agentIds: ["old-agent-1"],
          directories: ["/data/alpha"],
        },
        {
          resource: "mcp.tool.beta",
          approved: false,
          revision: "rev-beta-1",
          directories: [],
          agentOverrides: {
            "legacy-agent-override": {
              approved: true,
              revision: "rev-legacy-override",
              directories: ["/data/legacy"],
            },
          },
        },
      ],
    };
    service.replace(memStore.read().revision, initialPolicy);

    const oldOwner1: RunOwner = { kind: "run", id: "run-old-1", agentId: "old-agent-1" };
    const legacyOwner: RunOwner = {
      kind: "run",
      id: "run-legacy",
      agentId: "legacy-agent-override",
    };

    const reqAlpha: PermissionRequirement = {
      resource: "mcp.tool.alpha",
      revision: "rev-alpha-1",
      approvalRequired: false,
      directories: ["/data/alpha"],
    };
    const reqBeta: PermissionRequirement = {
      resource: "mcp.tool.beta",
      revision: "rev-legacy-override",
      approvalRequired: false,
      directories: ["/data/legacy"],
    };

    const sourceRefAlphaBefore = service.source(reqAlpha, oldOwner1);
    const approvalKeyAlphaBefore = service.approvalKey(reqAlpha, oldOwner1);

    const sourceRefBetaBefore = service.source(reqBeta, legacyOwner);
    const approvalKeyBetaBefore = service.approvalKey(reqBeta, legacyOwner);

    expect(service.sourceAccess(sourceRefAlphaBefore, oldOwner1)).toBe("available");
    expect(service.sourceAccess(sourceRefBetaBefore, legacyOwner)).toBe("available");

    const newRequirements: readonly PermissionRequirement[] = [
      {
        resource: "mcp.tool.alpha",
        revision: "rev-alpha-1",
        approvalRequired: false,
        directories: ["/data/alpha"],
      },
      {
        resource: "mcp.tool.beta",
        revision: "rev-beta-1",
        approvalRequired: false,
        directories: ["/data/beta"],
      },
      {
        resource: "mcp.tool.gamma",
        revision: "rev-gamma-1",
        approvalRequired: false,
        directories: ["/data/gamma"],
      },
    ];
    service.grantForNewAgent("new-agent-2", newRequirements);

    const sourceRefAlphaAfter = service.source(reqAlpha, oldOwner1);
    const approvalKeyAlphaAfter = service.approvalKey(reqAlpha, oldOwner1);

    const sourceRefBetaAfter = service.source(reqBeta, legacyOwner);
    const approvalKeyBetaAfter = service.approvalKey(reqBeta, legacyOwner);

    expect(sourceRefAlphaAfter.revision).toBe(sourceRefAlphaBefore.revision);
    expect(approvalKeyAlphaAfter).toBe(approvalKeyAlphaBefore);

    expect(sourceRefBetaAfter.revision).toBe(sourceRefBetaBefore.revision);
    expect(approvalKeyBetaAfter).toBe(approvalKeyBetaBefore);

    expect(service.sourceAccess(sourceRefAlphaBefore, oldOwner1)).toBe("available");
    expect(service.sourceAccess(sourceRefBetaBefore, legacyOwner)).toBe("available");

    const selectedLegacy = selectEffectivePermissionGrant(
      service.snapshot().policy,
      "mcp.tool.beta",
      "legacy-agent-override",
    );
    expect(selectedLegacy?.grant.enabled).toBeUndefined();
    expect(selectedLegacy?.identity).toEqual([
      "mcp.tool.beta",
      "legacy-agent-override",
      {
        approved: true,
        revision: "rev-legacy-override",
        directories: ["/data/legacy"],
      },
    ]);
  });

  it("denies access when enabled is explicitly false even if base is globally allowed, revoking source without bypass", () => {
    const memStore = new MemoryPermissionStore();
    const service = new PermissionService(memStore);

    const policy: PermissionPolicy = {
      version: 1,
      grants: [
        {
          resource: "mcp.open.service",
          approved: true,
          revision: "rev-open-1",
          directories: [],
          agentOverrides: {
            "disabled-agent": {
              enabled: false,
              approved: true,
              revision: "rev-open-1",
              directories: [],
            },
            "unapproved-agent": {
              enabled: true,
              approved: false,
              revision: "rev-open-1",
              directories: [],
            },
          },
        },
      ],
    };
    service.replace(memStore.read().revision, policy);

    const disabledOwner: RunOwner = { kind: "run", id: "run-dis", agentId: "disabled-agent" };
    const unapprovedOwner: RunOwner = { kind: "run", id: "run-unapp", agentId: "unapproved-agent" };
    const normalOwner: RunOwner = { kind: "run", id: "run-norm", agentId: "normal-agent" };

    const reqWithoutApproval: PermissionRequirement = {
      resource: "mcp.open.service",
      revision: "rev-open-1",
      approvalRequired: false,
    };
    const reqWithApproval: PermissionRequirement = {
      resource: "mcp.open.service",
      revision: "rev-open-1",
      approvalRequired: true,
    };

    expect(
      evaluatePermission(policy, reqWithoutApproval, normalOwner, "direct", "read", true),
    ).toEqual({
      allowed: true,
    });

    const disabledDecision = evaluatePermission(
      policy,
      reqWithoutApproval,
      disabledOwner,
      "direct",
      "read",
      true,
    );
    expect(disabledDecision).toEqual({ allowed: false, code: "PERMISSION_DENIED" });

    const disabledDecisionWithApproval = evaluatePermission(
      policy,
      reqWithApproval,
      disabledOwner,
      "direct",
      "read",
      true,
    );
    expect(disabledDecisionWithApproval).toEqual({ allowed: false, code: "PERMISSION_DENIED" });

    const disabledSource = service.source(reqWithoutApproval, disabledOwner);
    expect(service.sourceAccess(disabledSource, disabledOwner)).toBe("revoked");

    const executor = new ActionExecutor(service);
    const disabledCtx: ActionContext = {
      owner: disabledOwner,
      signal: new AbortController().signal,
    };
    expect(executor.allowed(makeAction(reqWithoutApproval), disabledCtx)).toBe(false);
    expect(() => executor.assert(makeAction(reqWithoutApproval), disabledCtx)).toThrow(
      new PermissionError("PERMISSION_DENIED"),
    );

    const unapprovedDecision = evaluatePermission(
      policy,
      reqWithApproval,
      unapprovedOwner,
      "direct",
      "read",
      true,
    );
    expect(unapprovedDecision).toEqual({ allowed: false, code: "PERMISSION_APPROVAL_REQUIRED" });

    const unapprovedSource = service.source(reqWithApproval, unapprovedOwner);
    expect(service.sourceAccess(unapprovedSource, unapprovedOwner)).toBe("available");

    const approvalKey = service.approvalKey(reqWithApproval, unapprovedOwner);
    const approvedDecision = service.decide(
      reqWithApproval,
      unapprovedOwner,
      "direct",
      "read",
      true,
      approvalKey,
    );
    expect(approvedDecision).toEqual({ allowed: true });
  });

  it("removes only own agent overrides while inheriting base grants and leaving other agents intact", () => {
    const memStore = new MemoryPermissionStore();
    const service = new PermissionService(memStore);

    const initialPolicy: PermissionPolicy = {
      version: 1,
      grants: [
        {
          resource: "mcp.base.global",
          approved: true,
          revision: "rev-global-1",
          directories: [],
        },
      ],
    };
    service.replace(memStore.read().revision, initialPolicy);

    service.grantForNewAgent("agent-alpha", [
      {
        resource: "mcp.base.global",
        revision: "rev-global-1",
        approvalRequired: false,
        directories: [],
      },
      {
        resource: "mcp.absent.feature",
        revision: "rev-feature-1",
        approvalRequired: false,
        directories: [],
      },
    ]);

    service.grantForNewAgent("agent-beta", [
      {
        resource: "mcp.base.global",
        revision: "rev-global-1",
        approvalRequired: false,
        directories: [],
      },
      {
        resource: "mcp.absent.feature",
        revision: "rev-feature-1",
        approvalRequired: false,
        directories: [],
      },
    ]);

    const ownerAlpha: RunOwner = { kind: "run", id: "run-a", agentId: "agent-alpha" };
    const ownerBeta: RunOwner = { kind: "run", id: "run-b", agentId: "agent-beta" };

    const reqGlobal: PermissionRequirement = {
      resource: "mcp.base.global",
      revision: "rev-global-1",
      approvalRequired: false,
    };
    const reqFeature: PermissionRequirement = {
      resource: "mcp.absent.feature",
      revision: "rev-feature-1",
      approvalRequired: false,
    };

    expect(
      evaluatePermission(service.snapshot().policy, reqFeature, ownerAlpha, "direct", "read", true),
    ).toEqual({
      allowed: true,
    });
    expect(
      evaluatePermission(service.snapshot().policy, reqFeature, ownerBeta, "direct", "read", true),
    ).toEqual({
      allowed: true,
    });

    const afterRemoveSnapshot = service.removeOwnOverrides("agent-alpha");

    const globalGrant = afterRemoveSnapshot.policy.grants.find(
      (g) => g.resource === "mcp.base.global",
    );
    expect(globalGrant?.agentOverrides?.["agent-alpha"]).toBeUndefined();
    expect(globalGrant?.agentOverrides?.["agent-beta"]).toBeDefined();

    const featureGrant = afterRemoveSnapshot.policy.grants.find(
      (g) => g.resource === "mcp.absent.feature",
    );
    expect(featureGrant?.agentOverrides?.["agent-alpha"]).toBeUndefined();
    expect(featureGrant?.agentOverrides?.["agent-beta"]).toBeDefined();

    expect(
      evaluatePermission(afterRemoveSnapshot.policy, reqGlobal, ownerAlpha, "direct", "read", true),
    ).toEqual({ allowed: true });

    expect(
      evaluatePermission(
        afterRemoveSnapshot.policy,
        reqFeature,
        ownerAlpha,
        "direct",
        "read",
        true,
      ),
    ).toEqual({ allowed: false, code: "PERMISSION_DENIED" });

    expect(
      evaluatePermission(afterRemoveSnapshot.policy, reqFeature, ownerBeta, "direct", "read", true),
    ).toEqual({ allowed: true });

    const revBeforeNoOp = afterRemoveSnapshot.revision;
    const noOpSnapshot = service.removeOwnOverrides("non-existent-agent");
    expect(noOpSnapshot.revision).toBe(revBeforeNoOp);

    service.removeOwnOverrides("agent-beta");
    const cleanFeatureGrant = service
      .snapshot()
      .policy.grants.find((g) => g.resource === "mcp.absent.feature");
    expect(cleanFeatureGrant?.agentOverrides).toBeUndefined();
    expect(cleanFeatureGrant?.approved).toBe(false);
    expect(cleanFeatureGrant?.agentIds).toEqual([]);
  });

  it("never selects overrides when owner is null, undefined, or missing agentId", () => {
    const memStore = new MemoryPermissionStore();
    const service = new PermissionService(memStore);

    const policy: PermissionPolicy = {
      version: 1,
      grants: [
        {
          resource: "mcp.scoped.only",
          approved: true,
          revision: "rev-1",
          agentIds: ["registered-agent"],
          directories: [],
          agentOverrides: {
            "registered-agent": {
              enabled: true,
              approved: true,
              revision: "rev-1",
              directories: [],
            },
          },
        },
        {
          resource: "mcp.absent.created",
          approved: false,
          revision: "rev-1",
          agentIds: [],
          directories: [],
          agentOverrides: {
            "registered-agent": {
              enabled: true,
              approved: true,
              revision: "rev-1",
              directories: [],
            },
          },
        },
      ],
    };
    service.replace(memStore.read().revision, policy);

    const nullAgentOwner: RunOwner = { kind: "system", id: "sys-1" };
    const emptyAgentOwner: RunOwner = { kind: "system", id: "sys-2", agentId: "" };
    const validOwner: RunOwner = { kind: "run", id: "run-reg", agentId: "registered-agent" };

    const reqScoped: PermissionRequirement = {
      resource: "mcp.scoped.only",
      revision: "rev-1",
      approvalRequired: false,
    };
    const reqAbsent: PermissionRequirement = {
      resource: "mcp.absent.created",
      revision: "rev-1",
      approvalRequired: false,
    };

    expect(evaluatePermission(policy, reqScoped, validOwner, "direct", "read", true)).toEqual({
      allowed: true,
    });
    expect(evaluatePermission(policy, reqAbsent, validOwner, "direct", "read", true)).toEqual({
      allowed: true,
    });

    for (const ownerWithoutAgent of [nullAgentOwner, emptyAgentOwner]) {
      expect(
        evaluatePermission(policy, reqScoped, ownerWithoutAgent, "direct", "read", true),
      ).toEqual({
        allowed: false,
        code: "PERMISSION_DENIED",
      });
      expect(
        evaluatePermission(policy, reqAbsent, ownerWithoutAgent, "direct", "read", true),
      ).toEqual({
        allowed: false,
        code: "PERMISSION_DENIED",
      });

      const selectedScoped = selectEffectivePermissionGrant(
        policy,
        "mcp.scoped.only",
        ownerWithoutAgent.agentId,
      );
      expect(selectedScoped?.identity).toEqual(
        policy.grants[0]
          ? {
              resource: "mcp.scoped.only",
              approved: true,
              revision: "rev-1",
              agentIds: ["registered-agent"],
              directories: [],
            }
          : undefined,
      );

      const sourceScoped = service.source(reqScoped, ownerWithoutAgent);
      expect(service.sourceAccess(sourceScoped, ownerWithoutAgent)).toBe("revoked");

      const executor = new ActionExecutor(service);
      const ctx: ActionContext = { owner: ownerWithoutAgent, signal: new AbortController().signal };
      expect(executor.allowed(makeAction(reqScoped), ctx)).toBe(false);
      expect(() => executor.assert(makeAction(reqScoped), ctx)).toThrow(
        new PermissionError("PERMISSION_DENIED"),
      );
    }

    expect(() => service.grantForNewAgent("", [reqScoped])).toThrow(
      new PermissionError("PERMISSION_DENIED"),
    );
    expect(() => service.removeOwnOverrides("")).toThrow(new PermissionError("PERMISSION_DENIED"));
  });

  it("rejects conflicting revisions, empty revisions, relative directories, and preserves global module boundaries", () => {
    const memStore = new MemoryPermissionStore();
    const service = new PermissionService(memStore);

    const baseDir = path.resolve("/var", "data");
    const subDirA = path.join(baseDir, "dir-a");
    const subDirB = path.join(baseDir, "dir-b");

    const conflictingRequirements: readonly PermissionRequirement[] = [
      { resource: "mcp.calc.eval", revision: "rev-1.0", approvalRequired: false, directories: [] },
      { resource: "mcp.calc.eval", revision: "rev-2.0", approvalRequired: false, directories: [] },
    ];
    expect(() => service.grantForNewAgent("agent-conflict", conflictingRequirements)).toThrow(
      new PermissionError("PERMISSION_REVISION_CHANGED"),
    );

    const emptyRevisionRequirements: readonly PermissionRequirement[] = [
      { resource: "mcp.calc.eval", revision: "", approvalRequired: false, directories: [] },
    ];
    expect(() => service.grantForNewAgent("agent-empty-rev", emptyRevisionRequirements)).toThrow(
      new PermissionError("PERMISSION_REVISION_CHANGED"),
    );

    const relativeDirRequirements: readonly PermissionRequirement[] = [
      {
        resource: "mcp.file.read",
        revision: "rev-1",
        approvalRequired: false,
        directories: ["relative/dir"],
      },
    ];
    expect(() => service.grantForNewAgent("agent-relative-dir", relativeDirRequirements)).toThrow(
      new PermissionError("PERMISSION_DIRECTORY_DENIED"),
    );

    const dedupeRequirements: readonly PermissionRequirement[] = [
      {
        resource: "mcp.file.read",
        revision: "rev-1",
        approvalRequired: false,
        directories: [subDirA, subDirB],
      },
      {
        resource: "mcp.file.read",
        revision: "rev-1",
        approvalRequired: false,
        directories: [subDirB, baseDir],
      },
    ];
    const dedupeSnapshot = service.grantForNewAgent("agent-dedupe", dedupeRequirements);
    const fileGrant = dedupeSnapshot.policy.grants.find((g) => g.resource === "mcp.file.read");
    const override = fileGrant?.agentOverrides?.["agent-dedupe"];
    expect(override?.directories).toEqual([subDirA, subDirB, baseDir]);

    expect(() => service.grantForNewAgent("agent-dedupe", dedupeRequirements)).toThrow(
      new PermissionError("PERMISSION_POLICY_CONFLICT"),
    );

    const ownerDedupe: RunOwner = { kind: "run", id: "run-d", agentId: "agent-dedupe" };
    const allowedPathInside = path.join(subDirA, "file.txt");
    const allowedReq: PermissionRequirement = {
      resource: "mcp.file.read",
      revision: "rev-1",
      approvalRequired: false,
      directories: [allowedPathInside],
    };
    expect(
      evaluatePermission(dedupeSnapshot.policy, allowedReq, ownerDedupe, "direct", "read", true),
    ).toEqual({
      allowed: true,
    });

    const outsidePath = path.resolve("/unauthorized", "secret.txt");
    const outsideReq: PermissionRequirement = {
      resource: "mcp.file.read",
      revision: "rev-1",
      approvalRequired: false,
      directories: [outsidePath],
    };
    expect(
      evaluatePermission(dedupeSnapshot.policy, outsideReq, ownerDedupe, "direct", "read", true),
    ).toEqual({
      allowed: false,
      code: "PERMISSION_DIRECTORY_DENIED",
    });

    const policyWithGlobalModules: PermissionPolicy = {
      version: 1,
      grants: dedupeSnapshot.policy.grants,
      execution: {
        research: false,
        code: false,
        modules: {
          mcp: true,
          skills: true,
          web: false,
          tasks: true,
          memoryJobs: true,
          knowledgeJobs: true,
          qqMedia: true,
          qqStickers: true,
          qqMembers: true,
        },
        maintenance: {
          memoryTimeoutSeconds: 3600,
          knowledgeTimeoutSeconds: 3600,
        },
        telemetry: {
          retentionDays: 14,
        },
        pausedTools: ["mcp.file.read"],
        tasks: {
          concurrency: 2,
          retentionHours: 24,
          leaseSeconds: 30,
          pollMs: 500,
        },
        researchLimits: {
          maxPerRun: 2,
          maxSteps: 6,
          deadlineMs: 60000,
          maxConclusionChars: 4000,
        },
        codeLimits: {
          timeoutMs: 20000,
          maxCalls: 32,
          concurrency: 3,
          memoryBytes: 33554432,
          maxTransferBytes: 1048576,
          maxConclusionChars: 4000,
        },
        loop: {
          maxSteps: 16,
          readBatch: 3,
          noProgress: 3,
          concurrency: 4,
          modelConcurrency: 4,
          providerConcurrency: 2,
        },
        qq: {
          retryDelayMs: 15000,
          maxAttempts: 3,
          deliveryTtlSeconds: 600,
        },
        system: {
          maxAttempts: 3,
          retryDelayMs: 2000,
        },
      },
    };

    const exec = executionPolicy(policyWithGlobalModules);
    expect(toolExecutionEnabled(exec, "web.search")).toBe(false);
    expect(toolExecutionEnabled(exec, "mcp.file.read")).toBe(false);
  });

  it("enforces single CAS conflict failure without retry and preserves overrides through full policy PUT roundtrip", () => {
    const { file, service } = createTempStore();

    const baseRequirement: PermissionRequirement = {
      resource: "mcp.service.ping",
      revision: "rev-1",
      approvalRequired: false,
      directories: [],
    };
    service.grantForNewAgent("agent-cas-1", [baseRequirement]);

    const baseStore = new FilePermissionStore(file);
    let readCalls = 0;
    let replaceCalls = 0;
    const conflictStore: PermissionStore = {
      read() {
        readCalls += 1;
        return baseStore.read();
      },
      replace(expected: string, policy: PermissionPolicy) {
        replaceCalls += 1;
        // 外部真实 replace 推进底层 revision：
        service.grantForNewAgent("interleaving-agent", [
          {
            resource: "mcp.service.interleave",
            revision: "rev-x",
            approvalRequired: false,
            directories: [],
          },
        ]);
        // 然后执行原 expected 的 replace，由于底层 revision 已被外部推进，必抛 PERMISSION_POLICY_CONFLICT
        return baseStore.replace(expected, policy);
      },
    };
    const conflictingService = new PermissionService(conflictStore);

    expect(() =>
      conflictingService.grantForNewAgent("agent-cas-2", [
        {
          resource: "mcp.service.status",
          revision: "rev-2",
          approvalRequired: false,
          directories: [],
        },
      ]),
    ).toThrow(new PermissionError("PERMISSION_POLICY_CONFLICT"));
    expect(readCalls).toBe(1);
    expect(replaceCalls).toBe(1);

    const currentSnapshot = service.snapshot();
    const serialized = JSON.stringify(currentSnapshot.policy);
    const deserialized = JSON.parse(serialized);
    const validated = PermissionPolicySchema.parse(deserialized);

    const roundtripSnapshot = service.replace(currentSnapshot.revision, validated);
    expect(
      roundtripSnapshot.policy.grants.find((g) => g.resource === "mcp.service.ping")
        ?.agentOverrides?.["agent-cas-1"],
    ).toEqual({
      enabled: true,
      approved: true,
      revision: "rev-1",
      directories: [],
    });
    expect(
      roundtripSnapshot.policy.grants.find((g) => g.resource === "mcp.service.interleave")
        ?.agentOverrides?.["interleaving-agent"],
    ).toEqual({
      enabled: true,
      approved: true,
      revision: "rev-x",
      directories: [],
    });

    const emptyGrantSnapshot = service.grantForNewAgent("agent-empty-reqs", []);
    expect(emptyGrantSnapshot.revision).toBe(roundtripSnapshot.revision);
  });
});
