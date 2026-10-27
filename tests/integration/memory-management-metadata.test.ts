import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server/app";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { memoryAccessMetadataBatch } from "../../src/server/db/memory-source-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
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
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { qqConversationKey, qqMemoryScopeKey } from "../../src/server/services/qq-binding-contract";
import { MemoryAccessMetadataSchema } from "../../src/shared/contracts/memory";

function fixture(count = 1) {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "synthetic");
  const session = createSession(business.orm, "synthetic", { modelName: "synthetic" });
  const canonical = new ConversationEventRepository(business.db).ensureWeb(session.id)!;
  const entries: (typeof schema.memoryEntries.$inferSelect)[] = [];
  for (let i = 0; i < count; i++) {
    const req = `meta-${i}`;
    const prepared = prepareTurn(business.orm, session.id, `PRIVATE question ${i}`, req);
    saveCompletedAssistantMessage(
      business.orm,
      session.id,
      `PRIVATE answer ${i}`,
      req,
      prepared.generationToken!,
    );
    const turn = getTurnByRequest(business.orm, session.id, req)!;
    const messages = business.orm
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.turnId, turn.id))
      .all();
    const user = messages.find((m) => m.role === "user")!;
    const assistant = messages.find((m) => m.role === "assistant")!;
    const entry = business.orm
      .insert(schema.memoryEntries)
      .values({
        id: crypto.randomUUID(),
        agentId: DEFAULT_AGENT_ID,
        userId: DEFAULT_USER_ID,
        name: "name",
        summary: "summary",
        body: "body",
        tags: "[]",
        kinds: "[]",
        scope: "reality_user",
        scopeKey: DEFAULT_AGENT_ID,
        status: "active",
        configSnapshot: "{}",
        createdAt: nowIso(),
      })
      .returning()
      .get()!;
    business.orm
      .insert(schema.memorySources)
      .values({
        memoryId: entry.id,
        turnId: turn.id,
        userMessageId: user.id,
        assistantMessageId: assistant.id,
        sequenceNo: user.sequenceNo,
      })
      .run();
    entries.push(entry);
  }
  const app = createApp({ business, externalActions: () => [] });
  return { business, app, entries, canonical };
}
describe("memory management access metadata", () => {
  it("returns known origin and current visibility CAS without raw content", async () => {
    const f = fixture();
    try {
      const entry = f.entries[0]!;
      const url = `/agents/${DEFAULT_AGENT_ID}/memory/entries/${entry.id}`;
      const first = await f.app.request(`${url}/access-metadata`);
      expect(first.status).toBe(200);
      const body = MemoryAccessMetadataSchema.parse(await first.json());
      expect(body).toMatchObject({
        visibility: null,
        visibility_revision: 1,
        recipient_agent_ids: [],
        origin_complete: true,
        origins: [{ channel: "web", conversation_id: f.canonical.id }],
        source_validity: "not_evaluated",
        runtime_eligibility: "not_evaluated",
        raw_preview: "not_evaluated",
      });
      expect(JSON.stringify(body)).not.toContain("PRIVATE");
      const put = await f.app.request(`${url}/visibility`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_revision: body.visibility_revision,
          visibility: "agent_shared",
          recipient_agent_ids: [DEFAULT_AGENT_ID],
        }),
      });
      expect(put.status).toBe(200);
      const after = MemoryAccessMetadataSchema.parse(
        await (await f.app.request(`${url}/access-metadata`)).json(),
      );
      expect(after.visibility_revision).toBe(2);
      expect(after.recipient_agent_ids).toEqual([DEFAULT_AGENT_ID]);
      expect(
        (
          await f.app.request(
            `/agents/${crypto.randomUUID()}/memory/entries/${entry.id}/access-metadata`,
          )
        ).status,
      ).toBe(404);
    } finally {
      f.business.close();
    }
  });
  it("does not guess an absent canonical conversation", () => {
    const f = fixture();
    try {
      f.business.db.query("DELETE FROM conversations WHERE id=?").run(f.canonical.id);
      const value = memoryAccessMetadataBatch(f.business.orm, f.entries).get(f.entries[0]!.id)!;
      expect(value.origin_complete).toBe(false);
      expect(value.origins).toEqual([{ channel: "unknown", conversation_id: null }]);
    } finally {
      f.business.close();
    }
  });
  it("shows distinct QQ and Web origins and never guesses a rebound epoch", () => {
    const f = fixture();
    try {
      const now = nowIso(),
        schemeId = crypto.randomUUID(),
        bindingId = crypto.randomUUID();
      f.business.orm
        .insert(schema.qqSchemes)
        .values({ id: schemeId, name: "synthetic", revision: 1, createdAt: now, updatedAt: now })
        .run();
      f.business.orm
        .insert(schema.qqBindings)
        .values({
          id: bindingId,
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
          schemeId,
          paused: 0,
          shareWebMemory: 0,
          memoryBatchSize: null,
          ownerIdentityRevision: null,
          revision: 1,
          authorityRevision: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      const journal = new ConversationEventRepository(f.business.db);
      const conversation = journal.ensureOneBot(bindingId)!;
      const event = normalizeOneBotMessage(
        {
          time: Math.floor(Date.now() / 1000),
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: 123,
          user_id: 20002,
          group_id: 30003,
          message: [{ type: "text", data: { text: "PRIVATE QQ" } }],
        },
        "90001",
      );
      if (event.kind !== "message") throw new Error("invalid fixture");
      recordObservation(f.business.orm, event.observation, DEFAULT_AGENT_ID);
      journal.ingestOneBotEvent(event.observation.eventKey, bindingId);
      f.business.orm
        .insert(schema.qqMemorySources)
        .values({
          memoryId: f.entries[0]!.id,
          eventKey: event.observation.eventKey,
          scopeKey: qqMemoryScopeKey({
            kind: "qq",
            accountId: "90001",
            conversationKind: "group",
            peerId: "30003",
            agentId: DEFAULT_AGENT_ID,
          }),
          conversationKey: qqConversationKey({
            accountId: "90001",
            kind: "group",
            peerId: "30003",
          }),
          messageId: event.observation.messageId,
          occurredAtSeconds: event.observation.occurredAtSeconds,
          speakerKind: "member",
          speakerId: event.observation.speaker.id,
        })
        .run();
      const known = memoryAccessMetadataBatch(f.business.orm, f.entries).get(f.entries[0]!.id)!;
      expect(known.origin_complete).toBe(true);
      expect(known.origins.map((item) => item.conversation_id).sort()).toEqual(
        [f.canonical.id, conversation.id].sort(),
      );
      f.business.orm
        .insert(schema.users)
        .values({ id: "foreign-user", name: "synthetic", createdAt: now })
        .run();
      f.business.db
        .query("UPDATE conversations SET user_id=? WHERE id=?")
        .run("foreign-user", conversation.id);
      const foreign = memoryAccessMetadataBatch(f.business.orm, f.entries).get(f.entries[0]!.id)!;
      expect(foreign.origin_complete).toBe(false);
      expect(foreign.origins).toContainEqual({ channel: "unknown", conversation_id: null });
      f.business.db
        .query("UPDATE conversations SET user_id=? WHERE id=?")
        .run(DEFAULT_USER_ID, conversation.id);
      f.business.db
        .query("UPDATE conversations SET closed_at=? WHERE id=?")
        .run(now, conversation.id);
      const replacement = journal.ensureOneBot(bindingId)!;
      f.business.db
        .query(`INSERT INTO conversation_events(conversation_id,seq,event_key,kind,source_kind,source_id,source_revision,source_expires_at,sources,participant,addressing,occurred_at,recorded_at,run_id,output_id)
        SELECT ?,seq,event_key,kind,source_kind,source_id,source_revision,source_expires_at,sources,participant,addressing,occurred_at,recorded_at,run_id,output_id
        FROM conversation_events WHERE conversation_id=? AND source_id=?`)
        .run(replacement.id, conversation.id, event.observation.eventKey);
      // A stale epoch with a different binding identity must still count as an
      // ambiguous raw journal candidate, even when the current one matches.
      f.business.db
        .query("UPDATE conversations SET source_id=? WHERE id=?")
        .run("old-binding", conversation.id);
      const ambiguous = memoryAccessMetadataBatch(f.business.orm, f.entries).get(f.entries[0]!.id)!;
      expect(ambiguous.origin_complete).toBe(false);
      expect(ambiguous.origins).toContainEqual({ channel: "unknown", conversation_id: null });
      expect(JSON.stringify(ambiguous)).not.toContain("PRIVATE QQ");
    } finally {
      f.business.close();
    }
  });
  it.each([1, 32, 200])(
    "loads metadata in bounded batches for %i entries without message text",
    (count) => {
      const f = fixture(count);
      try {
        const db = f.business.db,
          query = db.query,
          prepare = db.prepare;
        const statements: string[] = [];
        const trace = (sql: string, statement: ReturnType<typeof db.query>) =>
          new Proxy(statement, {
            get(target, key) {
              const value = Reflect.get(target, key, target);
              if (key === "all" || key === "get" || key === "values")
                return (...args: unknown[]) => {
                  statements.push(sql.toLowerCase());
                  return Reflect.apply(value, target, args);
                };
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        db.query = ((sql: string, ...args: unknown[]) =>
          trace(sql, Reflect.apply(query, db, [sql, ...args]))) as typeof db.query;
        db.prepare = ((sql: string, ...args: unknown[]) =>
          trace(sql, Reflect.apply(prepare, db, [sql, ...args]))) as typeof db.prepare;
        try {
          expect(memoryAccessMetadataBatch(f.business.orm, []).size).toBe(0);
          expect(statements).toEqual([]);
          expect(memoryAccessMetadataBatch(f.business.orm, f.entries).size).toBe(count);
        } finally {
          db.query = query;
          db.prepare = prepare;
        }
        expect(statements.length).toBeGreaterThan(0);
        expect(statements.length).toBeLessThanOrEqual(5);
        expect(statements.some((sql) => /messages\b|\bcontent\b/.test(sql))).toBe(false);
      } finally {
        f.business.close();
      }
    },
  );
});
