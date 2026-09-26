// 发言与节奏的四个开关：各自只关自己那一条路。
//
// 方案页上的四个勾选框（直接回应／连续交谈／自主接话／冷场发起）是**四条独立的路**：
//
//   直接回应 direct_reply  群内被 @、或任何私聊消息 → 立即路径（被叫到就是决定，不跑判断）
//   连续交谈 follow_up     她开口之后群友又说话（非 @）→ 同一条立即路径
//   自主接话 chiming_in    群内非 @ 的群友消息 → 候选 → 排队路径（跑判断打分）
//   冷场发起 idle_topic    房间安静够了 → 冷场扫描写候选 → 排队路径
//
// 这一组用例是"审计"而不是回归：它把四条路各自的**启动信号**和**开关关掉后的拒绝**逐条钉住，
// 再逐个数断言"关掉一个不影响另外三个"，最后钉住一处容易出错的交叉：被立即路径回过的那条消息，
// 留在队列里的自主接话候选不能因此再回一次。

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { type BusinessDbHandle, toOrmHandle } from "../../src/server/db/connection";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { recordQqSpeech } from "../../src/server/db/qq-speech-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  enqueueQqDispatchFromEvent,
  nextQqImmediateReplyTask,
  sweepQqIdleTopics,
} from "../../src/server/services/qq-dispatch";
import type { QqSpeechKind } from "../../src/server/services/qq-speaking-contract";
import type { QqStickerStage } from "../../src/server/services/qq-sticker-runner";
import type { QqSpeechTriggers } from "../../src/shared/contracts/qq";
import {
  runQqDispatchCycle,
  runQqImmediateReplyCycle,
} from "../fixtures/legacy-qq/qq-dispatch-cycle";

const agentId = "00000000-0000-0000-0000-000000000001";
const bindingId = "11111111-1111-4111-8111-111111111111";
const peerId = "30003";
const speaker = "20002";
const now = 2_000_000_000;
const stage: QqStickerStage = { counts: ["confirmed"], isAvailable: () => false };

const ALL_ON: QqSpeechTriggers = Object.freeze({
  direct_reply: true,
  follow_up: true,
  chiming_in: true,
  idle_topic: true,
});

const migratedImage = (() => {
  const h = openBusinessDb();
  const image = h.db.serialize();
  h.close();
  return image;
})();

function cloneBusinessDb(): BusinessDbHandle {
  const db = Database.deserialize(migratedImage);
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  return toOrmHandle(db);
}

/** One account, one scheme whose four switches are given, one bound group. */
function setup(triggers: QqSpeechTriggers = ALL_ON) {
  const h = cloneBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, { name: "synthetic", triggers: { ...triggers } });
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId,
      schemeId: scheme.id,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  return { h, schemeId: scheme.id };
}

function message(orm: Orm, key: string, at: number, addressed = false): void {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: key,
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId,
      messageId: key,
      occurredAtSeconds: at,
      speakerKind: "member",
      speakerId: speaker,
      addressed: addressed ? 1 : 0,
      recordedAt: nowIso(),
    })
    .run();
  orm
    .insert(schema.qqObservationText)
    .values({
      eventKey: key,
      body: `${key} 的内容`,
      occurredAtSeconds: at,
      expiresAt: new Date((at + 3600) * 1000).toISOString(),
      recordedAt: nowIso(),
    })
    .run();
}

function ownSpeech(orm: Orm, at: number, kind: QqSpeechKind = "chiming_in"): void {
  recordQqSpeech(orm, {
    scope: { kind: "qq", accountId: "10001", conversationKind: "group", peerId, agentId },
    kind,
    spokeAtSeconds: at,
    text: "我说的",
  });
}

/** Counts model calls and answers them in order; an extra call fails the test loudly. */
function scripted(answers: readonly string[]) {
  const calls: string[] = [];
  return {
    calls,
    gateway: {
      loadedContextCapacity: async () => 65536,
      complete: async () => {
        calls.push("complete");
        const answer = answers[calls.length - 1];
        if (answer === undefined) throw new Error("unexpected model call");
        return answer;
      },
    },
  };
}

function senderOf() {
  const delivered: string[] = [];
  const targets: (string | null)[] = [];
  return {
    delivered,
    targets,
    send: async ({
      prepared,
    }: {
      prepared: { text: string | null; targetSpeakerId: string | null };
    }) => {
      delivered.push(prepared.text ?? "");
      targets.push(prepared.targetSpeakerId);
      return null;
    },
  };
}

/** 直接回应：群内一条 @ 消息，取立即路径给不给它任务。 */
function directSignal(h: BusinessDbHandle): "direct_reply" | null {
  message(h.orm, "direct-1", now - 10, true);
  const task = nextQqImmediateReplyTask(h.orm, { nowSeconds: now });
  return task?.path === "direct_reply" ? "direct_reply" : null;
}

/** 连续交谈：她说过话之后群友又说话（非 @）。 */
function followSignal(h: BusinessDbHandle): "follow_up" | null {
  ownSpeech(h.orm, now - 120);
  message(h.orm, "follow-1", now - 60);
  const task = nextQqImmediateReplyTask(h.orm, { nowSeconds: now });
  return task?.path === "follow_up" ? "follow_up" : null;
}

/** 自主接话：一条非 @ 群友消息经分类入口是否写下候选。 */
function chimingSignal(h: BusinessDbHandle): "chiming_in" | null {
  message(h.orm, "chiming-1", now - 60);
  const result = enqueueQqDispatchFromEvent(h.orm, {
    bindingId,
    conversationKind: "group",
    speaker: "member",
    speakerId: speaker,
    mentionsSelf: false,
    eventKey: "chiming-1",
    observedAtSeconds: now - 60,
    nowSeconds: now,
    mergeWindowSeconds: 30,
  });
  return result.kind === "scheduled" && result.path === "chiming_in" ? "chiming_in" : null;
}

/** 冷场发起：安静够了的房间，扫描是否排下候选。 */
function idleSignal(h: BusinessDbHandle): { scheduled: boolean; reason: string | null } {
  message(h.orm, "idle-1", now - 20 * 60);
  const sweep = sweepQqIdleTopics(h.orm, { nowSeconds: now });
  const scheduled = sweep.scheduled.some((entry) => entry.path === "idle_topic");
  return { scheduled, reason: sweep.skipped[0]?.reason ?? null };
}

describe("speech triggers: each switch stops exactly its own path", () => {
  it("answers an addressed message without a judgement call", async () => {
    const { h } = setup();
    try {
      message(h.orm, "direct-1", now - 10, true);
      const model = scripted(["在的"]);
      const sender = senderOf();
      const result = await runQqImmediateReplyCycle(
        h.orm,
        model.gateway,
        { nowSeconds: now },
        stage,
        sender.send,
      );
      expect(result).toMatchObject({ kind: "authorized", path: "direct_reply" });
      expect(model.calls).toEqual(["complete"]);
      expect(sender.delivered).toEqual(["在的"]);
    } finally {
      h.close();
    }
  });

  it("refuses the addressed message when 直接回应 is off, with no model call", async () => {
    const { h } = setup({ ...ALL_ON, direct_reply: false });
    try {
      message(h.orm, "direct-1", now - 10, true);
      const model = scripted([]);
      const sender = senderOf();
      expect(nextQqImmediateReplyTask(h.orm, { nowSeconds: now })).toBeNull();
      expect(
        await runQqImmediateReplyCycle(
          h.orm,
          model.gateway,
          { nowSeconds: now },
          stage,
          sender.send,
        ),
      ).toEqual({ kind: "idle" });
      expect(model.calls).toEqual([]);
      expect(sender.delivered).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("starts a continuation when a partner speaks after her, and stops when 连续交谈 is off", async () => {
    const on = setup();
    try {
      expect(followSignal(on.h)).toBe("follow_up");
    } finally {
      on.h.close();
    }
    const off = setup({ ...ALL_ON, follow_up: false });
    try {
      expect(followSignal(off.h)).toBeNull();
    } finally {
      off.h.close();
    }
  });

  it("schedules an initiative candidate, runs it with a judgement call, and stops when 自主接话 is off", async () => {
    const on = setup();
    try {
      expect(chimingSignal(on.h)).toBe("chiming_in");
      const model = scripted(['{"score":9}', "张三你好"]);
      const sender = senderOf();
      const result = await runQqDispatchCycle(
        on.h.orm,
        model.gateway,
        { nowSeconds: now + 60 },
        stage,
        sender.send,
      );
      expect(result).toMatchObject({ kind: "authorized", path: "chiming_in" });
      expect(model.calls.length).toBeGreaterThan(0);
      expect(sender.delivered.length).toBe(1);
    } finally {
      on.h.close();
    }
    const off = setup({ ...ALL_ON, chiming_in: false });
    try {
      // 分类照写候选（那是"这条消息来过"的事实），开关管的是"说没说"。
      expect(chimingSignal(off.h)).toBe("chiming_in");
      const model = scripted([]);
      const sender = senderOf();
      const result = await runQqDispatchCycle(
        off.h.orm,
        model.gateway,
        { nowSeconds: now + 60 },
        stage,
        sender.send,
      );
      expect(result).toMatchObject({ kind: "held", reason: "trigger_off" });
      // 关掉的开关不花一次模型调用：这是"关掉"与"判过但不说"的分界。
      expect(model.calls).toEqual([]);
      expect(sender.delivered).toEqual([]);
    } finally {
      off.h.close();
    }
  });

  it("opens a quiet room, and refuses to when 冷场发起 is off", async () => {
    const on = setup();
    try {
      expect(idleSignal(on.h)).toEqual({ scheduled: true, reason: null });
    } finally {
      on.h.close();
    }
    const off = setup({ ...ALL_ON, idle_topic: false });
    try {
      expect(idleSignal(off.h)).toEqual({ scheduled: false, reason: "trigger_off" });
    } finally {
      off.h.close();
    }
  });

  it("turning one switch off leaves the other three paths unchanged", () => {
    // 四个开关各关一次，把四条路的信号一起读出来。这里要区分两类信号：
    //   * 「说没说」——立即路径给不给任务、冷场扫描排不排候选；
    //   * 「记没记」——非 @ 群友消息在分类入口是否写下候选（自主接话的候选是**投递事实**，
    //     开关管的是"说没说"，不是"记不记"；关掉它时候选照写，随后在预备阶段被判 trigger_off）。
    // 每条路各用一个自己的夹具：直接回应与连续交谈共用同一个"最新一条消息"的查找器，放在一个库里会互抢。
    const cases: readonly [QqSpeechKind, readonly [string, string, string, string]][] = [
      ["direct_reply", ["null", "follow_up", "chiming_in", "scheduled"]],
      ["follow_up", ["direct_reply", "null", "chiming_in", "scheduled"]],
      ["chiming_in", ["direct_reply", "follow_up", "chiming_in", "scheduled"]],
      ["idle_topic", ["direct_reply", "follow_up", "chiming_in", "trigger_off"]],
    ];
    const signal = (switches: QqSpeechTriggers, read: (h: BusinessDbHandle) => string): string => {
      const h = setup(switches).h;
      try {
        return read(h);
      } finally {
        h.close();
      }
    };
    for (const [off, expected] of cases) {
      const switches = { ...ALL_ON, [off]: false };
      expect([
        signal(switches, (h) => directSignal(h) ?? "null"),
        signal(switches, (h) => followSignal(h) ?? "null"),
        signal(switches, (h) => chimingSignal(h) ?? "null"),
        signal(switches, (h) => {
          const idle = idleSignal(h);
          return idle.scheduled ? "scheduled" : (idle.reason ?? "unknown");
        }),
      ]).toEqual([...expected]);
    }
  });

  it("still answers an @ that someone else's message pushed out of the newest slot, and replies to the caller", async () => {
    // 用户报告的"全勾上却有时候不回"（2026-09-25）：@ 之后、她开口之前有人又说了话，最新消息就换人了。
    // 旧实现只看最新那一条，于是这一轮去回别人、或者（她还没说过话时）整轮跳过。
    const other = "40004";
    const { h } = setup();
    try {
      message(h.orm, "call-1", now - 60, true);
      h.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "chat-2",
          accountId: "10001",
          conversationKind: "group",
          peerId,
          agentId,
          messageId: "chat-2",
          occurredAtSeconds: now - 30,
          speakerKind: "member",
          speakerId: other,
          addressed: 0,
          recordedAt: nowIso(),
        })
        .run();
      h.orm
        .insert(schema.qqObservationText)
        .values({
          eventKey: "chat-2",
          body: "别人插的一句",
          occurredAtSeconds: now - 30,
          expiresAt: new Date((now + 3600) * 1000).toISOString(),
          recordedAt: nowIso(),
        })
        .run();
      const model = scripted(["在的"]);
      const sender = senderOf();
      const result = await runQqImmediateReplyCycle(
        h.orm,
        model.gateway,
        { nowSeconds: now },
        stage,
        sender.send,
      );
      expect(result).toMatchObject({ kind: "authorized", path: "direct_reply" });
      expect(sender.delivered).toEqual(["在的"]);
      // 回话对象是叫她的人，不是最后说话的那个人。
      expect(sender.targets).toEqual([speaker]);
    } finally {
      h.close();
    }
  });

  it("does not reply twice when the immediate path already answered the same message", async () => {
    const { h } = setup();
    try {
      ownSpeech(h.orm, now - 120);
      message(h.orm, "both-1", now - 60);
      // 事件路径先写下自主接话候选（非 @ 消息都会写一条）。
      expect(chimingSignal(h)).toBe("chiming_in");
      // 立即路径把这条消息当连续交谈回掉，并把确认送达写成她自己的发言。
      const first = scripted(["好呀"]);
      const delivered = senderOf();
      const immediate = await runQqImmediateReplyCycle(
        h.orm,
        first.gateway,
        { nowSeconds: now },
        stage,
        delivered.send,
      );
      expect(immediate).toMatchObject({ kind: "authorized", path: "follow_up" });
      ownSpeech(h.orm, now - 30, "follow_up");
      // 队列里那条候选随后到期：它必须发现"没有人比她的发言更新"，于是不发也不调模型。
      const second = scripted([]);
      const result = await runQqDispatchCycle(
        h.orm,
        second.gateway,
        { nowSeconds: now + 60 },
        stage,
        delivered.send,
      );
      expect(result).toMatchObject({ kind: "held", reason: "nothing_to_answer" });
      expect(second.calls).toEqual([]);
      expect(delivered.delivered).toEqual(["好呀"]);
    } finally {
      h.close();
    }
  });
});
