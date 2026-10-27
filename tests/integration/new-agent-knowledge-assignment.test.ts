import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { createApp } from "../../src/server/app";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { KnowledgeReadRepository } from "../../src/server/db/knowledge-read-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { FilePermissionStore, PermissionService } from "../../src/server/permissions/service";
import { cloneBusinessDb } from "../harness/business-db";

class FakeGateway implements ModelGateway {
  config = { baseUrl: "http://unused", model: "synthetic", timeoutSeconds: 30 };
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
    throw new Error("unexpected model call");
  }
  async *streamChat(): AsyncGenerator<string, void, unknown> {
    yield await Promise.reject(new Error("unexpected model call"));
  }
}
const gateway = new FakeGateway();
const requirement = { resource: "mcp.synthetic.read", revision: "v1", approvalRequired: true };
const action: BuiltInAction = {
  permission: requirement,
  description: {
    name: "mcp.synthetic.read",
    description: "synthetic",
    capability: "test",
    parameters: {},
    effect: "read",
  },
  async execute() {
    return { value: "ok", sources: [] };
  },
};
function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

describe("new Agent knowledge assignment", () => {
  let business: BusinessDbHandle;
  let dir: string;
  let permissions: PermissionService;
  beforeEach(() => {
    business = cloneBusinessDb();
    dir = mkdtempSync(path.join(tmpdir(), "knowledge-assignment-"));
    permissions = new PermissionService(
      new FilePermissionStore(path.join(dir, "permissions.json")),
    );
  });
  afterEach(() => {
    business.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not implicitly assign existing documents and preserves old grants and discovered tools", async () => {
    ensureDefaults(business.orm, gateway.config.model);
    const library = new KnowledgeRepository(business.db);
    const granted = library.importDocument({
      name: "old grant",
      category_id: "default",
      original_text: "synthetic one",
    });
    const hidden = library.importDocument({
      name: "not granted",
      category_id: "default",
      original_text: "synthetic two",
    });
    library.replaceGrants(granted.id, granted.revision, [DEFAULT_AGENT_ID]);
    const before = business.db
      .query("SELECT * FROM knowledge_grants WHERE agent_id = ?")
      .all(DEFAULT_AGENT_ID);
    let reads = 0;
    const app = createApp({
      business,
      gateway,
      permissions,
      externalActions: () => {
        reads++;
        return [action];
      },
    });
    const response = await app.request(
      "/agents",
      json("POST", { name: "new", model_name: "synthetic" }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    expect(reads).toBe(1);
    expect(
      permissions.decide(
        requirement,
        { kind: "web", id: "new-session", agentId: created.id },
        "direct",
        "read",
        true,
      ).allowed,
    ).toBe(true);
    expect(
      business.db.query("SELECT * FROM knowledge_grants WHERE agent_id = ?").all(DEFAULT_AGENT_ID),
    ).toEqual(before);
    expect(library.agentDocuments(DEFAULT_AGENT_ID).map((item) => item.id)).toEqual([granted.id]);
    expect(library.agentDocuments(created.id)).toEqual([]);
    expect(
      business.db.query("SELECT * FROM knowledge_grants WHERE agent_id = ?").all(created.id),
    ).toEqual([]);
    expect(library.detail(hidden.id).id).toBe(hidden.id);
  });

  it("selected reading settings cannot grant an unassigned document", async () => {
    ensureDefaults(business.orm, gateway.config.model);
    const library = new KnowledgeRepository(business.db);
    const hidden = library.importDocument({
      name: "unassigned",
      category_id: "default",
      original_text: "synthetic",
    });
    const app = createApp({ business, gateway, permissions, externalActions: () => [] });
    const response = await app.request(
      "/agents",
      json("POST", { name: "new", model_name: "synthetic" }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };
    const read = new KnowledgeReadRepository(business.db);
    const settings = read.settings(created.id);
    const update = await app.request(
      `/agents/${created.id}/knowledge-read-settings`,
      json("PUT", {
        expected_revision: settings.revision,
        config: { ...settings.config, scope: "selected", document_ids: [hidden.id] },
      }),
    );
    expect(update.status).toBe(404);
    expect(read.settings(created.id)).toEqual(settings);
    expect(library.agentDocuments(created.id)).toEqual([]);
  });

  it("fresh builtin creation does not implicitly assign existing documents", () => {
    const library = new KnowledgeRepository(business.db);
    library.importDocument({
      name: "before bootstrap",
      category_id: "default",
      original_text: "synthetic",
    });
    createApp({ business, gateway, permissions, externalActions: () => [action] });
    expect(
      permissions.decide(
        requirement,
        { kind: "web", id: "builtin-session", agentId: DEFAULT_AGENT_ID },
        "direct",
        "read",
        true,
      ).allowed,
    ).toBe(true);
    expect(library.agentDocuments(DEFAULT_AGENT_ID)).toEqual([]);
  });
});
