import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { sourceAccess } from "../../src/server/agent/context-access";
import { history, saveSummary, summaries } from "../../src/server/db/context-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  conversationCorrections,
  correctMemory,
  memoryContent,
  setMemoryVisibility,
} from "../../src/server/db/memory-content-repository";
import { govern } from "../../src/server/db/memory-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
  getTurnByRequest,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";

function turn(b: ReturnType<typeof openBusinessDb>, sessionId: string, key: string) {
  const prepared = prepareTurn(b.orm, sessionId, key, key);
  saveCompletedAssistantMessage(b.orm, sessionId, "answer", key, prepared.generationToken!);
  const row = getTurnByRequest(b.orm, sessionId, key)!;
  const messages = b.orm
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.turnId, row.id))
    .all();
  return {
    row,
    user: messages.find((m) => m.role === "user")!,
    assistant: messages.find((m) => m.role === "assistant")!,
  };
}
function memory(b: ReturnType<typeof openBusinessDb>, turns: ReturnType<typeof turn>[]) {
  const id = crypto.randomUUID();
  b.orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: "source",
      summary: "source",
      tags: "[]",
      kinds: "[]",
      body: "old assertion",
      scope: "reality_user",
      scopeKey: DEFAULT_AGENT_ID,
      status: "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
      visibility: "session_private",
    })
    .run();
  for (const t of turns)
    b.orm
      .insert(schema.memorySources)
      .values({
        memoryId: id,
        turnId: t.row.id,
        userMessageId: t.user.id,
        assistantMessageId: t.assistant.id,
        sequenceNo: t.user.sequenceNo,
      })
      .run();
  const content = memoryContent(b.orm, DEFAULT_AGENT_ID, id);
  return correctMemory(b.orm, DEFAULT_AGENT_ID, id, {
    expected_revision: content.content.revision,
    name: "corrected",
    summary: "corrected",
    tags: [],
    body: "corrected sourced assertion",
  });
}

describe("correction full-source conversation eligibility", () => {
  it("keeps a same-conversation correction relevant to one selected batch while binding current authority", () => {
    const b = openBusinessDb();
    try {
      ensureDefaults(b.orm, "synthetic");
      const session = createSession(b.orm, "A", { modelName: "synthetic" });
      const journal = new ConversationEventRepository(b.db),
        canonical = journal.ensureWeb(session.id, DEFAULT_USER_ID)!;
      const first = turn(b, session.id, "first"),
        second = turn(b, session.id, "second");
      const fixed = memory(b, [first, second]);
      const projected = conversationCorrections(b.orm, DEFAULT_AGENT_ID, session.id, [
        first.row.id,
      ]);
      expect(projected).toHaveLength(1);
      expect(projected[0]!.id).toBe(fixed.content.id);
      expect(projected[0]!.source_ids).toEqual([first.row.id]);
      expect(projected[0]!.body).toBe("corrected sourced assertion");
      expect(projected[0]!.source.kind).toBe("memory_access");
      const owner = {
        kind: "web_turn" as const,
        id: second.row.id,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      };
      expect(
        sourceAccess(b.db, projected[0]!.source, owner, { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("available");
      expect(
        journal.setMemoryReadMode(canonical.id, DEFAULT_USER_ID, "agent_shared", 1)?.kind,
      ).toBe("saved");
      expect(
        journal.setMemoryReadMode(canonical.id, DEFAULT_USER_ID, "current_conversation", 2)?.kind,
      ).toBe("saved");
      expect(
        sourceAccess(b.db, projected[0]!.source, owner, { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("revoked");
      expect(
        conversationCorrections(b.orm, DEFAULT_AGENT_ID, session.id, [first.row.id]),
      ).toHaveLength(1);
    } finally {
      b.db.close();
    }
  });
  it("does not disclose an entire corrected body through one matching source from another private conversation", () => {
    const b = openBusinessDb();
    try {
      ensureDefaults(b.orm, "synthetic");
      const a = createSession(b.orm, "A", { modelName: "synthetic" }),
        other = createSession(b.orm, "B", { modelName: "synthetic" });
      const journal = new ConversationEventRepository(b.db);
      journal.ensureWeb(a.id, DEFAULT_USER_ID);
      journal.ensureWeb(other.id, DEFAULT_USER_ID);
      const first = turn(b, a.id, "A"),
        second = turn(b, other.id, "B");
      const fixed = memory(b, [first, second]);
      expect(() => conversationCorrections(b.orm, DEFAULT_AGENT_ID, a.id, [first.row.id])).toThrow(
        "当前无权读取",
      );
      expect(() =>
        conversationCorrections(b.orm, DEFAULT_AGENT_ID, other.id, [second.row.id]),
      ).toThrow("当前无权读取");
      setMemoryVisibility(b.orm, DEFAULT_AGENT_ID, fixed.content.id, {
        expected_revision: 1,
        visibility: "agent_shared",
        recipient_agent_ids: [DEFAULT_AGENT_ID],
      });
      const canonical = journal.ensureWeb(a.id, DEFAULT_USER_ID)!;
      journal.setMemoryReadMode(canonical.id, DEFAULT_USER_ID, "agent_shared", 1);
      const shared = conversationCorrections(b.orm, DEFAULT_AGENT_ID, a.id, [first.row.id]);
      expect(shared).toHaveLength(1);
      expect(shared[0]!.source.kind).toBe("memory_access");
      b.db
        .query("DELETE FROM memory_read_grants WHERE memory_id=? AND agent_id=?")
        .run(fixed.content.id, DEFAULT_AGENT_ID);
      expect(() => conversationCorrections(b.orm, DEFAULT_AGENT_ID, a.id, [first.row.id])).toThrow(
        "当前无权读取",
      );
    } finally {
      b.db.close();
    }
  });

  it("does not reuse a summary snapshot after canonical read-authority ABA", () => {
    const b = openBusinessDb();
    try {
      ensureDefaults(b.orm, "synthetic");
      const session = createSession(b.orm, "A", { modelName: "synthetic" });
      const journal = new ConversationEventRepository(b.db),
        canonical = journal.ensureWeb(session.id, DEFAULT_USER_ID)!;
      const prior = turn(b, session.id, "prior");
      memory(b, [prior]);
      const pending = prepareTurn(b.orm, session.id, "current", "current");
      const current = getTurnByRequest(b.orm, session.id, "current")!;
      const currentMessage = b.orm
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, pending.messageId))
        .get()!;
      const retained = history(b.orm, DEFAULT_AGENT_ID, session.id, currentMessage.sequenceNo);
      const runtime = runtimeFromAgent(getAgentRow(b.orm, DEFAULT_AGENT_ID)!);
      const facts = {
        facts: [
          {
            kind: "fact" as const,
            speaker: "user" as const,
            text: "corrected sourced assertion",
            source_ids: [prior.row.id],
          },
        ],
      };
      saveSummary(
        b.orm,
        DEFAULT_AGENT_ID,
        session.id,
        retained,
        facts,
        runtime,
        100,
        current.id,
        pending.generationToken!,
      );
      expect(summaries(b.orm, DEFAULT_AGENT_ID, session.id, retained)).toHaveLength(1);
      journal.setMemoryReadMode(canonical.id, DEFAULT_USER_ID, "agent_shared", 1);
      journal.setMemoryReadMode(canonical.id, DEFAULT_USER_ID, "current_conversation", 2);
      expect(summaries(b.orm, DEFAULT_AGENT_ID, session.id, retained)).toEqual([]);
    } finally {
      b.db.close();
    }
  });

  it("distinguishes no correction from a suppressed correction instead of reviving original history", () => {
    const b = openBusinessDb();
    try {
      ensureDefaults(b.orm, "synthetic");
      const session = createSession(b.orm, "A", { modelName: "synthetic" });
      new ConversationEventRepository(b.db).ensureWeb(session.id, DEFAULT_USER_ID);
      const prior = turn(b, session.id, "wrong claim");
      expect(conversationCorrections(b.orm, DEFAULT_AGENT_ID, session.id, [prior.row.id])).toEqual(
        [],
      );
      const fixed = memory(b, [prior]);
      b.db.query("UPDATE memory_entries SET status='suppressed' WHERE id=?").run(fixed.content.id);
      expect(() =>
        conversationCorrections(b.orm, DEFAULT_AGENT_ID, session.id, [prior.row.id]),
      ).toThrow("当前无权读取");
    } finally {
      b.db.close();
    }
  });

  it("does not revive retired original claims after the corrected replacement is purged", () => {
    const b = openBusinessDb();
    try {
      ensureDefaults(b.orm, "synthetic");
      const session = createSession(b.orm, "A", { modelName: "synthetic" });
      new ConversationEventRepository(b.db).ensureWeb(session.id, DEFAULT_USER_ID);
      const prior = turn(b, session.id, "wrong claim"),
        fixed = memory(b, [prior]);
      expect(
        conversationCorrections(b.orm, DEFAULT_AGENT_ID, session.id, [prior.row.id]),
      ).toHaveLength(1);
      govern(b.orm, DEFAULT_AGENT_ID, [fixed.content.id], "purge");
      expect(() =>
        conversationCorrections(b.orm, DEFAULT_AGENT_ID, session.id, [prior.row.id]),
      ).toThrow("当前无权读取");
    } finally {
      b.db.close();
    }
  });
});
