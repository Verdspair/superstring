import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { setMemoryVisibility } from "../../src/server/db/memory-content-repository";
import { memoryManagementPage } from "../../src/server/db/memory-management-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getTurnByRequest,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { createAgent } from "../../src/server/services/agent-service";
import { CreateAgentRequestSchema } from "../../src/shared/contracts/agent";

describe("memory management metadata projection", () => {
  it("pages metadata and evaluates runtime only for an explicit canonical context", () => {
    const b = openBusinessDb();
    try {
      ensureDefaults(b.orm, "synthetic");
      const a = createSession(b.orm, "A", { modelName: "synthetic" });
      const journal = new ConversationEventRepository(b.db),
        canonical = journal.ensureWeb(a.id, DEFAULT_USER_ID)!;
      const p = prepareTurn(b.orm, a.id, "question", "one");
      saveCompletedAssistantMessage(b.orm, a.id, "answer", "one", p.generationToken!);
      const t = getTurnByRequest(b.orm, a.id, "one")!,
        messages = b.orm
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.turnId, t.id))
          .all();
      const id = crypto.randomUUID();
      b.orm
        .insert(schema.memoryEntries)
        .values({
          id,
          agentId: DEFAULT_AGENT_ID,
          userId: DEFAULT_USER_ID,
          name: "needle",
          summary: "summary",
          tags: "[]",
          kinds: "[]",
          body: "PRIVATE BODY",
          scope: "reality_user",
          scopeKey: DEFAULT_AGENT_ID,
          status: "active",
          configSnapshot: "{}",
          createdAt: nowIso(),
          visibility: "session_private",
        })
        .run();
      b.orm
        .insert(schema.memorySources)
        .values({
          memoryId: id,
          turnId: t.id,
          userMessageId: messages.find((m) => m.role === "user")!.id,
          assistantMessageId: messages.find((m) => m.role === "assistant")!.id,
          sequenceNo: messages.find((m) => m.role === "user")!.sequenceNo,
        })
        .run();
      const page = memoryManagementPage(b.orm, DEFAULT_AGENT_ID, { limit: 1, search: "needle" });
      expect(page.total).toBe(1);
      expect(page.items).toHaveLength(1);
      expect(page.items[0]!.source_validity).toBe("valid");
      expect(page.items[0]!.runtime_eligibility).toBe("unknown");
      expect(page.items[0]!.raw_preview).toBe("unknown");
      expect(JSON.stringify(page)).not.toContain("PRIVATE BODY");
      expect(page.items[0]).not.toHaveProperty("body");
      b.db.query("UPDATE memory_entries SET name=?,summary=? WHERE id=?").run("ÄLPHA", "NEXT", id);
      expect(memoryManagementPage(b.orm, DEFAULT_AGENT_ID, { search: "  älpha  " }).total).toBe(1);
      expect(memoryManagementPage(b.orm, DEFAULT_AGENT_ID, { search: "ÄLPHA\nNEXT" }).total).toBe(
        1,
      );
      expect(memoryManagementPage(b.orm, DEFAULT_AGENT_ID, { search: "älpha next" }).total).toBe(0);
      expect(
        memoryManagementPage(b.orm, DEFAULT_AGENT_ID, { conversation_id: canonical.id }).items[0],
      ).toMatchObject({ runtime_eligibility: "available", raw_preview: "unknown" });
      const { persona, persona_intensity, ...config } = CreateAgentRequestSchema.parse({
        name: "recipient",
        model_name: "synthetic",
      });
      const recipient = createAgent(b.orm, config, persona, persona_intensity);
      setMemoryVisibility(b.orm, DEFAULT_AGENT_ID, id, {
        expected_revision: 1,
        visibility: "public",
        recipient_agent_ids: [recipient.id],
      });
      const received = memoryManagementPage(b.orm, recipient.id, { view: "received" });
      expect(received.total).toBe(1);
      expect(received.items[0]!.owner_agent_id).toBe(DEFAULT_AGENT_ID);
      expect(received.items[0]!.recipient_agent_ids).toEqual([recipient.id]);
      expect(received.items[0]!.runtime_eligibility).toBe("unknown");
      expect(received.items[0]!.raw_preview).toBe("unknown");
      const receivedSession = createSession(b.orm, "recipient session", {
        agentId: recipient.id,
        modelName: "synthetic",
      });
      const receivedConversation = journal.ensureWeb(receivedSession.id, DEFAULT_USER_ID)!;
      const receivedContext = memoryManagementPage(b.orm, recipient.id, {
        view: "received",
        conversation_id: receivedConversation.id,
      });
      expect(receivedContext.items[0]!.runtime_eligibility).toBe("unavailable");
      journal.setMemoryReadMode(receivedConversation.id, DEFAULT_USER_ID, "agent_shared", 1);
      expect(
        memoryManagementPage(b.orm, recipient.id, {
          view: "received",
          conversation_id: receivedConversation.id,
        }).items[0]!.runtime_eligibility,
      ).toBe("available");
      expect(memoryManagementPage(b.orm, recipient.id, { view: "owned" }).items).toEqual([]);
      b.db
        .query("DELETE FROM memory_read_grants WHERE memory_id=? AND agent_id=?")
        .run(id, recipient.id);
      expect(memoryManagementPage(b.orm, recipient.id, { view: "received" }).items).toEqual([]);
      expect(
        memoryManagementPage(b.orm, DEFAULT_AGENT_ID, { origin_conversation_id: canonical.id })
          .total,
      ).toBe(1);
    } finally {
      b.db.close();
    }
  });
});
