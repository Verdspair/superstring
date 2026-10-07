import { describe, expect, it } from "bun:test";
import {
  purgeExpiredQqMembers,
  qqMemberLabels,
  rememberQqMember,
  rememberQqMemberNames,
} from "../../src/server/db/qq-member-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { QqObservation } from "../../src/server/services/onebot-protocol";
import { qqIntakeCycle, recordInbound } from "../../src/server/services/qq-intake";
import { buildQqPrompt, QQ_PROMPT_DEFAULTS } from "../../src/server/services/qq-prompt-contract";
import { memberExpiresAt } from "../../src/server/services/qq-retention";

const scope = { accountId: "10001", conversationKind: "group", peerId: "30003" };
const at = Math.floor(Date.parse("2026-09-23T00:00:00Z") / 1000);
const now = "2026-09-23T00:00:00.000000Z";
const agent = "00000000-0000-0000-0000-000000000001";
function observation(patch: Partial<QqObservation> = {}): QqObservation {
  return {
    accountId: scope.accountId,
    conversation: { kind: "group", peerId: scope.peerId, key: "group-key" },
    eventKey: "event1",
    messageId: "m1",
    occurredAtSeconds: at,
    subType: "normal",
    speaker: { kind: "member", id: "20002", displayName: "昵称" },
    segments: [],
    text: "合成正文",
    mentionsSelf: false,
    ...patch,
  };
}
function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  return h;
}
function memberRow(orm: ReturnType<typeof openBusinessDb>["orm"]) {
  const row = orm.select().from(schema.qqMembers).get();
  if (!row) throw new Error("member row expected");
  return row;
}

describe("QQ latest member labels", () => {
  it("keeps one current nickname, stable identity and first-seen time", () => {
    const h = setup();
    try {
      rememberQqMember(h.orm, { scope, userId: "20002", nickname: "  旧名  ", seenAtSeconds: at });
      const row = rememberQqMember(h.orm, {
        scope,
        userId: "20002",
        nickname: "新名",
        seenAtSeconds: at + 10,
      });
      expect(row.firstSeenAtSeconds).toBe(at);
      expect(row.lastSeenAtSeconds).toBe(at + 10);
      expect(row.expiresAt).toBe(memberExpiresAt(at + 10));
      expect(qqMemberLabels(h.orm, scope, now).get("20002")).toBe("新名");
      expect(h.orm.select().from(schema.qqMembers).all()).toHaveLength(1);
    } finally {
      h.close();
    }
  });
  it("does not rewind the name or extend expiry on an older or same-second replay", () => {
    const h = setup();
    try {
      const latest = rememberQqMember(h.orm, {
        scope,
        userId: "20002",
        nickname: "新名",
        seenAtSeconds: at + 10,
      });
      for (const seenAtSeconds of [at, at + 10])
        expect(
          rememberQqMember(h.orm, { scope, userId: "20002", nickname: "旧名", seenAtSeconds }),
        ).toEqual(latest);
    } finally {
      h.close();
    }
  });
  it("isolates accounts, group/private kind and peers, but is not assistant-scoped", () => {
    const h = setup();
    try {
      const scopes = [
        scope,
        { ...scope, accountId: "10002" },
        { ...scope, conversationKind: "private" },
        { ...scope, peerId: "30004" },
      ];
      for (const [i, s] of scopes.entries()) {
        rememberQqMember(h.orm, {
          scope: s,
          userId: "20002",
          nickname: `name${i}`,
          seenAtSeconds: at,
        });
        expect([...qqMemberLabels(h.orm, s, now)]).toEqual([["20002", `name${i}`]]);
      }
      expect(
        h.db
          .query("PRAGMA table_info(qq_members)")
          .all()
          .map((x) => (x as { name: string }).name),
      ).not.toContain("agent_id");
    } finally {
      h.close();
    }
  });
  it("hides expired names before sweep, and sweep leaves event identities intact", () => {
    const h = setup();
    try {
      recordObservation(h.orm, observation(), agent);
      const expired = memberExpiresAt(at);
      expect(qqMemberLabels(h.orm, scope, expired).size).toBe(0);
      expect(purgeExpiredQqMembers(h.orm, expired)).toBe(1);
      expect(purgeExpiredQqMembers(h.orm, expired)).toBe(0);
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(1);
    } finally {
      h.close();
    }
  });
  it("rejects bad names and clocks, counts Unicode code points like SQLite", () => {
    const h = setup();
    try {
      for (const nickname of ["", " \t ", "x".repeat(65)])
        expect(() =>
          rememberQqMember(h.orm, { scope, userId: "20002", nickname, seenAtSeconds: at }),
        ).toThrow(TypeError);
      for (const seenAtSeconds of [-1, 1.5])
        expect(() =>
          rememberQqMember(h.orm, { scope, userId: "20002", nickname: "name", seenAtSeconds }),
        ).toThrow(TypeError);
      rememberQqMember(h.orm, {
        scope,
        userId: "20002",
        nickname: "𠮷".repeat(64),
        seenAtSeconds: at,
      });
      expect(qqMemberLabels(h.orm, scope, now).get("20002")).toBe("𠮷".repeat(64));
      expect(() => h.db.exec("UPDATE qq_members SET nickname=' '")).toThrow();
      expect(() => h.db.exec("UPDATE qq_members SET last_seen_at_seconds=0")).toThrow();
    } finally {
      h.close();
    }
  });
});

describe("member labels in the observation chain", () => {
  it("records a name even for media-only messages, never anonymous/system", () => {
    const h = setup();
    try {
      expect(recordObservation(h.orm, observation({ text: "" }), agent).hasText).toBe(false);
      for (const kind of ["anonymous", "system"] as const)
        recordObservation(
          h.orm,
          observation({
            eventKey: kind,
            messageId: kind,
            speaker: { kind, id: null, displayName: "not-member" },
          }),
          agent,
        );
      expect([...qqMemberLabels(h.orm, scope, now)]).toEqual([["20002", "昵称"]]);
    } finally {
      h.close();
    }
  });
  it("ignores oversized/blank metadata without losing a valid message", () => {
    const h = setup();
    try {
      for (const displayName of [null, " ", "x".repeat(65)]) {
        const eventKey = String(displayName);
        expect(
          recordObservation(
            h.orm,
            observation({
              eventKey,
              messageId: eventKey,
              speaker: { kind: "member", id: "20002", displayName },
            }),
            agent,
          ).recorded,
        ).toBe(true);
      }
      expect(qqMemberLabels(h.orm, scope, now).size).toBe(0);
      expect(h.orm.select().from(schema.qqObservationText).all()).toHaveLength(3);
    } finally {
      h.close();
    }
  });
  it("duplicate deliveries neither rewrite a name nor resurrect it after expiry", () => {
    const h = setup();
    try {
      const o = observation();
      recordObservation(h.orm, o, agent);
      const duplicate = { ...o, speaker: { ...o.speaker, displayName: "forged" } };
      expect(recordObservation(h.orm, duplicate, agent).recorded).toBe(false);
      expect(qqMemberLabels(h.orm, scope, now).get("20002")).toBe("昵称");
      purgeExpiredQqMembers(h.orm, memberExpiresAt(at));
      recordObservation(h.orm, duplicate, agent);
      expect(h.orm.select().from(schema.qqMembers).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("rolls back event, member and body together when a write fails", () => {
    const h = setup();
    try {
      h.db.exec(
        "CREATE TRIGGER reject_test_body BEFORE INSERT ON qq_observation_text BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;",
      );
      expect(() => recordObservation(h.orm, observation(), agent)).toThrow();
      expect(h.orm.select().from(schema.qqEvents).all()).toHaveLength(0);
      expect(h.orm.select().from(schema.qqMembers).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
  it("keeps wire card presence when the nickname is absent instead of clearing both (T03a)", () => {
    // 规格 §3.1：card 有值而 nickname 缺省时，当前目录不能把 undefined 归并成 null
    // 丢掉 card 的 presence——card 沿用，nickname 缺省。
    const h = setup();
    try {
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_names1",
          messageId: "m1",
          speaker: {
            kind: "member",
            id: "20002",
            displayName: "名片",
            groupCard: "名片",
            // personalNickname 整个缺省。
          },
        }),
        agent,
      );
      const row = memberRow(h.orm);
      expect(row.groupCard).toBe("名片");
      expect(row.nameState).toBe("known");
    } finally {
      h.close();
    }
  });
  it("clears the current nickname on an explicit null, keeps local on undefined (T03a)", () => {
    const h = setup();
    try {
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_n1",
          messageId: "m1",
          speaker: {
            kind: "member",
            id: "20002",
            displayName: "旧昵",
            personalNickname: "旧昵",
          },
        }),
        agent,
      );
      const first = memberRow(h.orm);
      expect(first.personalNickname).toBe("旧昵");
      // 显式 null：清空当前昵称（不是 ?? 旧值）。card 也没有 → nameState unknown。
      // （严格更新的观察才生效；同秒/乱序由上一用例保证不回退。）
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_n2",
          messageId: "m2",
          occurredAtSeconds: at + 10,
          speaker: {
            kind: "member",
            id: "20002",
            displayName: null,
            personalNickname: null,
          },
        }),
        agent,
      );
      const cleared = memberRow(h.orm);
      expect(cleared.lastSeenAtSeconds).toBe(at + 10);
      expect(cleared.groupCard).toBeNull();
      expect(cleared.personalNickname).toBeNull();
      expect(cleared.nameState).toBe("unknown");
      expect(cleared.lastSeenAtSeconds).toBeGreaterThanOrEqual(first.lastSeenAtSeconds);
      // 缺省（键整个不出现）才沿用本地：本地已 unknown，无可沿用，仍 unknown。
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_n3",
          messageId: "m3",
          speaker: { kind: "member", id: "20002", displayName: null },
        }),
        agent,
      );
      const kept = memberRow(h.orm);
      expect(kept.personalNickname).toBeNull();
      expect(kept.nameState).toBe("unknown");
    } finally {
      h.close();
    }
  });
  it("same-second and out-of-order deliveries never rewind the current directory (T03a)", () => {
    const h = setup();
    try {
      rememberQqMemberNames(h.orm, {
        scope,
        userId: "20002",
        names: { groupCard: "新名片", personalNickname: "新昵" },
        seenAtSeconds: at,
      });
      // 同秒再交：不能回退，也不因后写者吞掉前写者的字段。
      const sameSecond = rememberQqMemberNames(h.orm, {
        scope,
        userId: "20002",
        names: { groupCard: undefined, personalNickname: undefined },
        seenAtSeconds: at,
      });
      expect(sameSecond?.groupCard).toBe("新名片");
      expect(sameSecond?.personalNickname).toBe("新昵");
      // 更早观察：不回退当前目录。
      const older = rememberQqMemberNames(h.orm, {
        scope,
        userId: "20002",
        names: { groupCard: "旧名片", personalNickname: "旧昵" },
        seenAtSeconds: at - 10,
      });
      expect(older?.groupCard).toBe("新名片");
      expect(older?.personalNickname).toBe("新昵");
    } finally {
      h.close();
    }
  });
  it("labels do not render the stale legacy nickname after an explicit dual-name clearing (F2)", () => {
    // F2：显式清空双名后 nameState=unknown，nickname 列留着旧值（NOT NULL 列约束），
    // 时间线标签不得再渲染旧昵称——读取方按 nameState 过滤，unknown 不输出旧 label。
    const h = setup();
    try {
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_f2a",
          messageId: "ma",
          speaker: {
            kind: "member",
            id: "20002",
            displayName: "旧昵",
            personalNickname: "旧昵",
          },
        }),
        agent,
      );
      // 清空前标签有值。
      expect(qqMemberLabels(h.orm, scope, now).get("20002")).toBe("旧昵");
      // 显式双名清空（严格更新的观察）：目录 unknown。
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_f2b",
          messageId: "mb",
          occurredAtSeconds: at + 10,
          speaker: {
            kind: "member",
            id: "20002",
            displayName: null,
            groupCard: null,
            personalNickname: null,
          },
        }),
        agent,
      );
      const row = memberRow(h.orm);
      expect(row.nameState).toBe("unknown");
      expect(row.personalNickname).toBeNull();
      expect(row.groupCard).toBeNull();
      // nickname 列仍存真实 legacy 显示证据（清空前的最后值）。
      expect(row.nickname).toBe("旧昵");
      // 但标签不再输出旧昵称——渲染回退 QQ 号。
      expect(qqMemberLabels(h.orm, scope, now).has("20002")).toBe(false);
      // legacy 行（真实单昵称目录）的标签不受影响：still 渲染 nickname。
      h.orm
        .update(schema.qqMembers)
        .set({ nameState: "legacy", groupCard: null, personalNickname: null })
        .run();
      expect(qqMemberLabels(h.orm, scope, now).get("20002")).toBe("旧昵");
    } finally {
      h.close();
    }
  });
  it("known row with both current names blank does not fall back to the legacy nickname column (fix3)", () => {
    // fix3：known 行双名皆空（真实 DDL 可达）时，旧 nickname 列不代表当前名——
    // 与 unknown 同语义不输出 label，渲染回退 QQ 号；不靠列 NOT NULL 防崩兜底。
    const h = setup();
    try {
      h.orm
        .insert(schema.qqMembers)
        .values({
          accountId: scope.accountId,
          conversationKind: scope.conversationKind,
          peerId: scope.peerId,
          userId: "20002",
          nickname: "旧列名",
          nameState: "known",
          groupCard: null,
          personalNickname: null,
          firstSeenAtSeconds: at,
          lastSeenAtSeconds: at,
          expiresAt: memberExpiresAt(at),
        })
        .run();
      expect(qqMemberLabels(h.orm, scope, now).has("20002")).toBe(false);
    } finally {
      h.close();
    }
  });
  it("known dual names still render their label after the F2 filter (F2)", () => {
    // known 行不受 F2 影响：双名照常输出，优先 card。
    const h = setup();
    try {
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_f2c",
          messageId: "mc",
          speaker: {
            kind: "member",
            id: "20002",
            displayName: "名片",
            groupCard: "名片",
            personalNickname: "昵称",
          },
        }),
        agent,
      );
      const row = memberRow(h.orm);
      expect(row.nameState).toBe("known");
      expect(qqMemberLabels(h.orm, scope, now).get("20002")).toBe("名片");
    } finally {
      h.close();
    }
  });
  it("paused intake still records names; the cycle neither schedules nor purges", () => {
    const h = setup();
    try {
      updateQqSettings(h.orm, { enabled: true, accountId: scope.accountId, expectedRevision: 1 });
      const scheme = createQqScheme(h.orm, { name: "test" });
      h.orm
        .insert(schema.qqBindings)
        .values({
          id: "00000000-0000-0000-0000-000000000002",
          accountId: scope.accountId,
          conversationKind: "group",
          peerId: scope.peerId,
          agentId: agent,
          schemeId: scheme.id,
          paused: 1,
          shareWebMemory: 0,
          revision: 1,
          authorityRevision: 1,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .run();
      expect(
        recordInbound(
          h.orm,
          { kind: "message", observation: observation() },
          { accountId: scope.accountId },
        ).kind,
      ).toBe("recorded");
      const labels = qqMemberLabels(h.orm, scope, now);
      const sections = buildQqPrompt({
        tier: "reply",
        path: "direct_reply",
        persona: "",
        prompts: QQ_PROMPT_DEFAULTS,
        nowSeconds: at,
        labels,
        timeline: [
          {
            occurredAtSeconds: at,
            speaker: "member",
            speakerId: "20002",
            text: "合成正文",
            mediaNotes: [],
            mediaUnread: 0,
          },
        ],
      });
      expect(sections.find((s) => s.origin === "timeline")?.body).toContain("昵称(20002)");
      // The paused binding schedules nothing — and the same pass deletes nothing: expiry makes
      // the name unreadable, while physical deletion waits for the manual cleanup.
      expect(qqIntakeCycle(h.orm, memberExpiresAt(at)).enqueued).toBe(0);
      expect(qqMemberLabels(h.orm, scope, memberExpiresAt(at)).size).toBe(0);
      expect(h.orm.select().from(schema.qqMembers).all()).toHaveLength(1);
    } finally {
      h.close();
    }
  });
  it("unbound intake stores neither messages nor nicknames", () => {
    const h = setup();
    try {
      updateQqSettings(h.orm, { enabled: true, accountId: scope.accountId, expectedRevision: 1 });
      expect(
        recordInbound(
          h.orm,
          { kind: "message", observation: observation() },
          { accountId: scope.accountId },
        ),
      ).toEqual({ kind: "ignored", reason: "unbound_conversation" });
      expect(h.orm.select().from(schema.qqMembers).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });
});

describe("legacy display name in the live snapshot path (F3)", () => {
  it("records legacyDisplayName and nameState legacy when the directory is legacy and wire names are absent", () => {
    // §13.5/§4.5：legacy 行只有一份单昵称证据。发送时 wire 缺省双名时，快照应携带
    // legacyDisplayName（不冒充双名），而不是全空 unknown。
    const h = setup();
    try {
      // legacy 目录：只有 nickname 列有值（0052 之前的行）。
      h.orm
        .insert(schema.qqMembers)
        .values({
          accountId: scope.accountId,
          conversationKind: scope.conversationKind,
          peerId: scope.peerId,
          userId: "20002",
          nickname: "旧显示",
          firstSeenAtSeconds: at,
          lastSeenAtSeconds: at,
          // legacy 行必须仍活在本轮窗口内（默认 14 天窗口会随真实时钟到期），显式给上限保留期。
          expiresAt: memberExpiresAt(at, 3650),
          nameState: "legacy",
          groupCard: null,
          personalNickname: null,
        })
        .run();
      const result = recordObservation(h.orm, observation(), agent);
      expect(result.recorded).toBe(true);
      const row = h.db
        .query(
          "SELECT group_card,personal_nickname,legacy_display_name,name_state FROM qq_message_facts WHERE event_key=?",
        )
        .get("event1") as Record<string, unknown>;
      expect(row.legacy_display_name).toBe("旧显示");
      expect(row.name_state).toBe("legacy");
      expect(row.group_card).toBeNull();
      expect(row.personal_nickname).toBeNull();
    } finally {
      h.close();
    }
  });
  it("wire dual names win over a legacy directory and are not faked as dual from legacy (F3)", () => {
    const h = setup();
    try {
      h.orm
        .insert(schema.qqMembers)
        .values({
          accountId: scope.accountId,
          conversationKind: scope.conversationKind,
          peerId: scope.peerId,
          userId: "20002",
          nickname: "旧显示",
          firstSeenAtSeconds: at,
          lastSeenAtSeconds: at,
          expiresAt: memberExpiresAt(at),
          nameState: "legacy",
          groupCard: null,
          personalNickname: null,
        })
        .run();
      recordObservation(
        h.orm,
        observation({
          eventKey: "evt_wire",
          messageId: "mw",
          speaker: {
            kind: "member",
            id: "20002",
            displayName: "名片",
            groupCard: "名片",
            personalNickname: "昵称",
          },
        }),
        agent,
      );
      const row = h.db
        .query(
          "SELECT group_card,personal_nickname,legacy_display_name,name_state FROM qq_message_facts WHERE event_key=?",
        )
        .get("evt_wire") as Record<string, unknown>;
      expect(row.group_card).toBe("名片");
      expect(row.personal_nickname).toBe("昵称");
      expect(row.legacy_display_name).toBeNull();
      expect(row.name_state).toBe("known");
    } finally {
      h.close();
    }
  });
  it("a later nameless observation does not erase legacy evidence or push the row to unknown (F1 side-effect guard)", () => {
    // rememberQqMemberNames 对缺省双名会把 legacy 当前行转 unknown——这会影响下一条消息
    // 的快照来源。没有新名字观察时，legacy 证据必须原样保留。
    const h = setup();
    try {
      h.orm
        .insert(schema.qqMembers)
        .values({
          accountId: scope.accountId,
          conversationKind: scope.conversationKind,
          peerId: scope.peerId,
          userId: "20002",
          nickname: "旧显示",
          firstSeenAtSeconds: at,
          lastSeenAtSeconds: at,
          expiresAt: memberExpiresAt(at),
          nameState: "legacy",
          groupCard: null,
          personalNickname: null,
        })
        .run();
      const result = recordObservation(h.orm, observation(), agent);
      expect(result.recorded).toBe(true);
      const row = memberRow(h.orm);
      expect(row.nameState).toBe("legacy");
      expect(row.nickname).toBe("旧显示");
      expect(row.groupCard).toBeNull();
      expect(row.personalNickname).toBeNull();
    } finally {
      h.close();
    }
  });
  it("a strictly newer nameless observation reaches the legacy guard and leaves the row untouched (F1 side-effect guard)", () => {
    // guard 有效性：legacy 行 last_seen=at，观察 at+1——严格更新穿过同秒早退，
    // 真正到达 legacy guard：缺省双名的交付不降级 legacy 行。displayName 也缺省，
    // 避免旧 rememberQqMember 路径（保留"最新看到过的显示证据"语义）干扰断言。
    const h = setup();
    try {
      h.orm
        .insert(schema.qqMembers)
        .values({
          accountId: scope.accountId,
          conversationKind: scope.conversationKind,
          peerId: scope.peerId,
          userId: "20002",
          nickname: "旧显示",
          firstSeenAtSeconds: at,
          lastSeenAtSeconds: at,
          expiresAt: memberExpiresAt(at),
          nameState: "legacy",
          groupCard: null,
          personalNickname: null,
        })
        .run();
      const result = recordObservation(
        h.orm,
        observation({
          occurredAtSeconds: at + 1,
          speaker: { kind: "member", id: "20002", displayName: null },
        }),
        agent,
      );
      expect(result.recorded).toBe(true);
      const row = memberRow(h.orm);
      expect(row.nameState).toBe("legacy");
      expect(row.nickname).toBe("旧显示");
      expect(row.lastSeenAtSeconds).toBe(at);
      expect(row.groupCard).toBeNull();
      expect(row.personalNickname).toBeNull();
    } finally {
      h.close();
    }
  });
  it("legacy path labels use only the original nickname; a real card set by the dual-name path wins on known rows (F2)", () => {
    // 真实旧 rememberQqMember 路径只更新 nickname 列（nameState 留 legacy default），
    // legacy 行的 label 必须仍是 nickname。known 行（labels 读真实双名后）card trim
    // 非空优先于 nickname；私聊不取 card。
    const h = setup();
    try {
      // 旧路径：只有 rememberQqMember（真实旧链路），nameState 落默认 legacy。
      h.orm
        .insert(schema.qqMembers)
        .values({
          accountId: scope.accountId,
          conversationKind: scope.conversationKind,
          peerId: scope.peerId,
          userId: "20002",
          nickname: "旧路径名",
          firstSeenAtSeconds: at,
          lastSeenAtSeconds: at,
          expiresAt: memberExpiresAt(at),
          nameState: "legacy",
          groupCard: "真名片",
          personalNickname: null,
        })
        .run();
      // legacy 行：label 用原 nickname，不取 groupCard。
      expect(qqMemberLabels(h.orm, scope, now).get("20002")).toBe("旧路径名");
      // known 行（真实 intake 双名写入）：card trim 非空优先。
      h.orm.update(schema.qqMembers).set({ nameState: "known", personalNickname: "真昵称" }).run();
      expect(qqMemberLabels(h.orm, scope, now).get("20002")).toBe("真名片");
      // card 清空（CHECK 只允许 NULL，空白卡由 normalize 侧已转 null）后回退 personalNickname。
      h.orm.update(schema.qqMembers).set({ groupCard: null }).run();
      expect(qqMemberLabels(h.orm, scope, now).get("20002")).toBe("真昵称");
      // 私聊 scope：card 不参与，label 用 personalNickname。
      const privateScope = { ...scope, conversationKind: "private" };
      rememberQqMemberNames(h.orm, {
        scope: privateScope,
        userId: "20003",
        names: { groupCard: null, personalNickname: "私聊昵" },
        seenAtSeconds: at,
      });
      expect(qqMemberLabels(h.orm, privateScope, now).get("20003")).toBe("私聊昵");
    } finally {
      h.close();
    }
  });
});
