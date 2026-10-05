// 出站投递与发送台账/语音记录的精确 id 关联与来源到期帽（规格 §13.4 投影；原不变量实施）。
//
// 真实 Outbox/journal/run + 真实 OutboundDelivery：确认送达的旧意图投影 recordQqSend 时，
// 语音记录携带发送台账自己的 row id（speech.id == sendlog.id），调用方此后按
// legacy_send_id 与 speech source.id 精确对齐，不靠正文或时间猜；投影行的窗口被意图行与
// 出站事实行（按 intent_id 精确）的最早到期封顶、只提前不延后，用真实留存设置证明帽不
// 来自非法 retentionDays=0。缺事实的旧意图不猜生产；独立 recordQqSpeech 不传 id 仍写
// 自己的 UUID，来源帽非法 ISO 时 fail-closed 拒写。

import { afterEach, describe, expect, it } from "bun:test";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import type { OutboundTarget } from "../../src/server/db/outbound-intent-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import { readQqRetentionDays } from "../../src/server/db/qq-settings-repository";
import { recordQqSpeech } from "../../src/server/db/qq-speech-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { speechExpiresAt } from "../../src/server/services/qq-retention";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

const now = "2026-10-01T16:00:00.000000Z";
const later = "2026-10-01T17:00:00.000000Z";
const bindingId = "11111111-1111-4111-8111-111111111111";

function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic-model");
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(now, now);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',?,?)",
    )
    .run(bindingId, "90001", "group", "30003", DEFAULT_AGENT_ID, now, now);
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(bindingId);
  if (!conversation) throw new Error(`fixture: ensureOneBot(${bindingId}) returned null`);
  const outbox = new OutboundIntentRepository(h.db);
  const target: OutboundTarget = {
    accountId: "90001",
    conversationKind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    bindingId,
    bindingEpoch: 1,
  };
  const commitIntent = (intentId: string, expiresAt: string) => {
    new AgentRunRepository(h.db).createRun({
      runId: `run-${intentId}`,
      specId: "main",
      specVersion: "1",
      owner: { kind: "conversation", id: conversation.id },
      at: now,
    });
    return outbox.commit({
      id: intentId,
      runId: `run-${intentId}`,
      conversationId: conversation.id,
      ordinal: 0,
      target,
      speechKind: "direct_reply",
      sourceThroughSeq: 0,
      deliverBy: later,
      createdAt: now,
      expiresAt,
      parts: [{ kind: "text", text: "first" }],
    });
  };
  const seedOutboundFacts = (intentId: string, expiresAt: string) => {
    h.orm
      .insert(schema.qqOutboundMessageFacts)
      .values({
        intentId,
        accountId: "90001",
        agentId: DEFAULT_AGENT_ID,
        groupCard: "值班猫娘",
        personalNickname: null,
        legacyDisplayName: null,
        parts: "[]",
        revision: 1,
        expiresAt,
      })
      .run();
  };
  return { h, journal, outbox, commitIntent, seedOutboundFacts };
}

/** 恰取一行；行数不符直接失败，避免对可能缺失的行做非空断言。 */
function one<T>(rows: T[], label: string): T {
  const [row] = rows;
  if (rows.length !== 1 || !row)
    throw new Error(`expected exactly one ${label}, got ${rows.length}`);
  return row;
}

function sendLog(db: ReturnType<typeof openBusinessDb>["db"]) {
  return db.query("SELECT * FROM qq_send_log").all() as Array<{
    id: string;
    expires_at: string;
    outcome: string;
  }>;
}

function speechLog(db: ReturnType<typeof openBusinessDb>["db"]) {
  return db.query("SELECT * FROM qq_speech_log").all() as Array<{
    id: string;
    expires_at: string;
  }>;
}

function speechText(db: ReturnType<typeof openBusinessDb>["db"]) {
  return db.query("SELECT * FROM qq_speech_text").all() as Array<{
    speech_id: string;
    body: string;
    spoke_at_seconds: number;
    expires_at: string;
    recorded_at: string;
  }>;
}

function deliveryOf(
  h: ReturnType<typeof openBusinessDb>,
  journal: ConversationEventRepository,
  outbox: OutboundIntentRepository,
) {
  return new OutboundDelivery({
    orm: h.orm,
    repository: outbox,
    journal,
    stickerFile: () => null,
    authorize: () => true,
    now: () => now,
    port: {
      async send() {
        return { kind: "confirmed" as const, messageId: "plat-1" };
      },
    },
  });
}

describe("outbound projection speech link and source expiry cap", () => {
  it("shares the send ledger id with the speech record and keeps the earliest of intent and fact caps", async () => {
    const { h, journal, outbox, commitIntent, seedOutboundFacts } = setup();
    // 意图到期晚于事实到期：帽必须取事实行（最早）。两者都比回执晚 1 天以上，
    // 且真实留存设置（14 天）更晚——结果等于来源帽即证明不是 retentionDays=0。
    const intent = commitIntent("intent-link-fact-earlier", "2026-10-03T16:00:00.000000Z");
    seedOutboundFacts(intent.id, "2026-10-02T18:00:00.000000Z");
    const delivery = deliveryOf(h, journal, outbox);
    await delivery.deliver(intent.id);
    const send = one(sendLog(h.db), "send log row");
    const speech = one(speechLog(h.db), "speech log row");
    expect(send.outcome).toBe("sent");
    const parts = h.db
      .query(
        "SELECT status,platform_message_id AS platformMessageId FROM outbound_parts WHERE intent_id=? ORDER BY ordinal",
      )
      .all(intent.id) as Array<{ status: string; platformMessageId: string | null }>;
    expect(parts).toEqual([{ status: "confirmed", platformMessageId: "plat-1" }]);
    // speech.id == sendlog.id，legacy_send_id 指向同一个 id。
    expect(speech.id).toBe(send.id);
    const intentRow = one(
      h.db
        .query("SELECT legacy_send_id, expires_at FROM outbound_intents WHERE id=?")
        .all(intent.id) as Array<{ legacy_send_id: string; expires_at: string }>,
      "intent row",
    );
    expect(intentRow.legacy_send_id).toBe(send.id);
    // 帽 = min(真实留存戳, 意图到期, 事实到期) = 事实到期；speech_text 同帽。
    const cap = "2026-10-02T18:00:00.000000Z";
    expect(cap < intentRow.expires_at).toBe(true);
    expect(
      intentRow.expires_at <
        speechExpiresAt(Math.floor(Date.parse(now) / 1000), readQqRetentionDays(h.orm)),
    ).toBe(true);
    expect(send.expires_at).toBe(cap);
    expect(speech.expires_at).toBe(cap);
    const textRow = one(speechText(h.db), "speech text row");
    expect({
      speech_id: textRow.speech_id,
      body: textRow.body,
      expires_at: textRow.expires_at,
    }).toEqual({ speech_id: send.id, body: "first", expires_at: cap });
    expect(textRow.spoke_at_seconds).toBe(Math.floor(Date.parse(now) / 1000));
    expect(Number.isFinite(Date.parse(textRow.recorded_at))).toBe(true);
    // 重复 recover 仍由 legacy_send_id gate：不产生第二条发送或语音。
    delivery.recover();
    expect(sendLog(h.db)).toHaveLength(1);
    expect(speechLog(h.db)).toHaveLength(1);
  });

  it("caps at the intent's own expiry when the intent expires earlier than the fact", async () => {
    const { h, journal, outbox, commitIntent, seedOutboundFacts } = setup();
    // 意图到期早于事实到期：帽必须取意图行（最早）。回执晚 1 天以上，真实留存设置更晚。
    const intent = commitIntent("intent-link-intent-earlier", "2026-10-02T16:00:00.000000Z");
    seedOutboundFacts(intent.id, "2033-01-01T00:00:00.000000Z");
    const delivery = deliveryOf(h, journal, outbox);
    await delivery.deliver(intent.id);
    const send = one(sendLog(h.db), "send log row");
    const speech = one(speechLog(h.db), "speech log row");
    const cap = "2026-10-02T16:00:00.000000Z";
    expect(send.expires_at).toBe(cap);
    expect(speech.expires_at).toBe(cap);
    expect(speech.id).toBe(send.id);
  });

  it("an old intent without outbound facts is capped by its own expiry alone and fabricates nothing", async () => {
    const { h, journal, outbox, commitIntent } = setup();
    const intent = commitIntent("intent-link-no-facts", "2026-10-02T16:00:00.000000Z");
    const delivery = deliveryOf(h, journal, outbox);
    await delivery.deliver(intent.id);
    const send = one(sendLog(h.db), "send log row");
    const speech = one(speechLog(h.db), "speech log row");
    expect(send.expires_at).toBe("2026-10-02T16:00:00.000000Z");
    expect(speech.expires_at).toBe("2026-10-02T16:00:00.000000Z");
    expect(speech.id).toBe(send.id);
    // 不猜生产：缺事实就缺，不伪造事实行。
    expect(h.db.query("SELECT COUNT(*) AS n FROM qq_outbound_message_facts").get()).toEqual({
      n: 0,
    });
  });

  it("a standalone recordQqSpeech without an id keeps its own UUID and plain retention stamp", () => {
    const { h } = setup();
    const scope = {
      kind: "qq" as const,
      accountId: "90001",
      conversationKind: "group" as const,
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
    };
    const row = recordQqSpeech(h.orm, {
      scope,
      kind: "direct_reply",
      spokeAtSeconds: Math.floor(Date.parse(now) / 1000),
      text: "independent",
    });
    expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(row.expiresAt).toBe(
      speechExpiresAt(Math.floor(Date.parse(now) / 1000), readQqRetentionDays(h.orm)),
    );
    const second = recordQqSpeech(h.orm, {
      scope,
      kind: "direct_reply",
      spokeAtSeconds: Math.floor(Date.parse(now) / 1000),
      text: "independent two",
    });
    expect(second.id).not.toBe(row.id);
  });

  it("caps a standalone speech record by the source expiry and fails closed on an invalid ISO stamp", () => {
    const { h } = setup();
    const scope = {
      kind: "qq" as const,
      accountId: "90001",
      conversationKind: "group" as const,
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
    };
    const at = Math.floor(Date.parse(now) / 1000);
    const row = recordQqSpeech(h.orm, {
      scope,
      kind: "direct_reply",
      spokeAtSeconds: at,
      text: "capped",
      sourceExpiresAt: "2026-10-02T18:00:00.000000Z",
    });
    expect(row.expiresAt).toBe("2026-10-02T18:00:00.000000Z");
    // 比留存戳更晚的来源帽不得延后窗口。
    const kept = recordQqSpeech(h.orm, {
      scope,
      kind: "direct_reply",
      spokeAtSeconds: at,
      text: "kept",
      sourceExpiresAt: "2033-01-01T00:00:00.000000Z",
    });
    expect(kept.expiresAt).toBe(speechExpiresAt(at, readQqRetentionDays(h.orm)));
    // 非法 ISO 来源帽 fail-closed：拒写，不落任何行。
    expect(() =>
      recordQqSpeech(h.orm, {
        scope,
        kind: "direct_reply",
        spokeAtSeconds: at,
        text: "bad",
        sourceExpiresAt: "not-an-instant",
      }),
    ).toThrow(TypeError);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM qq_speech_log WHERE account_id=?").get("90001"),
    ).toEqual({ n: 2 });
  });

  it("recordQqSend refuses an invalid source expiry fail-closed before any write", () => {
    const { h } = setup();
    const scope = {
      kind: "qq" as const,
      accountId: "90001",
      conversationKind: "group" as const,
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
    };
    expect(() =>
      recordQqSend(h.orm, {
        scope,
        kind: "direct_reply",
        parts: [{ kind: "text", result: "confirmed", messageId: "plat-x" }],
        sentAtSeconds: Math.floor(Date.parse(now) / 1000),
        text: "should never land",
        sourceExpiresAt: "not-an-instant",
      }),
    ).toThrow(TypeError);
    expect(h.db.query("SELECT COUNT(*) AS n FROM qq_send_log").get()).toEqual({ n: 0 });
    expect(h.db.query("SELECT COUNT(*) AS n FROM qq_speech_log").get()).toEqual({ n: 0 });
  });
});
