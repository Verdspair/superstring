import { describe, expect, it } from "bun:test";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { createToolCatalog } from "../../src/server/agent/tool-catalog";
import { snapshotAgentCreationRequirements } from "../../src/server/api/agents";
import { createApp } from "../../src/server/app";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { SYSTEM_TOOL_DEFINITIONS } from "../../src/server/modules/tool-definitions";
import { PermissionService, type PermissionStore } from "../../src/server/permissions/service";
import { projectToolDirectory } from "../../src/server/permissions/tool-directory";
import { createSkillActions, skillToolDefinitions } from "../../src/server/skills/actions";
import { loadMergedSkillCatalog } from "../../src/server/skills/config";
import { skillCatalogView } from "../../src/server/skills/management";
import { createWebActions, createWebToolDefinitions } from "../../src/server/web-access/actions";
import {
  ExecutionPolicySchema,
  type PermissionPolicy,
} from "../../src/shared/contracts/permissions";

const owner = { kind: "fixture", id: "catalog-boundary", agentId: "agent-a" };
function permissionFixture() {
  let reads = 0;
  let policy: PermissionPolicy = {
    version: 1,
    grants: [{ resource: "web", approved: false, directories: [], agentIds: [owner.agentId] }],
  };
  const store: PermissionStore = {
    read() {
      reads++;
      return { revision: String(reads), policy };
    },
    replace(_revision, next) {
      policy = next;
      return { revision: "saved", policy };
    },
  };
  return {
    service: new PermissionService(store),
    reset() {
      reads = 0;
    },
    reads: () => reads,
    revoke() {
      policy = { version: 1, grants: [] };
    },
  };
}

describe("capability management read boundaries", () => {
  it("projects tools and permission resources without allocating execution actions", async () => {
    const business = openBusinessDb();
    ensureDefaults(business.orm, "synthetic-model");
    const permission = permissionFixture();
    const captures: boolean[] = [];
    const app = createApp({
      business,
      permissions: permission.service,
      externalActions: () => {
        throw new Error("execution factory used by management");
      },
      externalToolDefinitions: (includeSkills) => {
        captures.push(includeSkills);
        return [
          ...createWebToolDefinitions(),
          ...(includeSkills ? skillToolDefinitions(loadMergedSkillCatalog()) : []),
        ];
      },
    });
    try {
      permission.reset();
      const tools = await app.request("/v2/tools");
      expect(tools.status).toBe(200);
      const toolRows = (await tools.json()).tools;
      expect(toolRows.some((row: { name: string }) => row.name === "skill.catalog")).toBe(true);
      expect(permission.reads()).toBe(1);
      expect(
        toolRows
          .filter((row: { invocation: string }) => row.invocation === "host-terminal")
          .map((row: { name: string }) => row.name),
      ).toEqual(["reply.sticker", "reply.text"]);
      permission.reset();
      const permissions = await app.request("/v2/permissions");
      expect(permissions.status).toBe(200);
      const resourceRows = (await permissions.json()).resources;
      expect(resourceRows.map((row: { resource: string }) => row.resource)).toEqual(["web"]);
      expect(permission.reads()).toBe(1);
      expect(captures).toEqual([true, false]);
    } finally {
      business.close();
    }
  });

  it("does not scan an unrelated Skill root while reading permission requirements", async () => {
    const business = openBusinessDb();
    ensureDefaults(business.orm, "synthetic-model");
    const permission = permissionFixture();
    const app = createApp({
      business,
      permissions: permission.service,
      skillsRoot: `${import.meta.dir}/capability-catalog-read-boundary.test.ts`,
    });
    try {
      permission.reset();
      const response = await app.request("/v2/permissions");
      expect(response.status).toBe(200);
      expect(
        (await response.json()).resources.map((row: { resource: string }) => row.resource),
      ).toEqual(["web"]);
      expect(permission.reads()).toBe(1);
      // Explicit Skill discovery still refuses a non-directory; the permission read did not cache success.
      expect((await app.request("/v2/skills")).status).toBe(503);
    } finally {
      business.close();
    }
  });

  it("keeps declarations identical to executable descriptions without execute or run state", () => {
    const catalog = loadMergedSkillCatalog();
    const declarations = [...createWebToolDefinitions(), ...skillToolDefinitions(catalog)];
    const actions = [...createWebActions(), ...createSkillActions()];
    expect(declarations.every((item) => !("execute" in item) && !("assertAvailable" in item))).toBe(
      true,
    );
    expect(projectToolDirectory([], declarations, ExecutionPolicySchema.parse({}))).toEqual(
      projectToolDirectory([], actions, ExecutionPolicySchema.parse({})),
    );
    const runtimeCatalog = createToolCatalog(actions);
    for (const definition of declarations) {
      expect(runtimeCatalog.advertised([definition.description.name])).toEqual([
        definition.description,
      ]);
    }
    expect(skillCatalogView(undefined, false).skills.every((entry) => !entry.globalEnabled)).toBe(
      true,
    );
    expect(() =>
      projectToolDirectory(
        [],
        [declarations[0]!, declarations[0]!],
        ExecutionPolicySchema.parse({}),
      ),
    ).toThrow("TOOL_CATALOG_DUPLICATE");
  });

  it("captures creation requirements from declarations without Skill discovery or execution closures", () => {
    const definitions = createWebToolDefinitions();
    const requirements = snapshotAgentCreationRequirements(() => definitions);
    expect(requirements).toEqual(
      definitions.flatMap((definition) =>
        definition.permission
          ? [
              {
                ...definition.permission,
                ...(definition.permission.directories
                  ? { directories: [...definition.permission.directories] }
                  : {}),
              },
            ]
          : [],
      ),
    );
    expect(requirements.every((requirement) => requirement.resource === "web")).toBe(true);
  });

  it("uses first-resource indexed semantics without repeatedly scanning the grant array", () => {
    const policy: PermissionPolicy = {
      version: 1,
      grants: Array.from({ length: 400 }, (_, index) => ({
        resource: `resource-${index}`,
        approved: false,
        directories: [],
      })),
    };
    const service = new PermissionService({
      read: () => ({ revision: "one-pass", policy }),
      replace: () => {
        throw new Error("unused");
      },
    });
    const refs = policy.grants.map((grant) =>
      service.source(
        {
          resource: grant.resource,
          revision: "1",
          approvalRequired: false,
        },
        owner,
      ),
    );
    policy.grants.find = () => {
      throw new Error("repeated grant scan");
    };
    expect(service.sourceAccessMany(refs, owner).every((value) => value === "available")).toBe(
      true,
    );
  });

  it("does not carry a management snapshot into an action or past its awaited effect", async () => {
    const fixture = permissionFixture();
    let invoked = false;
    const action = {
      ...createWebToolDefinitions()[0]!,
      execute: async () => {
        invoked = true;
        return { value: {}, sources: [] };
      },
    };
    fixture.service.snapshot();
    fixture.revoke();
    const executor = new ActionExecutor(fixture.service);
    await expect(
      executor.execute(
        action,
        {},
        {
          owner,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow("PERMISSION_DENIED");
    expect(invoked).toBe(false);
    const during = permissionFixture();
    const delayed = {
      ...createWebToolDefinitions()[0]!,
      execute: async () => {
        await Promise.resolve();
        during.revoke();
        return { value: { protected: "result" }, sources: [] };
      },
    };
    await expect(
      new ActionExecutor(during.service).execute(
        delayed,
        {},
        {
          owner,
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow("PERMISSION_DENIED");
  });

  it("indexes only one synchronous permission source pass and rereads the next pass", () => {
    const fixture = permissionFixture();
    const source = fixture.service.source(
      { resource: "web", revision: "web/v1", approvalRequired: false },
      owner,
    );
    const ordinary = { kind: "external", id: "ordinary", revision: "1" };
    fixture.reset();
    const refs = Array.from({ length: 400 }, () => source);
    expect(fixture.service.sourceAccessMany([ordinary], owner)).toEqual([undefined]);
    expect(fixture.reads()).toBe(0);
    expect(
      fixture.service.sourceAccessMany(refs, owner).every((value) => value === "available"),
    ).toBe(true);
    expect(fixture.reads()).toBe(1);
    fixture.revoke();
    expect(
      fixture.service.sourceAccessMany(refs, owner).every((value) => value === "revoked"),
    ).toBe(true);
    expect(fixture.reads()).toBe(2);
    expect(fixture.service.sourceAccess(source, owner)).toBe("revoked");
    expect(fixture.reads()).toBe(3);
  });
});

it("projects terminal metadata without executing actions or extra per-terminal metadata reads at scale", () => {
  let metadataReads = 0;
  let executes = 0;
  const actions = Array.from({ length: 400 }, (_, index) => ({
    get description() {
      metadataReads++;
      return {
        name: `mcp.fixture.read-${index}`,
        capability: "mcp.fixture",
        description: "Read",
        parameters: {},
        effect: "read" as const,
      };
    },
    async execute() {
      executes++;
      return { value: {}, sources: [] };
    },
  }));
  const execution = ExecutionPolicySchema.parse({});
  const empty = projectToolDirectory(SYSTEM_TOOL_DEFINITIONS, [], execution);
  expect(empty).toHaveLength(SYSTEM_TOOL_DEFINITIONS.length);
  expect(metadataReads).toBe(0);
  const rows = projectToolDirectory(SYSTEM_TOOL_DEFINITIONS, actions, execution);
  expect(rows).toHaveLength(SYSTEM_TOOL_DEFINITIONS.length + actions.length);
  expect(metadataReads).toBe(actions.length * 2);
  expect(executes).toBe(0);
  expect(rows.filter(({ invocation }) => invocation === "host-terminal")).toHaveLength(2);
  expect(() =>
    projectToolDirectory(
      SYSTEM_TOOL_DEFINITIONS,
      [{ description: SYSTEM_TOOL_DEFINITIONS[0]!.description }],
      execution,
    ),
  ).toThrow("TOOL_CATALOG_DUPLICATE");
});
