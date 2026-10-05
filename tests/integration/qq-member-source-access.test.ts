import { describe, expect, it } from "bun:test";
import { sourceAccess } from "../../src/server/agent/context-access";
import { loadQqMessageFact } from "../../src/server/channels/onebot11/message-projection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { inTimeline } from "../../src/server/modules/conversation-evidence-store";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import {
  createQqMemberNameSource,
  pruneQqMemberCurrentNames,
  type QqMemberNameCandidate,
  qqMemberNameSourceAccess,
} from "../../src/server/services/qq-member-sources";
import { qqMessageFactSourceAccess } from "../../src/server/services/qq-message-fact-sources";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type {
  QqConversationScope,
  QqIdentity,
  QqMessageFact,
} from "../../src/shared/contracts/qq-message";

const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const now = "2026-10-01T16:00:00.000000Z";

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
  const conversation = journal.ensureOneBot(id);
  if (!conversation) throw new Error("conversation fixture missing");
  return { journal, conversation };
}

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

function memberObservation(input: {
  messageId: number;
  userId: number;
  card?: string;
  nickname?: string;
  text?: string;
  atSeconds?: number;
  mentions?: number[];
  anonymous?: boolean;
}) {
  const segments: Array<Record<string, unknown>> = [];
  for (const qq of input.mentions ?? []) segments.push({ type: "at", data: { qq } });
  segments.push({ type: "text", data: { text: input.text ?? "合成正文" } });
  const result = normalizeOneBotMessage(
    {
      time: input.atSeconds ?? at,
      self_id: 90001,
      post_type: "message",
      message_type: "group",
      sub_type: input.anonymous ? "anonymous" : "normal",
      message_id: input.messageId,
      user_id: input.userId,
      group_id: 30003,
      sender: input.anonymous ? {} : { card: input.card, nickname: input.nickname },
      message: segments,
    },
    "90001",
  );
  if (result.kind !== "message") throw new Error("message expected");
  return result.observation;
}

function recordWithJournal(
  h: ReturnType<typeof setup>,
  journal: ConversationEventRepository,
  observation: ReturnType<typeof memberObservation>,
) {
  recordObservation(h.orm, observation, DEFAULT_AGENT_ID);
  return journal.ingestOneBotEvent(observation.eventKey, "binding");
}

function ownerFor(
  scope: QqConversationScope,
  kind: "conversation" | "qq_binding",
  overrides: Partial<RunOwner> = {},
): RunOwner {
  return {
    kind,
    id: kind === "conversation" ? scope.conversationId : scope.bindingId,
    userId: DEFAULT_USER_ID,
    agentId: scope.agentId,
    ...overrides,
  };
}

function mintOf(h: ReturnType<typeof setup>, scope: QqConversationScope, qq: string) {
  return createQqMemberNameSource(h, scope, qq, now);
}

function candidateOf(minted: NonNullable<ReturnType<typeof mintOf>>): QqMemberNameCandidate {
  return { value: minted.currentName, source: minted.source };
}

function factRefOf(fact: QqMessageFact): SourceRef {
  const ref = fact.sources.find((s) => s.kind === "qq_message_fact");
  if (!ref) throw new Error("qq_message_fact ref missing");
  return ref;
}

function bodyRefOf(fact: QqMessageFact): SourceRef {
  const ref = fact.sources.find((s) => s.kind === "qq_observation");
  if (!ref) throw new Error("qq_observation ref missing");
  return ref;
}

describe("qq_member_name source mint (real timeline establishment)", () => {
  it("mints for a speaker the current timeline really shows; value and ref shape come from the real member row", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -201, userId: 10001, card: "阿林卡", nickname: "阿林" }),
      );
      const live = liveScope(h, conversation);
      const minted = mintOf(h, live, "10001");
      expect(minted).not.toBeNull();
      if (!minted) return;
      expect(minted.currentName).toEqual({ groupCard: "阿林卡", personalNickname: "阿林" });
      expect(minted.source.kind).toBe("qq_member_name");
      expect(minted.source.id).toBe(JSON.stringify(["90001", "group", "30003", "10001"]));
      const row = h.db.query("SELECT expires_at FROM qq_members WHERE user_id='10001'").get() as {
        expires_at: string;
      };
      expect(minted.source.expiresAt).toBe(row.expires_at);
      const principal = { userId: DEFAULT_USER_ID };
      expect(
        qqMemberNameSourceAccess(
          h.db,
          minted.source,
          ownerFor(live, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("available");
      expect(
        qqMemberNameSourceAccess(
          h.db,
          minted.source,
          ownerFor(live, "qq_binding"),
          principal,
          nowIso(),
        ),
      ).toBe("available");
    } finally {
      h.close();
    }
  });

  it("two people with the same name mint distinct per-member refs; rename and lastSeen update revoke the old refs while the snapshot stays", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -201, userId: 10001, card: "阿林卡", nickname: "阿林" }),
      );
      recordWithJournal(
        h,
        journal,
        memberObservation({
          messageId: -202,
          userId: 10002,
          card: "阿林卡",
          nickname: "同名昵",
          atSeconds: at + 10,
        }),
      );
      const live = liveScope(h, conversation);
      const mintedA = mintOf(h, live, "10001");
      const mintedB = mintOf(h, live, "10002");
      expect(mintedA && mintedB).toBeTruthy();
      if (!mintedA || !mintedB) return;
      expect(mintedA.source.id).not.toBe(mintedB.source.id);
      expect(mintedB.currentName).toEqual({ groupCard: "阿林卡", personalNickname: "同名昵" });
      const principal = { userId: DEFAULT_USER_ID };
      const owner = ownerFor(live, "conversation");
      expect(qqMemberNameSourceAccess(h.db, mintedA.source, owner, principal, nowIso())).toBe(
        "available",
      );
      expect(qqMemberNameSourceAccess(h.db, mintedB.source, owner, principal, nowIso())).toBe(
        "available",
      );
      // 改名：10001 换群名片 → 旧 ref 复算不等 revoked；新 mint 给新名。
      recordWithJournal(
        h,
        journal,
        memberObservation({
          messageId: -203,
          userId: 10001,
          card: "改卡名",
          nickname: "阿林",
          atSeconds: at + 20,
        }),
      );
      expect(qqMemberNameSourceAccess(h.db, mintedA.source, owner, principal, nowIso())).toBe(
        "revoked",
      );
      const mintedA2 = mintOf(h, live, "10001");
      expect(mintedA2?.currentName).toEqual({ groupCard: "改卡名", personalNickname: "阿林" });
      // 仅 lastSeen 前进（同值再出现）：旧 ref 同样 revoked（revision 冻结 lastSeen）。
      recordWithJournal(
        h,
        journal,
        memberObservation({
          messageId: -204,
          userId: 10002,
          card: "阿林卡",
          nickname: "同名昵",
          atSeconds: at + 30,
        }),
      );
      expect(qqMemberNameSourceAccess(h.db, mintedB.source, owner, principal, nowIso())).toBe(
        "revoked",
      );
      // 改名后投影：msg1 发送时快照保持"阿林卡"，currentName 是当前目录值；prune 校验通过时两者都保留。
      const fact1 = loadQqMessageFact(h, live, "-201", now);
      expect(fact1).not.toBeNull();
      if (!fact1) return;
      expect(fact1.speaker.groupCard).toBe("阿林卡");
      expect(fact1.speaker.currentName).toEqual({ groupCard: "改卡名", personalNickname: "阿林" });
      const fresh = mintOf(h, live, "10001");
      if (!fresh) throw new Error("fresh mint missing");
      const pruned = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [fact1],
        owner,
        principal,
        now: nowIso(),
        candidates: new Map([["10001", candidateOf(fresh)]]),
      });
      expect(pruned[0]?.speaker.groupCard).toBe("阿林卡");
      expect(pruned[0]?.speaker.currentName).toEqual({
        groupCard: "改卡名",
        personalNickname: "阿林",
      });
    } finally {
      h.close();
    }
  });

  it("no mint without a real appearance or a usable row: stranger, anonymous, unlinked, legacy, dual-null", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      const live = liveScope(h, conversation);
      // 陌生 QQ：无出现、无目录行。
      expect(mintOf(h, live, "99999")).toBeNull();
      // 匿名消息不建立任何可命名身份。
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -205, userId: 10001, anonymous: true }),
      );
      expect(mintOf(h, live, "99999")).toBeNull();
      // 出现但未进当前 timeline（只落库不 ingest）：不 mint。
      recordObservation(
        h.orm,
        memberObservation({ messageId: -206, userId: 10007, card: "未接卡", nickname: "未接" }),
        DEFAULT_AGENT_ID,
      );
      expect(mintOf(h, live, "10007")).toBeNull();
      // legacy 行：真实出现也不供当前名（不冒历史两名）。
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -207, userId: 10005, card: "有卡", nickname: "有名" }),
      );
      h.db
        .query(
          "UPDATE qq_members SET name_state='legacy', group_card=NULL, personal_nickname=NULL WHERE user_id='10005'",
        )
        .run();
      expect(mintOf(h, live, "10005")).toBeNull();
      // 双名显式清空（unknown 双 null）：不供 currentName。
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -208, userId: 10006, card: "先有卡", nickname: "先有名" }),
      );
      expect(mintOf(h, live, "10006")?.currentName).toEqual({
        groupCard: "先有卡",
        personalNickname: "先有名",
      });
      recordWithJournal(
        h,
        journal,
        memberObservation({
          messageId: -209,
          userId: 10006,
          card: "  ",
          nickname: "  ",
          atSeconds: at + 10,
        }),
      );
      expect(mintOf(h, live, "10006")).toBeNull();
    } finally {
      h.close();
    }
  });

  it("mentions establish through this message's recorded parts once the mentioned member has a real row", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(
        h,
        journal,
        memberObservation({
          messageId: -201,
          userId: 10001,
          card: "阿林卡",
          nickname: "阿林",
          mentions: [10003],
        }),
      );
      const live = liveScope(h, conversation);
      // 被 @ 者还没有目录行：不 mint（不造只有号码的姓名来源）。
      expect(mintOf(h, live, "10003")).toBeNull();
      // 被点者随后真实发言：出现与行都成立 → mint。
      recordWithJournal(
        h,
        journal,
        memberObservation({
          messageId: -202,
          userId: 10003,
          card: "小周卡",
          nickname: "小周",
          atSeconds: at + 10,
        }),
      );
      const minted = mintOf(h, live, "10003");
      expect(minted?.currentName).toEqual({ groupCard: "小周卡", personalNickname: "小周" });
      const principal = { userId: DEFAULT_USER_ID };
      if (minted) {
        expect(
          qqMemberNameSourceAccess(
            h.db,
            minted.source,
            ownerFor(live, "conversation"),
            principal,
            nowIso(),
          ),
        ).toBe("available");
      }
    } finally {
      h.close();
    }
  });
});

describe("qq_member_name source access (owner-first, fail closed)", () => {
  it("owner negatives are all revoked; foreign shapes learn nothing", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -201, userId: 10001, card: "阿林卡", nickname: "阿林" }),
      );
      const live = liveScope(h, conversation);
      const minted = mintOf(h, live, "10001");
      if (!minted) throw new Error("mint missing");
      const ref = minted.source;
      const principal = { userId: DEFAULT_USER_ID };
      expect(
        qqMemberNameSourceAccess(h.db, ref, ownerFor(live, "conversation"), principal, nowIso()),
      ).toBe("available");
      const noAgent = ownerFor(live, "conversation");
      delete (noAgent as { agentId?: string }).agentId;
      expect(qqMemberNameSourceAccess(h.db, ref, noAgent, principal, nowIso())).toBe("revoked");
      expect(
        qqMemberNameSourceAccess(
          h.db,
          ref,
          { ...ownerFor(live, "conversation"), agentId: "other-agent" },
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        qqMemberNameSourceAccess(
          h.db,
          ref,
          { ...ownerFor(live, "conversation"), userId: "someone-else" },
          { userId: "someone-else" },
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        qqMemberNameSourceAccess(
          h.db,
          ref,
          ownerFor(live, "conversation"),
          { userId: "someone-else" },
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        qqMemberNameSourceAccess(
          h.db,
          ref,
          { ...ownerFor(live, "conversation"), id: "other-conversation" },
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        qqMemberNameSourceAccess(
          h.db,
          ref,
          { kind: "web_turn", id: "t1", userId: DEFAULT_USER_ID },
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // 跨群 id（同账号同 kind 不同 peer）：revoked，不泄露存在性。
      expect(
        qqMemberNameSourceAccess(
          h.db,
          { ...ref, id: JSON.stringify(["90001", "group", "99999", "10001"]) },
          ownerFor(live, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // 跨 kind id。
      expect(
        qqMemberNameSourceAccess(
          h.db,
          { ...ref, id: JSON.stringify(["90001", "private", "30003", "10001"]) },
          ownerFor(live, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // id 严格解析：非 JSON / 三元 / 非字符串元素 / 空串 / 超长 全 revoked。
      expect(
        qqMemberNameSourceAccess(
          h.db,
          { ...ref, id: "not-json" },
          ownerFor(live, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        qqMemberNameSourceAccess(
          h.db,
          { ...ref, id: JSON.stringify(["90001", "group", "30003"]) },
          ownerFor(live, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        qqMemberNameSourceAccess(
          h.db,
          { ...ref, id: JSON.stringify(["90001", "group", "30003", 10001]) },
          ownerFor(live, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        qqMemberNameSourceAccess(
          h.db,
          { ...ref, id: JSON.stringify(["", "group", "30003", "10001"]) },
          ownerFor(live, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      expect(
        qqMemberNameSourceAccess(
          h.db,
          { ...ref, id: JSON.stringify(["9".repeat(200), "group", "30003", "10001"]) },
          ownerFor(live, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // 其它 kind 落回 undefined（不是本服务的判定对象）。
      expect(
        qqMemberNameSourceAccess(
          h.db,
          { ...ref, kind: "qq_message_fact" },
          ownerFor(live, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBeUndefined();
      // ref 帽不可解析：明确 fail closed（revoked），不是跳过帽继续可读。
      expect(
        qqMemberNameSourceAccess(
          h.db,
          { ...ref, expiresAt: "not-a-date" },
          ownerFor(live, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // 平台 AccountId 规则钉死：QQ "0" 不是合法定位键（wire 归一化排除）。
      expect(
        qqMemberNameSourceAccess(
          h.db,
          { ...ref, id: JSON.stringify(["90001", "group", "30003", "0"]) },
          ownerFor(live, "conversation"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("row expiry and frozen ref cap read expired for the right owner; a wrong owner never learns the expired state", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -201, userId: 10001, card: "阿林卡", nickname: "阿林" }),
      );
      const live = liveScope(h, conversation);
      const minted = mintOf(h, live, "10001");
      if (!minted) throw new Error("mint missing");
      const principal = { userId: DEFAULT_USER_ID };
      const owner = ownerFor(live, "conversation");
      h.db
        .query(
          "UPDATE qq_members SET expires_at='2026-10-01T12:00:00.000000Z' WHERE user_id='10001'",
        )
        .run();
      expect(qqMemberNameSourceAccess(h.db, minted.source, owner, principal, now)).toBe("expired");
      expect(mintOf(h, live, "10001")).toBeNull();
      // 冻结帽过期同样 expired，且不延长。
      expect(
        qqMemberNameSourceAccess(
          h.db,
          { ...minted.source, expiresAt: "2026-09-30T00:00:00.000000Z" },
          owner,
          principal,
          now,
        ),
      ).toBe("expired");
      expect(
        qqMemberNameSourceAccess(
          h.db,
          minted.source,
          { ...owner, agentId: "other-agent" },
          principal,
          now,
        ),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("clock rollback: eight pre-epoch candidates newer than the real record cannot mask the current timeline appearance", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      // 旧纪元（open 会话）先写八条“未来”时间候选：发言人用其他成员（10002）并 @ 目标
      // QQ——走生产的 normalize/record/journal 链，但 mention 不写被点者的目录行，所以
      // 目标 QQ 的目录仍是后面真实发言写的值。这八条按 occurred_at DESC 会占满时间线
      // 头部：去帽前“旧 LIMIT 8”截断会把真实记录挡在页外；去帽后分页穷尽必须跳过它们。
      for (let i = 0; i < 8; i++) {
        recordWithJournal(
          h,
          journal,
          memberObservation({
            messageId: -300 - i,
            userId: 10002,
            card: "旧纪元卡",
            nickname: "旧纪元",
            mentions: [10001],
            atSeconds: at + 900 + i,
          }),
        );
      }
      // 换绑推进纪元：关闭旧会话后才 ensure 新 epoch。这八条已入库（rowid 低于新会话的
      // source_watermark），永远进不了新 timeline——旧纪元事件不会回流污染新会话。
      h.db
        .query(
          "UPDATE conversations SET closed_at=? WHERE channel='onebot11' AND source_id='binding' AND closed_at IS NULL",
        )
        .run(nowIso());
      const conversation2 = journal.ensureOneBot("binding");
      if (!conversation2 || conversation2.bindingEpoch === 1)
        throw new Error("expected new conversation");
      const live2 = liveScope(h, conversation2);
      // 新纪元真实记录：目标 QQ 本人发言 at+60，早于八个候选的"未来"时间。
      recordWithJournal(
        h,
        journal,
        memberObservation({
          messageId: -310,
          userId: 10001,
          card: "阿林卡",
          nickname: "阿林",
          atSeconds: at + 60,
        }),
      );
      // 真实隔离证据：八个旧候选全属旧 conversation 且不在新 timeline；真实记录在新 timeline。
      const scopeArg = { channel: "onebot11" as const, ...live2 };
      for (let i = 0; i < 8; i++) {
        const key = JSON.stringify(["qq", "90001", "group", "30003", String(-300 - i)]);
        expect(inTimeline(h.db, scopeArg, "qq_event", key)).toBe(false);
        expect(
          h.db
            .query("SELECT conversation_id FROM conversation_events WHERE event_key=?")
            .get(`onebot:${key}`),
        ).toEqual({ conversation_id: conversation.id });
      }
      expect(
        inTimeline(
          h.db,
          scopeArg,
          "qq_event",
          JSON.stringify(["qq", "90001", "group", "30003", "-310"]),
        ),
      ).toBe(true);
      const minted = mintOf(h, live2, "10001");
      expect(minted).not.toBeNull();
      if (minted) {
        expect(minted.currentName).toEqual({ groupCard: "阿林卡", personalNickname: "阿林" });
      }
    } finally {
      h.close();
    }
  });

  it("epoch change revokes old refs and the new epoch neither mints nor revives; authority bump revokes", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -201, userId: 10001, card: "阿林卡", nickname: "阿林" }),
      );
      const live = liveScope(h, conversation);
      const minted = mintOf(h, live, "10001");
      if (!minted) throw new Error("mint missing");
      const principal = { userId: DEFAULT_USER_ID };
      expect(
        qqMemberNameSourceAccess(
          h.db,
          minted.source,
          ownerFor(live, "qq_binding"),
          principal,
          nowIso(),
        ),
      ).toBe("available");
      // 权限纪元前进：scope 现值变化 → 旧 ref 复算不等。
      h.db
        .query("UPDATE qq_bindings SET revision=2, authority_revision=2 WHERE id='binding'")
        .run();
      expect(
        qqMemberNameSourceAccess(
          h.db,
          minted.source,
          ownerFor(live, "qq_binding"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
      // 新 epoch 会话：成员不在新 timeline → 不 mint；旧 ref revoked。
      h.db
        .query("UPDATE conversations SET closed_at=? WHERE id=?")
        .run(nowIso(), live.conversationId);
      const conversation2 = journal.ensureOneBot("binding");
      if (!conversation2 || conversation2.id === live.conversationId)
        throw new Error("expected new conversation");
      const live2 = liveScope(h, conversation2);
      expect(mintOf(h, live2, "10001")).toBeNull();
      expect(
        qqMemberNameSourceAccess(
          h.db,
          minted.source,
          ownerFor(live2, "qq_binding"),
          principal,
          nowIso(),
        ),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });

  it("ambiguous owner fails closed instead of guessing", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -201, userId: 10001, card: "阿林卡", nickname: "阿林" }),
      );
      const live = liveScope(h, conversation);
      const minted = mintOf(h, live, "10001");
      if (!minted) throw new Error("mint missing");
      const principal = { userId: DEFAULT_USER_ID };
      h.db.query("DROP INDEX uq_conversations_current_source").run();
      h.db
        .query(
          "INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,source_watermark,next_seq,consumed_seq,created_at,updated_at) SELECT 'dup-'||substr(id,1,8)||?,channel,topology,source_id,agent_id,user_id,binding_epoch+1,0,1,0,?,? FROM conversations WHERE id=?",
        )
        .run(crypto.randomUUID().slice(0, 4), now, now, live.conversationId);
      expect(
        qqMemberNameSourceAccess(h.db, minted.source, ownerFor(live, "qq_binding"), principal, now),
      ).toBe("revoked");
    } finally {
      h.close();
    }
  });
});

describe("pruneQqMemberCurrentNames (typed, source-verified currentName clip)", () => {
  it("expired name source: only currentName is clipped; snapshot, text parts, reply, sources stay and the fact/body sources remain available", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(
        h,
        journal,
        memberObservation({
          messageId: -201,
          userId: 10001,
          card: "阿林卡",
          nickname: "阿林",
          text: "阿林在吗",
        }),
      );
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-201", now);
      expect(fact).not.toBeNull();
      if (!fact) return;
      expect(fact.speaker.currentName).toEqual({ groupCard: "阿林卡", personalNickname: "阿林" });
      const minted = mintOf(h, live, "10001");
      if (!minted) throw new Error("mint missing");
      const principal = { userId: DEFAULT_USER_ID };
      const owner = ownerFor(live, "conversation");
      // 刻意让正文含同一字符串："阿林" 只允许从 currentName 字段剪掉，正文 parts 不动。
      h.db
        .query(
          "UPDATE qq_members SET expires_at='2026-10-01T12:00:00.000000Z' WHERE user_id='10001'",
        )
        .run();
      const before = JSON.stringify(fact);
      const pruned = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [fact],
        owner,
        principal,
        now,
        candidates: new Map([["10001", candidateOf(minted)]]),
      });
      const clipped = pruned[0];
      expect(clipped).toBeDefined();
      if (!clipped) return;
      expect(clipped.speaker.currentName).toBeUndefined();
      expect(clipped.speaker.groupCard).toBe("阿林卡");
      expect(clipped.parts).toEqual(fact.parts);
      expect(clipped.parts.some((p) => p.kind === "text" && p.text === "阿林在吗")).toBe(true);
      expect(clipped.replyTo).toEqual(fact.replyTo);
      expect(clipped.completeness).toBe(fact.completeness);
      expect(clipped.sources).toEqual(fact.sources);
      expect(clipped.sources.map((s) => s.kind)).toEqual(["qq_message_fact", "qq_observation"]);
      // 正文与事实来源仍可复验；currentName 剪除不连带取消仍有权限的消息正文。
      expect(qqMessageFactSourceAccess(h.db, factRefOf(clipped), owner, principal, nowIso())).toBe(
        "available",
      );
      expect(sourceAccess(h.db, bodyRefOf(clipped), owner, principal, now)).toBe("available");
      // 调用方对象未被 mutate。
      expect(JSON.stringify(fact)).toBe(before);
      // name 来源从不进 fact.sources。
      expect(clipped.sources.some((s) => s.kind === "qq_member_name")).toBe(false);
    } finally {
      h.close();
    }
  });

  it("verified candidates keep currentName; missing, foreign-keyed or mismatched candidates clip it", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -201, userId: 10001, card: "阿林卡", nickname: "阿林" }),
      );
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-201", now);
      if (!fact) throw new Error("fact missing");
      const minted = mintOf(h, live, "10001");
      if (!minted) throw new Error("mint missing");
      const principal = { userId: DEFAULT_USER_ID };
      const owner = ownerFor(live, "conversation");
      // 候选与当前值匹配且来源 available：保留。
      const kept = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [fact],
        owner,
        principal,
        now: nowIso(),
        candidates: new Map([["10001", candidateOf(minted)]]),
      });
      expect(kept[0]?.speaker.currentName).toEqual({
        groupCard: "阿林卡",
        personalNickname: "阿林",
      });
      // 无候选（缺 ref）：剪。
      const clippedEmpty = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [fact],
        owner,
        principal,
        now: nowIso(),
        candidates: new Map(),
      });
      expect(clippedEmpty[0]?.speaker.currentName).toBeUndefined();
      // 候选值与 currentName 不匹配（另一 QQ 的当前名不得顶替）：剪。
      const forged = { ...minted.currentName, groupCard: "别的名字" };
      const clippedMismatch = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [fact],
        owner,
        principal,
        now: nowIso(),
        candidates: new Map([["10001", { value: forged, source: minted.source }]]),
      });
      expect(clippedMismatch[0]?.speaker.currentName).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it("mention identities verify against their own qq; anonymous or null-qq identities never keep a name", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(
        h,
        journal,
        memberObservation({
          messageId: -201,
          userId: 10001,
          card: "阿林卡",
          nickname: "阿林",
          mentions: [10003],
        }),
      );
      recordWithJournal(
        h,
        journal,
        memberObservation({
          messageId: -202,
          userId: 10003,
          card: "小周卡",
          nickname: "小周",
          atSeconds: at + 10,
        }),
      );
      const live = liveScope(h, conversation);
      const mintedSpeaker = mintOf(h, live, "10001");
      const mintedMention = mintOf(h, live, "10003");
      if (!mintedSpeaker || !mintedMention) throw new Error("mint missing");
      const principal = { userId: DEFAULT_USER_ID };
      const owner = ownerFor(live, "conversation");
      const speakerIdentity: QqIdentity = {
        role: "member",
        qq: "10001",
        groupCard: "阿林卡",
        personalNickname: "阿林",
        legacyDisplayName: null,
        nameState: "known",
        currentName: { groupCard: "阿林卡", personalNickname: "阿林" },
      };
      const mentionIdentity: QqIdentity = {
        role: "member",
        qq: "10003",
        groupCard: "小周卡",
        personalNickname: "小周",
        legacyDisplayName: null,
        nameState: "known",
        currentName: { groupCard: "小周卡", personalNickname: "小周" },
      };
      const forgedAnonymous: QqIdentity = {
        role: "anonymous",
        qq: null,
        groupCard: null,
        personalNickname: null,
        legacyDisplayName: null,
        nameState: "unknown",
        currentName: { groupCard: "假名", personalNickname: null },
      };
      const fact: QqMessageFact = {
        id: "synthetic",
        platformMessageId: "-201",
        seq: 1,
        occurredAtSeconds: at,
        speaker: speakerIdentity,
        parts: [{ kind: "mention", qq: "10003" }],
        mentions: [
          { qq: "10003", identity: mentionIdentity },
          { qq: "10001", identity: speakerIdentity },
        ],
        replyTo: null,
        sources: [],
        completeness: "full",
      };
      // 只给发言者候选：点名身份的 currentName 不得借另一 QQ 的候选续命 → 剪；
      // 发言者本人保留。
      const onlySpeaker = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [fact],
        owner,
        principal,
        now: nowIso(),
        candidates: new Map([["10001", candidateOf(mintedSpeaker)]]),
      });
      expect(onlySpeaker[0]?.speaker.currentName).toEqual({
        groupCard: "阿林卡",
        personalNickname: "阿林",
      });
      expect(onlySpeaker[0]?.mentions[0]?.identity?.currentName).toBeUndefined();
      expect(onlySpeaker[0]?.mentions[1]?.identity?.currentName).toEqual({
        groupCard: "阿林卡",
        personalNickname: "阿林",
      });
      // 两个候选都给：各自身份按自己的 qq 校验通过。
      const both = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [fact],
        owner,
        principal,
        now: nowIso(),
        candidates: new Map([
          ["10001", candidateOf(mintedSpeaker)],
          ["10003", candidateOf(mintedMention)],
        ]),
      });
      expect(both[0]?.mentions[0]?.identity?.currentName).toEqual({
        groupCard: "小周卡",
        personalNickname: "小周",
      });
      // 匿名身份伪造 currentName：一律剪（anonymous/null QQ 不给假名）。
      const anonFact: QqMessageFact = { ...fact, speaker: forgedAnonymous, mentions: [] };
      const anonPruned = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [anonFact],
        owner,
        principal,
        now: nowIso(),
        candidates: new Map([["10001", candidateOf(mintedSpeaker)]]),
      });
      expect(anonPruned[0]?.speaker.currentName).toBeUndefined();
      expect(anonPruned[0]?.speaker.role).toBe("anonymous");
      // 非变异：原 fact 及其身份对象不变。
      expect(fact.speaker.currentName).toEqual({ groupCard: "阿林卡", personalNickname: "阿林" });
      expect(fact.mentions[0]?.identity?.currentName).toEqual({
        groupCard: "小周卡",
        personalNickname: "小周",
      });
    } finally {
      h.close();
    }
  });

  it("projection facts never carry a member-name source, and prune output stays a fresh clone", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -201, userId: 10001, card: "阿林卡", nickname: "阿林" }),
      );
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-201", now);
      if (!fact) throw new Error("fact missing");
      expect(fact.sources.map((s) => s.kind)).toEqual(["qq_message_fact", "qq_observation"]);
      const principal = { userId: DEFAULT_USER_ID };
      const owner = ownerFor(live, "conversation");
      const pruned = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [fact],
        owner,
        principal,
        now: nowIso(),
        candidates: new Map(),
      });
      expect(pruned).not.toBe(fact);
      expect(pruned[0]).not.toBe(fact);
      expect(pruned[0]?.platformMessageId).toBe(fact.platformMessageId);
      expect(pruned[0]?.id).toBe(fact.id);
      expect(pruned[0]?.sources).toEqual(fact.sources);
    } finally {
      h.close();
    }
  });

  it("same-name rows share identical revision across different QQ: access re-locates by the ref's own userId and stays available", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      // 两行同名同 lastSeen：行内容完全一致 → revision 哈希相同（id 自身不参与哈希）。
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -201, userId: 10001, card: "阿林卡", nickname: "阿林" }),
      );
      recordWithJournal(
        h,
        journal,
        memberObservation({
          messageId: -202,
          userId: 10002,
          card: "阿林卡",
          nickname: "阿林",
          atSeconds: at,
        }),
      );
      const live = liveScope(h, conversation);
      const mintedA = mintOf(h, live, "10001");
      const mintedB = mintOf(h, live, "10002");
      if (!mintedA || !mintedB) throw new Error("mint missing");
      // revision 明确含 ref 自己的 userId：同名同 lastSeen 两行的哈希不再相等，
      // A 的 ref 即使改指 B 的 id，复算也不等。
      expect(mintedA.source.revision).not.toBe(mintedB.source.revision);
      const principal = { userId: DEFAULT_USER_ID };
      const owner = ownerFor(live, "conversation");
      // ref 的授权来自 id 定位的那一行复算，不来自哈希值本身。
      expect(qqMemberNameSourceAccess(h.db, mintedB.source, owner, principal, nowIso())).toBe(
        "available",
      );
    } finally {
      h.close();
    }
  });

  it("prune rejects a candidate whose ref points at a different member, a forged value, or a swapped map key, even when the value equals the identity's currentName", () => {
    const h = setup();
    try {
      const { conversation, journal } = bind(h);
      recordWithJournal(
        h,
        journal,
        memberObservation({ messageId: -201, userId: 10001, card: "阿林卡", nickname: "阿林" }),
      );
      recordWithJournal(
        h,
        journal,
        memberObservation({
          messageId: -202,
          userId: 10002,
          card: "阿林卡",
          nickname: "阿林",
          atSeconds: at,
        }),
      );
      const live = liveScope(h, conversation);
      const fact = loadQqMessageFact(h, live, "-202", now);
      if (!fact) throw new Error("fact missing");
      // B 的 currentName 真实存在于目录，且与其行值相同。
      expect(fact.speaker.qq).toBe("10002");
      expect(fact.speaker.currentName).toEqual({ groupCard: "阿林卡", personalNickname: "阿林" });
      const mintedA = mintOf(h, live, "10001");
      const mintedB = mintOf(h, live, "10002");
      if (!mintedA || !mintedB) throw new Error("mint missing");
      const principal = { userId: DEFAULT_USER_ID };
      const owner = ownerFor(live, "conversation");
      // ① A 的真 ref 配 B 的 currentName 值（值相等但来源是别人的行）：剪。
      const crossRef = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [fact],
        owner,
        principal,
        now: nowIso(),
        candidates: new Map([["10002", candidateOf(mintedA)]]),
      });
      expect(crossRef[0]?.speaker.currentName).toBeUndefined();
      // ② ref.id 改指 B（其余字段是 A 行的真实哈希）：复算不等 → 剪，不借同值哈希混过。
      const swappedId = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [fact],
        owner,
        principal,
        now: nowIso(),
        candidates: new Map([
          [
            "10002",
            { value: mintedA.currentName, source: { ...mintedA.source, id: mintedB.source.id } },
          ],
        ]),
      });
      expect(swappedId[0]?.speaker.currentName).toBeUndefined();
      // ③ 错 map key：A 的完整候选挂在 "10002" 下。source 本身 available，value 又恰等于
      // B 的 currentName——没有 ref↔identity 绑定就会让 A 的来源给 B 的名字"续命"。
      const wrongKey = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [fact],
        owner,
        principal,
        now: nowIso(),
        candidates: new Map([["10002", candidateOf(mintedA)]]),
      });
      expect(wrongKey[0]?.speaker.currentName).toBeUndefined();
      // ④ B 自己的真 ref + 真值（与行值一致）：保。
      const own = pruneQqMemberCurrentNames({
        db: h.db,
        facts: [fact],
        owner,
        principal,
        now: nowIso(),
        candidates: new Map([["10002", candidateOf(mintedB)]]),
      });
      expect(own[0]?.speaker.currentName).toEqual({
        groupCard: "阿林卡",
        personalNickname: "阿林",
      });
    } finally {
      h.close();
    }
  });
});
