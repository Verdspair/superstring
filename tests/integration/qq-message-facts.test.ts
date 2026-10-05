// T03：入站事实、双昵称快照和出站身份（计划 2026-10-02 T03；规格 §3/§4/§13）。
//
// 覆盖：recordObservation 同事务写 facts、幂等与 backfill 补齐、member 目录双名字与
// presence 语义、projectQqMessageFacts 的 scope/expiry/unavailable、出站身份快照与
// platform part 映射、expiry cleanup 扩展与在用保护。

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  loadQqMessageFact,
  projectQqMessageFacts,
  projectQqOutboundMessageFacts,
} from "../../src/server/channels/onebot11/message-projection";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { rememberQqMemberNames } from "../../src/server/db/qq-member-repository";
import {
  backfillQqMessageFact,
  confirmQqOutboundPart,
  recordQqOutboundMessageFact,
} from "../../src/server/db/qq-message-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { qqStorageCleanup } from "../../src/server/db/qq-storage-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import type { QqConversationScope } from "../../src/shared/contracts/qq-message";

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const now = "2026-10-01T16:00:00.000000Z";
const later = "2026-10-01T17:00:00.000000Z";

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

/** 真实 wire 路径：normalize 一条群消息（card 全空格、reply+at+text 有序片段）。 */
function alinObservation(messageId: number, text = "你不是就在南京吗？") {
  const result = normalizeOneBotMessage(
    {
      time: at,
      self_id: 90001,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: messageId,
      user_id: 10001,
      group_id: 30003,
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

describe("inbound message facts intake", () => {
  it("records the two-name snapshot, ordered parts and reply in the same transaction", () => {
    const h = setup();
    try {
      bind(h);
      const observation = alinObservation(-102);
      const result = recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      expect(result.recorded).toBe(true);
      const row = h.db
        .query("SELECT * FROM qq_message_facts WHERE event_key=?")
        .get(observation.eventKey) as Record<string, unknown>;
      expect(row).toMatchObject({
        group_card: null, // card "   " 是显式清空，不是名字
        group_card_source: "wire", // F4：显式 wire 清空＝已核清空，与缺省区分
        personal_nickname: "阿林",
        personal_nickname_source: "wire",
        legacy_display_name: null,
        name_state: "known",
        reply_to_message_id: "-101",
        revision: 1,
      });
      const parts = JSON.parse(row!.parts as string) as Array<{ kind: string }>;
      // 有序片段：mention/text 按 wire 原序（规格 §4.1/§4.2）；reply 关系单列
      // reply_to_message_id，不再渲染成 unavailable 未知媒体占位（T03a）。
      expect(parts.map((p) => p.kind)).toEqual(["mention", "text"]);
    } finally {
      h.close();
    }
  });

  it("resolves official system face labels at intake: known 29=悠闲, unknown stays null", () => {
    const h = setup();
    try {
      bind(h);
      const result = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -120,
          user_id: 10001,
          group_id: 30003,
          sender: { card: "   ", nickname: "阿林" },
          message: [
            { type: "face", data: { id: 29 } },
            { type: "face", data: { id: "987654" } },
          ],
        },
        "90001",
      );
      if (result.kind !== "message") throw new Error("message expected");
      const recorded = recordObservation(h.orm, result.observation, DEFAULT_AGENT_ID);
      expect(recorded.recorded).toBe(true);
      const row = h.db
        .query("SELECT * FROM qq_message_facts WHERE event_key=?")
        .get(result.observation.eventKey) as Record<string, unknown>;
      const parts = JSON.parse(row!.parts as string) as Array<{
        kind: string;
        id: string;
        name: string | null;
      }>;
      // 有序 face 片段原位：known 命中官方短名；unknown 大 ID 不猜、null（§7.3），不走 vision。
      expect(parts).toEqual([
        { kind: "face", id: "29", name: "悠闲" },
        { kind: "face", id: "987654", name: null },
      ]);
    } finally {
      h.close();
    }
  });

  it("stores image parts with the stable media note id and verified unknown category (T03a)", () => {
    const h = setup();
    try {
      bind(h);
      const result = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -105,
          user_id: 10001,
          group_id: 30003,
          sender: { nickname: "阿林" },
          message: [
            { type: "text", data: { text: "看" } },
            { type: "image", data: { file: "a.png" } },
          ],
        },
        "90001",
      );
      if (result.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, result.observation, DEFAULT_AGENT_ID);
      const row = h.db
        .query("SELECT parts FROM qq_message_facts WHERE event_key=?")
        .get(result.observation.eventKey) as { parts: string };
      const parts = JSON.parse(row.parts) as Array<{ kind: string; mediaId?: string }>;
      // image 片段真实关联同事务稳定下来的 media 行身份，不再是 unavailable；
      // 入站只能核实的类别是 unknown（没有分类就不冒充 ordinary/expression）。
      expect(parts.map((p) => p.kind)).toEqual(["text", "image"]);
      expect(parts[1]).toMatchObject({ category: "unknown" });
      expect(typeof parts[1]!.mediaId).toBe("string");
      const note = h.db
        .query("SELECT id FROM qq_media_notes WHERE event_key=? AND segment_index=1")
        .get(result.observation.eventKey) as { id: string };
      expect(parts[1]!.mediaId).toBe(note.id);
    } finally {
      h.close();
    }
  });

  it("keeps the reply relation in its column and does not render it as unknown media (T03a)", () => {
    const h = setup();
    try {
      bind(h);
      const observation = alinObservation(-106);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      const row = h.db
        .query("SELECT parts,reply_to_message_id FROM qq_message_facts WHERE event_key=?")
        .get(observation.eventKey) as { parts: string; reply_to_message_id: string };
      const parts = JSON.parse(row.parts) as Array<{ kind: string }>;
      // reply 关系单列在 reply_to_message_id；片段不再造 unavailable 占位。
      expect(parts.map((p) => p.kind)).toEqual(["mention", "text"]);
      expect(row.reply_to_message_id).toBe("-101");
    } finally {
      h.close();
    }
  });

  it("distinguishes absent fields (use local value) from explicit blank (clear card)", () => {
    const h = setup();
    try {
      bind(h);
      // 第一条：card="老名"（wire 原值），nickname="旧昵"。
      const first = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -1,
          user_id: 10001,
          group_id: 30003,
          sender: { card: "老名", nickname: "旧昵" },
          message: [{ type: "text", data: { text: "一" } }],
        },
        "90001",
      );
      if (first.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, first.observation, DEFAULT_AGENT_ID);
      // 第二条：card="   "（显式清空）+ nickname="新名" —— 显示名回退昵称，不沿用旧 card。
      const second = normalizeOneBotMessage(
        {
          time: at + 10,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -2,
          user_id: 10001,
          group_id: 30003,
          sender: { card: "   ", nickname: "新名" },
          message: [{ type: "text", data: { text: "二" } }],
        },
        "90001",
      );
      if (second.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, second.observation, DEFAULT_AGENT_ID);
      const facts = h.db
        .query(
          "SELECT group_card,group_card_source,personal_nickname,personal_nickname_source FROM qq_message_facts WHERE event_key=?",
        )
        .get(second.observation.eventKey) as {
        group_card: string | null;
        group_card_source: string | null;
        personal_nickname: string;
        personal_nickname_source: string;
      };
      // 显示名是"新名"且当前 groupCard 被清空（不是旧"老名"）——清空带 'wire' 来源。
      expect(facts.group_card).toBeNull();
      expect(facts.group_card_source).toBe("wire");
      expect(facts.personal_nickname).toBe("新名");
      expect(facts.personal_nickname_source).toBe("wire");
      const member = h.db
        .query("SELECT group_card,personal_nickname,nickname FROM qq_members WHERE user_id=?")
        .get("10001") as { group_card: string | null; personal_nickname: string; nickname: string };
      expect(member.group_card).toBeNull();
      expect(member.personal_nickname).toBe("新名");
    } finally {
      h.close();
    }
  });

  it("absent sender fields fall back to the local current value and are recorded as local", () => {
    const h = setup();
    try {
      bind(h);
      const first = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -1,
          user_id: 10001,
          group_id: 30003,
          sender: { card: "老名", nickname: "旧昵" },
          message: [{ type: "text", data: { text: "一" } }],
        },
        "90001",
      );
      if (first.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, first.observation, DEFAULT_AGENT_ID);
      // 第二条：sender 字段缺省（不是清空）——快照可用本地有效值。
      const second = normalizeOneBotMessage(
        {
          time: at + 10,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -2,
          user_id: 10001,
          group_id: 30003,
          sender: {},
          message: [{ type: "text", data: { text: "二" } }],
        },
        "90001",
      );
      if (second.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, second.observation, DEFAULT_AGENT_ID);
      const facts = h.db
        .query(
          "SELECT group_card,group_card_source,personal_nickname,personal_nickname_source FROM qq_message_facts WHERE event_key=?",
        )
        .get(second.observation.eventKey) as {
        group_card: string | null;
        group_card_source: string | null;
        personal_nickname: string | null;
        personal_nickname_source: string | null;
      };
      expect(facts.group_card).toBe("老名");
      expect(facts.group_card_source).toBe("local");
      expect(facts.personal_nickname).toBe("旧昵");
      expect(facts.personal_nickname_source).toBe("local");
    } finally {
      h.close();
    }
  });

  it("half-wire nick keeps the other field's local value instead of dropping it (fix2)", () => {
    // §3.1：字段未提供可按已确认规则使用本地有效信息——wire 只带 nickname 时，
    // card 缺省字段仍读本地当前值，不得因任一字段非空而短路丢掉另一字段。
    const h = setup();
    try {
      bind(h);
      rememberQqMemberNames(h.orm, {
        scope: { accountId: "90001", conversationKind: "group", peerId: "30003" },
        userId: "10001",
        names: { groupCard: "旧card", personalNickname: "旧nick" },
        seenAtSeconds: at - 10,
      });
      const obs = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -31,
          user_id: 10001,
          group_id: 30003,
          sender: { nickname: "新wire昵" },
          message: [{ type: "text", data: { text: "甲" } }],
        },
        "90001",
      );
      if (obs.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, obs.observation, DEFAULT_AGENT_ID);
      const row = h.db
        .query(
          "SELECT group_card,group_card_source,personal_nickname,personal_nickname_source,name_state FROM qq_message_facts WHERE event_key=?",
        )
        .get(obs.observation.eventKey) as Record<string, unknown>;
      expect(row.group_card).toBe("旧card");
      expect(row.group_card_source).toBe("local");
      expect(row.personal_nickname).toBe("新wire昵");
      expect(row.personal_nickname_source).toBe("wire");
      expect(row.name_state).toBe("known");
    } finally {
      h.close();
    }
  });

  it("half-wire card keeps the local nickname instead of dropping it (fix2)", () => {
    // 反方向：wire 只带 card 时，nickname 缺省字段同样保留本地当前值。
    const h = setup();
    try {
      bind(h);
      rememberQqMemberNames(h.orm, {
        scope: { accountId: "90001", conversationKind: "group", peerId: "30003" },
        userId: "10001",
        names: { groupCard: "旧card", personalNickname: "旧nick" },
        seenAtSeconds: at - 10,
      });
      const obs = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -32,
          user_id: 10001,
          group_id: 30003,
          sender: { card: "新wire卡" },
          message: [{ type: "text", data: { text: "甲" } }],
        },
        "90001",
      );
      if (obs.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, obs.observation, DEFAULT_AGENT_ID);
      const row = h.db
        .query(
          "SELECT group_card,group_card_source,personal_nickname,personal_nickname_source,name_state FROM qq_message_facts WHERE event_key=?",
        )
        .get(obs.observation.eventKey) as Record<string, unknown>;
      expect(row.group_card).toBe("新wire卡");
      expect(row.group_card_source).toBe("wire");
      expect(row.personal_nickname).toBe("旧nick");
      expect(row.personal_nickname_source).toBe("local");
      expect(row.name_state).toBe("known");
    } finally {
      h.close();
    }
  });

  it("explicit dual blank clears the snapshot and does not borrow a legacy display name (fix2)", () => {
    // §3.1 清空语义：wire 显式双空白是"本次明确无名字"，快照应 unknown 且 legacy_display_name
    // 为 null——旧目录的单昵称不是这条消息的名称证据，不得借它复活。
    const h = setup();
    try {
      bind(h);
      h.orm
        .insert(schema.qqMembers)
        .values({
          accountId: "90001",
          conversationKind: "group",
          peerId: "30003",
          userId: "10001",
          nickname: "旧显示",
          firstSeenAtSeconds: at,
          lastSeenAtSeconds: at,
          expiresAt: "2026-10-20T00:00:00.000000Z",
          nameState: "legacy",
          groupCard: null,
          personalNickname: null,
        })
        .run();
      const obs = normalizeOneBotMessage(
        {
          time: at + 1,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -33,
          user_id: 10001,
          group_id: 30003,
          sender: { card: "", nickname: "" },
          message: [{ type: "text", data: { text: "甲" } }],
        },
        "90001",
      );
      if (obs.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, obs.observation, DEFAULT_AGENT_ID);
      const row = h.db
        .query(
          "SELECT group_card,group_card_source,personal_nickname,personal_nickname_source,legacy_display_name,name_state FROM qq_message_facts WHERE event_key=?",
        )
        .get(obs.observation.eventKey) as Record<string, unknown>;
      expect(row.group_card).toBeNull();
      // F4：显式 wire 清空是"已核清空"（来源 'wire'），不是无证据缺省。
      expect(row.group_card_source).toBe("wire");
      expect(row.personal_nickname).toBeNull();
      expect(row.personal_nickname_source).toBe("wire");
      expect(row.legacy_display_name).toBeNull();
      expect(row.name_state).toBe("unknown");
    } finally {
      h.close();
    }
  });

  it("never rewinds the current directory on an older or same-second delivery", () => {
    const h = setup();
    try {
      bind(h);
      const older = alinObservation(-102, "旧消息");
      recordObservation(h.orm, older, DEFAULT_AGENT_ID);
      // 乱序（时间更早）的改名观察不能回退当前目录。
      const newerTime = at + 10;
      const late = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -3,
          user_id: 10001,
          group_id: 30003,
          sender: { card: "新名片", nickname: "阿林" },
          message: [{ type: "text", data: { text: "迟到" } }],
        },
        "90001",
      );
      if (late.kind !== "message") throw new Error("message expected");
      // 直接以更早 seenAt 记录：目录只前进。
      rememberQqMemberNames(h.orm, {
        scope: { accountId: "90001", conversationKind: "group", peerId: "30003" },
        userId: "10001",
        names: { groupCard: "新名片", personalNickname: "阿林" },
        seenAtSeconds: newerTime,
      });
      const before = h.db
        .query("SELECT group_card FROM qq_members WHERE user_id=?")
        .get("10001") as { group_card: string | null };
      expect(before.group_card).toBe("新名片");
      // 迟到交付（time 更早）不改当前目录。（fixture 修正：recordObservation 要的是
      // observation 本身，不是 normalized wrapper——原代理传错只暴露了 TypeError，
      // 不代表回退断言失败。）
      recordObservation(h.orm, late.observation, DEFAULT_AGENT_ID);
      const after = h.db
        .query("SELECT group_card FROM qq_members WHERE user_id=?")
        .get("10001") as { group_card: string | null };
      expect(after.group_card).toBe("新名片");
    } finally {
      h.close();
    }
  });

  it("redelivery after a directory rename stays idempotent and keeps the original snapshot (F1)", () => {
    // F1 复现：消息 A wire 缺省名字 → 快照记当时本地"旧名"；随后消息 B wire 新名推进当前
    // 目录；A 被再交付时快照不得按"现在的目录"重新解析出新名——时间依赖的 local 回退不能
    // 改写历史快照，幂等路径必须保持原值原 revision 原 expiry。
    const h = setup();
    try {
      bind(h);
      // 消息 A：sender 字段缺省（wire 无名字），目录此刻为"旧名/旧昵"。
      rememberQqMemberNames(h.orm, {
        scope: { accountId: "90001", conversationKind: "group", peerId: "30003" },
        userId: "10001",
        names: { groupCard: "旧名", personalNickname: "旧昵" },
        seenAtSeconds: at - 10,
      });
      const a = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -21,
          user_id: 10001,
          group_id: 30003,
          sender: {},
          message: [{ type: "text", data: { text: "甲" } }],
        },
        "90001",
      );
      if (a.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, a.observation, DEFAULT_AGENT_ID);
      const snapshotOf = () =>
        h.db
          .query(
            "SELECT group_card,group_card_source,personal_nickname,personal_nickname_source,legacy_display_name,name_state,revision,expires_at,recorded_at,parts FROM qq_message_facts WHERE event_key=?",
          )
          .get(a.observation.eventKey) as Record<string, unknown>;
      const first = snapshotOf();
      expect(first.recorded_at).toBeDefined();
      expect(first.group_card).toBe("旧名");
      expect(first.group_card_source).toBe("local");
      expect(first.personal_nickname).toBe("旧昵");
      expect(first.personal_nickname_source).toBe("local");
      expect(first.name_state).toBe("known");
      expect(first.revision).toBe(1);
      // 消息 B：wire 新名，目录前进。
      const b = normalizeOneBotMessage(
        {
          time: at + 10,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -22,
          user_id: 10001,
          group_id: 30003,
          sender: { card: "新名", nickname: "新昵" },
          message: [{ type: "text", data: { text: "乙" } }],
        },
        "90001",
      );
      if (b.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, b.observation, DEFAULT_AGENT_ID);
      const member = h.db
        .query("SELECT group_card,personal_nickname,name_state FROM qq_members WHERE user_id=?")
        .get("10001") as { group_card: string; personal_nickname: string; name_state: string };
      expect(member.group_card).toBe("新名");
      expect(member.personal_nickname).toBe("新昵");
      // 重放 A：不抛错、幂等返回 recorded:false，快照保持原值（不得解析出新名）。
      const replay = recordObservation(h.orm, a.observation, DEFAULT_AGENT_ID);
      expect(replay.recorded).toBe(false);
      const second = snapshotOf();
      expect(second.group_card).toBe("旧名");
      expect(second.group_card_source).toBe("local");
      expect(second.personal_nickname).toBe("旧昵");
      expect(second.personal_nickname_source).toBe("local");
      expect(second.name_state).toBe("known");
      expect(second.revision).toBe(1);
      expect(second.expires_at).toBe(first.expires_at);
      expect(second.recorded_at).toBe(first.recorded_at);
      expect(second.parts).toBe(first.parts);
      // 幂等路径也不得反向改写当前目录（重放不推进 last_seen）。
      const memberAfter = h.db
        .query("SELECT group_card FROM qq_members WHERE user_id=?")
        .get("10001") as { group_card: string };
      expect(memberAfter.group_card).toBe("新名");
    } finally {
      h.close();
    }
  });

  it("a genuine wire name conflict on redelivery is still refused (F1 negative)", () => {
    // 幂等路径对 wire 原值的冲突不放宽：同键同身份但 wire 带来不同原值 → 拒绝。
    const h = setup();
    try {
      bind(h);
      const a = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -23,
          user_id: 10001,
          group_id: 30003,
          sender: { card: "原名", nickname: "原昵" },
          message: [{ type: "text", data: { text: "甲" } }],
        },
        "90001",
      );
      if (a.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, a.observation, DEFAULT_AGENT_ID);
      // 同键伪造 wire 名：不同的事实 → 拒（identity 校验通过，facts 冲突拒绝）。
      const forged = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -23,
          user_id: 10001,
          group_id: 30003,
          sender: { card: "冒名", nickname: "原昵" },
          message: [{ type: "text", data: { text: "甲" } }],
        },
        "90001",
      );
      if (forged.kind !== "message") throw new Error("message expected");
      expect(() => recordObservation(h.orm, forged.observation, DEFAULT_AGENT_ID)).toThrow();
      const row = h.db
        .query("SELECT group_card,revision FROM qq_message_facts WHERE event_key=?")
        .get(a.observation.eventKey) as { group_card: string; revision: number };
      expect(row.group_card).toBe("原名");
      expect(row.revision).toBe(1);
    } finally {
      h.close();
    }
  });

  it("deleting the observation body does not resurrect it or extend expiry on redelivery (F6)", () => {
    const h = setup();
    try {
      bind(h);
      const observation = alinObservation(-102);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      const before = h.db
        .query("SELECT expires_at FROM qq_observation_text WHERE event_key=?")
        .get(observation.eventKey) as { expires_at: string };
      // 物理删除正文（模拟过期清理/手动清理）。
      h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(observation.eventKey);
      const redeliver = recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      expect(redeliver.recorded).toBe(false);
      expect(redeliver.hasText).toBe(false);
      // 正文不复活、不续期。
      const body = h.db
        .query("SELECT * FROM qq_observation_text WHERE event_key=?")
        .get(observation.eventKey);
      expect(body).toBeNull();
      expect(before.expires_at).toBeDefined();
      // 永久身份还在。
      expect((h.db.query("SELECT COUNT(*) AS n FROM qq_events").get() as { n: number }).n).toBe(1);
    } finally {
      h.close();
    }
  });

  it("redelivery of a truly nameless wire fills missing facts from wire absence, not the latest directory (F1, placeholder)", () => {
    // facts 缺失重建（§4.5）：journal 先占位后实时再交付。发送时 wire 本来就无名
    // （sender 双字段缺省）——补回必须如实保持"这条消息无名"（unknown/双 null），
    // 不得用"现在的目录"伪造成发送时名。
    const h = setup();
    try {
      bind(h);
      // 发送时 wire 无名字：整条 sender 不带 card/nickname 字段。
      const a = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -24,
          user_id: 10001,
          group_id: 30003,
          sender: {},
          message: [{ type: "text", data: { text: "甲" } }],
        },
        "90001",
      );
      if (a.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, a.observation, DEFAULT_AGENT_ID);
      // 模拟 journal 先占位：facts 名字缺失（真 unknown——值与来源双 NULL，不是已核清空）。
      h.orm
        .update(schema.qqMessageFacts)
        .set({
          groupCard: null,
          groupCardSource: null,
          personalNickname: null,
          personalNicknameSource: null,
          nameState: "unknown",
        })
        .where(eq(schema.qqMessageFacts.eventKey, a.observation.eventKey))
        .run();
      // 目录已推进到别的名字——补回不得借它。
      rememberQqMemberNames(h.orm, {
        scope: { accountId: "90001", conversationKind: "group", peerId: "30003" },
        userId: "10001",
        names: { groupCard: "后续名", personalNickname: "后续昵" },
        seenAtSeconds: at + 10,
      });
      const replay = recordObservation(h.orm, a.observation, DEFAULT_AGENT_ID);
      expect(replay.recorded).toBe(false);
      const row = h.db
        .query(
          "SELECT group_card,personal_nickname,legacy_display_name,name_state,revision,expires_at FROM qq_message_facts WHERE event_key=?",
        )
        .get(a.observation.eventKey) as Record<string, unknown>;
      // 如实双 wire 缺省：保持 unknown 双 null，不伪目录名。
      expect(row.group_card).toBeNull();
      expect(row.personal_nickname).toBeNull();
      expect(row.legacy_display_name).toBeNull();
      expect(row.name_state).toBe("unknown");
      expect(row.revision).toBe(1);
      expect(row.expires_at).toBeDefined();
    } finally {
      h.close();
    }
  });

  it("redelivery of a dual-wire message refills wire facts without borrowing the latest directory (F1, placeholder)", () => {
    // 对照：发送时 wire 双名齐备——补回用 wire 原值，不用目录当前值。
    const h = setup();
    try {
      bind(h);
      rememberQqMemberNames(h.orm, {
        scope: { accountId: "90001", conversationKind: "group", peerId: "30003" },
        userId: "10001",
        names: { groupCard: "目录名", personalNickname: "目录昵" },
        seenAtSeconds: at - 10,
      });
      const a = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          message_id: -25,
          user_id: 10001,
          group_id: 30003,
          sender: { card: "wire名", nickname: "wire昵" },
          message: [{ type: "text", data: { text: "甲" } }],
        },
        "90001",
      );
      if (a.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, a.observation, DEFAULT_AGENT_ID);
      h.orm
        .update(schema.qqMessageFacts)
        .set({
          groupCard: null,
          groupCardSource: null,
          personalNickname: null,
          personalNicknameSource: null,
          nameState: "unknown",
        })
        .where(eq(schema.qqMessageFacts.eventKey, a.observation.eventKey))
        .run();
      rememberQqMemberNames(h.orm, {
        scope: { accountId: "90001", conversationKind: "group", peerId: "30003" },
        userId: "10001",
        names: { groupCard: "后续名", personalNickname: "后续昵" },
        seenAtSeconds: at + 10,
      });
      const replay = recordObservation(h.orm, a.observation, DEFAULT_AGENT_ID);
      expect(replay.recorded).toBe(false);
      const row = h.db
        .query(
          "SELECT group_card,group_card_source,personal_nickname,personal_nickname_source,name_state,revision FROM qq_message_facts WHERE event_key=?",
        )
        .get(a.observation.eventKey) as Record<string, unknown>;
      expect(row.group_card).toBe("wire名");
      expect(row.group_card_source).toBe("wire");
      expect(row.personal_nickname).toBe("wire昵");
      expect(row.personal_nickname_source).toBe("wire");
      expect(row.name_state).toBe("known");
      expect(row.revision).toBe(2);
    } finally {
      h.close();
    }
  });
});

describe("backfill and revision", () => {
  it("fills a missing reply relation on a placeholder row and advances revision", () => {
    const h = setup();
    try {
      bind(h);
      const observation = alinObservation(-102);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      // 模拟"占位后补齐"：删掉 facts 行的引用关系，再 backfill 回真实值。
      h.db.exec(
        "UPDATE qq_message_facts SET reply_to_message_id=NULL, parts='[]', name_state='unknown' WHERE event_key IS NOT NULL",
      );
      const before = h.db
        .query("SELECT revision FROM qq_message_facts WHERE event_key=?")
        .get(observation.eventKey) as { revision: number };
      const row = backfillQqMessageFact(h.orm, {
        eventKey: observation.eventKey,
        groupCard: null,
        personalNickname: "阿林",
        legacyDisplayName: null,
        nameState: "known",
        parts: [{ kind: "text", text: "你不是就在南京吗？" }],
        replyToMessageId: "-101",
        occurredAtSeconds: at,
      });
      expect(row.revision).toBe(before.revision + 1);
      expect(row.replyToMessageId).toBe("-101");
      expect(row.nameState).toBe("known");
    } finally {
      h.close();
    }
  });

  it("refuses to overwrite an existing conflicting fact", () => {
    const h = setup();
    try {
      bind(h);
      const observation = alinObservation(-102);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      expect(() =>
        backfillQqMessageFact(h.orm, {
          eventKey: observation.eventKey,
          groupCard: null,
          personalNickname: "另一个人",
          legacyDisplayName: null,
          nameState: "known",
          parts: [],
          replyToMessageId: "-999",
          occurredAtSeconds: at,
        }),
      ).toThrow();
      // 原事实保持不变。
      const row = h.db
        .query(
          "SELECT personal_nickname,reply_to_message_id FROM qq_message_facts WHERE event_key=?",
        )
        .get(observation.eventKey) as { personal_nickname: string; reply_to_message_id: string };
      expect(row.personal_nickname).toBe("阿林");
      expect(row.reply_to_message_id).toBe("-101");
    } finally {
      h.close();
    }
  });

  it("identical redelivery keeps facts and does not refresh the expiry", () => {
    const h = setup();
    try {
      bind(h);
      const observation = alinObservation(-102);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      const first = h.db
        .query("SELECT expires_at,recorded_at,revision FROM qq_message_facts WHERE event_key=?")
        .get(observation.eventKey) as Record<string, string>;
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      const second = h.db
        .query("SELECT expires_at,recorded_at,revision FROM qq_message_facts WHERE event_key=?")
        .get(observation.eventKey) as Record<string, string>;
      expect(second.expires_at).toBe(first.expires_at);
      expect(second.recorded_at).toBe(first.recorded_at);
      expect(second.revision).toBe(first.revision);
    } finally {
      h.close();
    }
  });

  it("a redelivery of the same identity fills a placeholder's missing facts (T03a)", () => {
    // §4.5：journal 先占位时实时再交付要能补缺——同键同身份、只补缺失，不延 expiry、
    // 不重排 journal；补齐推进 revision。
    const h = setup();
    try {
      bind(h);
      const observation = alinObservation(-102);
      // 先只建永久身份占位：手动插 events + 空 facts（模拟 journal append 先占位）。
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: observation.eventKey,
          accountId: observation.accountId,
          conversationKind: observation.conversation.kind,
          peerId: observation.conversation.peerId,
          agentId: DEFAULT_AGENT_ID,
          messageId: observation.messageId,
          occurredAtSeconds: observation.occurredAtSeconds,
          speakerKind: observation.speaker.kind,
          speakerId: observation.speaker.id,
          addressed: 0,
          recordedAt: now,
        })
        .run();
      h.orm
        .insert(schema.qqMessageFacts)
        .values({
          eventKey: observation.eventKey,
          groupCard: null,
          personalNickname: null,
          legacyDisplayName: null,
          nameState: "unknown",
          parts: "[]",
          replyToMessageId: null,
          revision: 1,
          expiresAt: "2026-10-20T00:00:00.000000Z",
          recordedAt: now,
        })
        .run();
      const result = recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      expect(result.recorded).toBe(false);
      const row = h.db
        .query("SELECT * FROM qq_message_facts WHERE event_key=?")
        .get(observation.eventKey) as Record<string, unknown>;
      expect(row).toMatchObject({
        personal_nickname: "阿林",
        name_state: "known",
        reply_to_message_id: "-101",
        revision: 2,
      });
      // expiry 不被再交付延长。
      expect(row.expires_at).toBe("2026-10-20T00:00:00.000000Z");
      const parts = JSON.parse(row.parts as string) as Array<{ kind: string }>;
      expect(parts.map((p) => p.kind)).toEqual(["mention", "text"]);
    } finally {
      h.close();
    }
  });

  it("backfill fills only a missing reply when names are known and do not conflict (T03a)", () => {
    const h = setup();
    try {
      bind(h);
      const observation = alinObservation(-102);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      const before = h.db
        .query("SELECT revision,expires_at,recorded_at FROM qq_message_facts WHERE event_key=?")
        .get(observation.eventKey) as Record<string, string>;
      h.db.exec("UPDATE qq_message_facts SET reply_to_message_id=NULL WHERE event_key IS NOT NULL");
      const row = backfillQqMessageFact(h.orm, {
        eventKey: observation.eventKey,
        groupCard: null,
        personalNickname: "阿林",
        legacyDisplayName: null,
        nameState: "known",
        parts: [
          { kind: "mention", qq: "10002" },
          { kind: "text", text: "你不是就在南京吗？" },
        ],
        replyToMessageId: "-101",
        occurredAtSeconds: at,
      });
      expect(row.revision).toBe(Number(before.revision) + 1);
      expect(row.replyToMessageId).toBe("-101");
      expect(row.nameState).toBe("known");
      // expiry 是消息自己的窗口：backfill 只补缺失，不延长（§4.5）。
      expect(row.expiresAt).toBe(before.expires_at);
    } finally {
      h.close();
    }
  });

  it("backfill refuses a legacy display name conflict and a text conflict (T03a)", () => {
    const h = setup();
    try {
      bind(h);
      const observation = alinObservation(-102);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      // legacy：已存 legacyDisplayName 非空时，不同的 legacy 值拒绝。
      h.db.exec(
        "UPDATE qq_message_facts SET legacy_display_name='旧显示', name_state='legacy' WHERE event_key IS NOT NULL",
      );
      expect(() =>
        backfillQqMessageFact(h.orm, {
          eventKey: observation.eventKey,
          groupCard: null,
          personalNickname: null,
          legacyDisplayName: "另一个显示",
          nameState: "legacy",
          parts: [],
          replyToMessageId: null,
          occurredAtSeconds: at,
        }),
      ).toThrow();
      // 正文：已存非空片段与补记不同 → 拒绝，原片段保持。
      h.db.exec(
        "UPDATE qq_message_facts SET legacy_display_name=NULL, name_state='known' WHERE event_key IS NOT NULL",
      );
      expect(() =>
        backfillQqMessageFact(h.orm, {
          eventKey: observation.eventKey,
          groupCard: null,
          personalNickname: "阿林",
          legacyDisplayName: null,
          nameState: "known",
          parts: [{ kind: "text", text: "别的正文" }],
          replyToMessageId: "-101",
          occurredAtSeconds: at,
        }),
      ).toThrow();
      const row = h.db
        .query("SELECT parts FROM qq_message_facts WHERE event_key=?")
        .get(observation.eventKey) as { parts: string };
      expect(JSON.parse(row.parts)).toEqual([
        { kind: "mention", qq: "10002" },
        { kind: "text", text: "你不是就在南京吗？" },
      ]);
    } finally {
      h.close();
    }
  });
});

/** bind 后回填真实 conversation/binding 字段，构造当前有效 scope（不用占位假 ID）。 */
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

describe("fact projection (projectQqMessageFacts)", () => {
  it("projects the snapshot with speaker identity and ordered parts inside scope", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      journal.ingestOneBotEvent(observation.eventKey, "binding");
      const live = liveScope(h, conversation);
      // 锁定签名：loadQqMessageFact(store, scope, platformId, now) → fact | null。
      const load = loadQqMessageFact(h, live, "-102", now);
      expect(load).not.toBeNull();
      expect(load).toMatchObject({
        platformMessageId: "-102",
        completeness: "full",
        replyTo: { platformMessageId: "-101" },
      });
      expect(load?.speaker).toMatchObject({
        role: "member",
        qq: "10001",
        groupCard: null,
        personalNickname: "阿林",
        nameState: "known",
      });
      // 有序片段：mention/text 按 wire 原序；reply 单列，不再渲染 unavailable 占位。
      expect(load?.parts.map((p) => p.kind)).toEqual(["mention", "text"]);
      // 来源：可复验的过期事实来源 + 可读正文来源；永久 qq_event 身份不作 ref。
      expect(load?.sources.map((s) => s.kind)).toEqual(["qq_message_fact", "qq_observation"]);
      // 批量投影按内部事件键取（锁定签名 → 数组）。
      const projected = projectQqMessageFacts(h, live, [observation.eventKey], now);
      expect(projected).toHaveLength(1);
      expect(projected[0]?.platformMessageId).toBe("-102");
    } finally {
      h.close();
    }
  });

  it("gives no fact for an expired snapshot instead of borrowing current member names", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const observation = alinObservation(-102);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      journal.ingestOneBotEvent(observation.eventKey, "binding");
      // 到期时刻之后读取：整个事实不可用（fact null）；member 目录即使有当前名字，
      // 也不能经 currentName 复活快照——强断言无任何昵称回填。
      const expired = "2026-10-20T00:00:00.000000Z";
      const load = loadQqMessageFact(h, liveScope(h, conversation), "-102", expired);
      expect(load).toBeNull();
      expect(loadQqMessageFact(h, liveScope(h, conversation), "-102", now)).not.toBeNull();
    } finally {
      h.close();
    }
  });

  it("reports null for an unknown platform ID and out_of_scope across conversations", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const live = liveScope(h, conversation);
      // 未知 ID：null（不泄露存在性）。
      expect(loadQqMessageFact(h, live, "-777", now)).toBeNull();
      const observation = alinObservation(-102);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      journal.ingestOneBotEvent(observation.eventKey, "binding");
      // 另一间真实绑定的群查同一条消息：scope 过滤 fail closed，返回 null 不泄露别群内容。
      bind(h, "binding2", "30004");
      const otherConversation = journal.ensureOneBot("binding2");
      // fixture 失败直接显式报错，不用非空断言遮蔽。
      if (!otherConversation) throw new Error("binding2 conversation not created");
      const other = liveScope(h, otherConversation, "binding2");
      expect(loadQqMessageFact(h, other, "-102", now)).toBeNull();
      // 批量投影：scope 外/未知键静默丢弃，空数组（不猜、不产出伪造事实）。
      expect(projectQqMessageFacts(h, other, [observation.eventKey], now)).toEqual([]);
      expect(projectQqMessageFacts(h, live, ["missing-key"], now)).toEqual([]);
    } finally {
      h.close();
    }
  });
});

/** 出站 intent 提交 helper（outbound identity 与 expiry cleanup 两个 describe 复用）。 */
function commitIntent(h: ReturnType<typeof setup>, conversation: { id: string }, intentId: string) {
  new AgentRunRepository(h.db).createRun({
    runId: `run-${intentId}`,
    specId: "main",
    specVersion: "1",
    owner: { kind: "conversation", id: conversation.id },
    at: now,
  });
  return new OutboundIntentRepository(h.db).commit({
    id: intentId,
    runId: `run-${intentId}`,
    conversationId: conversation.id,
    ordinal: 0,
    target: {
      accountId: "90001",
      conversationKind: "group",
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      bindingId: "binding",
      bindingEpoch: 1,
    },
    speechKind: "direct_reply",
    sourceThroughSeq: 0,
    deliverBy: later,
    createdAt: now,
    expiresAt: later,
    parts: [
      { kind: "text", text: "第一段" },
      { kind: "text", text: "第二段" },
    ],
  });
}

describe("outbound identity snapshot and part mapping", () => {
  it("stores the platform identity at commit and maps parts only after confirmation", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      const outbox = new OutboundIntentRepository(h.db);
      const intent = commitIntent(h, conversation, "intent-facts-1");
      // commit 时存身份快照（真实发送账号＝登录账号 90001；Agent UUID 不充当 QQ 号）。
      recordQqOutboundMessageFact(h.orm, {
        intentId: intent.id,
        accountId: "90001",
        agentId: DEFAULT_AGENT_ID,
        identity: {
          qq: "90001",
          groupCard: null,
          personalNickname: "群猫娘",
          legacyDisplayName: null,
          nameState: "known",
        },
        occurredAtSeconds: at,
      });
      const claim1 = outbox.claimPart(intent.id, now)!;
      expect(claim1.payload).toEqual({ text: "第一段" });
      // 未确认前：没有 part 映射——不能把计划中的文本当作已发原文。
      const before = projectQqOutboundMessageFacts(h.orm, intent.id, now);
      expect(before.parts).toEqual([]);
      outbox.settlePart(claim1.part.id, { status: "confirmed", messageId: "-201" }, now);
      confirmQqOutboundPart(h.orm, {
        intentId: intent.id,
        platformMessageId: "-201",
        kind: "text",
        ordinal: 0,
        text: "第一段",
      });
      const claim2 = outbox.claimPart(intent.id, now)!;
      // 第二个部件未确认：投影只有第一段。
      const after = projectQqOutboundMessageFacts(h.orm, intent.id, now);
      expect(after.identity).toMatchObject({ qq: "90001", personalNickname: "群猫娘" });
      expect(after.parts).toEqual([{ ordinal: 0, platformMessageId: "-201", text: "第一段" }]);
      outbox.settlePart(claim2.part.id, { status: "unknown" }, now);
      const final = projectQqOutboundMessageFacts(h.orm, intent.id, now);
      expect(final.parts).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("refuses remapping a confirmed part to a different platform message", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      commitIntent(h, conversation, "intent-x");
      recordQqOutboundMessageFact(h.orm, {
        intentId: "intent-x",
        accountId: "90001",
        agentId: DEFAULT_AGENT_ID,
        identity: {
          qq: "90001",
          groupCard: null,
          personalNickname: null,
          legacyDisplayName: null,
          nameState: "unknown",
        },
        occurredAtSeconds: at,
      });
      confirmQqOutboundPart(h.orm, {
        intentId: "intent-x",
        platformMessageId: "-301",
        kind: "text",
        ordinal: 0,
        text: "原文",
      });
      expect(() =>
        confirmQqOutboundPart(h.orm, {
          intentId: "intent-x",
          platformMessageId: "-302",
          kind: "text",
          ordinal: 0,
          text: "原文",
        }),
      ).toThrow();
    } finally {
      h.close();
    }
  });
});

describe("expiry cleanup extension", () => {
  it("purges expired fact rows under the nickname category and keeps the event identity", () => {
    const h = setup();
    try {
      const { conversation } = bind(h);
      const observation = alinObservation(-102);
      recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
      commitIntent(h, conversation, "intent-y");
      // 在用保护（sendProtected 同语义面）会保住仍被 planned/delivering/unknown 意图持有的
      // 出站事实行；本用例验证的是"已结算的到期事实会被清理"，所以先走真实发送通路把
      // intent 结算到 confirmed，再清理。
      const outbox = new OutboundIntentRepository(h.db);
      for (;;) {
        const claim = outbox.claimPart("intent-y", now);
        if (!claim) break;
        outbox.settlePart(
          claim.part.id,
          { status: "confirmed", messageId: `m-${claim.part.ordinal}` },
          now,
        );
      }
      recordQqOutboundMessageFact(h.orm, {
        intentId: "intent-y",
        accountId: "90001",
        agentId: DEFAULT_AGENT_ID,
        identity: {
          qq: "90001",
          groupCard: null,
          personalNickname: "群猫娘",
          legacyDisplayName: null,
          nameState: "known",
        },
        occurredAtSeconds: at,
      });
      const expired = "2026-10-20T00:00:00.000000Z";
      const counts = qqStorageCleanup(h.orm, expired);
      expect(counts.nicknames).toBeGreaterThanOrEqual(1);
      expect(counts.sends).toBeGreaterThanOrEqual(1);
      // 永久事件键不删。
      expect((h.db.query("SELECT COUNT(*) AS n FROM qq_events").get() as { n: number }).n).toBe(1);
      expect(
        (h.db.query("SELECT COUNT(*) AS n FROM qq_message_facts").get() as { n: number }).n,
      ).toBe(0);
      expect(
        (h.db.query("SELECT COUNT(*) AS n FROM qq_outbound_message_facts").get() as { n: number })
          .n,
      ).toBe(0);
      // 未到期：清理无写。
      const observation2 = alinObservation(-104);
      recordObservation(h.orm, observation2, DEFAULT_AGENT_ID);
      const before = (
        h.db.query("SELECT COUNT(*) AS n FROM qq_message_facts").get() as { n: number }
      ).n;
      qqStorageCleanup(h.orm, now);
      expect(
        (h.db.query("SELECT COUNT(*) AS n FROM qq_message_facts").get() as { n: number }).n,
      ).toBe(before);
    } finally {
      h.close();
    }
  });
});
