// T03a：入站事实投影（锁定公开接口；计划 T03 Step8，规格 §4.3/§4.5/§13）。
//
// 覆盖锁定签名 `loadQqMessageFact(store, scope, platformMessageId, now)` 与
// `projectQqMessageFacts(store, scope, eventIds, now)`：真实 conversation_events seq、
// 完整 scope（conversation/binding epoch/authority/账号/kind/peer/Agent/bindingId）、
// 正文删除/到期不从 facts partsJSON 复活、media-only 无 body 是真完整、scope 失败
// 返回 null/[] 不泄露别群存在。源解析接线（qq_message_fact）留 T04b。

import { describe, expect, it } from "bun:test";
import {
  loadQqMessageFact,
  projectQqMessageFacts,
} from "../../src/server/channels/onebot11/message-projection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { EvidenceStore } from "../../src/server/modules/conversation-evidence-store";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const now = "2026-10-01T16:00:00.000000Z";
const expired = "2026-10-20T00:00:00.000000Z";

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

function bind(h: ReturnType<typeof setup>, id = "binding", peerId = "30003", kind = "group") {
  h.db
    .query(
      "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
    )
    .run(now, now);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,?,?,?,'scheme',?,?)",
    )
    .run(id, "90001", kind, peerId, DEFAULT_AGENT_ID, now, now);
  const journal = new ConversationEventRepository(h.db);
  const conversation = journal.ensureOneBot(id)!;
  return { journal, conversation };
}

/** 真实 wire 路径：normalize 一条群消息（card 显式空白、reply+at+text 有序片段）。 */
function alinObservation(messageId: number, text = "你不是就在南京吗？", groupId = 30003) {
  const result = normalizeOneBotMessage(
    {
      time: at,
      self_id: 90001,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: messageId,
      user_id: 10001,
      group_id: groupId,
      sender: { card: "   ", nickname: "阿林" },
      message: [
        { type: "reply", data: { id: -101 } },
        { type: "at", data: { qq: 10002 } },
        { type: "text", data: { text } },
      ],
    },
    "90001",
  );
  if (result.kind !== "message") throw new Error("message expected");
  return result.observation;
}

/** bind 后回填真实 conversation/binding，构造当前有效 scope（不用占位值）。 */
function liveScope(
  h: ReturnType<typeof setup>,
  conversation: { id: string; bindingEpoch: number },
  bindingId = "binding",
): QqConversationScope {
  const c = h.db
    .query("SELECT binding_epoch FROM conversations WHERE id=?")
    .get(conversation.id) as { binding_epoch: number };
  const b = h.db
    .query(
      "SELECT account_id,conversation_kind,peer_id,agent_id,authority_revision FROM qq_bindings WHERE id=?",
    )
    .get(bindingId) as {
    account_id: string;
    conversation_kind: "group" | "private";
    peer_id: string;
    agent_id: string;
    authority_revision: number;
  };
  return {
    conversationId: conversation.id,
    accountId: b.account_id,
    conversationKind: b.conversation_kind,
    peerId: b.peer_id,
    agentId: b.agent_id,
    bindingId,
    bindingEpoch: c.binding_epoch,
    authorityRevision: b.authority_revision,
  };
}

/** 入站写 + journal 派生（真实接线顺序：adapter.afterRecord 的 ingest）。 */
function recordWithJournal(
  h: ReturnType<typeof setup>,
  journal: ConversationEventRepository,
  bindingId: string,
  observation: ReturnType<typeof alinObservation>,
) {
  recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
  return journal.ingestOneBotEvent(observation.eventKey, bindingId);
}

describe("locked inbound fact projection interface", () => {
  it("projects real journal seq and ordered parts inside the full scope", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const first = alinObservation(-102);
      const second = alinObservation(-103, "同秒第二条");
      recordWithJournal(h, journal, "binding", first);
      recordWithJournal(h, journal, "binding", second);
      const store: EvidenceStore = h;
      const live = liveScope(h, conversation);
      const load = loadQqMessageFact(store, live, "-102", now);
      // 锁定签名存在且 seq 来自真实 conversation_events（非 0 占位），平台 ID 保留负数字符串。
      expect(load).toMatchObject({
        platformMessageId: "-102",
        replyTo: { platformMessageId: "-101" },
        completeness: "full",
      });
      expect(load!.id).toBe(first.eventKey);
      expect(load!.seq).toBeGreaterThan(0);
      const seqs = [-102, -103].map((id) => loadQqMessageFact(store, live, String(id), now)!.seq);
      expect(seqs[0]!).toBeLessThan(seqs[1]!);
      expect(load!.speaker).toMatchObject({
        role: "member",
        qq: "10001",
        groupCard: null, // card "   " 是显式清空
        personalNickname: "阿林",
        nameState: "known",
      });
      expect(load?.speaker).not.toHaveProperty("groupCardSource");
      expect(load?.speaker).not.toHaveProperty("personalNicknameSource");
      const storedSource = h.db
        .query(
          "SELECT group_card_source, personal_nickname_source FROM qq_message_facts WHERE event_key=?",
        )
        .get(first.eventKey) as { group_card_source: string; personal_nickname_source: string };
      expect(storedSource).toEqual({ group_card_source: "wire", personal_nickname_source: "wire" });
      // reply 引用单列（replyTo 字段），不再渲染成 unavailable 占位片段（§4.1）。
      expect(load!.parts.map((p) => p.kind)).toEqual(["mention", "text"]);
      expect(load!.mentions.map((m) => m.qq)).toEqual(["10002"]);
      // 批量投影按 eventIds（内部事件键）取，保持 seq 顺序且来源真实。
      const projected = projectQqMessageFacts(store, live, [first.eventKey, second.eventKey], now);
      expect(projected.map((f) => f.platformMessageId)).toEqual(["-102", "-103"]);
      expect(projected.every((f) => f.seq > 0)).toBe(true);
      // 空集合是空投影，不是错误。
      expect(projectQqMessageFacts(store, live, [], now)).toEqual([]);
      const beforeSourceFix = loadQqMessageFact(store, live, "-102", now);
      const refBefore = beforeSourceFix?.sources.find((s) => s.kind === "qq_message_fact");
      expect(refBefore).toBeDefined();
      expect(refBefore?.revision).toBeDefined();
      h.db
        .query(
          "UPDATE qq_message_facts SET group_card_source=NULL, personal_nickname_source=NULL WHERE event_key=?",
        )
        .run(first.eventKey);
      const afterSourceFix = loadQqMessageFact(store, live, "-102", now);
      const refAfter = afterSourceFix?.sources.find((s) => s.kind === "qq_message_fact");
      expect(refAfter).toBeDefined();
      expect(refAfter?.revision).toBeDefined();
      expect(refAfter?.revision).not.toBe(refBefore?.revision);
      h.db
        .query(
          "UPDATE qq_message_facts SET group_card_source='wire', personal_nickname_source='wire' WHERE event_key=?",
        )
        .run(first.eventKey);
      const restored = loadQqMessageFact(store, live, "-102", now);
      const refRestored = restored?.sources.find((s) => s.kind === "qq_message_fact");
      expect(refRestored).toBeDefined();
      expect(refRestored?.revision).toBeDefined();
      expect(refRestored?.revision).not.toBe(refAfter?.revision);
    } finally {
      h.close();
    }
  });

  it("fails closed on scope mismatch: conversation, epoch, authority, binding, agent, account, kind, peer", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(h, journal, "binding", alinObservation(-102));
      const store: EvidenceStore = h;
      const live = liveScope(h, conversation);
      // 正确 scope 可读（establish baseline）。
      expect(loadQqMessageFact(store, live, "-102", now)).not.toBeNull();
      // 每一个 scope 字段错都返回 null / 空数组，不泄露存在性或内容。
      const wrongScopes: QqConversationScope[] = [
        { ...live, conversationId: "other-conversation" },
        { ...live, bindingEpoch: 2 },
        { ...live, authorityRevision: 2 },
        { ...live, bindingId: "binding2" },
        { ...live, agentId: "00000000-0000-0000-0000-000000000002" },
        { ...live, accountId: "90002" },
        { ...live, conversationKind: "private" },
        { ...live, peerId: "30004" },
      ];
      for (const wrong of wrongScopes) {
        expect(loadQqMessageFact(store, wrong, "-102", now)).toBeNull();
        // scope 失败的批量投影不产出事实（空数组，非泄露）。
        expect(projectQqMessageFacts(store, wrong, ["e"], now)).toEqual([]);
      }
      // scope 失败的批量投影也不产出事实。
      expect(projectQqMessageFacts(store, { ...live, peerId: "30004" }, ["e"], now)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("does not resurrect body text from facts parts after deletion or expiry", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(h, journal, "binding", alinObservation(-102));
      const store: EvidenceStore = h;
      const live = liveScope(h, conversation);
      // 正文被物理删除（模拟手动清理删掉 qq_observation_text）：facts parts 仍存着 text 片段，
      // 但投影不得从 partsJSON 复活正文。快照存过 text 而正文行没了 → 正文"未知"，
      // 只有 full 可信为完整（§4.5），完整度降为 unavailable；身份/关系仍有效。
      h.db.exec("DELETE FROM qq_observation_text WHERE event_key IS NOT NULL");
      const noBody = loadQqMessageFact(store, live, "-102", now);
      expect(noBody).not.toBeNull(); // 身份与事实仍有效
      expect(noBody!.parts.some((p) => p.kind === "text" && p.text.length > 0)).toBe(false);
      expect(noBody!.completeness).toBe("unavailable");
      expect(noBody!.sources.some((s) => s.kind === "qq_observation")).toBe(false);
      // 正文到期（未删除）：同样不得复活，也不得借 member 当前名字补身。
      // 注意：正文到期时间 = occurred_at + 14 天保留窗，本消息 at=2026-10-01T16:00Z，
      // 到期于 2026-10-15；facts expires_at 同窗。用到期前 1 秒检验"正文行尚在但已过期"。
      const bodyExpired = new Date(Date.parse("2026-10-15T16:00:00Z") - 1000)
        .toISOString()
        .replace("Z", "000Z");
      const late = loadQqMessageFact(store, live, "-102", bodyExpired);
      expect(late).not.toBeNull();
      expect(late!.parts.some((p) => p.kind === "text" && p.text.length > 0)).toBe(false);
      expect(late!.completeness).toBe("unavailable");
      // 事实快照本身到期：整个事实不可用（不被永久身份复活）。
      h.db.exec(`UPDATE qq_message_facts SET expires_at='${expired}' WHERE event_key IS NOT NULL`);
      expect(loadQqMessageFact(store, live, "-102", expired)).toBeNull();
      expect(loadQqMessageFact(store, live, "-102", now)).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("media-only without a body is complete with the image presence kept", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-105, "");
      observation.segments = [{ kind: "image", file: "picture" }];
      observation.text = "";
      recordWithJournal(h, journal, "binding", observation);
      const store: EvidenceStore = h;
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(store, live, "-105", now);
      // 没有正文行是真"无正文"（media-only），不是不可用；image 以真实 mediaId 行保留，
      // 不再退化为 unavailable 占位（intake 已把 image 落成可引用的媒体事实行）。
      expect(fact).not.toBeNull();
      expect(fact!.completeness).toBe("full");
      expect(fact!.parts).toEqual([
        { kind: "image", mediaId: expect.any(String), category: "unknown" },
      ]);
      // mediaId 引用真实媒体行（不是猜的占位）。
      const mediaId = (fact!.parts[0] as { kind: "image"; mediaId: string }).mediaId;
      expect(
        h.db.query("SELECT 1 FROM qq_media_notes WHERE id=? AND segment_kind='image'").get(mediaId),
      ).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("fails closed when the stored text no longer matches a rewritten body", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(h, journal, "binding", alinObservation(-102));
      const store: EvidenceStore = h;
      const live = liveScope(h, conversation);
      // 正文被改写（来源 revision 会变，但 parts 还是旧正文）：旧 text 不得借 parts 副本
      // 继续可读——完整度 fail closed 为 unavailable，原文只经 qq_observation 来源可读。
      h.db.exec("UPDATE qq_observation_text SET body='被改写过的正文' WHERE event_key IS NOT NULL");
      const fact = loadQqMessageFact(store, live, "-102", now);
      expect(fact).not.toBeNull();
      expect(fact!.completeness).toBe("unavailable");
      expect(fact!.parts.some((p) => p.kind === "text" && p.text.includes("南京"))).toBe(false);
      // 改写后的正文仍从它自己的来源可读（不因 parts 不一致而连坐）。
      const obs = fact!.sources.find((s) => s.kind === "qq_observation");
      expect(obs).toBeDefined();
      expect(obs!.revision).not.toBe(
        fact!.sources.find((s) => s.kind === "qq_message_fact")!.revision,
      );
    } finally {
      h.close();
    }
  });

  it("keeps a repeated platform ID from a different conversation unresolvable instead of guessing the author", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(h, journal, "binding", alinObservation(-102));
      // 另一间群绑定并记录同一平台消息 ID。
      const second = bind(h, "binding2", "30004");
      recordWithJournal(h, journal, "binding2", alinObservation(-102, "你不是就在南京吗？", 30004));
      const store: EvidenceStore = h;
      const live = liveScope(h, conversation);
      const other = liveScope(h, second.conversation, "binding2");
      expect(other).toMatchObject({ bindingId: "binding2", peerId: "30004" });
      // 每间群各自 scope 读到各自记录（不跨群猜作者）；一次只返回唯一匹配，不并成猜测。
      expect(loadQqMessageFact(store, live, "-102", now)).not.toBeNull();
      expect(loadQqMessageFact(store, other, "-102", now)).not.toBeNull();
      // 缺失的键静默丢弃，不产出伪造事实。
      expect(projectQqMessageFacts(store, other, ["missing-key"], now)).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("maps legacy member names to the single current column and never fills history snapshots", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordWithJournal(h, journal, "binding", observation);
      // 把 facts 行改成 legacy 单昵称（旧目录形态），并清空双昵称与双来源
      // （真 unknown/legacy：值与来源一起置 NULL，不残留伪来源）。
      h.db.exec(
        `UPDATE qq_message_facts SET group_card=NULL, group_card_source=NULL,
        personal_nickname=NULL, personal_nickname_source=NULL,
        legacy_display_name='阿林旧名', name_state='legacy' WHERE event_key IS NOT NULL`,
      );
      const fact = loadQqMessageFact(h as EvidenceStore, liveScope(h, conversation), "-102", now);
      expect(fact!.speaker).toMatchObject({
        role: "member",
        qq: "10001",
        groupCard: null,
        personalNickname: null,
        legacyDisplayName: "阿林旧名",
        nameState: "legacy",
      });
      // legacy 单昵称不带 wire/local 双来源（§13.5 不伪造两份历史名字）。
      expect(fact?.speaker).not.toHaveProperty("groupCardSource");
      expect(fact?.speaker).not.toHaveProperty("personalNicknameSource");
    } finally {
      h.close();
    }
  });
});
