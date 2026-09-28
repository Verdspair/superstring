import { describe, expect, it } from "vitest";
import {
  ExecutionPolicySchema,
  executionPolicy,
  type PermissionPolicy,
  type PermissionResource,
} from "../../src/shared/contracts/permissions";
import { applyGrantEdits, grantDraftOf } from "../../src/web/features/access/permission-draft";
import { executionDraftOf, executionPayload } from "../../src/web/features/runs/execution-draft";

const resource = (name: string): PermissionResource => ({
  name,
  resource: name,
  description: name,
  revision: "v2",
  approvalRequired: false,
  effect: "read",
});
const resources = [resource("mcp.demo.first"), resource("mcp.demo.second")];

describe("configuration fidelity", () => {
  it("never grants an untouched resource while saving another", () => {
    const policy: PermissionPolicy = {
      version: 1,
      grants: [{ resource: resources[0].name, approved: false, revision: "v2", directories: [] }],
    };
    const drafts = Object.fromEntries(
      resources.map((item) => [item.name, grantDraftOf(policy, item.name)]),
    );
    drafts[resources[0].name].approved = true;
    const saved = applyGrantEdits(policy, resources, drafts);
    expect(saved.grants).toHaveLength(1);
    expect(saved.grants[0].approved).toBe(true);
  });

  it("pauses and resumes use without deleting approval, scope or directories", () => {
    const policy: PermissionPolicy = {
      version: 1,
      grants: [
        {
          resource: resources[0].name,
          approved: true,
          revision: "v2",
          agentIds: ["agent"],
          directories: ["/out"],
        },
      ],
    };
    const paused = applyGrantEdits(policy, resources, {
      [resources[0].name]: { ...grantDraftOf(policy, resources[0].name), enabled: false },
    });
    expect(paused.grants).toEqual(policy.grants);
    expect(executionPolicy(paused).pausedTools).toEqual([resources[0].name]);
    const resumed = applyGrantEdits(paused, resources, {
      [resources[0].name]: { ...grantDraftOf(paused, resources[0].name), enabled: true },
    });
    expect(resumed.grants).toEqual(policy.grants);
    expect(executionPolicy(resumed).pausedTools).toEqual([]);
  });

  it("requires explicit activation and reapproval for a changed revision", () => {
    const policy: PermissionPolicy = { version: 1, grants: [] };
    const created = applyGrantEdits(policy, resources, {
      [resources[0].name]: { ...grantDraftOf(policy, resources[0].name), enabled: true },
    });
    expect(created.grants).toEqual([
      { resource: resources[0].name, revision: "v2", approved: false, directories: [] },
    ]);
    const old: PermissionPolicy = {
      ...created,
      grants: [{ ...created.grants[0], revision: "v1", approved: true }],
    };
    const draft = grantDraftOf(old, resources[0].name, "v2");
    expect(draft.approved).toBe(false);
    const renewed = applyGrantEdits(old, resources, {
      [resources[0].name]: { ...draft, approved: true },
    });
    expect(renewed.grants[0]).toMatchObject({ revision: "v2", approved: true });
  });

  it("keeps deliberately configured inactive resources paused rather than silently losing edits", () => {
    const policy: PermissionPolicy = { version: 1, grants: [] };
    const saved = applyGrantEdits(policy, resources, {
      [resources[0].name]: { ...grantDraftOf(policy, resources[0].name), agentIds: ["a"] },
    });
    expect(saved.grants[0]).toMatchObject({
      resource: resources[0].name,
      approved: false,
      agentIds: ["a"],
    });
    expect(executionPolicy(saved).pausedTools).toEqual([resources[0].name]);
  });

  it("round-trips all values including fractional display units without changing bytes", () => {
    const policy = ExecutionPolicySchema.parse({
      modules: { skills: false, tasks: false, qqMedia: false },
      pausedTools: ["mcp.demo.first"],
      codeLimits: { concurrency: 5, memoryBytes: 33_554_433, maxTransferBytes: 1_048_577 },
      tasks: { retentionHours: 1 / 60 },
    });
    const draft = executionDraftOf(policy);
    expect(draft.codeConcurrency).toBe("5");
    expect(executionPayload(draft)).toEqual({ ok: true, execution: policy });
  });

  it.each(["0", "9", "1.5", "", "invalid", "Infinity"])(
    "locates invalid code concurrency %j on its draft field",
    (codeConcurrency) => {
      const draft = executionDraftOf(ExecutionPolicySchema.parse({}));
      expect(executionPayload({ ...draft, codeConcurrency })).toEqual({
        ok: false,
        problem: "codeConcurrency",
      });
    },
  );
});
