// 每人一条消息（0037，）：不同人的消息分开成各自的任务来跑。
//
// 用户看到的问题是"一次生成写多行、按行切开"这种做法**在结构上**允许搞混：模型要自己记住谁说了
// 什么、该 @ 谁。这一组用例钉的是新的骨架：
//
//   * 判断按人各一次（`{"score":n}` 一人一个答案），过门槛的人进这一轮；
//   * 生成也按人各一次，每次的提示词由**程序**写明"这一轮你回的是谁"，所以回错人不是提示词能不能
//     写好的问题；
//   * 一条消息一个收件人（`targetSpeakerId`），`@` 由发送通路按收件人加；
//   * 读数（0036）现在也是按人存的：一个人的分数不会替另一个人省下那次判断；
//   * 开关关掉时整轮收敛成一次生成、一条消息、不加 `@`（那是这个开关关掉时本来的行为）。

import { describe, expect, it } from "bun:test";
import { createQqScheme, updateQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { QQ_PROMPT_DEFAULTS } from "../../src/server/services/qq-prompt-contract";
import type { QqStickerStage } from "../../src/server/services/qq-sticker-runner";
import { runQqInitiativeCycle } from "../fixtures/legacy-qq/qq-initiative-cycle";

const agentId = "00000000-0000-0000-0000-000000000001";
const bindingId = "11111111-1111-4111-8111-111111111111";
const now = 2_000_000_000;
/** 两个群友：张三（较早说话）与李四（较晚说话）。 */
const zhang = "20002";
const li = "40004";

/** 空素材库：选图阶段直接答"没有候选"，于是模型调用序列就是"判断、生成"两类。 */
const noStickers: QqStickerStage = { counts: ["confirmed"], isAvailable: () => false };

function message(
  orm: Orm,
  key: string,
  at: number,
  speakerId: string | null,
  kind: "member" | "anonymous" = "member",
): void {
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
      speakerKind: kind,
      speakerId,
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

function setup(options: { splitBySpeaker?: boolean } = {}) {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  updateQqSettings(h.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "synthetic",
    triggers: { direct_reply: false, follow_up: false, chiming_in: true, idle_topic: true },
    prompts: { ...QQ_PROMPT_DEFAULTS, judge: "自定义判断任务" },
  });
  const row = h.orm.select().from(schema.qqSchemes).all()[0];
  if (!row) throw new Error("synthetic scheme missing");
  updateQqScheme(h.orm, scheme.id, {
    name: "synthetic",
    reply: { split_by_speaker: options.splitBySpeaker ?? true },
    expectedRevision: row.revision,
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
  return h;
}

/** 按顺序回答、并记下每一次请求的网关：调用次数本身就是断言。 */
function scripted(answers: readonly string[]) {
  const calls: { role: string; content: string }[][] = [];
  return {
    calls,
    gateway: {
      loadedContextCapacity: async () => 65536,
      complete: async (options: unknown) => {
        const { messages } = options as { messages: { role: string; content: string }[] };
        calls.push(messages);
        const answer = answers[calls.length - 1];
        if (answer === undefined) throw new Error("unexpected model call");
        return answer;
      },
    },
  };
}

const run = (orm: Orm, gateway: unknown) =>
  runQqInitiativeCycle(
    orm,
    gateway as never,
    { bindingId, path: "chiming_in", nowSeconds: now },
    noStickers,
  );

/** 所有请求里出现过的那一段文字，方便断言"这一次调用在回谁"。 */
const flat = (calls: readonly { content: string }[][]) =>
  calls.map((messages) => messages.map((m) => m.content).join("\n")).join("\n----\n");

describe("one task and one message per speaker (0037)", () => {
  it("judges each speaker separately and writes one message for each", async () => {
    const h = setup();
    try {
      message(h.orm, "a1", now - 1200, zhang);
      message(h.orm, "b1", now - 900, li);
      const gw = scripted(['{"score":9}', '{"score":9}', "张三你好", "李四你好"]);
      const result = await run(h.orm, gw.gateway);
      expect(result.kind).toBe("prepared_only");
      const drafts = result.kind === "prepared_only" ? result.drafts : [];
      // 两个发言人 → 两次判断 + 两条消息，顺序按"谁先开口"。
      expect(drafts.map((draft) => draft.pending.targetSpeakerId)).toEqual([zhang, li]);
      expect(drafts.map((draft) => draft.pending.text)).toEqual(["张三你好", "李四你好"]);
      // 每一次生成都只有一条文字部件：条数由人数决定，不由模型写几行决定。
      expect(
        drafts.map((draft) => (draft.plan.kind === "planned" ? draft.plan.parts.length : 0)),
      ).toEqual([1, 1]);
      // 场景行由程序写明回谁——这是"结构上不会搞混"的落点。
      expect(gw.calls[2]?.map((m) => m.content).join("\n")).toContain(
        `这一轮你要回的是 群友(${zhang})`,
      );
      expect(gw.calls[3]?.map((m) => m.content).join("\n")).toContain(
        `这一轮你要回的是 群友(${li})`,
      );
    } finally {
      h.close();
    }
  });

  it("answers only the people who clear the bar", async () => {
    const h = setup();
    try {
      message(h.orm, "a1", now - 1200, zhang);
      message(h.orm, "b1", now - 900, li);
      // 李四的分低于门槛：他这一轮不说话，张三的话照发。
      const gw = scripted(['{"score":9}', '{"score":2}', "只回张三"]);
      const result = await run(h.orm, gw.gateway);
      const drafts = result.kind === "prepared_only" ? result.drafts : [];
      expect(drafts.map((draft) => draft.pending.targetSpeakerId)).toEqual([zhang]);
      // 两次判断各问一次（李四 2 分、张三 9 分），只有过门槛的那条被写出来。
      expect(gw.calls).toHaveLength(3);
    } finally {
      h.close();
    }
  });

  it("judges each person every window — no cached score stands in", async () => {
    const h = setup();
    try {
      message(h.orm, "a1", now - 1200, zhang);
      message(h.orm, "b1", now - 900, li);
      // 2026-09-25：判断不再复用上次分数，所以两个人各问一次、一共四回请求。
      const gw = scripted(['{"score":8}', '{"score":8}', "张三你好", "李四你好"]);
      const result = await run(h.orm, gw.gateway);
      const drafts = result.kind === "prepared_only" ? result.drafts : [];
      expect(drafts.map((draft) => draft.pending.targetSpeakerId)).toEqual([zhang, li]);
      expect(gw.calls).toHaveLength(4);
      // 读数表不再被写入：它留在 schema 里只为不改结构，没有任何代码读写它。
      expect(h.orm.select().from(schema.qqJudgementReadings).all()).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("answers an anonymous speaker once, without a mention", async () => {
    const h = setup();
    try {
      message(h.orm, "anon", now - 1200, null, "anonymous");
      const gw = scripted(['{"score":9}', "匿名也回"]);
      const result = await run(h.orm, gw.gateway);
      const drafts = result.kind === "prepared_only" ? result.drafts : [];
      expect(drafts).toHaveLength(1);
      // 没有号 → 不加 `@`，也没有按人存的读数（没有办法知道是不是同一个人）。
      expect(drafts[0]?.pending.targetSpeakerId).toBeNull();
      expect(flat(gw.calls)).toContain("这一轮你要回的是 匿名群友");
      expect(flat(gw.calls)).not.toContain("开头会由程序 @ 他");
      expect(h.orm.select().from(schema.qqJudgementReadings).all()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it("collapses the round to one plain message when the switch is off", async () => {
    const h = setup({ splitBySpeaker: false });
    try {
      message(h.orm, "a1", now - 1200, zhang);
      message(h.orm, "b1", now - 900, li);
      const gw = scripted(['{"score":9}', "大家好"]);
      const result = await run(h.orm, gw.gateway);
      const drafts = result.kind === "prepared_only" ? result.drafts : [];
      expect(drafts).toHaveLength(1);
      // 关掉＝一次生成、一条消息、没有收件人（因此发送时不加 `@`），文案回到程序默认那一份。
      expect(drafts[0]?.pending.targetSpeakerId).toBeNull();
      expect(flat(gw.calls)).toContain(QQ_PROMPT_DEFAULTS.reply);
      expect(flat(gw.calls)).not.toContain("这一轮你要回的是");
    } finally {
      h.close();
    }
  });

  it("does not split one person's own sentence into several messages", async () => {
    const h = setup();
    try {
      message(h.orm, "a1", now - 1200, zhang);
      // 模型没听话，写了两行：一人一条消息是**结构**决定的，所以这里要并回一条。
      const gw = scripted(['{"score":9}', "张三你好\n顺便问一句"]);
      const result = await run(h.orm, gw.gateway);
      const drafts = result.kind === "prepared_only" ? result.drafts : [];
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.pending.text).toBe("张三你好 顺便问一句");
      expect(drafts[0]?.plan.kind === "planned" ? drafts[0].plan.parts.length : 0).toBe(1);
    } finally {
      h.close();
    }
  });
});
