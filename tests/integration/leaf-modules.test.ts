import { describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { SqliteKnowledgeModule } from "../../src/server/modules/knowledge-module";
import { KnowledgeOrganizer } from "../../src/server/services/knowledge-organizer";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "test-model");
  const repo = new KnowledgeRepository(business.db);
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "test-model", timeoutSeconds: 1 },
    listModels: async () => ["test-model"],
    loadedContextCapacity: async () => 32768,
    probeModelLoaded: async () => true,
    complete: async (request) => {
      const firstRaw = request.messages[1].content;
      if (typeof firstRaw !== "string") throw new Error("text content expected");
      const data = JSON.parse(firstRaw);
      return JSON.stringify({
        ids: data.candidates.map((candidate: { id: string }) => candidate.id),
      });
    },
    async *streamChat() {
      yield "unused";
    },
  };
  const runtime = createAgentRuntime({ gateway, repository: new AgentRunRepository(business.db) });
  const module = new SqliteKnowledgeModule({
    db: business.db,
    gateway,
    agentRuntime: runtime,
    runtime: (id) => {
      const agent = getAgentRow(business.orm, id);
      if (!agent) throw new Error("Missing fixture Agent");
      return runtimeFromAgent(agent);
    },
  });
  const owner = {
    kind: "knowledge_test",
    id: "query",
    userId: DEFAULT_USER_ID,
    agentId: DEFAULT_AGENT_ID,
  };
  return { business, repo, gateway, runtime, module, owner };
}

describe("shared leaf modules", () => {
  it("returns authorized knowledge previews and lazy text without a selector model run", async () => {
    const h = setup();
    try {
      h.gateway.complete = async () => {
        throw new Error("Unexpected selector call");
      };
      const doc = h.repo.importDocument({
        name: "设备",
        category_id: "default",
        original_text: "低于10°C禁止启动，维护模式例外。",
      });
      h.repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
      const result = await h.module.query({
        agentId: DEFAULT_AGENT_ID,
        query: "设备",
        budget: 4096,
        owner: h.owner,
      });
      expect(result.status).toBe("ok");
      const evidence = result.items[0];
      if (!evidence) throw new Error("Missing authorized evidence");
      expect(evidence.text).toBe("");
      expect(evidence.sources).toContainEqual({
        kind: "knowledge_grant",
        id: JSON.stringify([doc.id, DEFAULT_AGENT_ID]),
        revision: expect.any(String),
      });
      const page = await h.module.read({
        agentId: DEFAULT_AGENT_ID,
        evidence,
        offset: 0,
        limit: 4096,
        owner: h.owner,
      });
      expect(page.text).toContain("10°C");
      expect(h.business.db.query("SELECT spec_id FROM agent_runs").all()).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("does not return revoked text after its preview was disclosed", async () => {
    const h = setup();
    try {
      const doc = h.repo.importDocument({
        name: "restricted",
        category_id: "default",
        original_text: "源正文",
      });
      h.repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
      const result = await h.module.query({
        agentId: DEFAULT_AGENT_ID,
        query: "正文",
        budget: 4096,
        owner: h.owner,
      });
      const evidence = result.items[0];
      if (!evidence) throw new Error("Missing authorized evidence");
      h.repo.replaceGrants(doc.id, h.repo.detail(doc.id).revision, []);
      await expect(
        h.module.read({
          agentId: DEFAULT_AGENT_ID,
          evidence,
          offset: 0,
          limit: 4096,
          owner: h.owner,
        }),
      ).rejects.toThrow();
      expect(h.business.db.query("SELECT spec_id FROM agent_runs").all()).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("rejects a forged knowledge evidence identity without starting a model", async () => {
    const h = setup();
    try {
      const doc = h.repo.importDocument({
        name: "设备",
        category_id: "default",
        original_text: "阈值42。",
      });
      h.repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
      const result = await h.module.query({
        agentId: DEFAULT_AGENT_ID,
        query: "阈值",
        budget: 4096,
        owner: h.owner,
      });
      const evidence = result.items[0];
      if (!evidence) throw new Error("Missing authorized evidence");
      await expect(
        h.module.read({
          agentId: DEFAULT_AGENT_ID,
          evidence: { ...evidence, id: "not-an-authorized-candidate" },
          offset: 0,
          limit: 4096,
          owner: h.owner,
        }),
      ).rejects.toThrow();
      expect(h.business.db.query("SELECT spec_id FROM agent_runs").all()).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("records a maintenance job and its exact input without changing the draft publication contract", async () => {
    const h = setup();
    try {
      const doc = h.repo.importDocument({
        name: "来源",
        category_id: "default",
        original_text: "请保留42这个阈值。",
      });
      h.gateway.complete = async () => '{"summary":"阈值","tags":["设备"],"body":"阈值42。"}';
      const worker = new KnowledgeOrganizer({
        db: h.business.db,
        gateway: h.gateway,
        agentRuntime: h.runtime,
      });
      expect(await worker.runCycle()).toBe(true);
      const row = h.business.db
        .query<{ owner_kind: string; owner_id: string; spec_id: string; status: string }, []>(
          "SELECT owner_kind,owner_id,spec_id,status FROM agent_runs",
        )
        .get();
      if (!row) throw new Error("Missing maintenance run");
      expect(row.owner_kind).toBe("knowledge_job");
      expect(row.spec_id).toBe("knowledge.organize");
      expect(row.status).toBe("completed");
      expect(
        h.business.db
          .query("SELECT id FROM knowledge_jobs WHERE id = ? AND status = 'succeeded'")
          .get(row.owner_id),
      ).not.toBeNull();
      expect(h.repo.detail(doc.id).draft?.body).toBe("阈值42。");
      await worker.stop();
    } finally {
      h.business.close();
    }
  });
});
