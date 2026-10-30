import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  issueMemoryPublications,
  memoryPublicationSourceRevisions,
  parseMemoryPublication,
  retainedMemoryPublications,
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
import {
  collectQqEntryPublicationSources,
  type PublicationMaterial,
  verifyRetainedQqMaterials,
} from "../../src/server/services/qq-memory-fact-input";
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

function sourceAccessProbe<T extends object>(
  items: readonly T[],
  property: PropertyKey,
  read: () => void,
): T[] {
  return items.map(
    (item) =>
      new Proxy(item, {
        get(target, key, receiver) {
          if (key === property) read();
          return Reflect.get(target, key, receiver);
        },
      }),
  );
}

describe("batch publication proof", () => {
  it("preserves v1 one-entry digest and omits only invalid entries", () => {
    const h = fixture(2);
    try {
      const now = nowIso();
      const singles = h.entries.map((entry) =>
        memoryPublicationSourceRevisions(
          h.business.orm,
          [entry],
          new Map([[entry.id, memoryRevision(entry)]]),
          now,
        ).get(entry.id),
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
      expect(
        memoryPublicationSourceRevisions(
          h.business.orm,
          [h.entries[0]!],
          new Map([[h.entries[0]!.id, memoryRevision(h.entries[0]!)]]),
          now,
        ).has(h.entries[0]!.id),
      ).toBe(false);
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
          memoryPublicationSourceRevisions(
            h.business.orm,
            [entry],
            new Map([[entry.id, memoryRevision(entry)]]),
            now,
          ).get(entry.id),
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
          sql.includes("null as body"),
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
  it("rejects malformed/duplicate descriptors while allowing one event under fact and observation kinds", () => {
    const h = fixture(1);
    try {
      const journal = new ConversationEventRepository(h.business.db);
      const source = h.business.orm
        .select()
        .from(schema.turns)
        .where(eq(schema.turns.id, h.turns[0]!))
        .get()!;
      journal.ensureWeb(source.sessionId, DEFAULT_USER_ID);
      addQqSources(h, nowIso());
      const row = h.entries[0]!,
        encoded = issueMemoryPublications(h.business.orm, [row], nowIso()).get(row.id);
      if (!encoded) throw new Error("issue missing");
      const value = parseMemoryPublication(encoded);
      if (!value || value === "legacy") throw new Error("parse missing");
      expect(value.sources.filter((item) => item.kind !== "web_message")).toHaveLength(2);
      expect(parseMemoryPublication("mempub:v3:" + encoded)).toBeNull();
      expect(
        parseMemoryPublication("mempub:v2:" + JSON.stringify({ ...value, extra: true })),
      ).toBeNull();
      expect(
        parseMemoryPublication(
          "mempub:v2:" +
            JSON.stringify({ ...value, sources: [...value.sources, value.sources[0]] }),
        ),
      ).toBeNull();
      expect(
        parseMemoryPublication(
          "mempub:v2:" + JSON.stringify({ ...value, sources: value.sources.slice(1) }),
        ),
      ).not.toBe("legacy");
      const damaged = {
        ...row,
        publicationSourceRevision:
          "mempub:v2:" + JSON.stringify({ ...value, sources: value.sources.slice(1) }),
      };
      expect(retainedMemoryPublications(h.business.orm, [damaged], nowIso()).has(row.id)).toBe(
        false,
      );
    } finally {
      h.business.close();
    }
  });
  it.each([1, 32, 400])(
    "batches v2 retained verification across %i distinct entries without rereading expired QQ payload",
    (count) => {
      const h = fixture(count);
      try {
        const journal = new ConversationEventRepository(h.business.db);
        const session = h.business.orm
          .select()
          .from(schema.turns)
          .where(eq(schema.turns.id, h.turns[0]!))
          .get()!.sessionId;
        journal.ensureWeb(session, DEFAULT_USER_ID);
        const now = nowIso();
        addQqSources(h, now);
        const issued = issueMemoryPublications(h.business.orm, h.entries, now);
        expect(issued.size).toBe(count);
        const entries = h.entries.map((row) => ({
          ...row,
          publicationSourceRevision: issued.get(row.id)!,
        }));
        const manifests = entries.map((row) =>
          parseMemoryPublication(row.publicationSourceRevision),
        );
        const caps = manifests.flatMap((value) =>
          !value || value === "legacy"
            ? []
            : value.sources.flatMap((item) => (item.own_cap ? [Date.parse(item.own_cap)] : [])),
        );
        const later = new Date(Math.max(...caps) + 1).toISOString();
        const query = h.business.db.query,
          trace: string[] = [];
        h.business.db.query = ((sql: string) => {
          trace.push(sql.replace(/\s+/g, " ").toLowerCase());
          return Reflect.apply(query, h.business.db, [sql]);
        }) as typeof query;
        try {
          expect(retainedMemoryPublications(h.business.orm, entries, later).size).toBe(count);
        } finally {
          h.business.db.query = query;
        }
        expect(
          trace.some((sql) =>
            /\b(?:t\.body|f\.parts|f\.group_card|f\.personal_nickname)\b/.test(sql),
          ),
        ).toBe(false);
        expect(
          trace.filter((sql) =>
            sql.includes("from conversation_events where source_kind='qq_event'"),
          ).length,
        ).toBe(1);
        expect(
          trace.filter((sql) => sql.includes("from qq_bindings") && sql.includes("account_id=?"))
            .length,
        ).toBe(1);
        expect(trace.filter((sql) => sql.includes("f.revision as producerrevision")).length).toBe(
          1,
        );
        // Returned statement count is not visited-row/CPU work. Permanent fact checks still include every source.
      } finally {
        h.business.close();
      }
    },
  );

  it("shares one live source-material read across 400 distinct candidate entries that cite the same QQ event", () => {
    const h = fixture(400);
    try {
      const journal = new ConversationEventRepository(h.business.db),
        firstTurn = h.business.orm
          .select()
          .from(schema.turns)
          .where(eq(schema.turns.id, h.turns[0]!))
          .get()!;
      journal.ensureWeb(firstTurn.sessionId, DEFAULT_USER_ID);
      addQqSources(h, nowIso());
      const first = h.business.orm
        .select()
        .from(schema.qqMemorySources)
        .where(eq(schema.qqMemorySources.memoryId, h.entries[0]!.id))
        .get()!;
      h.business.db.query("DELETE FROM qq_memory_sources").run();
      for (const entry of h.entries)
        h.business.orm
          .insert(schema.qqMemorySources)
          .values({ ...first, memoryId: entry.id })
          .run();
      const issued = issueMemoryPublications(h.business.orm, h.entries, nowIso());
      expect(issued.size).toBe(400);
      const rows = h.entries.map((entry) => ({
        ...entry,
        publicationSourceRevision: issued.get(entry.id)!,
      }));
      const query = h.business.db.query,
        sqls: string[] = [];
      h.business.db.query = ((sql: string) => {
        sqls.push(sql.replace(/\s+/g, " ").toLowerCase());
        return Reflect.apply(query, h.business.db, [sql]);
      }) as typeof query;
      try {
        expect(retainedMemoryPublications(h.business.orm, rows, nowIso()).size).toBe(400);
      } finally {
        h.business.db.query = query;
      }
      expect(sqls.filter((sql) => sql.includes("f.parts as parts")).length).toBe(1);
      expect(
        sqls.filter((sql) => sql.includes("select event_key as id,body from qq_observation_text"))
          .length,
      ).toBe(1);
      expect(
        sqls.filter((sql) => sql.includes("from qq_bindings") && sql.includes("account_id=?"))
          .length,
      ).toBe(1);
    } finally {
      h.business.close();
    }
  });

  it("issues and retains one entry backed by 400 distinct Web/QQ source pairs without an invisible descriptor cap", () => {
    const h = fixture(400);
    try {
      const journal = new ConversationEventRepository(h.business.db),
        turn = h.business.orm
          .select()
          .from(schema.turns)
          .where(eq(schema.turns.id, h.turns[0]!))
          .get()!;
      journal.ensureWeb(turn.sessionId, DEFAULT_USER_ID);
      addQqSources(h, nowIso());
      const first = h.entries[0]!;
      h.business.db.query("UPDATE memory_sources SET memory_id=?").run(first.id);
      h.business.db.query("UPDATE qq_memory_sources SET memory_id=?").run(first.id);
      const carrier = issueMemoryPublications(h.business.orm, [first], nowIso()).get(first.id);
      if (!carrier) throw new Error("400source issue missing");
      const manifest = parseMemoryPublication(carrier);
      if (!manifest || manifest === "legacy") throw new Error("400source manifest missing");
      expect(manifest.sources.filter((material) => material.kind === "web_message")).toHaveLength(
        800,
      );
      expect(
        manifest.sources.filter((material) => material.kind === "qq_message_fact"),
      ).toHaveLength(400);
      expect(
        manifest.sources.filter((material) => material.kind === "qq_observation"),
      ).toHaveLength(400);
      const caps = manifest.sources.flatMap((material) =>
        material.own_cap ? [Date.parse(material.own_cap)] : [],
      );
      expect(
        retainedMemoryPublications(
          h.business.orm,
          [{ ...first, publicationSourceRevision: carrier }],
          new Date(Math.max(...caps) + 1).toISOString(),
        ).has(first.id),
      ).toBe(true);
    } finally {
      h.business.close();
    }
  });
  it.each([1, 32, 400])(
    "indexes %i distinct QQ sources once per call while preserving closure and live/expired material decisions",
    (count) => {
      const h = fixture(count);
      try {
        const journal = new ConversationEventRepository(h.business.db);
        const session = h.business.orm
          .select()
          .from(schema.turns)
          .where(eq(schema.turns.id, h.turns[0]!))
          .get()!.sessionId;
        journal.ensureWeb(session, DEFAULT_USER_ID);
        const now = nowIso();
        addQqSources(h, now);
        const entry = h.entries[0]!;
        h.business.db.query("UPDATE memory_sources SET memory_id=?").run(entry.id);
        h.business.db.query("UPDATE qq_memory_sources SET memory_id=?").run(entry.id);
        const carrier = issueMemoryPublications(h.business.orm, [entry], now).get(entry.id);
        if (!carrier) throw new Error("source-work carrier missing");
        const manifest = parseMemoryPublication(carrier);
        if (!manifest || manifest === "legacy") throw new Error("source-work manifest missing");
        const sources = h.business.orm
          .select()
          .from(schema.qqMemorySources)
          .where(eq(schema.qqMemorySources.memoryId, entry.id))
          .all();
        const input = {
          db: h.business.db,
          orm: h.business.orm,
          now,
          entries: [{ id: entry.id, agentId: entry.agentId, sources }],
        };
        const authority = collectQqEntryPublicationSources(input, true).authority;
        let materialIdReads = 0,
          authorityIdReads = 0;
        const probeMaterials = sourceAccessProbe(manifest.sources, "id", () => {
          materialIdReads++;
        });
        const parts = authority.get(entry.id);
        if (!parts) throw new Error("source-work authority missing");
        const probeAuthority = sourceAccessProbe(parts as object[], "1", () => {
          authorityIdReads++;
        });
        const result = verifyRetainedQqMaterials(
          input,
          new Map([[entry.id, probeMaterials]]),
          new Map([[entry.id, probeAuthority]]),
        );
        expect(result.has(entry.id)).toBe(true);
        // Each actual descriptor is indexed once and its material may be checked/queued;
        // no source repeatedly scans the full material/authority collection.
        expect(materialIdReads).toBeGreaterThan(count);
        expect(materialIdReads).toBeLessThanOrEqual(manifest.sources.length * 8);
        expect(authorityIdReads).toBeGreaterThan(0);
        expect(authorityIdReads).toBeLessThanOrEqual(count * 4);
        const missing = new Map([
          [entry.id, manifest.sources.filter((material) => material.id !== sources[0]!.eventKey)],
        ]);
        expect(verifyRetainedQqMaterials(input, missing, authority).has(entry.id)).toBe(false);
        const invalidAuthority = new Map([[entry.id, parts.slice(1)]]);
        expect(
          verifyRetainedQqMaterials(
            input,
            new Map([[entry.id, manifest.sources]]),
            invalidAuthority,
          ).has(entry.id),
        ).toBe(false);
        const caps = manifest.sources.flatMap((material) =>
          material.own_cap ? [Date.parse(material.own_cap)] : [],
        );
        const afterCap = { ...input, now: new Date(Math.max(...caps) + 1).toISOString() };
        expect(
          verifyRetainedQqMaterials(
            afterCap,
            new Map([[entry.id, manifest.sources]]),
            authority,
          ).has(entry.id),
        ).toBe(true);
      } finally {
        h.business.close();
      }
    },
  );

  it.each([1, 32, 400])(
    "keeps complete retained membership closure scans proportional for %i distinct sources",
    (count) => {
      const h = fixture(count);
      try {
        const journal = new ConversationEventRepository(h.business.db);
        const session = h.business.orm
          .select()
          .from(schema.turns)
          .where(eq(schema.turns.id, h.turns[0]!))
          .get()!.sessionId;
        journal.ensureWeb(session, DEFAULT_USER_ID);
        const now = nowIso();
        addQqSources(h, now);
        const entry = h.entries[0]!;
        h.business.db.query("UPDATE memory_sources SET memory_id=?").run(entry.id);
        h.business.db.query("UPDATE qq_memory_sources SET memory_id=?").run(entry.id);
        const carrier = issueMemoryPublications(h.business.orm, [entry], now).get(entry.id);
        if (!carrier) throw new Error("membership-work carrier missing");
        const manifest = parseMemoryPublication(carrier);
        if (!manifest || manifest === "legacy") throw new Error("membership-work manifest missing");
        const caps = manifest.sources.flatMap((material) =>
          material.own_cap ? [Date.parse(material.own_cap)] : [],
        );
        const later = new Date(Math.max(...caps) + 1).toISOString();
        const originalSome = Array.prototype.some;
        let actualDescriptorVisits = 0,
          actualDescriptorScans = 0;
        Array.prototype.some = function <T>(
          this: T[],
          callback: (value: T, index: number, array: T[]) => unknown,
          thisArg?: unknown,
        ): boolean {
          const first = this[0] as { own_cap?: unknown; consumable_cap?: unknown } | undefined;
          const materials =
            this.length === manifest.sources.length &&
            first !== undefined &&
            typeof first === "object" &&
            first !== null &&
            Object.hasOwn(first, "own_cap") &&
            Object.hasOwn(first, "consumable_cap");
          if (materials) actualDescriptorScans++;
          return originalSome.call(this, (value: T, index: number, array: T[]) => {
            if (materials) actualDescriptorVisits++;
            return callback.call(thisArg, value, index, array);
          });
        };
        try {
          expect(
            retainedMemoryPublications(
              h.business.orm,
              [{ ...entry, publicationSourceRevision: carrier }],
              later,
            ).has(entry.id),
          ).toBe(true);
        } finally {
          Array.prototype.some = originalSome;
        }
        expect(actualDescriptorScans).toBeGreaterThan(0);
        expect(actualDescriptorVisits).toBeGreaterThan(0);
        expect(actualDescriptorVisits).toBeLessThanOrEqual(manifest.sources.length * 4);
        // Canonical sorting, hashing and serialization are deliberately outside this
        // membership-scan count; no linear total CPU or timing claim follows.
      } finally {
        h.business.close();
      }
    },
  );

  it.each([
    { entries: 1, sources: 400 },
    { entries: 32, sources: 32 },
    { entries: 400, sources: 1 },
  ])(
    "preserves current material results with $entries entries × $sources distinct shared QQ sources and one-pass per-entry indexes",
    ({ entries: entryCount, sources: sourceCount }) => {
      const h = fixture(Math.max(entryCount, sourceCount));
      try {
        const journal = new ConversationEventRepository(h.business.db);
        const session = h.business.orm
          .select()
          .from(schema.turns)
          .where(eq(schema.turns.id, h.turns[0]!))
          .get()!.sessionId;
        journal.ensureWeb(session, DEFAULT_USER_ID);
        const now = nowIso();
        addQqSources(h, now);
        const templates = h.business.orm
          .select()
          .from(schema.qqMemorySources)
          .all()
          .slice(0, sourceCount);
        const selected = h.entries.slice(0, entryCount);
        h.business.db.query("DELETE FROM qq_memory_sources").run();
        for (const entry of selected)
          for (const source of templates)
            h.business.orm
              .insert(schema.qqMemorySources)
              .values({ ...source, memoryId: entry.id })
              .run();
        const issued = issueMemoryPublications(h.business.orm, selected, now);
        expect(issued.size).toBe(entryCount);
        const rows = selected.map((entry) => ({
          ...entry,
          publicationSourceRevision: issued.get(entry.id)!,
        }));
        expect(retainedMemoryPublications(h.business.orm, rows, now).size).toBe(entryCount);
        const input = {
          db: h.business.db,
          orm: h.business.orm,
          now,
          entries: rows.map((entry) => ({
            id: entry.id,
            agentId: entry.agentId,
            sources: h.business.orm
              .select()
              .from(schema.qqMemorySources)
              .where(eq(schema.qqMemorySources.memoryId, entry.id))
              .all(),
          })),
        };
        const authority = collectQqEntryPublicationSources(input, true).authority;
        let descriptorIds = 0,
          authorityIds = 0,
          totalDescriptors = 0;
        const materialMap = new Map<string, PublicationMaterial[]>();
        const authorityMap = new Map<string, unknown[]>();
        for (const row of rows) {
          const parsed = parseMemoryPublication(row.publicationSourceRevision);
          if (!parsed || parsed === "legacy") throw new Error("combination basis missing");
          totalDescriptors += parsed.sources.length;
          materialMap.set(
            row.id,
            sourceAccessProbe(parsed.sources, "id", () => {
              descriptorIds++;
            }),
          );
          const parts = authority.get(row.id);
          if (!parts) throw new Error("combination authority missing");
          authorityMap.set(
            row.id,
            sourceAccessProbe(parts as object[], "1", () => {
              authorityIds++;
            }),
          );
        }
        expect(verifyRetainedQqMaterials(input, materialMap, authorityMap).size).toBe(entryCount);
        expect(descriptorIds).toBeGreaterThan(0);
        expect(descriptorIds).toBeLessThanOrEqual(totalDescriptors * 8);
        expect(authorityIds).toBeGreaterThan(0);
        expect(authorityIds).toBeLessThanOrEqual(entryCount * sourceCount * 4);
      } finally {
        h.business.close();
      }
    },
  );
});
