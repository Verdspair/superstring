// T13 Step6：既有 `/v2/conversations/:id/events` 投影的可选 `qqMessageFacts` 详情。
//
// 覆盖（规格 §3/§4/§6，计划 T13 Step6）：真实 wire → recordObservation → journal →
// conversationRoutes HTTP 读回——事件详情携带发送时双名快照、当前双名映射（独立
// qq_member_name 来源 + pruneQqMemberCurrentNames 校验）、ordered @/reply 关系；改名后
// 快照不跟随；当前名过期只裁 currentName、不取消仍合法的事实/正文；跨会话平台 ID 不
// 借 current owner 读旧 facts（正文历史仍按既有 guard 保持）；conversationId 用真实
// event 归属而非展示用的 history root remap。不新增 API，不解析 raw OneBot。

import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { conversationRoutes } from "../../src/server/api/conversations";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { ConversationEventsSchema } from "../../src/shared/contracts/conversation";
import type { QqMessageFact } from "../../src/shared/contracts/qq-message";

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const atIso = new Date(at * 1000).toISOString();

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

function bind(h: ReturnType<typeof setup>, id: string, peerId: string, kind: "group" | "private") {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(atIso, atIso);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',?,?)",
    )
    .run(id, "90001", kind, peerId, DEFAULT_AGENT_ID, atIso, atIso);
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(id);
  if (!conversation) throw new Error("conversation fixture missing");
  return { journal, conversation };
}

function groupObservation(input: {
  messageId: number;
  userId: number;
  card?: string;
  nickname?: string;
  text?: string;
  atSeconds?: number;
  mentions?: Array<number | "all">;
  replyTo?: number;
}) {
  const segments: Array<Record<string, unknown>> = [];
  if (input.replyTo !== undefined) segments.push({ type: "reply", data: { id: input.replyTo } });
  for (const qq of input.mentions ?? []) segments.push({ type: "at", data: { qq } });
  segments.push({ type: "text", data: { text: input.text ?? "合成正文" } });
  const result = normalizeOneBotMessage(
    {
      time: input.atSeconds ?? at,
      self_id: 90001,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: input.messageId,
      user_id: input.userId,
      group_id: 30003,
      sender: { card: input.card, nickname: input.nickname },
      message: segments,
    },
    "90001",
  );
  if (result.kind !== "message") throw new Error("message expected");
  return result.observation;
}

function readEvents(app: Hono, conversationId: string, query = "") {
  return app.request(`/v2/conversations/${conversationId}/events${query}`);
}

describe("T13 event fact details via existing events projection", () => {
  it("exposes snapshot dual names, current dual-name mapping, ordered mentions and reply over real HTTP", async () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h, "binding", "30003", "group");
      const first = groupObservation({
        messageId: -201,
        userId: 10001,
        card: "阿林卡",
        nickname: "阿林",
        mentions: [10002],
        replyTo: -101,
        text: "引用并点名",
      });
      recordObservation(h.orm, first, DEFAULT_AGENT_ID);
      const event = journal.ingestOneBotEvent(first.eventKey, "binding");
      expect(event).not.toBeNull();
      const app = new Hono().route(
        "/v2/conversations",
        conversationRoutes(h.db, { includeShared: true }),
      );
      const response = await readEvents(app, conversation.id);
      expect(response.status).toBe(200);
      // shared schema 严格解析真实 HTTP 响应（strictObject；多余/缺失字段都会失败）。
      const page = ConversationEventsSchema.parse(await response.json());
      const details = page.items.flatMap((item) => item.qqMessageFacts ?? []);
      expect(details).toHaveLength(1);
      const fact = details[0];
      if (!fact) throw new Error("fact detail missing");
      // 发送时双名快照 + 当前映射（独立成员目录来源，§3.1）。
      expect(fact.speaker).toMatchObject({
        role: "member",
        qq: "10001",
        groupCard: "阿林卡",
        personalNickname: "阿林",
        nameState: "known",
        currentName: { groupCard: "阿林卡", personalNickname: "阿林" },
      });
      expect(fact.platformMessageId).toBe("-201");
      expect(fact.replyTo).toEqual({ platformMessageId: "-101" });
      expect(fact.parts.map((p) => p.kind)).toEqual(["mention", "text"]);
      expect(fact.mentions).toEqual([{ qq: "10002", identity: null }]);
      // conversationId 是真实 event 归属（remap 前后同 id；负向在 rebind 用例锁定）。
      expect(page.items[0]?.conversationId).toBe(conversation.id);
    } finally {
      h.close();
    }
  });

  it("keeps the snapshot dual names after a rename while current mapping follows the directory", async () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h, "binding", "30003", "group");
      const first = groupObservation({
        messageId: -202,
        userId: 10001,
        card: "旧卡",
        nickname: "旧昵",
        text: "改名前",
      });
      recordObservation(h.orm, first, DEFAULT_AGENT_ID);
      journal.ingestOneBotEvent(first.eventKey, "binding");
      const second = groupObservation({
        messageId: -203,
        userId: 10001,
        card: "新卡",
        nickname: "新昵",
        text: "改名后",
        atSeconds: at + 60,
      });
      recordObservation(h.orm, second, DEFAULT_AGENT_ID);
      journal.ingestOneBotEvent(second.eventKey, "binding");
      const app = new Hono().route(
        "/v2/conversations",
        conversationRoutes(h.db, { includeShared: true }),
      );
      const page = (await (await readEvents(app, conversation.id)).json()) as {
        items: Array<{ qqMessageFacts?: QqMessageFact[] }>;
      };
      const facts = page.items.flatMap((item) => item.qqMessageFacts ?? []);
      expect(facts).toHaveLength(2);
      expect(facts[0]?.speaker.groupCard).toBe("旧卡");
      expect(facts[0]?.speaker.personalNickname).toBe("旧昵");
      // 当前映射跟随目录（§3.1 当前双昵称目录）。
      expect(facts[0]?.speaker.currentName).toEqual({
        groupCard: "新卡",
        personalNickname: "新昵",
      });
      expect(facts[1]?.speaker.currentName).toEqual({
        groupCard: "新卡",
        personalNickname: "新昵",
      });
    } finally {
      h.close();
    }
  });

  it("clips only the expired currentName and keeps the still-valid fact and body", async () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h, "binding", "30003", "group");
      const observation = groupObservation({
        messageId: -204,
        userId: 10001,
        card: "名片",
        nickname: "昵称",
        text: "正文仍可读",
      });
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      journal.ingestOneBotEvent(observation.eventKey, "binding");
      // 成员目录行过期（事实/正文行保持有效）。
      h.db
        .query("UPDATE qq_members SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id='10001'")
        .run();
      const app = new Hono().route(
        "/v2/conversations",
        conversationRoutes(h.db, { includeShared: true }),
      );
      const page = (await (await readEvents(app, conversation.id)).json()) as {
        items: Array<{
          text: string | null;
          contentState: string;
          qqMessageFacts?: Array<{ speaker: { currentName?: unknown } }>;
        }>;
      };
      const item = page.items[0];
      if (!item) throw new Error("event item missing");
      expect(item.qqMessageFacts).toHaveLength(1);
      expect(item.qqMessageFacts?.[0]?.speaker.currentName).toBeUndefined();
      // 姓名失效不取消仍合法的 body（§4.5 边界记录在报告）。
      expect(item.contentState).toBe("active");
      expect(item.text).toBe("正文仍可读");
    } finally {
      h.close();
    }
  });

  it("returns no fact details for a closed-epoch event read through a new binding scope while history text keeps the existing guard", async () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h, "binding", "30003", "group");
      const observation = groupObservation({
        messageId: -205,
        userId: 10001,
        card: "卡",
        nickname: "昵",
        text: "旧纪元正文",
      });
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      journal.ingestOneBotEvent(observation.eventKey, "binding");
      // 换绑产生新 epoch 会话（旧 conversation 关闭，历史 remap 到 root）。
      // 复刻 conversation-history.test.ts 的既有历史语义：换到助手 B 再换回同一助手 A，
      // 旧纪元正文经 remap 在新 epoch 会话里仍按原 guard 可读。
      h.db
        .query(
          "INSERT INTO agents SELECT 'agent-b',name,system_prompt,description,additional_instructions,p5_config,model_name,temperature,memory_consolidation_model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_model_name,memory_retrieval_prompt,context_compression_model_name,persona_intensity,is_active,config_version,updated_at,created_at FROM agents WHERE id=?",
        )
        .run(DEFAULT_AGENT_ID);
      h.db.query("UPDATE qq_bindings SET agent_id='agent-b' WHERE id='binding'").run();
      journal.ensureOneBot("binding");
      h.db.query("UPDATE qq_bindings SET agent_id=? WHERE id='binding'").run(DEFAULT_AGENT_ID);
      const rebound = journal.ensureOneBot("binding");
      if (!rebound) throw new Error("rebound fixture missing");
      expect(rebound.id).not.toBe(conversation.id);
      const app = new Hono().route(
        "/v2/conversations",
        conversationRoutes(h.db, { includeShared: true }),
      );
      // 历史正文仍按既有 remap guard 展示（不回退现有行为）。
      const page = (await (await readEvents(app, rebound.id)).json()) as {
        items: Array<{
          text: string | null;
          contentState: string;
          qqMessageFacts?: unknown[];
        }>;
      };
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.contentState).toBe("active");
      expect(page.items[0]?.text).toBe("旧纪元正文");
      // 但 facts 详情不借当前 owner 授权旧纪元事件（8 scope 含 conversationId/bindingId/
      // epoch/authority，全部随当前会话，旧 event 的 timeline 归属校验失败 → 无详情、
      // 不带原因，不泄露）。
      expect(page.items[0]?.qqMessageFacts).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it("omits detail groups for unavailable content and never fabricates identity for anonymous speakers", async () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h, "binding", "30003", "group");
      const observation = groupObservation({
        messageId: -206,
        userId: 10001,
        card: "卡",
        nickname: "昵",
        text: "将被删除的正文",
      });
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      journal.ingestOneBotEvent(observation.eventKey, "binding");
      h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(observation.eventKey);
      const app = new Hono().route(
        "/v2/conversations",
        conversationRoutes(h.db, { includeShared: true }),
      );
      const page = (await (await readEvents(app, conversation.id)).json()) as {
        items: Array<{
          contentState: string;
          qqMessageFacts?: Array<{ speaker: Record<string, unknown> }>;
        }>;
      };
      const item = page.items[0];
      if (!item) throw new Error("event item missing");
      // 正文被删除 → unavailable：不含正文细节（现有投影行为），也不附事实详情组。
      expect(item.contentState).toBe("unavailable");
      expect(item.qqMessageFacts).toBeUndefined();
      // 匿名：不编 QQ / 身份（独立用例）。
      const anon = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "anonymous",
          message_id: -207,
          user_id: 10001,
          group_id: 30003,
          sender: {},
          message: [{ type: "text", data: { text: "匿名发言" } }],
        },
        "90001",
      );
      if (anon.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, anon.observation, DEFAULT_AGENT_ID);
      journal.ingestOneBotEvent(anon.observation.eventKey, "binding");
      const page2 = (await (await readEvents(app, conversation.id)).json()) as {
        items: Array<{ qqMessageFacts?: QqMessageFact[] }>;
      };
      const anonFact = page2.items
        .flatMap((item) => item.qqMessageFacts ?? [])
        .find((fact) => fact.speaker.role === "anonymous");
      expect(anonFact).toBeDefined();
      expect(anonFact?.speaker.qq).toBeNull();
    } finally {
      h.close();
    }
  });

  it("omits detail groups when the body has expired without being deleted", async () => {
    const h = setup();
    try {
      const { journal, conversation } = bind(h, "binding", "30003", "group");
      const observation = groupObservation({
        messageId: -208,
        userId: 10001,
        card: "卡",
        nickname: "昵",
        text: "正文已到期",
      });
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      journal.ingestOneBotEvent(observation.eventKey, "binding");
      h.db
        .query(
          "UPDATE qq_observation_text SET expires_at='2000-01-01T00:00:00.000Z' WHERE event_key=?",
        )
        .run(observation.eventKey);
      const app = new Hono().route(
        "/v2/conversations",
        conversationRoutes(h.db, { includeShared: true }),
      );
      const page = (await (await readEvents(app, conversation.id)).json()) as {
        items: Array<{ contentState: string; qqMessageFacts?: QqMessageFact[] }>;
      };
      const item = page.items[0];
      if (!item) throw new Error("event item missing");
      expect(item.contentState).toBe("expired");
      expect(item.qqMessageFacts).toBeUndefined();
    } finally {
      h.close();
    }
  });
});
