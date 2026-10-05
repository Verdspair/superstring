// T03b：OutboundDelivery 平台 part 确认映射（规格 §13.4；计划 2026-10-02 T03 Step6 交付片）。
//
// 真实 Outbox/journal/run + 真实 OutboundDelivery 确认段：只有平台确认送达的部件才把
// 实际 part 正文映射进 qq_outbound_message_facts；kind 与 text 都取自与发送同一路径的
// claim（不整条拼接、不造 platformID）。UNKNOWN 不产生映射也不重发；提交时缺出站事实
// 的旧意图不得把已真实送达的平台回执回滚，也不伪造身份或事实。

import { afterEach, describe, expect, it } from "bun:test";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import type { OutboundTarget } from "../../src/server/db/outbound-intent-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import {
  createQqStickerCollection,
  importQqSticker,
} from "../../src/server/db/qq-sticker-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";

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
  const commitIntent = (
    intentId: string,
    parts: ({ kind: "text"; text: string } | { kind: "sticker"; stickerId: string })[],
  ) => {
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
      expiresAt: later,
      parts,
    });
  };
  /** 出站事实行由 bot-host 在 commit 时播种（bot-host.ts 的 commit 时快照）；测试等价播种。 */
  const seedOutboundFacts = (intentId: string) => {
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
        expiresAt: "2033-01-01T00:00:00.000000Z",
      })
      .run();
  };
  /** 真实贴纸资产行：qq_send_part.sticker_id 外键引用它（合成导入，不读真实素材）。 */
  const importSticker = (stickerId: string) => {
    const collection = createQqStickerCollection(h.orm, { name: `coll-${stickerId}` });
    importQqSticker(h.orm, {
      id: stickerId,
      copy: { fileName: `${stickerId}.png`, byteSize: 64, mediaType: "image" },
      name: `wave-${stickerId}`,
      width: 64,
      height: 64,
      collectionIds: [collection.id],
    });
  };
  return { h, journal, outbox, commitIntent, seedOutboundFacts, importSticker, conversation };
}

function outboundParts(db: ReturnType<typeof openBusinessDb>["db"], intentId: string) {
  const row = db
    .query("SELECT parts FROM qq_outbound_message_facts WHERE intent_id=?")
    .get(intentId) as { parts: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.parts) as Array<{
    kind: "text" | "sticker";
    ordinal: number;
    platformMessageId: string | null;
    text: string | null;
  }>;
}

describe("OutboundDelivery platform part confirmation mapping", () => {
  it("maps each confirmed text part to its own platform message ID with exact text", async () => {
    const { h, journal, outbox, commitIntent, seedOutboundFacts } = setup();
    const intent = commitIntent("intent-t03b-text", [
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
    seedOutboundFacts(intent.id);
    let sends = 0;
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: outbox,
      journal,
      stickerFile: () => null,
      authorize: () => true,
      now: () => now,
      port: {
        async send() {
          sends++;
          // 网络前已有 durable sending 行；每个部件各拿到一个不同平台消息 ID。
          expect(outbox.parts(intent.id).filter((p) => p.status === "sending")).toHaveLength(1);
          return { kind: "confirmed", messageId: `plat-${sends}` };
        },
      },
    });
    await delivery.deliver(intent.id);
    expect(sends).toBe(2);
    expect(outbox.get(intent.id)).toMatchObject({ status: "confirmed" });
    expect(outboundParts(h.db, intent.id)).toEqual([
      { kind: "text", ordinal: 0, platformMessageId: "plat-1", text: "first" },
      { kind: "text", ordinal: 1, platformMessageId: "plat-2", text: "second" },
    ]);
  });

  it("maps a sticker part with null text while the text part keeps its exact body", async () => {
    const { h, journal, outbox, commitIntent, seedOutboundFacts, importSticker } = setup();
    importSticker("s-1");
    const intent = commitIntent("intent-t03b-mix", [
      { kind: "text", text: "你好" },
      { kind: "sticker", stickerId: "s-1" },
    ]);
    seedOutboundFacts(intent.id);
    let sends = 0;
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: outbox,
      journal,
      stickerFile: () => "base64://sticker",
      authorize: () => true,
      now: () => now,
      port: {
        async send() {
          sends++;
          return { kind: "confirmed", messageId: `plat-${sends}` };
        },
      },
    });
    await delivery.deliver(intent.id);
    expect(sends).toBe(2);
    expect(outboundParts(h.db, intent.id)).toEqual([
      { kind: "text", ordinal: 0, platformMessageId: "plat-1", text: "你好" },
      { kind: "sticker", ordinal: 1, platformMessageId: "plat-2", text: null },
    ]);
  });

  it("unknown receipt maps no part and never resends on recovery", async () => {
    const { h, journal, outbox, commitIntent, seedOutboundFacts } = setup();
    const intent = commitIntent("intent-t03b-unknown", [
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
    seedOutboundFacts(intent.id);
    let sends = 0;
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: outbox,
      journal,
      stickerFile: () => null,
      authorize: () => true,
      now: () => now,
      port: {
        async send() {
          sends++;
          return { kind: "unknown", reason: "timeout" };
        },
      },
    });
    await delivery.deliver(intent.id);
    expect(sends).toBe(1);
    expect(outbox.get(intent.id)).toMatchObject({
      parts: [{ status: "unknown" }, { status: "not_sent" }],
    });
    expect(outboundParts(h.db, intent.id)).toEqual([]);
    delivery.recover();
    await delivery.runOnce();
    expect(sends).toBe(1);
    expect(outboundParts(h.db, intent.id)).toEqual([]);
  });

  it("an old intent without outbound facts keeps the real platform receipt without fabricating facts", async () => {
    const { h, journal, outbox, commitIntent } = setup();
    const intent = commitIntent("intent-t03b-old", [
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ]);
    let sends = 0;
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: outbox,
      journal,
      stickerFile: () => null,
      authorize: () => true,
      now: () => now,
      port: {
        async send() {
          sends++;
          return { kind: "confirmed", messageId: `plat-${sends}` };
        },
      },
    });
    // 提交时缺出站事实的旧意图：已真实送达的平台回执不能被回滚成 sending→unknown。
    await delivery.deliver(intent.id);
    expect(sends).toBe(2);
    expect(outbox.get(intent.id)).toMatchObject({
      status: "confirmed",
      parts: [
        { status: "confirmed", platformMessageId: "plat-1" },
        { status: "confirmed", platformMessageId: "plat-2" },
      ],
    });
    // 不伪造身份、不造事实行。
    expect(outboundParts(h.db, intent.id)).toBeNull();
    // 真实回执仍投影进发送台账。
    expect(h.db.query("SELECT COUNT(*) AS n FROM qq_send_log").get()).toEqual({ n: 1 });
    // 第二次投递不重发、不新造事实。
    await delivery.deliver(intent.id);
    expect(sends).toBe(2);
    expect(outboundParts(h.db, intent.id)).toBeNull();
  });
});
