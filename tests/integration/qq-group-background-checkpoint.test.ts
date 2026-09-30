// 后台压缩（水位任务）的能力纪元边界：叶子运行时完全不看 guard（模拟缺省装配）时，
// 业务闭包也要自足——飞行中停用再恢复不得写摘要；恢复后的新任务照当前纪元运行；
// 暂停不属于能力面，跨暂停在跑的任务照旧完成。

import { describe, expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import type { LeafAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { CompressionRecord } from "../../src/server/agent/conversation-compression";
import { createBotCompressionJob } from "../../src/server/channels/onebot11/background-compression";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  insertQqBinding,
  readQqBinding,
  saveQqBinding,
  writeQqGroupAgentConfigRow,
} from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  type Orm,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { createQqBinding, updateQqBinding } from "../../src/server/services/qq-binding-contract";
import { type RuntimeConfig, RuntimeConfigSchema } from "../../src/shared/contracts";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import type { QqGroupCapability } from "../../src/shared/contracts/qq-group-config";

const AGENT_ID = DEFAULT_AGENT_ID;
const SOURCES: SourceRef[] = [{ kind: "qq_observation", id: "evt-1", revision: "1" }];

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "chat-model");
  const scheme = createQqScheme(business.orm, { name: "checkpoint" });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId: AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("binding");
  const binding = insertQqBinding(business.orm, created.binding);
  const conversation = new ConversationEventRepository(business.db).ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const runtime: RuntimeConfig = RuntimeConfigSchema.parse({
    agent_id: AGENT_ID,
    name: "agent",
    system_prompt: "",
    additional_instructions: "",
    model_name: "chat-model",
    temperature: 0,
    memory_consolidation_model_name: "chat-model",
    memory_consolidation_prompt: "整理记忆",
    memory_consolidation_additional_instructions: "",
    memory_retrieval_model_name: "chat-model",
    memory_retrieval_prompt: "挑选相关记忆",
    context_compression_model_name: "chat-model",
    p5_config: {},
    config_version: 1,
  });
  return {
    business,
    orm: business.orm,
    bindingId: binding.id,
    conversationId: conversation.id,
    runtime,
  };
}

/** 假叶子运行时：不进任何 guard 复验（中央注入被省略时也成立），只回一条合法事实。 */
function fakeLeafRuntime(events: ReadonlyArray<{ id: string; speaker: string }>) {
  const calls: string[] = [];
  let gate: (() => Promise<void>) | null = null;
  const runtime: LeafAgentRuntime = {
    async completeLeaf(spec, _input) {
      calls.push(spec.id);
      await gate?.();
      return JSON.stringify({
        facts: events.map((entry) => ({
          kind: "fact",
          speaker: entry.speaker,
          text: "旧事实",
          source_ids: [entry.id],
        })),
      });
    },
    async completeVisionLeaf(_spec, _input) {
      throw new Error("unused");
    },
  };
  return {
    runtime,
    calls,
    setGate: (value: (() => Promise<void>) | null) => {
      gate = value;
    },
  };
}

function compressionJob(h: ReturnType<typeof setup>, agentRuntime: LeafAgentRuntime) {
  const records: CompressionRecord[] = [
    { id: "r1", seq: 1, speaker: "甲", text: "旧问题", sources: [] },
  ];
  const job = createBotCompressionJob({
    orm: h.orm,
    gateway: { loadedContextCapacity: async () => 65_536 },
    agentRuntime,
    runtime: h.runtime,
    owner: { kind: "qq_binding", id: h.bindingId, userId: DEFAULT_USER_ID, agentId: AGENT_ID },
    conversationId: h.conversationId,
    agentId: AGENT_ID,
    expected: null,
    records,
    throughSeq: 1,
    coveredSeq: 1,
    fromSeconds: 0,
    throughSeconds: 60,
    question: "旧问题是什么",
    sources: SOURCES,
    target: 512,
    packageLimit: 5,
    task: "把消息压成事实",
    // 宿主侧的复验在留空（模拟只查"现在是否启用"的调用方）：拦截只能来自任务自身的纪元闭包。
    assertCurrent: () => {},
    assertSources: () => {},
    now: () => "2026-09-30T00:00:00.000Z",
    onFailure: () => {},
  });
  return job;
}

/** 走真实保存路径更新停用集合（与 PUT /capabilities 同构），修订随每次翻转前进。 */
function setCapabilities(
  h: ReturnType<typeof setup>,
  disabled: QqGroupCapability[],
  expectedRevision: number,
): void {
  writeQqGroupAgentConfigRow(h.orm, {
    bindingId: h.bindingId,
    agentId: AGENT_ID,
    overrides: {},
    disabledCapabilities: disabled,
    expectedRevision,
  });
}

/** 走真实保存路径暂停本群：paused 与 revision 一起推进，不做裸 SQL。 */
function pauseGroup(h: ReturnType<typeof setup>): void {
  const current = readQqBinding(h.orm, h.bindingId);
  if (current === null) throw new Error("missing binding");
  const result = updateQqBinding(current, { paused: true }, current.revision);
  if (result.kind !== "saved") throw new Error(`pause not saved: ${result.kind}`);
  saveQqBinding(h.orm, { binding: result.binding, expectedRevision: current.revision });
}

function deferred(): { gate: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await delay(1);
  }
}

const summaries = (orm: Orm) => orm.select().from(schema.qqConversationSummaries).all();

describe("后台压缩的能力纪元闭包", () => {
  it("飞行中停用再恢复：闭包在写入前拒绝，不写摘要", async () => {
    const h = setup();
    try {
      const blocked = deferred();
      const leaf = fakeLeafRuntime([{ id: "r1", speaker: "甲" }]);
      leaf.setGate(() => blocked.gate);
      const job = compressionJob(h, leaf.runtime);

      const run = job.run(new AbortController().signal);
      await waitUntil(() => leaf.calls.length === 1);
      // 真实保存路径：停用（纪元 1）再恢复（纪元 2）——当前状态又是启用。
      setCapabilities(h, ["history_summary"], 0);
      setCapabilities(h, [], 1);
      leaf.setGate(null);
      blocked.release();
      let code: string | undefined;
      try {
        await run;
      } catch (error) {
        code = (error as { code?: string }).code;
      }
      expect(code).toBe("QQ_GROUP_CAPABILITY_DISABLED");
      expect(leaf.calls).toHaveLength(1);
      expect(summaries(h.orm)).toHaveLength(0);
    } finally {
      h.business.close();
    }
  });

  it("停用再恢复后的新任务按当前纪元运行并写入摘要", async () => {
    const h = setup();
    try {
      setCapabilities(h, ["history_summary"], 0);
      setCapabilities(h, [], 1);
      const leaf = fakeLeafRuntime([{ id: "r1", speaker: "甲" }]);
      const job = compressionJob(h, leaf.runtime);

      await job.run(new AbortController().signal);

      expect(leaf.calls).toEqual(["context.compress.events"]);
      const row = summaries(h.orm)[0];
      expect(row?.throughSeq).toBe(1);
      expect(row?.coveredSeq).toBe(1);
      expect(row?.modelName).toBe("chat-model");
    } finally {
      h.business.close();
    }
  });

  it("已经在飞的压缩跨暂停照旧完成：闭包不看暂停", async () => {
    const h = setup();
    try {
      const blocked = deferred();
      const leaf = fakeLeafRuntime([{ id: "r1", speaker: "甲" }]);
      leaf.setGate(() => blocked.gate);
      const job = compressionJob(h, leaf.runtime);

      const run = job.run(new AbortController().signal);
      await waitUntil(() => leaf.calls.length === 1);
      pauseGroup(h);
      leaf.setGate(null);
      blocked.release();
      await run;

      expect(summaries(h.orm)[0]?.throughSeq).toBe(1);
    } finally {
      h.business.close();
    }
  });
});
