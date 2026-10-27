import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { sourceData, turns } from "../../src/server/db/memory-repository";
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
