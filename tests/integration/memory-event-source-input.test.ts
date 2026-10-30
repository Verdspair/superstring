import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { enqueue, sourceData, turns } from "../../src/server/db/memory-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { buildConsolidationPrompt } from "../../src/server/services/memory-contract";
import { MemoryService } from "../../src/server/services/memory-service";
import { DEFAULT_MEMORY_CONSOLIDATION_PROMPT } from "../../src/shared/contracts/agent";

function fixture() {
  const business = openBusinessDb();
  const { orm } = business;
  ensureDefaults(orm, "synthetic");
  const session = createSession(orm, "synthetic", { modelName: "synthetic" });
  function complete(key: string, userText: string, assistantText: string) {
    const prepared = prepareTurn(orm, session.id, userText, key);
    if (!prepared.generationToken) throw new Error("missing generation token");
    saveCompletedAssistantMessage(orm, session.id, assistantText, key, prepared.generationToken);
    const turn = getTurnByRequest(orm, session.id, key);
    if (!turn) throw new Error("missing completed turn");
    return turn.id;
  }
  return { business, orm, session, complete };
}

describe("long-term memory source input", () => {
  it("sends the real Web actors and recording times with the common source explanation", async () => {
    const f = fixture();
    const calls: Array<Parameters<ModelGateway["complete"]>[0]> = [];
    const gateway: ModelGateway = {
      config: { baseUrl: "http://127.0.0.1:1234/v1", model: "synthetic", timeoutSeconds: 30 },
      listModels: async () => ["synthetic"],
      loadedContextCapacity: async () => 32768,
      probeModelLoaded: async () => true,
      complete: async (options) => {
        calls.push(options);
        return '{"memory":null}';
      },
      async *streamChat() {
        yield "unused";
      },
    };
    const service = new MemoryService({ orm: f.orm, db: f.business.db, gateway });
    try {
      const userText = "30001说自己于2026年10月20日向30002提出申请，尚未获批。";
      const assistantText = "这是30001的陈述，不代表30002已确认。";
      const turnId = f.complete("recorded-later", userText, assistantText);
      const rows = turns(f.orm, DEFAULT_AGENT_ID, f.session.id, { ids: [turnId] });
      const row = rows[0];
      if (!row) throw new Error("source turn missing");
      const userAt = "2026-10-28T01:02:03.000Z";
      const assistantAt = "2026-10-28T01:02:04.000Z";
      f.orm
        .update(schema.messages)
        .set({ createdAt: userAt })
        .where(eq(schema.messages.id, row.user.id))
        .run();
      f.orm
        .update(schema.messages)
        .set({ createdAt: assistantAt })
        .where(eq(schema.messages.id, row.assistant.id))
        .run();
      const job = enqueue(f.orm, DEFAULT_AGENT_ID, "recorded-later", {
        kind: "manual",
        sessionId: f.session.id,
        turnIds: [turnId],
      });
      await service.runJob(job.id);
      expect(calls).toHaveLength(1);
      const messages = calls[0]?.messages;
      if (!messages) throw new Error("worker request missing");
      const instruction = messages[0]?.content;
      if (typeof instruction !== "string") throw new Error("text instruction missing");
      const snapshot = JSON.parse(job.configSnapshot);
      expect(snapshot.base_prompt).toBe(DEFAULT_MEMORY_CONSOLIDATION_PROMPT);
      const sources = sourceData(turns(f.orm, DEFAULT_AGENT_ID, f.session.id, { ids: [turnId] }));
      expect(messages).toEqual(buildConsolidationPrompt("manual", snapshot, sources));
      expect(sources[0]).toMatchObject({
        turn_id: turnId,
        user: userText,
        assistant: assistantText,
        user_source: { actor: { kind: "user", id: f.session.userId }, recorded_at: userAt },
        assistant_source: {
          actor: { kind: "agent", id: f.session.agentId },
          recorded_at: assistantAt,
        },
      });
      expect(instruction).toContain(
        "user_source/assistant_source.recorded_at与message_records.created_at表示消息记录时刻",
      );
      expect(instruction).toContain("都不自动成为所述事件的发生时间");
      const finished = f.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get();
      expect(finished?.status).toBe("succeeded");
      expect(finished?.resultId).toBeNull();
    } finally {
      await service.stop();
      f.business.close();
    }
  });

  it("carries distinct stable message actors and recorded times", () => {
    const f = fixture();
    try {
      const id = f.complete("first", "I plan a trip", "I will help");
      const userAt = "2026-01-02T03:04:05.000Z";
      const assistantAt = "2026-01-02T03:05:06.000Z";
      const messages = f.orm
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.turnId, id))
        .all();
      const user = messages.find((message) => message.role === "user");
      const assistant = messages.find((message) => message.role === "assistant");
      if (!user || !assistant) throw new Error("missing source messages");
      f.orm
        .update(schema.messages)
        .set({ createdAt: userAt })
        .where(eq(schema.messages.id, user.id))
        .run();
      f.orm
        .update(schema.messages)
        .set({ createdAt: assistantAt })
        .where(eq(schema.messages.id, assistant.id))
        .run();
      const rows = turns(f.orm, DEFAULT_AGENT_ID, f.session.id, { ids: [id] });
      expect(rows).toHaveLength(1);
      expect(sourceData(rows)[0]).toMatchObject({
        user_source: { actor: { kind: "user", id: f.session.userId }, recorded_at: userAt },
        assistant_source: {
          actor: { kind: "agent", id: f.session.agentId },
          recorded_at: assistantAt,
        },
      });
    } finally {
      f.business.close();
    }
  });

  it("preserves original text and provenance for each of multiple turns", () => {
    const f = fixture();
    try {
      const first = f.complete("one", "question one", "answer one");
      const second = f.complete("two", "question two", "answer two");
      const rows = turns(f.orm, DEFAULT_AGENT_ID, f.session.id, { ids: [first, second] });
      expect(rows).toHaveLength(2);
      const result = sourceData(rows);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) throw new Error("missing turn row");
        expect(result[i]).toMatchObject({
          turn_id: row.turn.id,
          sequence_no: row.user.sequenceNo,
          user_message_id: row.user.id,
          assistant_message_id: row.assistant.id,
          user: row.user.content,
          assistant: row.assistant.content,
          user_source: {
            actor: { kind: "user", id: f.session.userId },
            recorded_at: row.user.createdAt,
          },
          assistant_source: {
            actor: { kind: "agent", id: f.session.agentId },
            recorded_at: row.assistant.createdAt,
          },
        });
      }
    } finally {
      f.business.close();
    }
  });
});
