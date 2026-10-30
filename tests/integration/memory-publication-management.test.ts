import { describe, expect, it, setSystemTime } from "bun:test";
import { eq } from "drizzle-orm";
import { sourceAccess } from "../../src/server/agent/context-access";
import { createApp } from "../../src/server/app";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
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
import { SqliteMemoryModule } from "../../src/server/modules/memory-module";
import { createAgent, getAgentRowById } from "../../src/server/services/agent-service";
import { memoryRevision } from "../../src/server/services/memory-revision";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { qqConversationKey, qqMemoryScopeKey } from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "synthetic");
  const persona = {
    core_identity: "",
    communication_style: "",
    interaction_boundaries: "",
    example_dialogues: "",
    advanced_instructions: "",
  };
  const other = createAgent(business.orm, { name: "other", model_name: "synthetic" }, persona);
  const session = createSession(business.orm, "synthetic", { modelName: "synthetic" });
  const request = crypto.randomUUID();
  const prepared = prepareTurn(business.orm, session.id, "synthetic question", request);
  saveCompletedAssistantMessage(
    business.orm,
    session.id,
    "synthetic answer",
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
  business.orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: "memory",
      summary: "summary",
      tags: "[]",
      kinds: '["semantic"]',
      body: "body",
      scope: "reality_user",
      scopeKey: DEFAULT_AGENT_ID,
      status: "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
      visibility: "session_private",
    })
    .run();
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
  const app = createApp({ business, externalActions: () => [] });
  const base = `/agents/${DEFAULT_AGENT_ID}/memory`;
  const send = (url: string, method: string, body: unknown) =>
    app.request(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const set = (visibility: string, recipients: string[], revision: number) =>
    send(`${base}/entries/${id}/visibility`, "PUT", {
      expected_revision: revision,
      visibility,
      recipient_agent_ids: recipients,
    });
  const grants = () =>
    business.orm
      .select()
      .from(schema.memoryReadGrants)
      .where(eq(schema.memoryReadGrants.memoryId, id))
      .all();
  return { business, app, base, id, other, turn, set, grants, send };
}

function addQqSource(h: ReturnType<typeof setup>) {
  const now = nowIso();
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
  const conversation = journal.ensureOneBot(bindingId);
  if (!conversation) throw new Error("missing QQ conversation");
  const result = normalizeOneBotMessage(
    {
      time: Math.floor(Date.now() / 1000),
      self_id: 90001,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: 102,
      user_id: 20002,
      group_id: 30003,
      sender: { card: "synthetic", nickname: "synthetic" },
      message: [{ type: "text", data: { text: "synthetic QQ source" } }],
    },
    "90001",
  );
  if (result.kind !== "message") throw new Error("invalid fixture");
  recordObservation(h.business.orm, result.observation, DEFAULT_AGENT_ID);
  journal.ingestOneBotEvent(result.observation.eventKey, bindingId);
  const scopeKey = qqMemoryScopeKey({
    kind: "qq",
    accountId: "90001",
    conversationKind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
  });
  h.business.orm
    .insert(schema.qqMemorySources)
    .values({
      memoryId: h.id,
      eventKey: result.observation.eventKey,
      scopeKey,
      conversationKey: qqConversationKey({ accountId: "90001", kind: "group", peerId: "30003" }),
      messageId: result.observation.messageId,
      occurredAtSeconds: result.observation.occurredAtSeconds,
      speakerKind: "member",
      speakerId: "20002",
    })
    .run();
  return { key: result.observation.eventKey, bindingId, conversationId: conversation.id };
}

describe("memory publication management", () => {
  it("publishes explicit recipients with CAS and preserves no-op tokens", async () => {
    const h = setup();
    try {
      expect((await h.set("agent_shared", [DEFAULT_AGENT_ID], 1)).status).toBe(200);
      const initial = h.grants();
      expect(initial).toHaveLength(1);
      expect((await h.set("agent_shared", [DEFAULT_AGENT_ID], 2)).status).toBe(200);
      expect(h.grants()).toEqual(initial);
      expect((await h.set("public", [h.other.id], 1)).status).toBe(409);
      expect(h.grants()).toEqual(initial);
      expect((await h.set("public", [h.other.id], 2)).status).toBe(200);
      expect(h.grants().map((item) => item.agentId)).toEqual([h.other.id]);
      expect((await h.set("public", [], 3)).status).not.toBe(200);
    } finally {
      h.business.close();
    }
  });
  it("revoke and regrant mint a fresh token", async () => {
    const h = setup();
    try {
      expect((await h.set("public", [h.other.id], 1)).status).toBe(200);
      const token = h.grants()[0]!.token;
      expect((await h.set("session_private", [], 2)).status).toBe(200);
      expect(h.grants()).toEqual([]);
      expect((await h.set("public", [h.other.id], 3)).status).toBe(200);
      expect(h.grants()[0]!.token).not.toBe(token);
    } finally {
      h.business.close();
    }
  });
  it("rejects invalid and missing source sets without writes", async () => {
    const h = setup();
    try {
      h.business.db.query("UPDATE turns SET source_valid=0 WHERE id=?").run(h.turn.id);
      const invalid = await h.set("public", [h.other.id], 1);
      expect(invalid.status).toBe(409);
      expect((await invalid.json()).error.code).toBe("MEMORY_SOURCE_INVALID");
      expect(h.grants()).toEqual([]);
      h.business.db.query("DELETE FROM memory_sources WHERE memory_id=?").run(h.id);
      expect((await h.set("public", [h.other.id], 1)).status).not.toBe(200);
      expect(h.grants()).toEqual([]);
    } finally {
      h.business.close();
    }
  });
  it("does not let an intact Web source hide an invalid QQ source", async () => {
    const h = setup();
    try {
      const key = crypto.randomUUID();
      h.business.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: key,
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
          messageId: "message",
          occurredAtSeconds: 1,
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: nowIso(),
        })
        .run();
      h.business.orm
        .insert(schema.qqMemorySources)
        .values({
          memoryId: h.id,
          eventKey: key,
          scopeKey: JSON.stringify(["qq", "90001", "group", "30003", DEFAULT_AGENT_ID]),
          conversationKey: JSON.stringify(["qq", "90001", "group", "30003"]),
          messageId: "message",
          occurredAtSeconds: 1,
          speakerKind: "member",
          speakerId: "20002",
        })
        .run();
      expect((await h.set("public", [h.other.id], 1)).status).not.toBe(200);
      expect(h.grants()).toEqual([]);
    } finally {
      h.business.close();
    }
  });
  it("publishes valid mixed QQ source and binds current authority in the proof", async () => {
    const h = setup();
    try {
      const qq = addQqSource(h);
      expect((await h.set("public", [h.other.id], 1)).status).toBe(200);
      const row = h.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, h.id))
        .get()!;
      const proof = row.publicationSourceRevision;
      expect(proof).toBeTruthy();
      // Synthetic authority change follows the persisted revision constraint.
      h.business.db
        .query(
          "UPDATE qq_bindings SET revision=revision+1, authority_revision=authority_revision+1 WHERE id=?",
        )
        .run(qq.bindingId);
      expect(proof?.startsWith("mempub:v2:")).toBe(true);
      expect(retainedMemoryPublications(h.business.orm, [row], nowIso()).has(h.id)).toBe(false);
    } finally {
      h.business.close();
    }
  });
  it.each(["body", "fact"] as const)("rejects expired QQ %s source", async (kind) => {
    const h = setup();
    try {
      const qq = addQqSource(h);
      const table = kind === "body" ? "qq_observation_text" : "qq_message_facts";
      h.business.db
        .query(`UPDATE ${table} SET expires_at='2020-01-01T00:00:00Z' WHERE event_key=?`)
        .run(qq.key);
      expect((await h.set("public", [h.other.id], 1)).status).not.toBe(200);
      expect(h.grants()).toEqual([]);
    } finally {
      h.business.close();
    }
  });
  it("rejects a foreign event even if it is linked into the current journal", async () => {
    const h = setup();
    try {
      const qq = addQqSource(h);
      h.business.db
        .query("UPDATE qq_events SET peer_id='other-peer' WHERE event_key=?")
        .run(qq.key);
      h.business.db.query("DELETE FROM qq_message_facts WHERE event_key=?").run(qq.key);
      expect((await h.set("public", [h.other.id], 1)).status).not.toBe(200);
      expect(h.grants()).toEqual([]);
    } finally {
      h.business.close();
    }
  });
  it("rejects an event associated with more than one canonical epoch", async () => {
    const h = setup();
    try {
      const qq = addQqSource(h);
      const nextId = crypto.randomUUID();
      h.business.db
        .query(`INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,created_at,updated_at,closed_at)
        SELECT ?,channel,topology,source_id,agent_id,user_id,binding_epoch+1,created_at,updated_at,'closed' FROM conversations WHERE id=?`)
        .run(nextId, qq.conversationId);
      h.business.db
        .query(`INSERT INTO conversation_events(conversation_id,seq,event_key,kind,source_kind,source_id,source_revision,source_expires_at,sources,participant,addressing,occurred_at,recorded_at,run_id,output_id)
        SELECT ?,seq,event_key,kind,source_kind,source_id,source_revision,source_expires_at,sources,participant,addressing,occurred_at,recorded_at,run_id,output_id
        FROM conversation_events WHERE conversation_id=? AND source_kind='qq_event' AND source_id=?`)
        .run(nextId, qq.conversationId, qq.key);
      expect((await h.set("public", [h.other.id], 1)).status).not.toBe(200);
      expect(h.grants()).toEqual([]);
    } finally {
      h.business.close();
    }
  });
  it("keeps first entry success when a second entry conflicts", async () => {
    const h = setup();
    try {
      const second = crypto.randomUUID();
      const original = h.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, h.id))
        .get()!;
      h.business.orm
        .insert(schema.memoryEntries)
        .values({ ...original, id: second })
        .run();
      const source = h.business.orm
        .select()
        .from(schema.memorySources)
        .where(eq(schema.memorySources.memoryId, h.id))
        .get()!;
      h.business.orm
        .insert(schema.memorySources)
        .values({ ...source, memoryId: second })
        .run();
      expect((await h.set("public", [h.other.id], 1)).status).toBe(200);
      const res = await h.send(`${h.base}/entries/${second}/visibility`, "PUT", {
        expected_revision: 2,
        visibility: "public",
        recipient_agent_ids: [h.other.id],
      });
      expect(res.status).toBe(409);
      expect(h.grants()).toHaveLength(1);
      expect(
        h.business.orm
          .select()
          .from(schema.memoryReadGrants)
          .where(eq(schema.memoryReadGrants.memoryId, second))
          .all(),
      ).toEqual([]);
    } finally {
      h.business.close();
    }
  });
  it("correction of published memory creates a private replacement", async () => {
    const h = setup();
    try {
      expect((await h.set("public", [h.other.id], 1)).status).toBe(200);
      const row = h.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, h.id))
        .get()!;
      const res = await h.send(`${h.base}/entries/${h.id}/correct`, "POST", {
        expected_revision: memoryRevision(row),
        name: "corrected",
        summary: "corrected",
        tags: [],
        body: "corrected body",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { content: { id: string } };
      const replacement = h.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, body.content.id))
        .get()!;
      expect(replacement.visibility).toBe("session_private");
      expect(replacement.publicationSourceRevision).toBeNull();
      expect(
        h.business.orm
          .select()
          .from(schema.memoryReadGrants)
          .where(eq(schema.memoryReadGrants.memoryId, replacement.id))
          .all(),
      ).toEqual([]);
    } finally {
      h.business.close();
    }
  });
  it("rebuilds one explicit page without changing content or sources", async () => {
    const h = setup();
    try {
      h.business.db
        .query("UPDATE memory_entries SET folded_search=NULL,fold_version=NULL WHERE id=?")
        .run(h.id);
      const before = h.business.db
        .query("SELECT body,config_snapshot FROM memory_entries WHERE id=?")
        .get(h.id);
      const res = await h.send(`${h.base}/search-projection/rebuild`, "POST", { limit: 1 });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ rebuilt: 1, next_after_id: null });
      expect(
        h.business.db.query("SELECT body,config_snapshot FROM memory_entries WHERE id=?").get(h.id),
      ).toEqual(before);
      expect(
        h.business.db
          .query("SELECT folded_search,fold_version FROM memory_entries WHERE id=?")
          .get(h.id),
      ).toMatchObject({ fold_version: 1 });
      expect(
        (await h.send(`${h.base}/search-projection/rebuild`, "POST", { limit: 301 })).status,
      ).toBe(422);
    } finally {
      h.business.close();
    }
  });
  it("issues a strict v2 basis and retains authorized derived reads after each captured cap without expired payload reads", async () => {
    const h = setup();
    try {
      const qq = addQqSource(h);
      expect((await h.set("public", [h.other.id], 1)).status).toBe(200);
      const row = h.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, h.id))
        .get()!;
      const carrier = row.publicationSourceRevision;
      if (carrier === null) throw new Error("missing publication carrier");
      const parsed = parseMemoryPublication(carrier);
      if (!parsed || parsed === "legacy") throw new Error("missing v2 basis");
      expect(
        parsed.sources
          .filter((item) => item.id === qq.key)
          .map((item) => item.kind)
          .sort(),
      ).toEqual(["qq_message_fact", "qq_observation"]);
      expect(parsed.sources.some((item) => item.kind === "web_message")).toBe(true);
      expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
      const caps = parsed.sources.flatMap((item) =>
        item.own_cap ? [Date.parse(item.own_cap)] : [],
      );
      const retainedNow = new Date(Math.max(...caps) + 1).toISOString();
      const query = h.business.db.query,
        statements: string[] = [];
      h.business.db.query = ((sql: string) => {
        statements.push(sql);
        return Reflect.apply(query, h.business.db, [sql]);
      }) as typeof query;
      try {
        expect(retainedMemoryPublications(h.business.orm, [row], retainedNow).get(h.id)).toBe(
          carrier,
        );
      } finally {
        h.business.db.query = query;
      }
      expect(
        statements.some((sql) =>
          /(?:t\.body\b|f\.parts\b|f\.group_card\b|f\.personal_nickname\b)/.test(sql),
        ),
      ).toBe(false);
      h.business.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(qq.key);
      h.business.db.query("DELETE FROM qq_message_facts WHERE event_key=?").run(qq.key);
      expect(retainedMemoryPublications(h.business.orm, [row], retainedNow).has(h.id)).toBe(true);
      h.business.db
        .query("UPDATE qq_events SET speaker_id=? WHERE event_key=?")
        .run("wrong", qq.key);
      expect(retainedMemoryPublications(h.business.orm, [row], retainedNow).has(h.id)).toBe(false);
    } finally {
      h.business.close();
    }
  });
  it("keeps captured own caps independent, rejects early missing/shortening, and never extends captured read authority", async () => {
    const h = setup();
    try {
      const qq = addQqSource(h),
        now = nowIso();
      const rawCap = new Date(Date.parse(now) + 10000).toISOString(),
        factCap = new Date(Date.parse(now) + 20000).toISOString();
      h.business.db
        .query("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?")
        .run(rawCap, qq.key);
      h.business.db
        .query("UPDATE qq_message_facts SET expires_at=? WHERE event_key=?")
        .run(factCap, qq.key);
      expect((await h.set("public", [h.other.id], 1)).status).toBe(200);
      const row = h.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, h.id))
        .get()!;
      const manifest = parseMemoryPublication(row.publicationSourceRevision);
      if (!manifest || manifest === "legacy") throw new Error("no v2");
      const raw = manifest.sources.find((item) => item.kind === "qq_observation")!,
        fact = manifest.sources.find((item) => item.kind === "qq_message_fact")!;
      expect(raw.own_cap).toBe(rawCap);
      expect(fact.own_cap).toBe(factCap);
      expect(fact.consumable_cap).toBe(rawCap);
      const between = new Date(Date.parse(rawCap) + 1).toISOString();
      h.business.db
        .query("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?")
        .run(new Date(Date.parse(factCap) + 10000).toISOString(), qq.key);
      const query = h.business.db.query,
        sqls: string[] = [];
      h.business.db.query = ((sql: string) => {
        sqls.push(sql);
        return Reflect.apply(query, h.business.db, [sql]);
      }) as typeof query;
      try {
        expect(retainedMemoryPublications(h.business.orm, [row], between).has(h.id)).toBe(true);
      } finally {
        h.business.db.query = query;
      }
      expect(
        sqls.some((sql) =>
          /(?:t\.body\b|f\.parts\b|f\.group_card\b|f\.personal_nickname\b|SELECT\s+(?:event_key\s+AS\s+id,)?body\b)/i.test(
            sql,
          ),
        ),
      ).toBe(false);
      h.business.db
        .query("UPDATE qq_message_facts SET revision=revision+1 WHERE event_key=?")
        .run(qq.key);
      expect(retainedMemoryPublications(h.business.orm, [row], between).has(h.id)).toBe(false);
      h.business.db
        .query("UPDATE qq_message_facts SET revision=revision-1,expires_at=? WHERE event_key=?")
        .run(new Date(Date.parse(now) - 1).toISOString(), qq.key);
      expect(retainedMemoryPublications(h.business.orm, [row], between).has(h.id)).toBe(false);
    } finally {
      h.business.close();
    }
  });
  it("allows suppressed or bad-basis subset/private revocation without blessing remaining readers", async () => {
    const h = setup();
    try {
      expect((await h.set("public", [h.other.id, DEFAULT_AGENT_ID], 1)).status).toBe(200);
      const before = h.grants();
      h.business.db
        .query(
          "UPDATE memory_entries SET publication_source_revision='broken',status='suppressed' WHERE id=?",
        )
        .run(h.id);
      expect((await h.set("public", [h.other.id], 2)).status).toBe(200);
      expect(h.grants()).toHaveLength(1);
      expect(h.grants()[0]!.token).toBe(
        before.find((grant) => grant.agentId === h.other.id)!.token,
      );
      const row = h.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, h.id))
        .get()!;
      expect(row.publicationSourceRevision).toBe("broken");
      expect(retainedMemoryPublications(h.business.orm, [row], nowIso()).has(h.id)).toBe(false);
      expect((await h.set("session_private", [], 3)).status).toBe(200);
      expect(h.grants()).toEqual([]);
    } finally {
      h.business.close();
    }
  });
  it("never upgrades v1 on read and explicitly revalidates a clean same-reader basis with CAS/token rotation", async () => {
    const h = setup();
    try {
      expect((await h.set("public", [h.other.id], 1)).status).toBe(200);
      let row = h.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, h.id))
        .get()!;
      const legacy = memoryPublicationSourceRevisions(
        h.business.orm,
        [row],
        new Map([[row.id, memoryRevision(row)]]),
        nowIso(),
      ).get(row.id);
      if (legacy === undefined) throw new Error("missing legacy publication proof");
      h.business.db
        .query("UPDATE memory_entries SET publication_source_revision=? WHERE id=?")
        .run(legacy, h.id);
      row = { ...row, publicationSourceRevision: legacy };
      const tokens = h.grants();
      const session = createSession(h.business.orm, "legacy recipient", {
        agentId: h.other.id,
        modelName: "synthetic",
      });
      const journal = new ConversationEventRepository(h.business.db),
        conversation = journal.ensureWeb(session.id, DEFAULT_USER_ID)!;
      journal.setMemoryReadMode(conversation.id, DEFAULT_USER_ID, "agent_shared", 1);
      const owner = {
        kind: "conversation",
        id: conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: h.other.id,
      };
      const module = new SqliteMemoryModule({
        orm: h.business.orm,
        runtime: () => runtimeFromAgent(getAgentRowById(h.business.orm, h.other.id)),
      });
      const beforeQuery = await module.query({
        agentId: h.other.id,
        conversationId: conversation.id,
        scopes: null,
        query: "",
        budget: 65536,
        owner,
      });
      const beforeRef = beforeQuery.items.find((item) => item.id === h.id)?.sources[0];
      if (!beforeRef) throw new Error("legacy ref missing");
      expect(retainedMemoryPublications(h.business.orm, [row], nowIso()).has(h.id)).toBe(true);
      expect(
        h.business.orm
          .select()
          .from(schema.memoryEntries)
          .where(eq(schema.memoryEntries.id, h.id))
          .get()!.publicationSourceRevision,
      ).toBe(legacy);
      const result = await h.send(`${h.base}/entries/${h.id}/visibility`, "PUT", {
        expected_revision: 2,
        visibility: "public",
        recipient_agent_ids: [h.other.id],
        revalidate_publication: true,
      });
      expect(result.status).toBe(200);
      const upgraded = h.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, h.id))
        .get()!;
      expect(upgraded.visibilityRevision).toBe(3);
      expect(upgraded.publicationSourceRevision).toStartWith("mempub:v2:");
      expect(h.grants()[0]!.token).not.toBe(tokens[0]!.token);
      expect(
        sourceAccess(h.business.db, beforeRef, owner, { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("revoked");
      const unchanged = h.grants();
      expect((await h.set("public", [h.other.id], 3)).status).toBe(200);
      expect(h.grants()).toEqual(unchanged);
    } finally {
      h.business.close();
    }
  });

  it("reads v2 through the module/current ref after retention and rejects new readers, revalidation and mode ABA", async () => {
    const h = setup();
    try {
      const qq = addQqSource(h),
        now = nowIso(),
        cap = new Date(Date.parse(now) + 1000).toISOString();
      h.business.db
        .query("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?")
        .run(cap, qq.key);
      h.business.db
        .query("UPDATE qq_message_facts SET expires_at=? WHERE event_key=?")
        .run(cap, qq.key);
      expect((await h.set("public", [h.other.id], 1)).status).toBe(200);
      const session = createSession(h.business.orm, "recipient", {
        agentId: h.other.id,
        modelName: "synthetic",
      });
      const journal = new ConversationEventRepository(h.business.db),
        conversation = journal.ensureWeb(session.id, DEFAULT_USER_ID)!;
      journal.setMemoryReadMode(conversation.id, DEFAULT_USER_ID, "agent_shared", 1);
      const owner = {
        kind: "conversation",
        id: conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: h.other.id,
      };
      const module = new SqliteMemoryModule({
        orm: h.business.orm,
        runtime: () => runtimeFromAgent(getAgentRowById(h.business.orm, h.other.id)),
      });
      const input = {
        agentId: h.other.id,
        conversationId: conversation.id,
        scopes: null,
        query: "",
        budget: 65536,
        owner,
      };
      const first = await module.query(input),
        item = first.items.find((entry) => entry.id === h.id);
      if (!item) throw new Error("public v2 query missing");
      setSystemTime(new Date(Date.parse(cap) + 1));
      expect((await module.read({ ...input, evidence: item, offset: 0, limit: 4096 })).text).toBe(
        "body",
      );
      expect(
        sourceAccess(h.business.db, item.sources[0]!, owner, { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("available");
      const tokens = h.grants(),
        row = h.business.orm
          .select()
          .from(schema.memoryEntries)
          .where(eq(schema.memoryEntries.id, h.id))
          .get()!;
      expect((await h.set("public", [h.other.id], 2)).status).toBe(200);
      expect(h.grants()).toEqual(tokens);
      expect(
        (
          await h.send(`${h.base}/entries/${h.id}/visibility`, "PUT", {
            expected_revision: 2,
            visibility: "public",
            recipient_agent_ids: [h.other.id],
            revalidate_publication: true,
          })
        ).status,
      ).toBe(409);
      expect((await h.set("public", [h.other.id, DEFAULT_AGENT_ID], 2)).status).toBe(409);
      expect(h.grants()).toEqual(tokens);
      expect(
        h.business.orm
          .select()
          .from(schema.memoryEntries)
          .where(eq(schema.memoryEntries.id, h.id))
          .get()!.publicationSourceRevision,
      ).toBe(row.publicationSourceRevision);
      journal.setMemoryReadMode(conversation.id, DEFAULT_USER_ID, "current_conversation", 2);
      journal.setMemoryReadMode(conversation.id, DEFAULT_USER_ID, "agent_shared", 3);
      expect(
        sourceAccess(h.business.db, item.sources[0]!, owner, { userId: DEFAULT_USER_ID }, nowIso()),
      ).toBe("revoked");
    } finally {
      setSystemTime();
      h.business.close();
    }
  });

  it("preserves surviving tokens on public-to-owner-only contraction even with malformed basis and refuses identical invalid saves", async () => {
    const h = setup();
    try {
      expect((await h.set("public", [DEFAULT_AGENT_ID, h.other.id], 1)).status).toBe(200);
      const ownerToken = h.grants().find((grant) => grant.agentId === DEFAULT_AGENT_ID)!.token;
      h.business.db
        .query("UPDATE memory_entries SET publication_source_revision='mempub:v2:bad' WHERE id=?")
        .run(h.id);
      expect((await h.set("public", [DEFAULT_AGENT_ID, h.other.id], 2)).status).toBe(409);
      expect((await h.set("agent_shared", [DEFAULT_AGENT_ID], 2)).status).toBe(200);
      expect(h.grants()).toHaveLength(1);
      expect(h.grants()[0]!.token).toBe(ownerToken);
      const row = h.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, h.id))
        .get()!;
      expect(row.publicationSourceRevision).toBe("mempub:v2:bad");
      expect(retainedMemoryPublications(h.business.orm, [row], nowIso()).has(h.id)).toBe(false);
    } finally {
      h.business.close();
    }
  });

  it("rejects missing material before captured own cap and cannot upgrade an expired legacy v1 basis", async () => {
    const h = setup();
    try {
      const qq = addQqSource(h);
      expect((await h.set("public", [h.other.id], 1)).status).toBe(200);
      const row = h.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, h.id))
        .get()!;
      const legacy = memoryPublicationSourceRevisions(
        h.business.orm,
        [row],
        new Map([[row.id, memoryRevision(row)]]),
        nowIso(),
      ).get(row.id);
      if (legacy === undefined) throw new Error("missing legacy publication proof");
      h.business.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(qq.key);
      expect(retainedMemoryPublications(h.business.orm, [row], nowIso()).has(h.id)).toBe(false);
      h.business.db
        .query("UPDATE memory_entries SET publication_source_revision=? WHERE id=?")
        .run(legacy, h.id);
      const grants = h.grants();
      expect(
        retainedMemoryPublications(
          h.business.orm,
          [{ ...row, publicationSourceRevision: legacy }],
          nowIso(),
        ).has(h.id),
      ).toBe(false);
      expect(
        (
          await h.send(`${h.base}/entries/${h.id}/visibility`, "PUT", {
            expected_revision: 2,
            visibility: "public",
            recipient_agent_ids: [h.other.id],
            revalidate_publication: true,
          })
        ).status,
      ).toBe(409);
      expect(h.grants()).toEqual(grants);
      expect(
        h.business.orm
          .select()
          .from(schema.memoryEntries)
          .where(eq(schema.memoryEntries.id, h.id))
          .get()!.publicationSourceRevision,
      ).toBe(legacy);
    } finally {
      h.business.close();
    }
  });

  it("rejects a currently shortened raw cap before the captured cap without fetching its expired payload", async () => {
    const h = setup();
    try {
      const qq = addQqSource(h);
      expect((await h.set("public", [h.other.id], 1)).status).toBe(200);
      const row = h.business.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, h.id))
        .get()!;
      h.business.db
        .query("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?")
        .run("2000-01-01T00:00:00.000Z", qq.key);
      const query = h.business.db.query,
        statements: string[] = [];
      h.business.db.query = ((sql: string) => {
        statements.push(sql);
        return Reflect.apply(query, h.business.db, [sql]);
      }) as typeof query;
      try {
        expect(retainedMemoryPublications(h.business.orm, [row], nowIso()).has(h.id)).toBe(false);
      } finally {
        h.business.db.query = query;
      }
      expect(
        statements.some((sql) =>
          /(?:t\.body\b|f\.parts\b|f\.group_card\b|SELECT\s+(?:event_key\s+AS\s+id,)?body\b)/i.test(
            sql,
          ),
        ),
      ).toBe(false);
    } finally {
      h.business.close();
    }
  });
  it("keeps module and source keeper aligned for exact Web turn and conversation owners without allowing a foreign turn or grant ABA", async () => {
    const h = setup();
    try {
      expect((await h.set("public", [h.other.id], 1)).status).toBe(200);
      const session = createSession(h.business.orm, "recipient exact owner", {
        agentId: h.other.id,
        modelName: "synthetic",
      });
      const prepared = prepareTurn(h.business.orm, session.id, "current", "recipient-turn");
      const turn = getTurnByRequest(h.business.orm, session.id, "recipient-turn")!;
      if (!prepared.generationToken) throw new Error("current turn missing generation");
      const journal = new ConversationEventRepository(h.business.db);
      const conversation = journal.ensureWeb(session.id, DEFAULT_USER_ID)!;
      journal.setMemoryReadMode(conversation.id, DEFAULT_USER_ID, "agent_shared", 1);
      const module = new SqliteMemoryModule({
        orm: h.business.orm,
        runtime: () => runtimeFromAgent(getAgentRowById(h.business.orm, h.other.id)),
      });
      const turnOwner = {
        kind: "web_turn",
        id: turn.id,
        userId: DEFAULT_USER_ID,
        agentId: h.other.id,
      };
      const input = {
        agentId: h.other.id,
        conversationId: conversation.id,
        sessionId: session.id,
        scopes: null,
        query: "",
        budget: 65536,
        owner: turnOwner,
      };
      const page = await module.query(input);
      const item = page.items.find((entry) => entry.id === h.id);
      if (!item) throw new Error("turn-scoped public item missing");
      expect((await module.read({ ...input, evidence: item, offset: 0, limit: 4096 })).text).toBe(
        "body",
      );
      expect(
        sourceAccess(
          h.business.db,
          item.sources[0]!,
          turnOwner,
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      const conversationOwner = {
        kind: "conversation",
        id: conversation.id,
        userId: DEFAULT_USER_ID,
        agentId: h.other.id,
      };
      const conversationInput = { ...input, sessionId: undefined, owner: conversationOwner };
      const conversationPage = await module.query(conversationInput);
      const conversationItem = conversationPage.items.find((entry) => entry.id === h.id);
      if (!conversationItem) throw new Error("conversation-scoped public item missing");
      expect(
        (
          await module.read({
            ...conversationInput,
            evidence: conversationItem,
            offset: 0,
            limit: 4096,
          })
        ).text,
      ).toBe("body");
      expect(
        sourceAccess(
          h.business.db,
          conversationItem.sources[0]!,
          conversationOwner,
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("available");
      const foreignSession = createSession(h.business.orm, "foreign turn session", {
        agentId: h.other.id,
        modelName: "synthetic",
      });
      prepareTurn(h.business.orm, foreignSession.id, "foreign", "foreign-turn");
      const foreignTurn = getTurnByRequest(h.business.orm, foreignSession.id, "foreign-turn")!;
      expect(
        sourceAccess(
          h.business.db,
          item.sources[0]!,
          { ...turnOwner, id: foreignTurn.id },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        sourceAccess(
          h.business.db,
          item.sources[0]!,
          { ...turnOwner, agentId: DEFAULT_AGENT_ID },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        sourceAccess(
          h.business.db,
          conversationItem.sources[0]!,
          { ...conversationOwner, id: foreignSession.id },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        sourceAccess(
          h.business.db,
          conversationItem.sources[0]!,
          { ...conversationOwner, kind: "unsupported" },
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      expect((await h.set("session_private", [], 2)).status).toBe(200);
      expect((await h.set("public", [h.other.id], 3)).status).toBe(200);
      expect(
        sourceAccess(
          h.business.db,
          item.sources[0]!,
          turnOwner,
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        sourceAccess(
          h.business.db,
          conversationItem.sources[0]!,
          conversationOwner,
          { userId: DEFAULT_USER_ID },
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      h.business.close();
    }
  });
});
