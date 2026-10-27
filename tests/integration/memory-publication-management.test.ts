import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../../src/server/app";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { memoryPublicationSourceRevision } from "../../src/server/db/memory-source-repository";
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
import { createAgent } from "../../src/server/services/agent-service";
import { memoryRevision } from "../../src/server/services/memory-revision";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { qqConversationKey, qqMemoryScopeKey } from "../../src/server/services/qq-binding-contract";

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
      expect((await h.set("public", [h.other.id], 1)).status).not.toBe(200);
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
      expect(
        memoryPublicationSourceRevision(h.business.orm, row, memoryRevision(row), nowIso()),
      ).not.toBe(proof);
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
});
