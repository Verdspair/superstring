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
      const data = JSON.parse(request.messages[1].content);
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
  it("runs standalone semantic knowledge selection through the persisted Agent runtime with grant provenance", async () => {
    const h = setup();
    try {
      const doc = h.repo.importDocument({
        name: "设备",
        category_id: "default",
        original_text: "低于10°C禁止启动，维护模式例外。",
      });
      h.repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
      const evidence = await h.module.query({
        agentId: DEFAULT_AGENT_ID,
        query: "寒冷时可以开机吗？",
        budget: 4096,
        owner: h.owner,
      });
      expect(evidence).toHaveLength(1);
      expect(evidence[0].text).toContain("10°C");
      expect(evidence[0].sources.some((source) => source.kind === "knowledge_grant")).toBe(true);
      const runs = h.business.db
        .query<{ spec_id: string; status: string }, []>("SELECT spec_id,status FROM agent_runs")
        .all();
      expect(runs).toEqual([{ spec_id: "knowledge.select", status: "completed" }]);
      const snapshot = h.business.db
        .query<{ protected_messages: string; source_refs: string }, []>(
          "SELECT protected_messages,source_refs FROM context_snapshots",
        )
        .get();
      if (!snapshot) throw new Error("Missing context snapshot");
      expect(snapshot.protected_messages).toContain("寒冷");
      expect(
        JSON.parse(snapshot.source_refs).some(
          (source: { kind: string; id: string }) =>
            source.kind === "knowledge_grant" &&
            source.id === JSON.stringify([doc.id, DEFAULT_AGENT_ID]),
        ),
      ).toBe(true);
    } finally {
      h.business.close();
    }
  });

  it("does not return a revoked candidate after semantic selection", async () => {
    const h = setup();
    try {
      const doc = h.repo.importDocument({
        name: "restricted",
        category_id: "default",
        original_text: "源正文",
      });
      h.repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
      h.gateway.complete = async (request) => {
        const data = JSON.parse(request.messages[1].content);
        const latest = h.repo.detail(doc.id);
        h.repo.replaceGrants(doc.id, latest.revision, []);
        return JSON.stringify({
          ids: data.candidates.map((candidate: { id: string }) => candidate.id),
        });
      };
      await expect(
        h.module.query({ agentId: DEFAULT_AGENT_ID, query: "正文", budget: 4096, owner: h.owner }),
      ).rejects.toThrow("资料已更新");
    } finally {
      h.business.close();
    }
  });

  it("records invalid semantic selection as a failed leaf run", async () => {
    const h = setup();
    try {
      const doc = h.repo.importDocument({
        name: "设备",
        category_id: "default",
        original_text: "阈值42。",
      });
      h.repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
      h.gateway.complete = async () => '{"ids":["not-an-authorized-candidate"]}';
      await expect(
        h.module.query({
          agentId: DEFAULT_AGENT_ID,
          query: "阈值？",
          budget: 4096,
          owner: h.owner,
        }),
      ).rejects.toThrow();
      expect(
        h.business.db.query<{ status: string }, []>("SELECT status FROM agent_runs").get()?.status,
      ).toBe("failed");
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
