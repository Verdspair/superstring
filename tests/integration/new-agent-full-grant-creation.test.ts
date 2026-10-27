import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { createApp } from "../../src/server/app";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_SYSTEM_PROMPT,
  ensureDefaults,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import {
  FilePermissionStore,
  PermissionError,
  PermissionService,
  type PermissionStore,
} from "../../src/server/permissions/service";
import {
  type PermissionPolicy,
  PermissionPolicySchema,
  type PermissionRequirement,
} from "../../src/shared/contracts/permissions";
import { cloneBusinessDb } from "../harness/business-db";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempPermissionStore(initialPolicy?: PermissionPolicy): {
  dir: string;
  file: string;
  service: PermissionService;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "new-agent-grant-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, "permissions.json");
  if (initialPolicy) {
    const parsed = PermissionPolicySchema.parse(initialPolicy);
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  }
  const service = new PermissionService(new FilePermissionStore(file));
  return { dir, file, service };
}

class FakeGateway implements ModelGateway {
  config = { baseUrl: "http://unused", model: "test-model", timeoutSeconds: 30 };
  async listModels() {
    return [this.config.model];
  }
  async loadedContextCapacity() {
    return 65536;
  }
  async probeModelLoaded() {
    return true;
  }
  async complete(): Promise<string> {
    throw new Error("Model calls are forbidden in Agent creation");
  }
  async *streamChat(): AsyncGenerator<string, void, unknown> {
    yield await Promise.reject(new Error("Model calls are forbidden in Agent creation"));
  }
}

function makeAction(
  name: string,
  permission?: PermissionRequirement,
  effect: "read" | "write" = "read",
): BuiltInAction {
  return {
    permission,
    description: {
      name,
      description: `Action ${name}`,
      capability: "test",
      parameters: {},
      effect,
    },
    async execute() {
      return { value: "ok", sources: [] };
    },
  };
}

const currentRequirement: PermissionRequirement = {
  resource: "mcp.current",
  revision: "current/v1",
  approvalRequired: true,
};

function creationRows(business: BusinessDbHandle) {
  return {
    agents: business.db.query("SELECT * FROM agents ORDER BY id").all(),
    personas: business.db.query("SELECT * FROM agent_personas ORDER BY id").all(),
    settings: business.db
      .query("SELECT * FROM agent_knowledge_read_settings ORDER BY agent_id")
      .all(),
    grants: business.db
      .query("SELECT * FROM knowledge_grants ORDER BY agent_id, document_id")
      .all(),
  };
}

function installDeferredCommitFailure(business: BusinessDbHandle) {
  business.db.run("CREATE TABLE synthetic_commit_parent (id TEXT PRIMARY KEY)");
  business.db.run(
    "CREATE TABLE synthetic_commit_child (id TEXT REFERENCES synthetic_commit_parent(id) DEFERRABLE INITIALLY DEFERRED)",
  );
  business.db.run(`CREATE TRIGGER fail_creation_commit AFTER INSERT ON agents
    BEGIN INSERT INTO synthetic_commit_child (id) VALUES (NEW.id); END`);
}

function actionsForOldOwner(directory: string): PermissionRequirement {
  return {
    resource: "mcp.scoped.write",
    revision: "rev-scoped-1",
    approvalRequired: true,
    directories: [directory],
  };
}

function jsonPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("New Agent Full Default Grant Creation (Server-side Closed Loop)", () => {
  let business: BusinessDbHandle;
  const gateway = new FakeGateway();

  beforeEach(() => {
    business = cloneBusinessDb();
    ensureDefaults(business.orm, gateway.config.model);
  });

  afterEach(() => {
    business.close();
  });

  it("grants full tool permission overrides without implicit knowledge grants while keeping old scoped/denied/global-off unchanged", async () => {
    const { dir, service } = createTempPermissionStore();
    const allowedDir = path.resolve(dir, "workspace");

    const initialPolicy: PermissionPolicy = {
      version: 1,
      execution: PermissionPolicySchema.parse({
        version: 1,
        grants: [],
        execution: {
          modules: { mcp: false, skills: false, web: false },
          pausedTools: ["mcp.scoped.write"],
        },
      }).execution,
      grants: [
        {
          resource: "web",
          approved: false,
          directories: [],
        },
        {
          resource: "mcp.scoped.write",
          approved: true,
          revision: "rev-scoped-1",
          agentIds: ["old-agent-fixed"],
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
    service.replace(service.snapshot().revision, initialPolicy);

    // Pre-seed knowledge library with 2 documents
    const library = new KnowledgeRepository(business.db);
    const doc1 = library.importDocument({
      name: "文档一",
      category_id: "default",
      original_text: "资料库首篇受控文档",
    });
    const doc2 = library.importDocument({
      name: "文档二",
      category_id: "default",
      original_text: "资料库第二篇受控文档",
    });
    // Grant doc1 to DEFAULT_AGENT_ID, doc2 remains ungranted to default agent
    library.replaceGrants(doc1.id, doc1.revision, [DEFAULT_AGENT_ID]);

    const oldDocuments = business.db.query("SELECT * FROM knowledge_documents ORDER BY id").all();
    const oldTokens = business.db
      .query("SELECT * FROM knowledge_grants WHERE agent_id = ?")
      .all(DEFAULT_AGENT_ID);
    const oldAgent = business.db.query("SELECT * FROM agents WHERE id = ?").get(DEFAULT_AGENT_ID);
    const oldSettings = business.db
      .query("SELECT * FROM agent_knowledge_read_settings WHERE agent_id = ?")
      .get(DEFAULT_AGENT_ID);
    const oldRequirement = actionsForOldOwner(allowedDir);
    const oldOwner = { kind: "web", agentId: "old-agent-fixed", id: "old-session" } as const;
    const oldSource = service.source(oldRequirement, oldOwner);
    const oldApproval = service.approvalKey(oldRequirement, oldOwner);
    const oldExecution = service.snapshot().policy.execution;
    const initialDoc1Revision = library.detail(doc1.id).revision;
    const initialDoc2Revision = library.detail(doc2.id).revision;
    const defaultAgentDocsBefore = library.agentDocuments(DEFAULT_AGENT_ID);
    expect(defaultAgentDocsBefore).toHaveLength(1);
    expect(defaultAgentDocsBefore[0].id).toBe(doc1.id);

    // Actions snapshot: web, scoped, denied, and a fresh un-grated resource, plus a skill with NO resource
    const actions: BuiltInAction[] = [
      makeAction("web.search", { resource: "web", revision: "web/v1", approvalRequired: false }),
      makeAction("web.fetch", { resource: "web", revision: "web/v1", approvalRequired: false }),
      makeAction("mcp.scoped.write", {
        resource: "mcp.scoped.write",
        revision: "rev-scoped-1",
        approvalRequired: true,
        directories: [allowedDir],
      }),
      makeAction("mcp.denied.read", {
        resource: "mcp.denied.read",
        revision: "rev-denied-1",
        approvalRequired: false,
      }),
      makeAction("mcp.fresh.tool", {
        resource: "mcp.fresh.tool",
        revision: "rev-fresh-1",
        approvalRequired: false,
        directories: [allowedDir],
      }),
      makeAction("mcp.scoped.second", {
        resource: "mcp.scoped.write",
        revision: "rev-scoped-1",
        approvalRequired: true,
        directories: [allowedDir],
      }),
      makeAction("skill.system.read", undefined), // skills have no resource permission
    ];

    let catalogReads = 0;
    const app = createApp({
      business,
      gateway,
      permissions: service,
      externalActions: () => {
        catalogReads++;
        return actions;
      },
    });

    const res = await app.request(
      "/agents",
      jsonPost({
        name: "新建助手Alpha",
        model_name: "test-model",
      }),
    );

    expect(res.status).toBe(201);
    expect(catalogReads).toBe(1);
    const created = (await res.json()) as {
      id: string;
      name: string;
      temperature: number;
      persona_intensity: number;
      is_active: boolean;
      p5_config: {
        retrieval_mode: string;
        allocation: { mode: string };
        recent_turns: number;
        max_output_tokens: number;
      };
    };
    expect(created.name).toBe("新建助手Alpha");
    expect(created.temperature).toBe(1);
    expect(created.persona_intensity).toBe(100);
    expect(created.is_active).toBe(true);
    expect(created.p5_config).toMatchObject({
      retrieval_mode: "full_catalog",
      allocation: { mode: "auto" },
      recent_turns: 200,
      max_output_tokens: 32768,
    });
    const newAgentId = created.id;
    expect(
      business.db
        .query(
          "SELECT enabled, scope, document_ids FROM agent_knowledge_read_settings WHERE agent_id = ?",
        )
        .get(newAgentId),
    ).toEqual({ enabled: 1, scope: "all", document_ids: "[]" });
    expect(
      business.db.query("SELECT agent_id FROM agent_personas WHERE agent_id = ?").get(newAgentId),
    ).toEqual({ agent_id: newAgentId });
    for (const action of actions) {
      expect(
        service.decide(
          action.permission,
          { kind: "web", id: "new-session", agentId: newAgentId },
          "direct",
          action.description.effect ?? "write",
          true,
        ).allowed,
      ).toBe(true);
    }

    // 1. Verify policy overrides for new agent
    const snapshot = service.snapshot();
    expect(snapshot.policy.execution).toEqual(oldExecution);
    const grants = snapshot.policy.grants;

    const webGrant = grants.find((g) => g.resource === "web");
    expect(webGrant).toBeDefined();
    expect(webGrant?.approved).toBe(false); // Global off is STILL off!
    expect(webGrant?.agentOverrides?.[newAgentId]).toEqual({
      enabled: true,
      approved: true,
      revision: "web/v1",
      directories: [],
    });

    const scopedGrant = grants.find((g) => g.resource === "mcp.scoped.write");
    expect(scopedGrant).toBeDefined();
    expect(scopedGrant?.agentIds).toEqual(["old-agent-fixed"]); // Old scope NOT globally widened!
    expect(scopedGrant?.agentOverrides?.[newAgentId]).toEqual({
      enabled: true,
      approved: true,
      revision: "rev-scoped-1",
      directories: [allowedDir],
    });

    const deniedGrant = grants.find((g) => g.resource === "mcp.denied.read");
    expect(deniedGrant).toBeDefined();
    expect(deniedGrant?.approved).toBe(false); // Old deny NOT globally approved!
    expect(deniedGrant?.agentIds).toEqual([]);
    expect(deniedGrant?.agentOverrides?.[newAgentId]).toEqual({
      enabled: true,
      approved: true,
      revision: "rev-denied-1",
      directories: [],
    });

    const freshGrant = grants.find((g) => g.resource === "mcp.fresh.tool");
    expect(freshGrant).toBeDefined();
    expect(freshGrant?.approved).toBe(false); // Fresh base is denied
    expect(freshGrant?.agentOverrides?.[newAgentId]).toEqual({
      enabled: true,
      approved: true,
      revision: "rev-fresh-1",
      directories: [allowedDir],
    });

    // Skill has no resource requirement, so no grant was created for it
    expect(grants.find((g) => g.resource.startsWith("skill."))).toBeUndefined();

    // Existing documents are not assigned implicitly.
    expect(library.agentDocuments(newAgentId)).toEqual([]);

    // Verify old document revisions are UNCHANGED
    expect(library.detail(doc1.id).revision).toBe(initialDoc1Revision);
    expect(library.detail(doc2.id).revision).toBe(initialDoc2Revision);

    // Verify DEFAULT_AGENT_ID's docs and tokens are UNTOUCHED
    const defaultAgentDocsAfter = library.agentDocuments(DEFAULT_AGENT_ID);
    expect(defaultAgentDocsAfter).toHaveLength(1);
    expect(defaultAgentDocsAfter[0].id).toBe(doc1.id);
    expect(business.db.query("SELECT * FROM knowledge_documents ORDER BY id").all()).toEqual(
      oldDocuments,
    );
    expect(
      business.db.query("SELECT * FROM knowledge_grants WHERE agent_id = ?").all(DEFAULT_AGENT_ID),
    ).toEqual(oldTokens);
    expect(business.db.query("SELECT * FROM agents WHERE id = ?").get(DEFAULT_AGENT_ID)).toEqual(
      oldAgent,
    );
    expect(
      business.db
        .query("SELECT * FROM agent_knowledge_read_settings WHERE agent_id = ?")
        .get(DEFAULT_AGENT_ID),
    ).toEqual(oldSettings);
    expect(service.source(oldRequirement, oldOwner)).toEqual(oldSource);
    expect(service.sourceAccess(oldSource, oldOwner)).toBe("available");
    expect(service.approvalKey(oldRequirement, oldOwner)).toBe(oldApproval);
    expect(
      service.decide(
        { resource: "mcp.future", revision: "v1", approvalRequired: false },
        { ...oldOwner, agentId: newAgentId },
        "direct",
        "read",
        true,
      ).allowed,
    ).toBe(false);
  });

  it("handles empty catalog normally without implicitly granting knowledge documents", async () => {
    const { service } = createTempPermissionStore();
    service.replace(service.snapshot().revision, { version: 1, grants: [] });

    const library = new KnowledgeRepository(business.db);
    const doc = library.importDocument({
      name: "单篇文档",
      category_id: "default",
      original_text: "空目录测试文档",
    });

    const app = createApp({
      business,
      gateway,
      permissions: service,
      externalActions: () => [],
    });

    const res = await app.request(
      "/agents",
      jsonPost({
        name: "空目录助手",
        model_name: "test-model",
      }),
    );

    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string };

    expect(library.agentDocuments(created.id)).toEqual([]);
    expect(library.detail(doc.id).id).toBe(doc.id);

    // Policy grants remain empty
    expect(service.snapshot().policy.grants).toHaveLength(0);
  });

  it("compensates and cleans up new agent, knowledge grants and overrides on policy CAS conflict failure", async () => {
    const { dir, file } = createTempPermissionStore();
    const allowedDir = path.resolve(dir, "workspace");

    // Custom store that throws PERMISSION_POLICY_CONFLICT on replace
    let replaceFail = false;
    const innerStore = new FilePermissionStore(file);
    const mockStore: PermissionStore = {
      read: () => innerStore.read(),
      replace: (expectedRevision, policy) => {
        if (replaceFail) {
          throw new PermissionError("PERMISSION_POLICY_CONFLICT");
        }
        return innerStore.replace(expectedRevision, policy);
      },
    };
    const service = new PermissionService(mockStore);
    service.replace(service.snapshot().revision, { version: 1, grants: [] });

    const library = new KnowledgeRepository(business.db);
    library.importDocument({
      name: "冲突补偿文档",
      category_id: "default",
      original_text: "用于测试补偿回滚的文档",
    });

    const agentsBeforeCount = business.orm.select().from(schema.agents).all().length;
    const grantsBeforeCount = business.orm.select().from(schema.knowledgeGrants).all().length;

    const actions: BuiltInAction[] = [
      makeAction("mcp.tool", {
        resource: "mcp.tool",
        revision: "v1",
        approvalRequired: false,
        directories: [allowedDir],
      }),
    ];

    const app = createApp({
      business,
      gateway,
      permissions: service,
      externalActions: () => actions,
    });

    // Arm the failure on replace
    replaceFail = true;

    const res = await app.request(
      "/agents",
      jsonPost({
        name: "失败回滚助手",
        model_name: "test-model",
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PERMISSION_POLICY_CONFLICT");

    // Compensation verification: NO new Agent remains in DB!
    const agentsAfterCount = business.orm.select().from(schema.agents).all().length;
    expect(agentsAfterCount).toBe(agentsBeforeCount);

    // Compensation verification: NO dangling knowledge grants remain!
    const grantsAfterCount = business.orm.select().from(schema.knowledgeGrants).all().length;
    expect(grantsAfterCount).toBe(grantsBeforeCount);

    // Policy grants remain untouched
    expect(service.snapshot().policy.grants).toHaveLength(0);
  });

  it("pre-validates catalog revision conflict before DB write without creating agent row", async () => {
    const { service } = createTempPermissionStore();
    service.replace(service.snapshot().revision, { version: 1, grants: [] });

    const agentsBeforeCount = business.orm.select().from(schema.agents).all().length;

    business.db.run(`CREATE TRIGGER reject_any_agent_write BEFORE INSERT ON agents
      BEGIN SELECT RAISE(ABORT, 'catalog validation must run before inserts'); END`);
    // Conflicting actions: same resource "conflict.res" but different revisions
    const actions: BuiltInAction[] = [
      makeAction("conflict.a", {
        resource: "conflict.res",
        revision: "rev-A",
        approvalRequired: false,
      }),
      makeAction("conflict.b", {
        resource: "conflict.res",
        revision: "rev-B",
        approvalRequired: false,
      }),
    ];

    const app = createApp({
      business,
      gateway,
      permissions: service,
      externalActions: () => actions,
    });

    const res = await app.request(
      "/agents",
      jsonPost({
        name: "冲突拒绝助手",
        model_name: "test-model",
      }),
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PERMISSION_REVISION_CHANGED");

    // Zero rows added to agents table
    const agentsAfterCount = business.orm.select().from(schema.agents).all().length;
    expect(agentsAfterCount).toBe(agentsBeforeCount);
  });

  it("succeeds when permissions service is unconfigured/absent without requiring FileStore", async () => {
    const library = new KnowledgeRepository(business.db);
    const doc = library.importDocument({
      name: "无权限服务测试",
      category_id: "default",
      original_text: "离线测试文档",
    });

    // Empty standalone catalogs need no policy file.
    const app = createApp({
      business,
      gateway,
      externalActions: () => [],
    });

    const res = await app.request(
      "/agents",
      jsonPost({
        name: "默认无权限服务助手",
        model_name: "test-model",
      }),
    );

    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: string; name: string };
    expect(created.name).toBe("默认无权限服务助手");

    expect(library.agentDocuments(created.id)).toEqual([]);
    expect(library.detail(doc.id).id).toBe(doc.id);
  });

  it("creates the Agent without writing implicit knowledge grants", async () => {
    const { service } = createTempPermissionStore();
    const library = new KnowledgeRepository(business.db);
    const doc = library.importDocument({
      name: "existing document",
      category_id: "default",
      original_text: "synthetic",
    });
    library.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
    const oldDocRevision = library.detail(doc.id).revision;
    const oldGrants = business.db.query("SELECT * FROM knowledge_grants").all();
    business.db.run(`CREATE TRIGGER fail_new_knowledge_grant BEFORE INSERT ON knowledge_grants
      BEGIN SELECT RAISE(ABORT, 'unexpected implicit knowledge grant'); END`);
    const app = createApp({
      business,
      gateway,
      permissions: service,
      externalActions: () => [makeAction("mcp.current", currentRequirement)],
    });
    const response = await app.request(
      "/agents",
      jsonPost({ name: "no implicit grant", model_name: "test-model" }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    expect(business.db.query("SELECT * FROM knowledge_grants").all()).toEqual(oldGrants);
    expect(library.agentDocuments(created.id)).toEqual([]);
    expect(library.detail(doc.id).revision).toBe(oldDocRevision);
    expect(
      service.snapshot().policy.grants.find((grant) => grant.resource === "mcp.current")
        ?.agentOverrides?.[created.id],
    ).toEqual({
      enabled: true,
      approved: true,
      revision: "current/v1",
      directories: [],
    });
  });

  it("rolls back the Agent and removes its override when persona insertion fails", async () => {
    const { service } = createTempPermissionStore();
    const beforeRows = creationRows(business);
    const beforePolicy = service.snapshot();
    business.db.run(`CREATE TRIGGER fail_new_persona BEFORE INSERT ON agent_personas
      BEGIN SELECT RAISE(ABORT, 'synthetic persona failure'); END`);
    const app = createApp({
      business,
      gateway,
      permissions: service,
      externalActions: () => [makeAction("mcp.current", currentRequirement)],
    });
    const response = await app.request(
      "/agents",
      jsonPost({ name: "persona failure", model_name: "test-model" }),
    );
    expect(response.status).toBe(503);
    expect(creationRows(business)).toEqual(beforeRows);
    expect(service.snapshot().policy.grants).toEqual([
      { resource: "mcp.current", approved: false, agentIds: [], directories: [] },
    ]);
    expect(beforePolicy.policy.grants).toEqual([]);
  });

  it("compensates only the new ID against current policy if the DB commit fails after policy success", async () => {
    const { service } = createTempPermissionStore();
    service.replace(service.snapshot().revision, {
      version: 1,
      grants: [{ resource: "old", approved: true, directories: [] }],
    });
    const beforeRows = creationRows(business);
    installDeferredCommitFailure(business);
    const replace = service.replace.bind(service);
    let writes = 0;
    const save = spyOn(service, "replace").mockImplementation((revision, policy) => {
      const saved = replace(revision, policy);
      writes++;
      if (writes === 1) {
        // A distinct current-policy change must survive compensation.
        replace(saved.revision, {
          ...saved.policy,
          grants: [
            ...saved.policy.grants,
            { resource: "other-owner", approved: true, directories: [] },
          ],
        });
      }
      return saved;
    });
    const app = createApp({
      business,
      gateway,
      permissions: service,
      externalActions: () => [makeAction("mcp.current", currentRequirement)],
    });
    const response = await app.request(
      "/agents",
      jsonPost({ name: "commit failure", model_name: "test-model" }),
    );
    expect(response.status).toBe(503);
    expect(creationRows(business)).toEqual(beforeRows);
    const grants = service.snapshot().policy.grants;
    expect(grants.find((grant) => grant.resource === "old")?.approved).toBe(true);
    expect(grants.find((grant) => grant.resource === "other-owner")?.approved).toBe(true);
    expect(
      grants.every(
        (grant) => !grant.agentOverrides || Object.keys(grant.agentOverrides).length === 0,
      ),
    ).toBe(true);
    expect(grants.find((grant) => grant.resource === "mcp.current")?.agentIds).toEqual([]);
    expect(writes).toBe(2);
    save.mockRestore();
  });

  it("reports both original and cleanup failures instead of silently returning a normal conflict", async () => {
    const { service } = createTempPermissionStore();
    const original = new PermissionError("PERMISSION_POLICY_CONFLICT");
    const cleanup = new PermissionError("PERMISSION_POLICY_UNAVAILABLE");
    const storeWrite = spyOn(service, "replace").mockImplementation(() => {
      throw original;
    });
    const cleanupCall = spyOn(service, "removeOwnOverrides").mockImplementation(() => {
      throw cleanup;
    });
    const diagnostics = spyOn(console, "error").mockImplementation(() => {});
    try {
      const beforeRows = creationRows(business);
      const app = createApp({
        business,
        gateway,
        permissions: service,
        externalActions: () => [makeAction("mcp.current", currentRequirement)],
      });
      const response = await app.request(
        "/agents",
        jsonPost({ name: "cleanup failure", model_name: "test-model" }),
      );
      expect(response.status).toBe(500);
      expect(creationRows(business)).toEqual(beforeRows);
      expect(cleanupCall).toHaveBeenCalledTimes(1);
      expect(diagnostics).toHaveBeenCalledWith(
        "Agent creation permission cleanup failed",
        expect.objectContaining({
          error: original,
          cleanupError: cleanup,
          agentId: expect.any(String),
        }),
      );
    } finally {
      diagnostics.mockRestore();
      cleanupCall.mockRestore();
      storeWrite.mockRestore();
    }
  });

  it("rejects an unavailable policy before any Agent row can be inserted", async () => {
    const service = new PermissionService({
      read() {
        throw new PermissionError("PERMISSION_POLICY_UNAVAILABLE");
      },
      replace() {
        throw new Error("unexpected write");
      },
    });
    const beforeRows = creationRows(business);
    const app = createApp({
      business,
      gateway,
      permissions: service,
      externalActions: () => [makeAction("mcp.current", currentRequirement)],
    });
    const diagnostics = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await app.request(
        "/agents",
        jsonPost({ name: "policy unavailable", model_name: "test-model" }),
      );
      expect(response.status).toBe(500);
      expect(creationRows(business)).toEqual(beforeRows);
      expect(diagnostics).toHaveBeenCalledWith(
        "Agent creation permission cleanup failed",
        expect.objectContaining({
          error: expect.any(PermissionError),
          cleanupError: expect.any(PermissionError),
        }),
      );
    } finally {
      diagnostics.mockRestore();
    }
  });

  it("does not return false success for installed resources without a writable permission service", async () => {
    const beforeRows = creationRows(business);
    const app = createApp({
      business,
      gateway,
      externalActions: () => [makeAction("mcp.current", currentRequirement)],
    });
    const response = await app.request(
      "/agents",
      jsonPost({ name: "missing policy owner", model_name: "test-model" }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "PERMISSION_MANAGEMENT_UNAVAILABLE" },
    });
    expect(creationRows(business)).toEqual(beforeRows);
  });

  it("removes only its own overrides when the policy write succeeded but its return failed", async () => {
    const { service } = createTempPermissionStore();
    const beforeRows = creationRows(business);
    const replace = service.replace.bind(service);
    let calls = 0;
    const save = spyOn(service, "replace").mockImplementation((revision, policy) => {
      const snapshot = replace(revision, policy);
      if (++calls === 1) throw new PermissionError("PERMISSION_POLICY_UNAVAILABLE");
      return snapshot;
    });
    try {
      const app = createApp({
        business,
        gateway,
        permissions: service,
        externalActions: () => [makeAction("mcp.current", currentRequirement)],
      });
      const response = await app.request(
        "/agents",
        jsonPost({ name: "ambiguous policy failure", model_name: "test-model" }),
      );
      expect(response.status).toBe(503);
      expect(creationRows(business)).toEqual(beforeRows);
      expect(calls).toBe(2);
      expect(service.snapshot().policy.grants).toEqual([
        { resource: "mcp.current", approved: false, agentIds: [], directories: [] },
      ]);
    } finally {
      save.mockRestore();
    }
  });
});

describe("Fresh builtin Agent provisioning", () => {
  let business: BusinessDbHandle;
  const gateway = new FakeGateway();

  beforeEach(() => {
    business = cloneBusinessDb();
  });

  afterEach(() => {
    business.close();
  });

  it("provisions the truly missing builtin from the raw installed catalog before routes", async () => {
    const { service } = createTempPermissionStore();
    service.replace(
      service.snapshot().revision,
      PermissionPolicySchema.parse({
        version: 1,
        grants: [],
        execution: { modules: { mcp: false, web: false }, pausedTools: ["mcp.current"] },
      }),
    );
    const execution = service.snapshot().policy.execution;
    const library = new KnowledgeRepository(business.db);
    const doc = library.importDocument({
      name: "bootstrap knowledge",
      category_id: "default",
      original_text: "synthetic bootstrap content",
    });
    const documentBefore = business.db
      .query("SELECT * FROM knowledge_documents WHERE id = ?")
      .get(doc.id);
    let catalogReads = 0;
    const app = createApp({
      business,
      gateway,
      permissions: service,
      externalActions: () => {
        catalogReads++;
        return [makeAction("mcp.current", currentRequirement)];
      },
    });
    expect(catalogReads).toBe(1);
    expect(service.snapshot().policy.execution).toEqual(execution);
    expect(service.snapshot().policy.grants[0]?.agentOverrides?.[DEFAULT_AGENT_ID]).toEqual({
      enabled: true,
      approved: true,
      revision: "current/v1",
      directories: [],
    });
    const row = business.db
      .query(
        "SELECT model_name, temperature, persona_intensity, system_prompt FROM agents WHERE id = ?",
      )
      .get(DEFAULT_AGENT_ID);
    expect(row).toEqual({
      model_name: "test-model",
      temperature: 1,
      persona_intensity: 100,
      system_prompt: DEFAULT_SYSTEM_PROMPT,
    });
    expect(
      business.db
        .query("SELECT core_identity FROM agent_personas WHERE agent_id = ?")
        .get(DEFAULT_AGENT_ID),
    ).toEqual({ core_identity: DEFAULT_SYSTEM_PROMPT });
    expect(
      business.db
        .query(
          "SELECT enabled, scope, document_ids FROM agent_knowledge_read_settings WHERE agent_id = ?",
        )
        .get(DEFAULT_AGENT_ID),
    ).toEqual({ enabled: 1, scope: "all", document_ids: "[]" });
    expect(library.agentDocuments(DEFAULT_AGENT_ID)).toEqual([]);
    expect(business.db.query("SELECT * FROM knowledge_documents WHERE id = ?").get(doc.id)).toEqual(
      documentBefore,
    );
    const grantsBefore = business.db.query("SELECT * FROM knowledge_grants").all();
    const policyBefore = service.snapshot();
    expect((await app.request("/agents")).status).toBe(200);
    const session = await app.request("/sessions", jsonPost({ title: "first session" }));
    expect(session.status).toBe(201);
    expect(catalogReads).toBe(1);
    expect(service.snapshot()).toEqual(policyBefore);
    expect(business.db.query("SELECT * FROM knowledge_grants").all()).toEqual(grantsBefore);
  });

  it("never grants an existing builtin or rereads its catalog during repeated construction and default routes", async () => {
    ensureDefaults(business.orm, gateway.config.model);
    business.db
      .query("UPDATE agents SET temperature = 0.3, persona_intensity = 17 WHERE id = ?")
      .run(DEFAULT_AGENT_ID);
    const { service } = createTempPermissionStore({
      version: 1,
      grants: [{ resource: "mcp.current", approved: false, directories: [], agentIds: [] }],
    });
    const library = new KnowledgeRepository(business.db);
    library.importDocument({
      name: "not granted to old builtin",
      category_id: "default",
      original_text: "synthetic",
    });
    const rowsBefore = creationRows(business);
    const policyBefore = service.snapshot();
    const catalog = () => {
      throw new Error("existing builtin must not read the installed catalog");
    };
    const grant = spyOn(service, "grantForNewAgent");
    const snapshot = spyOn(service, "snapshot");
    try {
      const first = createApp({
        business,
        gateway,
        permissions: service,
        externalActions: catalog,
      });
      createApp({ business, gateway, permissions: service, externalActions: catalog });
      expect((await first.request("/agents")).status).toBe(200);
      expect(
        (await first.request("/sessions", jsonPost({ title: "old builtin session" }))).status,
      ).toBe(201);
      expect(grant).not.toHaveBeenCalled();
      expect(snapshot).not.toHaveBeenCalled();
      expect(creationRows(business)).toEqual(rowsBefore);
    } finally {
      snapshot.mockRestore();
      grant.mockRestore();
    }
    expect(service.snapshot()).toEqual(policyBefore);
  });

  it("rejects conflicting bootstrap declarations before writing any Agent row", () => {
    const { service } = createTempPermissionStore();
    const rowsBefore = creationRows(business);
    business.db.run(`CREATE TRIGGER reject_bootstrap_insert BEFORE INSERT ON agents
      BEGIN SELECT RAISE(ABORT, 'must validate catalog before row writes'); END`);
    expect(() =>
      createApp({
        business,
        gateway,
        permissions: service,
        externalActions: () => [
          makeAction("first", currentRequirement),
          makeAction("second", { ...currentRequirement, revision: "other/v2" }),
        ],
      }),
    ).toThrow("PERMISSION_REVISION_CHANGED");
    expect(creationRows(business)).toEqual(rowsBefore);
    expect(service.snapshot().policy.grants).toEqual([]);
  });

  it("creates the fresh builtin without writing implicit knowledge grants", () => {
    const { service } = createTempPermissionStore();
    const library = new KnowledgeRepository(business.db);
    library.importDocument({
      name: "bootstrap document",
      category_id: "default",
      original_text: "synthetic",
    });
    const oldGrants = business.db.query("SELECT * FROM knowledge_grants").all();
    business.db.run(`CREATE TRIGGER fail_bootstrap_grant BEFORE INSERT ON knowledge_grants
      BEGIN SELECT RAISE(ABORT, 'unexpected implicit bootstrap grant'); END`);
    createApp({
      business,
      gateway,
      permissions: service,
      externalActions: () => [makeAction("mcp.current", currentRequirement)],
    });
    expect(business.db.query("SELECT * FROM knowledge_grants").all()).toEqual(oldGrants);
    expect(library.agentDocuments(DEFAULT_AGENT_ID)).toEqual([]);
    expect(
      service.snapshot().policy.grants.find((grant) => grant.resource === "mcp.current")
        ?.agentOverrides?.[DEFAULT_AGENT_ID],
    ).toEqual({
      enabled: true,
      approved: true,
      revision: "current/v1",
      directories: [],
    });
  });

  it("rechecks builtin ownership inside the transaction rather than granting an Agent created after the initial check", () => {
    const { service } = createTempPermissionStore();
    const grant = spyOn(service, "grantForNewAgent");
    let racedRows: ReturnType<typeof creationRows> | undefined;
    try {
      createApp({
        business,
        gateway,
        permissions: service,
        externalActions: () => {
          ensureDefaults(business.orm, gateway.config.model);
          business.db
            .query("UPDATE agents SET persona_intensity = 19 WHERE id = ?")
            .run(DEFAULT_AGENT_ID);
          racedRows = creationRows(business);
          return [makeAction("mcp.current", currentRequirement)];
        },
      });
      expect(grant).not.toHaveBeenCalled();
      if (!racedRows) throw new Error("Synthetic concurrent initializer did not run");
      expect(creationRows(business)).toEqual(racedRows);
      expect(service.snapshot().policy.grants).toEqual([]);
    } finally {
      grant.mockRestore();
    }
  });

  it("allows an empty standalone bootstrap but does not fabricate grants for installed resources", () => {
    createApp({ business, gateway, externalActions: () => [] });
    expect(business.db.query("SELECT id FROM agents WHERE id = ?").get(DEFAULT_AGENT_ID)).toEqual({
      id: DEFAULT_AGENT_ID,
    });
    const fresh = cloneBusinessDb();
    try {
      expect(() =>
        createApp({
          business: fresh,
          gateway,
          externalActions: () => [makeAction("mcp.current", currentRequirement)],
        }),
      ).toThrow("PERMISSION_MANAGEMENT_UNAVAILABLE");
      expect(fresh.db.query("SELECT id FROM agents").all()).toEqual([]);
    } finally {
      fresh.close();
    }
  });

  it("compensates the builtin overrides if the initial DB commit fails", () => {
    const { service } = createTempPermissionStore();
    const rowsBefore = creationRows(business);
    installDeferredCommitFailure(business);
    expect(() =>
      createApp({
        business,
        gateway,
        permissions: service,
        externalActions: () => [makeAction("mcp.current", currentRequirement)],
      }),
    ).toThrow();
    expect(creationRows(business)).toEqual(rowsBefore);
    expect(service.snapshot().policy.grants).toEqual([
      { resource: "mcp.current", approved: false, agentIds: [], directories: [] },
    ]);
  });

  it("preserves bootstrap failure and cleanup failure in the existing diagnostic channel", () => {
    const { service } = createTempPermissionStore();
    const original = new PermissionError("PERMISSION_POLICY_CONFLICT");
    const cleanup = new PermissionError("PERMISSION_POLICY_UNAVAILABLE");
    const save = spyOn(service, "replace").mockImplementation(() => {
      throw original;
    });
    const remove = spyOn(service, "removeOwnOverrides").mockImplementation(() => {
      throw cleanup;
    });
    const diagnostic = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        createApp({
          business,
          gateway,
          permissions: service,
          externalActions: () => [makeAction("mcp.current", currentRequirement)],
        }),
      ).toThrow(AggregateError);
      expect(business.db.query("SELECT id FROM agents").all()).toEqual([]);
      expect(diagnostic).toHaveBeenCalledWith("Agent creation permission cleanup failed", {
        agentId: DEFAULT_AGENT_ID,
        error: original,
        cleanupError: cleanup,
      });
    } finally {
      diagnostic.mockRestore();
      remove.mockRestore();
      save.mockRestore();
    }
  });
});
