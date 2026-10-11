import { describe, expect, it } from "bun:test";
import {
  bindingResponse,
  insertQqBinding,
  readQqBinding,
  saveQqBinding,
} from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { ensureDefaults } from "../../src/server/db/repositories";
import { createQqBinding, updateQqBinding } from "../../src/server/services/qq-binding-contract";
import { classifyQqTrigger } from "../../src/server/services/qq-trigger-contract";
import { cloneBusinessDb } from "../harness/business-db";

const sample = { conversationKind: "group", speaker: "member", mentionsSelf: false };
describe("QQ trigger classification boundary", () => {
  it("classifies explicit group @ as direct reply regardless of initiative hint", () => {
    expect(classifyQqTrigger({ ...sample, mentionsSelf: true })).toEqual({
      kind: "classified",
      path: "direct_reply",
    });
    expect(
      classifyQqTrigger({ ...sample, mentionsSelf: true, initiativePath: "idle_topic" }),
    ).toEqual({ kind: "classified", path: "direct_reply" });
  });
  it("offers group talk as a judgement candidate, not permission to speak", () => {
    expect(classifyQqTrigger(sample)).toEqual({ kind: "candidate", path: "chiming_in" });
    expect(classifyQqTrigger({ ...sample, followsAssistant: false })).toEqual({
      kind: "candidate",
      path: "chiming_in",
    });
    expect(classifyQqTrigger({ ...sample, speaker: "anonymous" })).toEqual({
      kind: "pending",
      reason: "not_classified",
    });
  });
  it("routes private speech and verified follow-up without converting a hint into a send", () => {
    expect(classifyQqTrigger({ ...sample, conversationKind: "private" })).toEqual({
      kind: "classified",
      path: "direct_reply",
    });
    expect(
      classifyQqTrigger({ ...sample, conversationKind: "private", followsAssistant: true }),
    ).toEqual({
      kind: "classified",
      path: "follow_up",
    });
    expect(classifyQqTrigger({ ...sample, followsAssistant: true })).toEqual({
      kind: "classified",
      path: "follow_up",
    });
  });
  it("accepts only independently chosen initiative paths", () => {
    expect(classifyQqTrigger({ ...sample, initiativePath: "chiming_in" })).toEqual({
      kind: "classified",
      path: "chiming_in",
    });
    expect(classifyQqTrigger({ ...sample, initiativePath: "idle_topic" })).toEqual({
      kind: "classified",
      path: "idle_topic",
    });
    expect(() => classifyQqTrigger({ ...sample, initiativePath: "follow_up" })).toThrow(TypeError);
    expect(() => classifyQqTrigger({ ...sample, initiativePath: "direct_reply" })).toThrow(
      TypeError,
    );
  });
  it("never classifies a system notification", () => {
    expect(
      classifyQqTrigger({
        ...sample,
        speaker: "system",
        mentionsSelf: true,
        initiativePath: "chiming_in",
      }),
    ).toEqual({ kind: "ignored", reason: "system_message" });
  });
  it("rejects malformed, extra and missing input without logging content", () => {
    for (const input of [
      null,
      {},
      { ...sample, extra: "text" },
      { ...sample, mentionsSelf: "true" },
    ])
      expect(() => classifyQqTrigger(input)).toThrow(TypeError);
  });
});

// ---- 0059：并行任务上限与输入防抖随绑定保存走同一条 group/private 路径 ----
//
// 两个会话种类没有第二套绑定存储：同一张表、同一组可空列、同一份合同解析。
// 覆盖整组 travel、null＝跟随方案；行读回后必须与合同形状一致。

describe("0059 override groups ride the same binding save path for group and private", () => {
  const AGENT_ID = "00000000-0000-0000-0000-000000000001";

  for (const kind of ["group", "private"] as const) {
    it(`saves and reads back explicit overrides for a ${kind} binding`, () => {
      const h = cloneBusinessDb();
      try {
        ensureDefaults(h.orm, "synthetic-model");
        const scheme = createQqScheme(h.orm, { name: `0059-${kind}` });
        const created = createQqBinding({
          id: "33333333-3333-4333-8333-333333333331",
          accountId: "10001",
          kind,
          peerId: "50005",
          agentId: AGENT_ID,
          schemeId: scheme.id,
          paused: false,
          taskLimits: { mention_task_limit: 5, ordinary_task_limit: 2 },
          inputAntiSpam: { enabled: false },
        });
        if (created.kind !== "saved") throw Error(`Unexpected result: ${created.kind}`);
        const stored = insertQqBinding(h.orm, created.binding);
        expect(stored.taskLimits).toEqual({ mention_task_limit: 5, ordinary_task_limit: 2 });
        expect(stored.inputAntiSpam).toEqual({ enabled: false });

        // 合同补丁：显式 null 恢复跟随方案；读回行与合同一致。
        const patched = updateQqBinding(
          stored,
          { taskLimits: { mention_task_limit: null, ordinary_task_limit: null } },
          stored.revision,
        );
        if (patched.kind !== "saved") throw Error(`Unexpected result: ${patched.kind}`);
        const persisted = saveQqBinding(h.orm, {
          binding: patched.binding,
          expectedRevision: stored.revision,
        });
        const reread = readQqBinding(h.orm, persisted.id);
        if (reread === null) throw Error("expected the stored binding");
        expect(reread.taskLimits).toEqual({ mention_task_limit: null, ordinary_task_limit: null });
        expect(reread.inputAntiSpam).toEqual({ enabled: false });

        const wire = bindingResponse(h.orm, reread);
        expect(wire.task_limits).toEqual({ mention_task_limit: null, ordinary_task_limit: null });
        expect(wire.input_anti_spam).toEqual({ enabled: false });
      } finally {
        h.close();
      }
    });
  }
});
