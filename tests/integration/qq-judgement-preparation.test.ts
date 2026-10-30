import { describe, expect, it } from "bun:test";
import {
  attemptedUnreadMediaCount,
  recordMediaAttempt,
  recordMediaNote,
  recordMediaSegment,
} from "../../src/server/db/qq-media-repository";
import {
  createQqScheme,
  schemeRhythm,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { QQ_CONTEXT_DEFAULT as fixtureLegacyContext } from "../../src/server/services/qq-context-contract";
import { prepareQqJudgement } from "../../src/server/services/qq-judgement-preparation";
import { QQ_PROMPT_DEFAULTS } from "../../src/server/services/qq-prompt-contract";
import { QQ_RHYTHM_DEFAULT as fixtureLegacyRhythm } from "../../src/server/services/qq-rhythm-contract";
import { QQ_ALLOCATION_DEFAULT as fixtureLegacyAllocation } from "../../src/shared/contracts/context-allocation";
import * as fixtureLegacyQq from "../../src/shared/contracts/qq";
import { runtimeFixtureBusiness } from "../harness/business-db";

const agentId = "00000000-0000-0000-0000-000000000001";
const bindingId = "11111111-1111-4111-8111-111111111111";
const now = 2_000_000_000;

function setup(
  options: {
    enabled?: boolean;
    paused?: boolean;
    chiming?: boolean;
    nickname?: boolean;
    /** 0038: the QQ-global judgement model, unset = follow the assistant's conversation model. */
    judgementModel?: string;
  } = {},
) {
  const h = runtimeFixtureBusiness(openBusinessDb(), "synthetic-model");
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, {
    accountId: "10001",
    enabled: options.enabled ?? true,
    ...(options.judgementModel === undefined ? {} : { judgementModelName: options.judgementModel }),
    expectedRevision: 1,
  });
  const scheme = createQqScheme(h.orm, {
    context: { ...fixtureLegacyContext },
    rhythm: { ...fixtureLegacyRhythm },
    compression: { ...fixtureLegacyQq.QQ_COMPRESSION_DEFAULT },
    outputReserve: { ...fixtureLegacyQq.QQ_MODEL_OUTPUT_RESERVE_DEFAULT },
    allocation: structuredClone(fixtureLegacyAllocation),
    stickers: { ...fixtureLegacyQq.QQ_STICKER_DEDUP_DEFAULT },
    mediaInput: structuredClone(fixtureLegacyQq.QQ_MEDIA_INPUT_SCHEME_DEFAULT),
    name: "synthetic",
    triggers: {
      direct_reply: false,
      follow_up: false,
      chiming_in: options.chiming ?? true,
      idle_topic: true,
    },
    prompts: { ...QQ_PROMPT_DEFAULTS, judge: "自定义判断任务" },
  });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId,
      schemeId: scheme.id,
      paused: options.paused ? 1 : 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  event(h.orm, "old", now - 90, "旧消息");
  event(h.orm, "latest", now - 40, "新消息");
  if (options.nickname) {
    h.orm
      .insert(schema.qqMembers)
      .values({
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        userId: "20002",
        nickname: "小明",
        firstSeenAtSeconds: now - 40,
        lastSeenAtSeconds: now - 40,
        expiresAt: new Date((now + 3600) * 1000).toISOString(),
      })
      .run();
  }
  return h;
}
function event(orm: Orm, key: string, at: number, text: string, speakerId = "20002") {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: key,
      accountId: "10001",
      conversationKind: "group",
      peerId: "30003",
      agentId,
      messageId: key,
      occurredAtSeconds: at,
      speakerKind: "member",
      speakerId,
      recordedAt: nowIso(),
    })
    .run();
  orm
    .insert(schema.qqObservationText)
    .values({
      eventKey: key,
      body: text,
      occurredAtSeconds: at,
      expiresAt: new Date((at + 3600) * 1000).toISOString(),
      recordedAt: nowIso(),
    })
    .run();
}
const request = (path = "chiming_in", seconds = now) => ({
  bindingId,
  path,
  nowSeconds: seconds,
});
describe("offline QQ judgement preparation", () => {
  it("prepares only the current target, without assembling model material", () => {
    const h = setup({ nickname: true });
    try {
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "prepared",
        path: "chiming_in",
        targets: [{ speakerId: "20002", newestSeconds: now - 40, messageCount: 2 }],
      });
    } finally {
      h.close();
    }
  });
  it("blocks when switch, binding pause or path switch is off", () => {
    for (const options of [{ enabled: false }, { paused: true }, { chiming: false }]) {
      const h = setup(options);
      try {
        const result = prepareQqJudgement(h.orm, request());
        expect(result).toEqual({
          kind: "blocked",
          reason:
            !options.enabled && options.enabled !== undefined
              ? "feature_off"
              : options.paused
                ? "conversation_paused"
                : "trigger_off",
        });
      } finally {
        h.close();
      }
    }
  });
  it("waits for the merge window and enforces the initiative cooldown", () => {
    const h = setup();
    try {
      expect(prepareQqJudgement(h.orm, request("chiming_in", now - 25))).toEqual({
        kind: "blocked",
        reason: "waiting_for_batch",
        readyAtSeconds: now - 10,
      });
      // 0037: 冷却要在自主接话里**真的**挡得住，就得比合并窗口长。理由是个算术事实：一个"值得回"
      // 的人必须是在她上次开口之后说过话（eligible）**并且**自己那一条已经过了合并窗口（ripe），
      // 于是 `他的消息 ≤ now − 合并窗口`；而冷却要求 `她的开口 > now − 冷却`。冷却 ≤ 合并窗口时这两条
      // 不可能同时成立——所以默认的 10 秒冷却在这条路径上永远不会单独生效（它被合并窗口盖住了）。
      // 这里把冷却调到 600 秒，场景就是"她刚回过、有人又说了话、她还在冷却里"。
      const row = h.orm.select().from(schema.qqSchemes).all()[0];
      if (!row) throw new Error("synthetic scheme missing");
      updateQqScheme(h.orm, row.id, {
        name: "synthetic",
        rhythm: { ...schemeRhythm(row), reply_cooldown_seconds: 600 },
        expectedRevision: row.revision,
      });
      h.orm
        .insert(schema.qqSpeechLog)
        .values({
          id: "22222222-2222-4222-8222-222222222222",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId,
          kind: "direct_reply",
          spokeAtSeconds: now - 60,
          expiresAt: new Date((now + 3600) * 1000).toISOString(),
          recordedAt: nowIso(),
        })
        .run();
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "cooling_down",
        readyAtSeconds: now + 540,
      });
    } finally {
      h.close();
    }
  });
  it("does not repeat an unanswered initiative even when its cooldown elapsed", () => {
    const h = setup();
    try {
      h.orm
        .insert(schema.qqSpeechLog)
        .values({
          id: "22222222-2222-4222-8222-222222222222",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId,
          kind: "chiming_in",
          spokeAtSeconds: now - 35,
          expiresAt: new Date((now + 3600) * 1000).toISOString(),
          recordedAt: nowIso(),
        })
        .run();
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "awaiting_reply",
      });
    } finally {
      h.close();
    }
  });
  it("prepares all four paths, and still refuses a path that does not exist", () => {
    const h = setup();
    try {
      // P5s: the two REPLY paths prepare here too — they share the switch/pause/agent gates and
      // skip the initiative-only ones (merge window, cooldown, hourly cap). 写入侧双真互斥后，
      // 各路径按自己的合法基态开：direct/follow 一态（chiming 关），chiming 另一态（follow 关）。
      h.orm
        .update(schema.qqSchemes)
        .set({ triggerDirectReply: 1, triggerFollowUp: 1, triggerChimingIn: 0 })
        .run();
      // A minute later the merge window has passed, so the paths whose remaining gates are
      // satisfied prepare; the difference between reply and initiative paths is pinned in the next
      // test.
      for (const path of ["direct_reply", "follow_up"])
        expect(prepareQqJudgement(h.orm, request(path, now + 60)).kind).toBe("prepared");
      h.orm.update(schema.qqSchemes).set({ triggerFollowUp: 0, triggerChimingIn: 1 }).run();
      expect(prepareQqJudgement(h.orm, request("chiming_in", now + 60)).kind).toBe("prepared");
      // An opener additionally needs the room to have gone quiet, so it prepares a quarter of an
      // hour later — through the same entry.
      expect(prepareQqJudgement(h.orm, request("idle_topic", now + 16 * 60)).kind).toBe("prepared");
      expect(() => prepareQqJudgement(h.orm, request("wrong"))).toThrow(TypeError);
    } finally {
      h.close();
    }
  });

  it("prepares a reply inside the merge window that holds an initiative back", () => {
    const h = setup();
    try {
      // The batch window exists to collect messages before JUDGING an initiative. Someone talking
      // TO the assistant is not that case: an @ must prepare (and be answered) right away, which is
      // exactly why the immediate paths run through this entry with the initiative gates skipped.
      h.orm
        .update(schema.qqSchemes)
        .set({ triggerDirectReply: 1, triggerChimingIn: 1, triggerFollowUp: 0 })
        .run();
      h.orm.update(schema.qqEvents).set({ occurredAtSeconds: now }).run();
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "waiting_for_batch",
        readyAtSeconds: expect.any(Number),
      });
      expect(prepareQqJudgement(h.orm, request("direct_reply")).kind).toBe("prepared");
      // continuous 按自己的合法基态开：必回路径不吃合并窗口。
      h.orm.update(schema.qqSchemes).set({ triggerChimingIn: 0, triggerFollowUp: 1 }).run();
      expect(prepareQqJudgement(h.orm, request("follow_up")).kind).toBe("prepared");
    } finally {
      h.close();
    }
  });
  it("rejects missing binding, invalid shape, disabled assistant and account mismatch", () => {
    const h = setup();
    try {
      expect(
        prepareQqJudgement(h.orm, {
          ...request(),
          bindingId: "33333333-3333-4333-8333-333333333333",
        }),
      ).toEqual({ kind: "blocked", reason: "binding_missing" });
      expect(() => prepareQqJudgement(h.orm, { ...request(), extra: true })).toThrow(TypeError);
      h.orm.update(schema.agents).set({ isActive: 0 }).run();
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "agent_unavailable",
      });
      h.orm.update(schema.qqSettings).set({ accountId: "99999" }).run();
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "account_mismatch",
      });
    } finally {
      h.close();
    }
  });
});

// 读过了却没读出（在途或失败）就不要自主接话。"读取失败"的口径是
// 「花过尝试、仍没有描述」——不是"任何未读"（还没试过的不拦，否则没接视觉通道时她会永久闭嘴），
// 也不是"两次都失败"（第一张读不出来的图就已经是"没读懂还硬要说话"）。
// 回复任务文案由方案的「按发言人分开回答」开关选，两套都是程序文案。
describe("media that was attempted and never read ", () => {
  /** One picture on a message, with a spent read attempt: attempted, still no description. */
  function attemptedImage(orm: Orm, eventKey: string) {
    recordMediaSegment(orm, {
      eventKey,
      segmentIndex: 0,
      kind: "image",
      sourceRef: "qq-media://synthetic",
      occurredAtSeconds: now - 40,
      addressed: false,
    });
    recordMediaAttempt(orm, { eventKey, segmentIndex: 0 });
  }

  it("refuses to chime in when its own target has an unread failed image", () => {
    const h = setup();
    try {
      attemptedImage(h.orm, "latest");
      expect(prepareQqJudgement(h.orm, request())).toEqual({
        kind: "blocked",
        reason: "media_read_failed",
      });
    } finally {
      h.close();
    }
  });

  it("lets an idle opener through: it answers no message, so there is no picture to have read", () => {
    const h = setup();
    try {
      attemptedImage(h.orm, "latest");
      // 冷场发起不回应任何具体消息，没有"你要回应的那张图"这个对象。模型仍然看得见
      // 那条"没有描述的图片"，§7.1 照旧禁止假装知道——但一张别人发的图不该让她连话题都不能开。
      expect(prepareQqJudgement(h.orm, request("idle_topic", now + 16 * 60)).kind).toBe("prepared");
    } finally {
      h.close();
    }
  });

  it("still answers when it is the one being addressed", () => {
    const h = setup();
    try {
      // 合法基态开 direct/follow（chiming 关）：回应路径不被读不出的图按住。
      h.orm
        .update(schema.qqSchemes)
        .set({ triggerDirectReply: 1, triggerFollowUp: 1, triggerChimingIn: 0 })
        .run();
      attemptedImage(h.orm, "latest");
      // Being called is someone else's question, not her initiative: a picture she could not read
      // must not turn an @ into silence.
      for (const path of ["direct_reply", "follow_up"])
        expect(prepareQqJudgement(h.orm, request(path)).kind).toBe("prepared");
      // 自主基态（follow 关）里那张图仍然按住自主接话。
      h.orm.update(schema.qqSchemes).set({ triggerFollowUp: 0, triggerChimingIn: 1 }).run();
      expect(prepareQqJudgement(h.orm, request("chiming_in"))).toEqual({
        kind: "blocked",
        reason: "media_read_failed",
      });
    } finally {
      h.close();
    }
  });

  /**
   * 闸门原来按整个判断窗口（60 分钟）算消息，于是那张 14:43 读失败的图把
   * 15:09–15:32 的每一轮 chiming_in 都按住了。这一轮要回谁，就只看谁的消息。
   */
  it("scopes the gate to the people this round answers, not the whole window", () => {
    const h = setup();
    try {
      event(h.orm, "other", now - 200, "别人的消息", "30004");
      attemptedImage(h.orm, "other");
      const pending = (speakerId: string, newestSeconds: number) => [
        { speakerId, newestSeconds, messageCount: 1 },
      ];
      // 这一轮要回的是 20002：30004 那张没读出的图仍在窗口里，但与这一轮无关。
      expect(
        prepareQqJudgement(h.orm, request(), {
          pendingTargets: pending("20002", now - 40),
        }),
      ).toMatchObject({ kind: "prepared" });
      // 要回的正是他：同一张图仍然按住这一轮。
      expect(
        prepareQqJudgement(h.orm, request(), {
          pendingTargets: pending("30004", now - 200),
        }),
      ).toEqual({ kind: "blocked", reason: "media_read_failed" });
    } finally {
      h.close();
    }
  });

  it("does not pre-empt media nothing has tried yet, nor media already read", () => {
    const h = setup();
    try {
      recordMediaSegment(h.orm, {
        eventKey: "latest",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "qq-media://synthetic",
        occurredAtSeconds: now - 40,
        addressed: false,
      });
      // A picture waiting for its turn is not a failure. Blocking here would silence every
      // initiative for as long as a read is queued, which is not what "读取失败" means.
      expect(prepareQqJudgement(h.orm, request()).kind).toBe("prepared");
      recordMediaAttempt(h.orm, { eventKey: "latest", segmentIndex: 0 });
      recordMediaNote(h.orm, {
        eventKey: "latest",
        segmentIndex: 0,
        note: "一只橘猫趴在键盘上",
        noteModel: "vision-local",
      });
      expect(prepareQqJudgement(h.orm, request()).kind).toBe("prepared");
    } finally {
      h.close();
    }
  });

  it("counts spent attempts only, and only for the messages it was handed", () => {
    const h = setup();
    try {
      recordMediaSegment(h.orm, {
        eventKey: "old",
        segmentIndex: 0,
        kind: "image",
        sourceRef: "qq-media://synthetic",
        occurredAtSeconds: now - 90,
        addressed: false,
      });
      // Waiting its turn is not a failure.
      expect(attemptedUnreadMediaCount(h.orm, ["old", "latest"])).toBe(0);
      recordMediaAttempt(h.orm, { eventKey: "old", segmentIndex: 0 });
      expect(attemptedUnreadMediaCount(h.orm, ["old", "latest"])).toBe(1);
      // The gate asks about the messages of ITS conversation; a key it was not given is not its
      // business, which is what keeps one group's broken picture out of another group's turn.
      expect(attemptedUnreadMediaCount(h.orm, ["latest"])).toBe(0);
      recordMediaNote(h.orm, {
        eventKey: "old",
        segmentIndex: 0,
        note: "一只橘猫趴在键盘上",
        noteModel: "vision-local",
      });
      // Once the attempt has an answer it stops being a failure, whatever it took.
      expect(attemptedUnreadMediaCount(h.orm, ["old", "latest"])).toBe(0);
      expect(attemptedUnreadMediaCount(h.orm, [])).toBe(0);
    } finally {
      h.close();
    }
  });

  it("does not let another conversation's unreadable picture silence this one", () => {
    const h = setup();
    try {
      attemptedImage(h.orm, "latest");
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "elsewhere",
          accountId: "10001",
          conversationKind: "group",
          peerId: "40004",
          agentId,
          messageId: "elsewhere",
          occurredAtSeconds: now - 40,
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: nowIso(),
        })
        .run();
      attemptedImage(h.orm, "elsewhere");
      expect(prepareQqJudgement(h.orm, request("chiming_in"))).toEqual({
        kind: "blocked",
        reason: "media_read_failed",
      });
      // The other group's read belongs to the other group's turn only.
      expect(attemptedUnreadMediaCount(h.orm, ["elsewhere"])).toBe(1);
    } finally {
      h.close();
    }
  });
});
