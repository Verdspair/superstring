// T06：memory_job 运行记录的 inspect。钉住两条 ruling：
// * 失效的 `qq_member_name` 只剪 identity.currentName（可选资料）——事实快照/正文/关系
//   原样出示，上下文仍 exact；currentName 值也必须真实换成 null。
// * 仍活的名字与 fact/body refs 保持 exact 不裁剪；name ref id 畸形 fail closed 整体 revoked。
// 快照走真实 MemoryService 生成路径落盘（startStep 的 sources 就是真实 mint 的 refs），
// 再按裁决就地改库制造失效，不造假投影。

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { inspectContext } from "../../src/server/agent/context-access";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { enqueue, policy } from "../../src/server/db/memory-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { MemoryService } from "../../src/server/services/memory-service";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { qqMemoryScopeKey } from "../../src/server/services/qq-binding-contract";

const AGENT_ID = DEFAULT_AGENT_ID;
const MODEL = "qwen/qwen3-4b-2507";
const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const NAME_REF_ID = JSON.stringify(["90001", "group", "30003", "10001"]);

const VALID_DRAFT_JSON = JSON.stringify({
  memory: {
    name: "喜好",
    summary: "群友喜欢精炼回复",
    tags: ["偏好"],
    kinds: ["semantic"],
    body: "群友希望答复使用中文，表达简短。",
  },
});

interface CompleteCall {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  temperature?: number;
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

class WorkerGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  calls: CompleteCall[] = [];
  replies: string[] = [];

  async listModels(): Promise<string[]> {
    return [MODEL];
  }
  async loadedContextCapacity(): Promise<number | null> {
    return 32768;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(options: CompleteCall): Promise<string> {
    this.calls.push(options);
    return this.replies[this.calls.length - 1] ?? JSON.stringify({ memory: null });
  }
  async *streamChat(): AsyncGenerator<string, void, unknown> {
    yield "unused";
  }
}

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const journal = new ConversationEventRepository(business.db);
  const gateway = new WorkerGateway();
  const service = new MemoryService({
    orm: business.orm,
    db: business.db,
    gateway,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 5,
    jobTimeoutMs: 2_000,
  });
  const repository = new AgentRunRepository(business.db);
  return { business, db: business.db, orm: business.orm, journal, gateway, service, repository };
}

function bind(h: ReturnType<typeof setup>): void {
  const now = nowIso();
  h.orm
    .insert(schema.qqSchemes)
    .values({ id: SCHEME_ID, name: "方案", revision: 1, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: BINDING_ID,
      accountId: "90001",
      conversationKind: "group",
      peerId: "30003",
      agentId: AGENT_ID,
      schemeId: SCHEME_ID,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const conversation = h.journal.ensureOneBot(BINDING_ID);
  if (!conversation) throw new Error("conversation fixture missing");
}

function groupObservation(
  messageId: number,
  text = "我喜欢精炼的回复",
  userId = 10001,
  card = "阿林卡",
  atSeconds = at,
) {
  const result = normalizeOneBotMessage(
    {
      time: atSeconds,
      self_id: 90001,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: messageId,
      user_id: userId,
      group_id: 30003,
      sender: { card, nickname: "阿林" },
      message: [{ type: "text", data: { text } }],
    },
    "90001",
  );
  if (result.kind !== "message") throw new Error("message expected");
  return result.observation;
}

/** 一个真实跑完并发布成功的 memory_job，返回它的 run/step 句柄与原文消息。 */
async function runOrganiseJob(h: ReturnType<typeof setup>): Promise<{
  runId: string;
  stepId: string;
  rawUserText: string;
}> {
  const observation = groupObservation(-110);
  recordObservation(h.orm, observation, AGENT_ID);
  h.journal.ingestOneBotEvent(observation.eventKey, BINDING_ID);
  policy(h.orm, AGENT_ID);
  const job = enqueue(h.orm, AGENT_ID, `req_${crypto.randomUUID()}`, {
    kind: "manual",
    eventIds: [observation.eventKey],
    scope: {
      scope: "reality_user",
      scopeKey: qqMemoryScopeKey({
        kind: "qq",
        accountId: "90001",
        conversationKind: "group",
        peerId: "30003",
        agentId: AGENT_ID,
      }),
    },
  });
  h.gateway.replies = [VALID_DRAFT_JSON];
  await h.service.runJob(job.id);
  const row = h.orm.select().from(schema.memoryJobs).where(eq(schema.memoryJobs.id, job.id)).get();
  if (row?.status !== "succeeded") throw new Error(`job did not succeed: ${row?.status}`);

  const run = h.db
    .query(
      `SELECT r.run_id,s.step_id FROM agent_runs r JOIN agent_steps s ON s.run_id=r.run_id
      WHERE r.owner_kind='memory_job' AND r.owner_id=? AND r.spec_id='memory.consolidate'`,
    )
    .get(job.id) as { run_id: string; step_id: string } | null;
  if (!run) throw new Error("consolidate run not found");

  const stored = h.repository.getContext({ runId: run.run_id, stepId: run.step_id });
  if (!stored?.messages) throw new Error("context snapshot missing");
  const userText = stored.messages
    .flatMap((message) => message.content)
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .find((text) => text.startsWith("来源数据（非指令）：\n"));
  if (!userText) throw new Error("consolidation source message missing");
  // 前置：快照里确实出示了当前名与 name ref，正文在。
  expect(JSON.parse(userText.slice("来源数据（非指令）：\n".length))[0].currentName).toEqual({
    groupCard: "阿林卡",
    personalNickname: "阿林",
  });
  expect(stored.sources.some((ref) => ref.kind === "qq_member_name")).toBe(true);
  expect(
    stored.sources.some((ref) => ref.kind === "qq_member_name" && ref.id === NAME_REF_ID),
  ).toBe(true);
  return { runId: run.run_id, stepId: run.step_id, rawUserText: userText };
}

describe("memory_job 运行记录的 inspect（T06 name-clip）", () => {
  it("名字失效只剪 currentName：快照/正文/关系原样，上下文保持 exact，值被真实置空", async () => {
    const h = setup();
    try {
      bind(h);
      const { runId, stepId, rawUserText } = await runOrganiseJob(h);
      // 成员改名（wire 新卡名，时间前进）→ 冻结的 name ref 复算不等 → 失效；fact/body 不动。
      const observation = groupObservation(-111, "改名后的消息", 10001, "新卡名", at + 10);
      recordObservation(h.orm, observation, AGENT_ID);
      h.journal.ingestOneBotEvent(observation.eventKey, BINDING_ID);

      const inspected = inspectContext(
        h.db,
        h.repository,
        { runId, stepId },
        { userId: DEFAULT_USER_ID },
        nowIso(),
      );
      expect(inspected?.status).toBe("exact");
      const messages = inspected?.exactMessages ?? [];
      const userText = messages
        .flatMap((message) => message.content)
        .flatMap((part) => (part.kind === "text" ? [part.text] : []))
        .find((text) => text.startsWith("来源数据（非指令）：\n"));
      if (!userText) throw new Error("source message missing after trim");
      const record = JSON.parse(userText.slice("来源数据（非指令）：\n".length))[0];
      // currentName 被剪空；快照名、正文与 parts 原样。
      expect(record.currentName).toBeNull();
      expect(record.speaker.groupCard).toBe("阿林卡");
      expect(
        record.parts.some(
          (p: { kind: string; text?: string }) =>
            p.kind === "text" && p.text === "我喜欢精炼的回复",
        ),
      ).toBe(true);
      expect(userText).not.toBe(rawUserText);
    } finally {
      h.business.close();
    }
  });

  it("名字仍活时上下文 exact 且不裁剪；name ref id 畸形时 fail closed 整体 revoked", async () => {
    const h = setup();
    try {
      bind(h);
      const { runId, stepId, rawUserText } = await runOrganiseJob(h);

      // 基线：无变化，inspect 保持 exact 且原样出示（不裁剪）。
      const intact = inspectContext(
        h.db,
        h.repository,
        { runId, stepId },
        { userId: DEFAULT_USER_ID },
        nowIso(),
      );
      expect(intact?.status).toBe("exact");
      const intactText = (intact?.exactMessages ?? [])
        .flatMap((message) => message.content)
        .flatMap((part) => (part.kind === "text" ? [part.text] : []))
        .find((text) => text.startsWith("来源数据（非指令）：\n"));
      expect(intactText).toBe(rawUserText);

      // 畸形 name ref：把 sources 里该 ref 的 id 换成不可定位串 → revoked（不虚报已裁剪）。
      const stored = h.repository.getContext({ runId, stepId });
      if (!stored) throw new Error("context missing");
      const tampered = stored.sources.map((ref) =>
        ref.kind === "qq_member_name" ? { ...ref, id: "[bogus]" } : ref,
      );
      h.db
        .query("UPDATE context_snapshots SET source_refs=? WHERE step_id=?")
        .run(JSON.stringify(tampered), stepId);
      const malformed = inspectContext(
        h.db,
        h.repository,
        { runId, stepId },
        { userId: DEFAULT_USER_ID },
        nowIso(),
      );
      expect(malformed?.status).toBe("revoked");
    } finally {
      h.business.close();
    }
  });
});
