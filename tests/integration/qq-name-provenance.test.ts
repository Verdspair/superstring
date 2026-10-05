// F4（T03a name-provenance1）：`qq_message_facts` 逐字段姓名来源。
// 规格 §3.1：发送时快照记录所采用名称的证据来源——入站原值 'wire'、本地有效回退 'local'、
// 无证据/历史 NULL。NULL 不伪造成 wire 或 local；显式 wire 清空（值 null＋来源 'wire'）与
// 字段缺省（值 null＋来源 NULL）是两个不同事实。回填按"名字＋来源"pair 合并：已核清空
// 不复活、已记录名字不重标、占位只有真实 wire 补缺、source-only 核补推进 revision。

import { describe, expect, it } from "bun:test";
import { rememberQqMemberNames } from "../../src/server/db/qq-member-repository";
import { backfillQqMessageFact } from "../../src/server/db/qq-message-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { QqObservation } from "../../src/server/services/onebot-protocol";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const now = "2026-10-01T16:00:00.000000Z";

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}

function observationOf(
  messageId: number,
  sender: { card?: string; nickname?: string },
  text = "甲",
): QqObservation {
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
      sender,
      message: [{ type: "text", data: { text } }],
    },
    "90001",
  );
  if (result.kind !== "message") throw new Error("message expected");
  return result.observation;
}

type FactRow = {
  group_card: string | null;
  group_card_source: string | null;
  personal_nickname: string | null;
  personal_nickname_source: string | null;
  legacy_display_name: string | null;
  name_state: string;
  revision: number;
};

function factRow(h: ReturnType<typeof setup>, eventKey: string): FactRow {
  return h.db
    .query(
      "SELECT group_card,group_card_source,personal_nickname,personal_nickname_source," +
        "legacy_display_name,name_state,revision FROM qq_message_facts WHERE event_key=?",
    )
    .get(eventKey) as FactRow;
}

function seedDirectory(h: ReturnType<typeof setup>, card: string, nick: string) {
  rememberQqMemberNames(h.orm, {
    scope: { accountId: "90001", conversationKind: "group", peerId: "30003" },
    userId: "10001",
    names: { groupCard: card, personalNickname: nick },
    seenAtSeconds: at - 10,
  });
}

function seedLegacyDirectory(h: ReturnType<typeof setup>, legacyName: string) {
  h.orm
    .insert(schema.qqMembers)
    .values({
      accountId: "90001",
      conversationKind: "group",
      peerId: "30003",
      userId: "10001",
      nickname: legacyName,
      firstSeenAtSeconds: at,
      lastSeenAtSeconds: at,
      expiresAt: "2026-10-20T00:00:00.000000Z",
      nameState: "legacy",
      groupCard: null,
      personalNickname: null,
    })
    .run();
}

/** 模拟 journal 先占位：只建永久身份＋空 facts（名字与来源全 NULL 的真占位）。 */
function seedPlaceholder(h: ReturnType<typeof setup>, observation: QqObservation) {
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
}

describe("per-field name provenance at intake (F4)", () => {
  it("records a wire card and a local nickname with distinct per-field sources", () => {
    const h = setup();
    try {
      seedDirectory(h, "旧card", "旧nick");
      const obs = observationOf(-901, { card: "新wire卡" });
      recordObservation(h.orm, obs, DEFAULT_AGENT_ID);
      expect(factRow(h, obs.eventKey)).toMatchObject({
        group_card: "新wire卡",
        group_card_source: "wire",
        personal_nickname: "旧nick",
        personal_nickname_source: "local",
        name_state: "known",
      });
    } finally {
      h.close();
    }
  });

  it("records a wire nickname and a local card the other way round", () => {
    const h = setup();
    try {
      seedDirectory(h, "旧card", "旧nick");
      const obs = observationOf(-902, { nickname: "新wire昵" });
      recordObservation(h.orm, obs, DEFAULT_AGENT_ID);
      expect(factRow(h, obs.eventKey)).toMatchObject({
        group_card: "旧card",
        group_card_source: "local",
        personal_nickname: "新wire昵",
        personal_nickname_source: "wire",
        name_state: "known",
      });
    } finally {
      h.close();
    }
  });

  it("records an explicit wire blank as a wire-sourced clearing, distinct from absence", () => {
    const h = setup();
    try {
      seedDirectory(h, "旧card", "旧nick");
      // card 显式空白＝本次明确清空（值 null＋来源 'wire'）；nickname 缺省＝本地回退。
      const obs = observationOf(-903, { card: "   " });
      recordObservation(h.orm, obs, DEFAULT_AGENT_ID);
      expect(factRow(h, obs.eventKey)).toMatchObject({
        group_card: null,
        group_card_source: "wire",
        personal_nickname: "旧nick",
        personal_nickname_source: "local",
        name_state: "known",
      });
    } finally {
      h.close();
    }
  });

  it("keeps absent names without local evidence at NULL value and NULL source", () => {
    const h = setup();
    try {
      const obs = observationOf(-904, {});
      recordObservation(h.orm, obs, DEFAULT_AGENT_ID);
      // 无目录证据：不伪造成 wire 或 local，来源保持 NULL（历史未知）。
      expect(factRow(h, obs.eventKey)).toMatchObject({
        group_card: null,
        group_card_source: null,
        personal_nickname: null,
        personal_nickname_source: null,
        name_state: "unknown",
      });
    } finally {
      h.close();
    }
  });

  it("keeps a legacy directory row on the single legacy name without dual sources", () => {
    const h = setup();
    try {
      seedLegacyDirectory(h, "旧显示");
      const obs = observationOf(-905, {});
      recordObservation(h.orm, obs, DEFAULT_AGENT_ID);
      // §13.5：legacy 单昵称不伪造成 wire/local 双名，双名字段与来源都保持 NULL。
      expect(factRow(h, obs.eventKey)).toMatchObject({
        group_card: null,
        group_card_source: null,
        personal_nickname: null,
        personal_nickname_source: null,
        legacy_display_name: "旧显示",
        name_state: "legacy",
      });
    } finally {
      h.close();
    }
  });

  it("records no names and no sources for anonymous speakers", () => {
    const h = setup();
    try {
      const result = normalizeOneBotMessage(
        {
          time: at,
          self_id: 90001,
          post_type: "message",
          message_type: "group",
          sub_type: "anonymous",
          message_id: -906,
          user_id: 10001,
          group_id: 30003,
          message: [{ type: "text", data: { text: "甲" } }],
        },
        "90001",
      );
      if (result.kind !== "message") throw new Error("message expected");
      recordObservation(h.orm, result.observation, DEFAULT_AGENT_ID);
      expect(factRow(h, result.observation.eventKey)).toMatchObject({
        group_card: null,
        group_card_source: null,
        personal_nickname: null,
        personal_nickname_source: null,
        name_state: "unknown",
      });
    } finally {
      h.close();
    }
  });
});

describe("backfill name+source pairs (F4)", () => {
  it("refuses to revive a wire-verified clearing with a later string backfill", () => {
    const h = setup();
    try {
      const obs = observationOf(-911, { card: "   ", nickname: "阿林" });
      recordObservation(h.orm, obs, DEFAULT_AGENT_ID);
      expect(factRow(h, obs.eventKey)).toMatchObject({
        group_card: null,
        group_card_source: "wire",
      });
      expect(() =>
        backfillQqMessageFact(h.orm, {
          eventKey: obs.eventKey,
          groupCard: "复活名",
          groupCardSource: "wire",
          personalNickname: "阿林",
          personalNicknameSource: "wire",
          legacyDisplayName: null,
          nameState: "known",
          parts: [],
          replyToMessageId: null,
          occurredAtSeconds: at,
        }),
      ).toThrow();
      expect(factRow(h, obs.eventKey)).toMatchObject({
        group_card: null,
        group_card_source: "wire",
        revision: 1,
      });
    } finally {
      h.close();
    }
  });

  it("ignores an absent-field redelivery on a recorded local value (no relabel, no revision)", () => {
    const h = setup();
    try {
      seedDirectory(h, "旧名", "旧昵");
      const obs = observationOf(-912, {});
      recordObservation(h.orm, obs, DEFAULT_AGENT_ID);
      const first = factRow(h, obs.eventKey);
      expect(first).toMatchObject({
        group_card: "旧名",
        group_card_source: "local",
        personal_nickname: "旧昵",
        personal_nickname_source: "local",
        revision: 1,
      });
      const replay = recordObservation(h.orm, obs, DEFAULT_AGENT_ID);
      expect(replay.recorded).toBe(false);
      // 无变化：值与来源都不动，revision 不推进（expiry/journal 同样不动）。
      expect(factRow(h, obs.eventKey)).toEqual(first);
    } finally {
      h.close();
    }
  });

  it("does not relabel a recorded local source when wire repeats the same value", () => {
    const h = setup();
    try {
      seedDirectory(h, "旧名", "旧昵");
      const first = observationOf(-913, {});
      recordObservation(h.orm, first, DEFAULT_AGENT_ID);
      // 同键再交付但本次 wire 带来同名原值：值相同 → 不把 local 改标 wire。
      const replay = observationOf(-913, { card: "旧名", nickname: "旧昵" });
      const result = recordObservation(h.orm, replay, DEFAULT_AGENT_ID);
      expect(result.recorded).toBe(false);
      expect(factRow(h, first.eventKey)).toMatchObject({
        group_card: "旧名",
        group_card_source: "local",
        personal_nickname: "旧昵",
        personal_nickname_source: "local",
        revision: 1,
      });
    } finally {
      h.close();
    }
  });

  it("refuses a real wire conflict with a recorded name on redelivery", () => {
    const h = setup();
    try {
      const first = observationOf(-914, { card: "原名", nickname: "原昵" });
      recordObservation(h.orm, first, DEFAULT_AGENT_ID);
      const forged = observationOf(-914, { card: "冒名", nickname: "原昵" });
      expect(() => recordObservation(h.orm, forged, DEFAULT_AGENT_ID)).toThrow();
      expect(factRow(h, first.eventKey)).toMatchObject({
        group_card: "原名",
        group_card_source: "wire",
        revision: 1,
      });
    } finally {
      h.close();
    }
  });

  it("fills an unknown-source placeholder only from real wire, never from the directory", () => {
    const h = setup();
    try {
      seedDirectory(h, "目录名", "目录昵");
      // 占位＋wire 缺省：不借当前目录补名字（不伪历史），保持真 unknown。
      // 占位＋wire 缺省：不借当前目录补名字（不伪历史），保持真 unknown；
      // 片段照常补齐（§4.5 只补缺失事实），revision 前进。
      const absent = observationOf(-915, {});
      seedPlaceholder(h, absent);
      recordObservation(h.orm, absent, DEFAULT_AGENT_ID);
      expect(factRow(h, absent.eventKey)).toMatchObject({
        group_card: null,
        group_card_source: null,
        personal_nickname: null,
        personal_nickname_source: null,
        legacy_display_name: null,
        name_state: "unknown",
        revision: 2,
      });
      // 占位＋真实 wire：补值并记录来源，revision 前进。
      const wired = observationOf(-916, { card: "wire名" });
      seedPlaceholder(h, wired);
      recordObservation(h.orm, wired, DEFAULT_AGENT_ID);
      expect(factRow(h, wired.eventKey)).toMatchObject({
        group_card: "wire名",
        group_card_source: "wire",
        name_state: "known",
        revision: 2,
      });
    } finally {
      h.close();
    }
  });

  it("advances revision when a source-only verification is recorded on an unknown-source value", () => {
    const h = setup();
    try {
      const obs = observationOf(-917, { card: "旧名" });
      seedPlaceholder(h, obs);
      // 旧形态行：值已记录但来源未知（F4 之前的历史行）。
      h.db
        .query(
          "UPDATE qq_message_facts SET group_card='旧名', name_state='known' WHERE event_key=?",
        )
        .run(obs.eventKey);
      recordObservation(h.orm, obs, DEFAULT_AGENT_ID);
      // wire 同名重放：source-only 核补（值不变、来源落 'wire'），revision 前进使旧投影失效。
      expect(factRow(h, obs.eventKey)).toMatchObject({
        group_card: "旧名",
        group_card_source: "wire",
        revision: 2,
      });
    } finally {
      h.close();
    }
  });

  it("refuses a wire-declared clearing that conflicts with a recorded wire name (card)", () => {
    const h = setup();
    try {
      const first = observationOf(-921, { card: "原名", nickname: "原昵" });
      recordObservation(h.orm, first, DEFAULT_AGENT_ID);
      const base = factRow(h, first.eventKey);
      expect(base).toMatchObject({ group_card: "原名", group_card_source: "wire" });
      // 同键重放本次明确 card 清空（值 null＋来源 'wire'）与已记录非空名冲突：
      // 拒绝（§4.5 同一消息冲突事实应拒），不是静默保留；外层事务回滚，DB 不动。
      const forged = observationOf(-921, { card: "   ", nickname: "原昵" });
      expect(() => recordObservation(h.orm, forged, DEFAULT_AGENT_ID)).toThrow();
      expect(factRow(h, first.eventKey)).toEqual(base);
    } finally {
      h.close();
    }
  });

  it("refuses a wire-declared clearing that conflicts with a recorded wire name (nickname)", () => {
    const h = setup();
    try {
      const first = observationOf(-922, { card: "原名", nickname: "原昵" });
      recordObservation(h.orm, first, DEFAULT_AGENT_ID);
      const base = factRow(h, first.eventKey);
      expect(base).toMatchObject({ personal_nickname: "原昵", personal_nickname_source: "wire" });
      const forged = observationOf(-922, { card: "原名", nickname: "   " });
      expect(() => recordObservation(h.orm, forged, DEFAULT_AGENT_ID)).toThrow();
      expect(factRow(h, first.eventKey)).toEqual(base);
    } finally {
      h.close();
    }
  });

  it("refuses a wire-declared clearing that conflicts with a recorded local name", () => {
    const h = setup();
    try {
      seedDirectory(h, "旧名", "旧昵");
      const first = observationOf(-923, {});
      recordObservation(h.orm, first, DEFAULT_AGENT_ID);
      const base = factRow(h, first.eventKey);
      expect(base).toMatchObject({ group_card: "旧名", group_card_source: "local" });
      const forged = observationOf(-923, { card: "   ", nickname: "旧昵" });
      expect(() => recordObservation(h.orm, forged, DEFAULT_AGENT_ID)).toThrow();
      expect(factRow(h, first.eventKey)).toEqual(base);
    } finally {
      h.close();
    }
  });

  it("refuses a wire-declared clearing that conflicts with an unknown-source recorded name", () => {
    const h = setup();
    try {
      // 旧形态行：值已记录但来源 NULL（F4 之前的历史行）。
      const obs = observationOf(-924, { card: "旧名", nickname: "旧昵" });
      seedPlaceholder(h, obs);
      h.db
        .query(
          "UPDATE qq_message_facts SET group_card='旧名', personal_nickname='旧昵', name_state='known' WHERE event_key=?",
        )
        .run(obs.eventKey);
      const base = factRow(h, obs.eventKey);
      expect(base).toMatchObject({
        group_card: "旧名",
        group_card_source: null,
        personal_nickname: "旧昵",
        personal_nickname_source: null,
      });
      const forged = observationOf(-924, { card: "   ", nickname: "旧昵" });
      expect(() => recordObservation(h.orm, forged, DEFAULT_AGENT_ID)).toThrow();
      expect(factRow(h, obs.eventKey)).toEqual(base);
    } finally {
      h.close();
    }
  });

  it("keeps absent-field redelivery silent while a wire clearing refuses: missing vs clear", () => {
    const h = setup();
    try {
      seedDirectory(h, "旧名", "旧昵");
      const first = observationOf(-925, {});
      recordObservation(h.orm, first, DEFAULT_AGENT_ID);
      const base = factRow(h, first.eventKey);
      // 缺省字段（值 null＋来源 NULL）重放：静默不参与冲突（F1 重放不读目录改历史）。
      const replay = recordObservation(h.orm, first, DEFAULT_AGENT_ID);
      expect(replay.recorded).toBe(false);
      expect(factRow(h, first.eventKey)).toEqual(base);
      // 明确清空（值 null＋来源 'wire'）：与已记录名冲突即拒——missing 与 clear 是两个事实。
      const cleared = observationOf(-925, { card: "   ", nickname: "旧昵" });
      expect(() => recordObservation(h.orm, cleared, DEFAULT_AGENT_ID)).toThrow();
      expect(factRow(h, first.eventKey)).toEqual(base);
    } finally {
      h.close();
    }
  });

  it("keeps a legacy fact row on its single legacy evidence without adopting dual sources", () => {
    const h = setup();
    try {
      const legacyOf = (obs: QqObservation) => {
        h.db
          .query(
            "UPDATE qq_message_facts SET legacy_display_name='旧显示', name_state='legacy' WHERE event_key=?",
          )
          .run(obs.eventKey);
      };
      // wire 缺省重放：legacy 行姓名原样保留（不补双名/双来源）；片段照常补齐，
      // revision 前进（§4.5），但姓名事实不动。
      const absent = observationOf(-918, {});
      seedPlaceholder(h, absent);
      legacyOf(absent);
      recordObservation(h.orm, absent, DEFAULT_AGENT_ID);
      expect(factRow(h, absent.eventKey)).toMatchObject({
        group_card: null,
        group_card_source: null,
        personal_nickname: null,
        personal_nickname_source: null,
        legacy_display_name: "旧显示",
        name_state: "legacy",
        revision: 2,
      });
      // wire 带名也不把 legacy 行补成双名/双来源；片段仍可补（revision 前进），姓名不动。
      const wired = observationOf(-919, { card: "wire名" });
      seedPlaceholder(h, wired);
      legacyOf(wired);
      recordObservation(h.orm, wired, DEFAULT_AGENT_ID);
      expect(factRow(h, wired.eventKey)).toMatchObject({
        group_card: null,
        group_card_source: null,
        personal_nickname: null,
        personal_nickname_source: null,
        legacy_display_name: "旧显示",
        name_state: "legacy",
        revision: 2,
      });
    } finally {
      h.close();
    }
  });
});
