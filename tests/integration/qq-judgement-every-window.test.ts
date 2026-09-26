// 判断每次都真跑一遍：取消 0036 的"判断间隔 + 复用上次分数"。
//
// 用户的原话是"不要每个人单独判定了，让每个人的窗口都单独计算合并时间，每个人合并窗口一次，就判断开口
// 门槛一次"。落地就是：**合并窗口仍按人算，但窗口一结束就为他真判一次**——没有读数复用，没有间隔。
// 这一组用例钉三件事：每次都真的问模型、门槛总按当前方案读、读数表不再被写入。

import { describe, expect, it } from "bun:test";
import {
  createQqScheme,
  schemeRhythm,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { QQ_PROMPT_DEFAULTS } from "../../src/server/services/qq-prompt-contract";
import { runQqJudgement } from "../fixtures/legacy-qq/qq-judgement-runner";

const agentId = "00000000-0000-0000-0000-000000000001";
const bindingId = "11111111-1111-4111-8111-111111111111";
const now = 2_000_000_000;

function message(orm: Orm, key: string, at: number, speakerId = "20002"): void {
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
      body: `合成消息 ${key}`,
      occurredAtSeconds: at,
      expiresAt: new Date((at + 3600) * 1000).toISOString(),
      recordedAt: nowIso(),
    })
    .run();
}

function setup(options: { threshold?: number } = {}) {
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
    rhythm: { ...schemeRhythm(row), initiative_min_score: options.threshold ?? 6 },
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
  // Two messages, both past the merge window and past `idle_quiet_minutes` so either initiative path
  // clears its gates with one fixture.
  message(h.orm, "m1", now - 3600);
  message(h.orm, "m2", now - 3000);
  return h;
}

/** Answers from a queue and counts the asks: the count IS the assertion. */
function gateway(answers: readonly string[]) {
  const calls: string[] = [];
  const queue = [...answers];
  return {
    calls,
    port: {
      loadedContextCapacity: async () => 65536,
      complete: async () => {
        const answer = queue.shift() ?? '{"score":0}';
        calls.push(answer);
        return answer;
      },
    },
  };
}

function judge(orm: Orm, port: unknown, path: string) {
  return runQqJudgement(orm, port as Parameters<typeof runQqJudgement>[1], {
    bindingId,
    path,
    nowSeconds: now,
  });
}

describe("every merge window judges for real", () => {
  it("asks again as soon as a new message arrives — no cached score stands in", async () => {
    const h = setup();
    try {
      const gw = gateway(['{"score":8}', '{"score":8}']);
      expect((await judge(h.orm, gw.port, "chiming_in")).kind).toBe("candidate");
      expect(gw.calls).toHaveLength(1);
      message(h.orm, "m3", now - 2400);
      expect((await judge(h.orm, gw.port, "chiming_in")).kind).toBe("candidate");
      // 旧行为会在这里复用上次的分数（0 次调用）；现在每一次都是真判断。
      expect(gw.calls).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("compares each fresh answer against the scheme's current threshold", async () => {
    const h = setup();
    try {
      const gw = gateway(['{"score":8}', '{"score":8}']);
      expect((await judge(h.orm, gw.port, "chiming_in")).kind).toBe("candidate");
      const row = h.orm.select().from(schema.qqSchemes).all()[0];
      if (!row) throw new Error("synthetic scheme missing");
      updateQqScheme(h.orm, row.id, {
        name: "synthetic",
        rhythm: { ...schemeRhythm(row), initiative_min_score: 9 },
        expectedRevision: row.revision,
      });
      // 抬高门槛之后同一个分数不再通过，而且这一轮真的又问了一次（不是拿旧分数重比）。
      expect((await judge(h.orm, gw.port, "chiming_in")).kind).toBe("silent");
      expect(gw.calls).toHaveLength(2);
    } finally {
      h.close();
    }
  });

  it("never writes the retired reading table", async () => {
    const h = setup();
    try {
      const gw = gateway(['{"score":9}', '{"score":2}', '{"score":7}']);
      await judge(h.orm, gw.port, "chiming_in");
      await judge(h.orm, gw.port, "idle_topic");
      await judge(h.orm, gw.port, "chiming_in");
      // 表与列留在 schema 里（不迁移），但没有任何代码再写它——留着旧分数只会让人以为它还在生效。
      expect(h.orm.select().from(schema.qqJudgementReadings).all()).toHaveLength(0);
      expect(gw.calls).toHaveLength(3);
    } finally {
      h.close();
    }
  });
});
