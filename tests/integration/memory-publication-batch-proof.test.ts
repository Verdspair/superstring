import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  memoryPublicationSourceRevision,
  memoryPublicationSourceRevisions,
} from "../../src/server/db/memory-source-repository";
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
import { memoryRevision } from "../../src/server/services/memory-revision";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { qqConversationKey, qqMemoryScopeKey } from "../../src/server/services/qq-binding-contract";
import { projectQqMessageFacts } from "../../src/server/services/qq-message-fact-projection";

function fixture(count: number) {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "synthetic");
  const session = createSession(business.orm, "synthetic", { modelName: "synthetic" });
  const entries: (typeof schema.memoryEntries.$inferSelect)[] = [];
  const turns: string[] = [];
  for (let i = 0; i < count; i++) {
    const request = `batch-${i}`;
    const prepared = prepareTurn(business.orm, session.id, `question ${i}`, request);
    saveCompletedAssistantMessage(
      business.orm,
      session.id,
      `answer ${i}`,
      request,
      prepared.generationToken!,
    );
    const turn = getTurnByRequest(business.orm, session.id, request)!;
    const messages = business.orm
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.turnId, turn.id))
      .all();
    const user = messages.find((message) => message.role === "user")!;
    const assistant = messages.find((message) => message.role === "assistant")!;
    const id = crypto.randomUUID();
    const row = business.orm
      .insert(schema.memoryEntries)
      .values({
        id,
        agentId: DEFAULT_AGENT_ID,
        userId: DEFAULT_USER_ID,
        name: `n${i}`,
        summary: "s",
        tags: "[]",
        kinds: "[]",
        body: `body${i}`,
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
        memoryId: id,
        turnId: turn.id,
        userMessageId: user.id,
        assistantMessageId: assistant.id,
        sequenceNo: user.sequenceNo,
      })
      .run();
    entries.push(row);
    turns.push(turn.id);
  }
  return { business, entries, turns };
}

function addQqSources(h: ReturnType<typeof fixture>, now: string) {
  const schemeId = crypto.randomUUID();
  const bindingId = crypto.randomUUID();
  h.business.orm
    .insert(schema.qqSchemes)
    .values({ id: schemeId, name: "synthetic", revision: 1, createdAt: now, updatedAt: now })
    .run();
  h.business.orm
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
  const journal = new ConversationEventRepository(h.business.db);
  if (!journal.ensureOneBot(bindingId)) throw new Error("missing conversation");
  for (let i = 0; i < h.entries.length; i++) {
    const result = normalizeOneBotMessage(
      {
        time: Math.floor(Date.now() / 1000),
        self_id: 90001,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: 100 + i,
        user_id: 20002 + i,
        group_id: 30003,
        message: [{ type: "text", data: { text: `QQ ${i}` } }],
      },
      "90001",
    );
    if (result.kind !== "message") throw new Error("bad fixture");
    const event = result.observation;
    recordObservation(h.business.orm, event, DEFAULT_AGENT_ID);
    journal.ingestOneBotEvent(event.eventKey, bindingId);
    h.business.orm
      .insert(schema.qqMemorySources)
      .values({
        memoryId: h.entries[i]!.id,
        eventKey: event.eventKey,
        scopeKey: qqMemoryScopeKey({
          kind: "qq",
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
        }),
        conversationKey: qqConversationKey({ accountId: "90001", kind: "group", peerId: "30003" }),
        messageId: event.messageId,
        occurredAtSeconds: event.occurredAtSeconds,
        speakerKind: "member",
        speakerId: event.speaker.id,
      })
      .run();
  }
}

describe("batch publication proof", () => {
  it("preserves v1 one-entry digest and omits only invalid entries", () => {
    const h = fixture(2);
    try {
      const now = nowIso();
      const singles = h.entries.map((entry) =>
        memoryPublicationSourceRevision(h.business.orm, entry, memoryRevision(entry), now),
      );
      const batch = memoryPublicationSourceRevisions(
        h.business.orm,
        h.entries,
        new Map(h.entries.map((entry) => [entry.id, memoryRevision(entry)])),
        now,
      );
      expect(h.entries.map((entry) => batch.get(entry.id))).toEqual(singles);
      for (const entry of h.entries) {
        const source = h.business.orm
          .select()
          .from(schema.memorySources)
          .where(eq(schema.memorySources.memoryId, entry.id))
          .get()!;
        const turn = h.business.orm
          .select()
          .from(schema.turns)
          .where(eq(schema.turns.id, source.turnId))
          .get()!;
        const user = h.business.orm
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.id, source.userMessageId))
          .get()!;
        const assistant = h.business.orm
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.id, source.assistantMessageId))
          .get()!;
        const sourceItem = [
          "web",
          source.turnId,
          turn.sessionId,
          source.userMessageId,
          source.assistantMessageId,
          source.sequenceNo,
          user.content,
          assistant.content,
        ];
        const frozenV1 = createHash("sha256")
          .update(
            JSON.stringify([
              "memory-publication-v1",
              entry.id,
              memoryRevision(entry),
              [JSON.stringify(sourceItem)],
            ]),
          )
          .digest("hex");
        expect(batch.get(entry.id)).toBe(frozenV1);
      }
      h.business.db.query("UPDATE turns SET source_valid=0 WHERE id=?").run(h.turns[0]!);
      const after = memoryPublicationSourceRevisions(
        h.business.orm,
        h.entries,
        new Map(h.entries.map((entry) => [entry.id, memoryRevision(entry)])),
        now,
      );
      expect(after.has(h.entries[0]!.id)).toBe(false);
      expect(after.get(h.entries[1]!.id)).toBe(singles[1]);
      expect(() =>
        memoryPublicationSourceRevision(
          h.business.orm,
          h.entries[0]!,
          memoryRevision(h.entries[0]!),
          now,
        ),
      ).toThrow();
    } finally {
      h.business.close();
    }
  });
  it.each([1, 32, 400])("keeps Web source query work bounded for %i distinct sources", (count) => {
    const h = fixture(count);
    try {
      const statements: string[] = [];
      const db = h.business.db;
      const query = db.query;
      const prepare = db.prepare;
      const wrapped = new WeakSet<object>();
      const trace = (sql: string, statement: ReturnType<typeof db.query>) => {
        if (wrapped.has(statement) || !/^\s*select\b/i.test(sql)) return statement;
        const proxy = new Proxy(statement, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key === "all" || key === "get" || key === "values")
              return (...args: unknown[]) => {
                statements.push(sql);
                return Reflect.apply(value, target, args);
              };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        wrapped.add(proxy);
        return proxy;
      };
      db.query = ((sql: string, ...args: unknown[]) =>
        trace(sql, Reflect.apply(query, db, [sql, ...args]))) as typeof db.query;
      db.prepare = ((sql: string, ...args: unknown[]) =>
        trace(sql, Reflect.apply(prepare, db, [sql, ...args]))) as typeof db.prepare;
      try {
        expect(
          memoryPublicationSourceRevisions(
            h.business.orm,
            h.entries,
            new Map(h.entries.map((entry) => [entry.id, memoryRevision(entry)])),
            nowIso(),
          ).size,
        ).toBe(count);
      } finally {
        db.query = query;
        db.prepare = prepare;
      }
      const relevant = statements.filter((sql) =>
        /\b(memory_sources|qq_memory_sources|turns|sessions|messages)\b/i.test(sql),
      );
      expect(relevant.length).toBeGreaterThan(0);
      expect(relevant.length).toBeLessThanOrEqual(8);
    } finally {
      h.business.close();
    }
  });
  it("matches mixed QQ v1 single and batch proofs for separate sources", () => {
    const h = fixture(2);
    try {
      const now = nowIso();
      addQqSources(h, now);
      const batch = memoryPublicationSourceRevisions(
        h.business.orm,
        h.entries,
        new Map(h.entries.map((entry) => [entry.id, memoryRevision(entry)])),
        now,
      );
      const binding = h.business.orm.select().from(schema.qqBindings).get()!;
      const conversation = h.business.db
        .query(
          "SELECT id, binding_epoch FROM conversations WHERE source_id=? AND closed_at IS NULL",
        )
        .get(binding.id) as { id: string; binding_epoch: number };
      const scope = {
        conversationId: conversation.id,
        accountId: binding.accountId,
        conversationKind: "group" as const,
        peerId: binding.peerId,
        agentId: binding.agentId,
        bindingId: binding.id,
        bindingEpoch: conversation.binding_epoch,
        authorityRevision: binding.authorityRevision,
      };
      const sources = h.business.orm.select().from(schema.qqMemorySources).all();
      const facts = projectQqMessageFacts(
        { db: h.business.db, orm: h.business.orm },
        scope,
        sources.map((source) => source.eventKey),
        now,
      );
      expect(facts).toHaveLength(2);
      for (const entry of h.entries) {
        const web = h.business.orm
          .select()
          .from(schema.memorySources)
          .where(eq(schema.memorySources.memoryId, entry.id))
          .get()!;
        const turn = h.business.orm
          .select()
          .from(schema.turns)
          .where(eq(schema.turns.id, web.turnId))
          .get()!;
        const user = h.business.orm
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.id, web.userMessageId))
          .get()!;
        const assistant = h.business.orm
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.id, web.assistantMessageId))
          .get()!;
        const qq = sources.find((source) => source.memoryId === entry.id)!;
        const fact = facts.find((item) => item.id === qq.eventKey)!;
        const webPart = [
          "web",
          web.turnId,
          turn.sessionId,
          web.userMessageId,
          web.assistantMessageId,
          web.sequenceNo,
          user.content,
          assistant.content,
        ];
        const qqPart = [
          "qq",
          qq.eventKey,
          qq.scopeKey,
          qq.conversationKey,
          qq.messageId,
          qq.occurredAtSeconds,
          qq.speakerKind,
          qq.speakerId,
          scope,
          fact.sources.map((ref) => [ref.kind, ref.id, ref.revision, ref.expiresAt ?? null]),
        ];
        const ordered = [JSON.stringify(webPart), JSON.stringify(qqPart)].sort();
        const frozenV1 = createHash("sha256")
          .update(
            JSON.stringify(["memory-publication-v1", entry.id, memoryRevision(entry), ordered]),
          )
          .digest("hex");
        expect(batch.get(entry.id)).toBe(frozenV1);
        expect(batch.get(entry.id)).toBe(
          memoryPublicationSourceRevision(h.business.orm, entry, memoryRevision(entry), now),
        );
      }
      h.business.db
        .query(
          "UPDATE qq_message_facts SET expires_at='2020-01-01T00:00:00Z' WHERE event_key=(SELECT event_key FROM qq_memory_sources WHERE memory_id=?)",
        )
        .run(h.entries[0]!.id);
      const after = memoryPublicationSourceRevisions(
        h.business.orm,
        h.entries,
        new Map(h.entries.map((entry) => [entry.id, memoryRevision(entry)])),
        now,
      );
      expect(after.has(h.entries[0]!.id)).toBe(false);
      expect(after.get(h.entries[1]!.id)).toBe(batch.get(h.entries[1]!.id));
    } finally {
      h.business.close();
    }
  });
  it.each([1, 32, 400])("groups QQ authority and source SQL for %i distinct events", (count) => {
    const h = fixture(count);
    try {
      const now = nowIso();
      addQqSources(h, now);
      const db = h.business.db;
      const query = db.query;
      const prepare = db.prepare;
      const statements: string[] = [];
      const wrapped = new WeakSet<object>();
      const trace = (sql: string, statement: ReturnType<typeof db.query>) => {
        if (wrapped.has(statement) || !/^\s*select\b/i.test(sql)) return statement;
        const proxy = new Proxy(statement, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key === "all" || key === "get" || key === "values")
              return (...args: unknown[]) => {
                statements.push(sql.replace(/\s+/g, " ").toLowerCase());
                return Reflect.apply(value, target, args);
              };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        wrapped.add(proxy);
        return proxy;
      };
      db.query = ((sql: string, ...args: unknown[]) =>
        trace(sql, Reflect.apply(query, db, [sql, ...args]))) as typeof db.query;
      db.prepare = ((sql: string, ...args: unknown[]) =>
        trace(sql, Reflect.apply(prepare, db, [sql, ...args]))) as typeof db.prepare;
      try {
        const revisions = new Map(h.entries.map((entry) => [entry.id, memoryRevision(entry)]));
        expect(
          memoryPublicationSourceRevisions(h.business.orm, h.entries, revisions, now).size,
        ).toBe(count);
      } finally {
        db.query = query;
        db.prepare = prepare;
      }
      const loadRows = statements.filter(
        (sql) =>
          sql.includes("from json_each(?) requested join qq_events e") &&
          sql.includes("left join qq_message_facts f") &&
          sql.includes("t.body as body"),
      );
      const projectedEvents = statements.filter(
        (sql) =>
          sql.includes("from json_each(?) requested cross join qq_events e") &&
          sql.includes("e.recorded_at as recordedat"),
      );
      const factStates = statements.filter(
        (sql) =>
          sql.includes("from json_each(?) requested cross join qq_message_facts f") &&
          sql.includes("cross join qq_events e"),
      );
      const journal = statements.filter(
        (sql) =>
          sql.includes("from conversation_events where source_kind='qq_event'") &&
          sql.includes("source_id in (select value from json_each(?))"),
      );
      const bindings = statements.filter(
        (sql) => sql.includes("from qq_bindings") && sql.includes("account_id=?"),
      );
      expect(loadRows.length).toBe(1);
      expect(projectedEvents.length).toBe(1);
      expect(factStates.length).toBe(1);
      expect(journal.length).toBe(1);
      expect(bindings.length).toBe(1);
    } finally {
      h.business.close();
    }
  });
  it("does not convert database failures into invalid entries", () => {
    const h = fixture(1);
    try {
      h.business.db.run("DROP TABLE memory_sources");
      expect(() =>
        memoryPublicationSourceRevisions(
          h.business.orm,
          h.entries,
          new Map(h.entries.map((entry) => [entry.id, memoryRevision(entry)])),
          nowIso(),
        ),
      ).toThrow();
    } finally {
      h.business.close();
    }
  });
});
