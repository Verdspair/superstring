import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import {
  concurrentJobsDumpValue,
  projectConcurrentReplyQuestions,
  QQ_CONCURRENT_JOBS_LIMIT,
  readConcurrentReplyFacts,
  readConcurrentReplyJobs,
} from "../../src/server/channels/onebot11/concurrent-reply-context";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import { cloneBusinessDb } from "../harness/business-db";

/**
 * 并发任务投影聚焦用例：读取器是其他在飞任务（同会话×纪元×Agent）的唯一有界读取。
 * 覆盖范围排除、到期来源/过期租约不算当前责任、混合回执的真实聚合（unknown 压过一切、
 * confirmed 混未确认＝partial）、已知重叠冲突优先、可见性判据与结构不泄露。
 */

const ACCOUNT_ID = "10001";
const GROUP_ID = "30003";
const A = "20002";
const B = "20003";
const NOW = "2026-10-15T12:00:00.000Z";

const conversationFor = (h: BusinessDbHandle, epoch = 1): string => {
  ensureDefaults(h.orm, "projection-model");
  const id = `conv-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  h.db
    .query(
      "INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,created_at,updated_at) VALUES(?,'onebot11','shared',?,?,?,?,?,?)",
    )
    .run(id, `binding-${id}`, DEFAULT_AGENT_ID, DEFAULT_USER_ID, epoch, now, now);
  return id;
};

type TaskSeed = {
  id: string;
  conversationId: string;
  status: string;
  cancellationRequested?: number;
  cause?: string;
  taskClass?: string;
  agentId?: string;
  epoch?: number;
  throughSeq?: number;
  sourceExpiresAt?: string | null;
  leaseExpiresAt?: string | null;
};
const seedTask = (h: BusinessDbHandle, seed: TaskSeed): string => {
  const id = seed.id;
  const now = new Date().toISOString();
  h.db
    .query(
      `INSERT INTO qq_conversation_tasks(id,task_key,conversation_id,binding_epoch,agent_id,task_class,cause,
        source_from_seq,source_through_seq,status,cancellation_requested,source_expires_at,lease_expires_at,created_at,updated_at,platform_message_id,lease_token)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      `key-${id}`,
      seed.conversationId,
      seed.epoch ?? 1,
      seed.agentId ?? DEFAULT_AGENT_ID,
      seed.taskClass ?? "mention",
      seed.cause ?? "direct_reply",
      seed.throughSeq ?? 10,
      seed.throughSeq ?? 10,
      seed.status,
      seed.cancellationRequested ?? 0,
      seed.sourceExpiresAt ?? null,
      seed.status === "running" ? (seed.leaseExpiresAt ?? "2026-10-15T13:00:00.000Z") : null,
      now,
      now,
      (seed.taskClass ?? "mention") === "mention" ? `platform-${id}` : null,
      seed.status === "running" ? `lease-${id}` : null,
    );
  return id;
};

type IntentSeed = {
  conversationId: string;
  taskId: string | null;
  status: string;
  parts: string[];
};
const seedIntent = (h: BusinessDbHandle, seed: IntentSeed): void => {
  const now = new Date().toISOString();
  const runId = `run-${crypto.randomUUID()}`;
  h.db
    .query(
      "INSERT INTO agent_runs(run_id,conversation_id,spec_id,spec_version,owner_kind,owner_id,status,started_at) VALUES(?,?,?,?,'conversation',?,'completed',?)",
    )
    .run(runId, seed.conversationId, "test.spec", "1", seed.conversationId, now);
  const intentId = `intent-${crypto.randomUUID()}`;
  h.db
    .query(
      `INSERT INTO outbound_intents(id,run_id,conversation_id,output_ordinal,target,speech_kind,source_through_seq,deliver_by,status,created_at,expires_at)
       VALUES(?,?,?,1,?,?,?,?,'planned',?,?)`,
    )
    .run(
      intentId,
      runId,
      seed.conversationId,
      JSON.stringify({ participantId: null, qqTaskId: seed.taskId }),
      "chiming_in",
      10,
      new Date(Date.now() + 600_000).toISOString(),
      now,
      new Date(Date.now() + 600_000).toISOString(),
    );
  h.db.query("UPDATE outbound_intents SET status=? WHERE id=?").run(seed.status, intentId);
  seed.parts.forEach((partStatus, index) => {
    h.db
      .query(
        "INSERT INTO outbound_parts(id,intent_id,ordinal,kind,payload,status) VALUES(?,?,?,'text',NULL,?)",
      )
      .run(`part-${intentId}-${index}`, intentId, index, partStatus);
  });
};

const reader = (
  h: BusinessDbHandle,
  conversationId: string,
  extra: Partial<Parameters<typeof readConcurrentReplyJobs>[1]> = {},
) =>
  readConcurrentReplyJobs(h.db, {
    conversationId,
    bindingEpoch: 1,
    agentId: DEFAULT_AGENT_ID,
    now: NOW,
    visibleEventKeys: new Set<string>(),
    ...extra,
  });

describe("concurrent reply projection (bounded reader facts)", () => {
  it("projects only same conversation/epoch/agent, still-active, unexpired other tasks; the autonomous cursor no longer filters direct ongoing jobs", () => {
    const h = cloneBusinessDb();
    try {
      const own = conversationFor(h, 1);
      // 第二个 Agent 行满足外键：只用于验证 agent 排除。
      h.db
        .query(
          `INSERT INTO agents(id,name,system_prompt,description,additional_instructions,p5_config,
            model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,
            memory_retrieval_prompt,persona_intensity,is_active,config_version,updated_at,created_at)
           SELECT 'agent-other',name,system_prompt,description,additional_instructions,p5_config,
            model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,
            memory_retrieval_prompt,persona_intensity,is_active,config_version,updated_at,created_at
           FROM agents WHERE id=?`,
        )
        .run(DEFAULT_AGENT_ID);
      const otherAgentConversation = conversationFor(h, 1);
      const otherConversation = conversationFor(h, 1);
      const ownTaskId = seedTask(h, {
        id: "own-task",
        conversationId: own,
        status: "running",
      });
      const expected = seedTask(h, {
        id: "peer-task",
        conversationId: own,
        status: "pending",
        cause: "chiming_in",
        taskClass: "ordinary",
        throughSeq: 40,
      });
      const cancelled = seedTask(h, {
        id: "cancelled",
        conversationId: own,
        status: "running",
        cancellationRequested: 1,
        throughSeq: 41,
      });
      seedTask(h, { id: "old-epoch", conversationId: own, epoch: 2, status: "running" });
      seedTask(h, {
        id: "other-agent",
        conversationId: otherAgentConversation,
        agentId: "agent-other",
        status: "running",
      });
      seedTask(h, {
        id: "other-conversation",
        conversationId: otherConversation,
        status: "running",
      });
      seedTask(h, { id: "settled", conversationId: own, status: "completed" });
      // 到期来源与过期租约：不是“正在处理的责任”，不进投影。
      seedTask(h, {
        id: "source-expired",
        conversationId: own,
        status: "running",
        throughSeq: 30,
        sourceExpiresAt: "2026-10-15T11:59:59.000Z",
      });
      seedTask(h, {
        id: "lease-expired",
        conversationId: own,
        status: "running",
        throughSeq: 31,
        leaseExpiresAt: "2026-10-15T11:00:00.000Z",
      });
      seedTask(h, {
        id: "source-live",
        conversationId: own,
        status: "running",
        throughSeq: 32,
        sourceExpiresAt: "2026-10-15T13:00:00.000Z",
        leaseExpiresAt: "2026-10-15T13:00:00.000Z",
      });
      // 自主判定游标（chiming_in_observed_seq=25）不再过滤：游标只表达“自主批次判定消费
      // 到哪”，仍在飞/待处理的直接任务（seq 5 在游标之前）依旧是当前责任，必须如实投影。
      h.db.query("UPDATE conversations SET chiming_in_observed_seq=25 WHERE id=?").run(own);
      const behindCursor = seedTask(h, {
        id: "behind-cursor",
        conversationId: own,
        status: "pending",
        throughSeq: 5,
      });
      const projection = reader(h, own, { ownTaskId });
      expect(projection.jobs.map((job) => job.taskId)).toEqual([
        "cancelled",
        expected,
        "source-live",
        behindCursor,
      ]);
      expect(projection.totalActive).toBe(4);
      expect(projection.jobs.every((job) => job.status !== undefined)).toBe(true);
      expect(projection.jobs.find((job) => job.taskId === cancelled)?.status).toBe(
        "cancel_requested",
      );
    } finally {
      h.close();
    }
  });

  it("known focus-overlap conflicts are prioritized and the cap never hides the newest overlap; overflow is omitted explicitly", () => {
    const h = cloneBusinessDb();
    try {
      const conversationId = conversationFor(h, 1);
      const overlap = seedTask(h, {
        id: "overlap",
        conversationId,
        status: "running",
        throughSeq: 55,
      });
      for (let index = 0; index < 8; index += 1)
        seedTask(h, {
          id: `newer-${index}`,
          conversationId,
          status: "pending",
          cause: "chiming_in",
          taskClass: "ordinary",
          throughSeq: 100 + index,
        });
      const projection = reader(h, conversationId, {
        focusFromSeq: 50,
        focusThroughSeq: 60,
      });
      expect(projection.totalActive).toBe(9);
      expect(projection.jobs).toHaveLength(QQ_CONCURRENT_JOBS_LIMIT);
      // 重叠冲突排第一，其余按 seq 新→旧；最旧的非重叠任务被截断并如实标注。
      expect(projection.jobs[0]!.taskId).toBe(overlap);
      expect(projection.jobs[1]!.taskId).toBe("newer-7");
      expect(projection.jobs[QQ_CONCURRENT_JOBS_LIMIT - 1]!.taskId).toBe("newer-4");
      expect(projection.jobs.find((job) => job.taskId === "newer-0")).toBeUndefined();
      const dump = concurrentJobsDumpValue(projection) as Record<string, unknown>;
      expect(dump.omitted).toBe(projection.totalActive - QQ_CONCURRENT_JOBS_LIMIT);
      const allOverlap = reader(h, conversationId, { focusFromSeq: 1, focusThroughSeq: 200 });
      expect(allOverlap.omittedOverlapping).toBe(9 - QQ_CONCURRENT_JOBS_LIMIT);
      expect(concurrentJobsDumpValue(allOverlap).omittedOverlapping).toBe(
        9 - QQ_CONCURRENT_JOBS_LIMIT,
      );
    } finally {
      h.close();
    }
  });

  it("reply facts follow the real part ledger: unknown dominates, confirmed mixed with unconfirmed is partial", () => {
    const h = cloneBusinessDb();
    try {
      const conversationId = conversationFor(h, 1);
      const planned = seedTask(h, { id: "j-planned", conversationId, status: "running" });
      const confirmed = seedTask(h, { id: "j-confirmed", conversationId, status: "running" });
      const mixedParts = seedTask(h, { id: "j-mixed-parts", conversationId, status: "running" });
      const mixedIntents = seedTask(h, {
        id: "j-mixed-intents",
        conversationId,
        status: "running",
      });
      const mixedPlanned = seedTask(h, {
        id: "j-confirmed-planned",
        conversationId,
        status: "running",
      });
      const unknownMix = seedTask(h, { id: "j-unknown-mix", conversationId, status: "running" });
      const failed = seedTask(h, { id: "j-failed", conversationId, status: "running" });
      const silent = seedTask(h, { id: "j-silent", conversationId, status: "running" });
      seedIntent(h, { conversationId, taskId: planned, status: "planned", parts: ["planned"] });
      seedIntent(h, {
        conversationId,
        taskId: confirmed,
        status: "confirmed",
        parts: ["confirmed"],
      });
      seedIntent(h, {
        conversationId,
        taskId: mixedParts,
        status: "failed",
        parts: ["confirmed", "not_sent"],
      });
      seedIntent(h, {
        conversationId,
        taskId: mixedIntents,
        status: "confirmed",
        parts: ["confirmed"],
      });
      seedIntent(h, {
        conversationId,
        taskId: mixedIntents,
        status: "failed",
        parts: ["not_sent"],
      });
      seedIntent(h, {
        conversationId,
        taskId: mixedPlanned,
        status: "confirmed",
        parts: ["confirmed"],
      });
      seedIntent(h, {
        conversationId,
        taskId: mixedPlanned,
        status: "planned",
        parts: ["planned"],
      });
      seedIntent(h, {
        conversationId,
        taskId: unknownMix,
        status: "confirmed",
        parts: ["confirmed"],
      });
      seedIntent(h, {
        conversationId,
        taskId: unknownMix,
        status: "unknown",
        parts: ["unknown"],
      });
      seedIntent(h, { conversationId, taskId: failed, status: "stale", parts: ["stale"] });
      const taskIds = [
        planned,
        confirmed,
        mixedParts,
        mixedIntents,
        mixedPlanned,
        unknownMix,
        failed,
        silent,
      ];
      const byId = new Map(
        taskIds.map((id, index) => {
          const seq = 100 + index;
          h.db
            .query(
              "UPDATE qq_conversation_tasks SET source_from_seq=?,source_through_seq=? WHERE id=?",
            )
            .run(seq, seq, id);
          const projection = reader(h, conversationId, { focusFromSeq: seq, focusThroughSeq: seq });
          return [id, projection.jobs.find((job) => job.taskId === id)];
        }),
      );
      expect(byId.get(planned)!.reply).toBe("planned");
      expect(byId.get(confirmed)!.reply).toBe("confirmed");
      expect(byId.get(mixedParts)!.reply).toBe("partial");
      expect(byId.get(mixedIntents)!.reply).toBe("partial");
      expect(byId.get(mixedPlanned)!.reply).toBe("partial");
      expect(byId.get(unknownMix)!.reply).toBe("unknown");
      expect(byId.get(failed)!.reply).toBe("failed");
      expect(byId.get(silent)!.reply).toBeUndefined();
    } finally {
      h.close();
    }
  });

  it("questionSeq appears only when the question maps to a currently visible timeline event; dump carries metadata only", () => {
    const h = cloneBusinessDb();
    try {
      const conversationId = conversationFor(h, 1);
      const mentionTask = seedTask(h, {
        id: "j-mention",
        conversationId,
        status: "running",
        throughSeq: 7,
      });
      h.db
        .query(
          "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at) VALUES('evt-7','10001','group','30003',?,'7',0,'member','20002',?)",
        )
        .run(DEFAULT_AGENT_ID, NOW);
      h.db
        .query("UPDATE qq_conversation_tasks SET origin_event_key='evt-7' WHERE id='j-mention'")
        .run();
      const ordinaryTask = seedTask(h, {
        id: "j-ordinary",
        conversationId,
        status: "running",
        cause: "chiming_in",
        taskClass: "ordinary",
        throughSeq: 8,
      });
      const now = new Date().toISOString();
      h.db
        .query(
          `INSERT INTO conversation_events(conversation_id,seq,event_key,kind,source_kind,source_id,
            source_revision,sources,addressing,occurred_at,recorded_at)
           VALUES(?,8,'evt-8','inbound','qq_event','evt-8','rev','[]','{}',?,?)`,
        )
        .run(conversationId, now, now);
      const projection = readConcurrentReplyJobs(h.db, {
        conversationId,
        bindingEpoch: 1,
        agentId: DEFAULT_AGENT_ID,
        now: NOW,
        visibleEventKeys: new Set(["evt-7", "evt-8"]),
      });
      const byId = new Map(projection.jobs.map((job) => [job.taskId, job]));
      expect(byId.get(mentionTask)!.questionSeq).toBe(7);
      // 普通任务无 origin_event_key：问题 seq 经 journal 精确解析后再按可见性给出。
      expect(byId.get(ordinaryTask)!.questionSeq).toBe(8);
      const hidden = readConcurrentReplyJobs(h.db, {
        conversationId,
        bindingEpoch: 1,
        agentId: DEFAULT_AGENT_ID,
        now: NOW,
        visibleEventKeys: new Set<string>(),
      });
      const hiddenById = new Map(hidden.jobs.map((job) => [job.taskId, job]));
      expect(hiddenById.get(mentionTask)!.questionSeq).toBeUndefined();
      expect(hiddenById.get(ordinaryTask)!.questionSeq).toBeUndefined();
      const dump = concurrentJobsDumpValue(projection) as Record<string, unknown>;
      for (const key of Object.keys(dump))
        expect(["kind", "trust", "guidance", "jobs", "omitted"]).toContain(key);
      expect(dump.trust).toBe("data_only");
      for (const job of dump.jobs as Record<string, unknown>[])
        for (const key of Object.keys(job))
          expect(["taskId", "cause", "taskClass", "status", "questionSeq", "reply"]).toContain(key);
      expect(JSON.stringify(dump)).not.toContain("event_key");
      // 无模块级缓存：行变化立刻如实反映。
      h.db
        .query(
          "UPDATE qq_conversation_tasks SET status='completed',lease_token=NULL,lease_expires_at=NULL WHERE id='j-mention'",
        )
        .run();
      const again = reader(h, conversationId);
      expect(again.jobs.find((job) => job.taskId === mentionTask)).toBeUndefined();
    } finally {
      h.close();
    }
  });
});

type DecisionTrigger = { seq: number; cause: string };
const decisionTriggerOf = (request: ModelRequest): DecisionTrigger => {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.kind !== "text") continue;
      try {
        const dump = JSON.parse(part.text) as { kind?: string; value?: Record<string, unknown> };
        if (dump?.kind !== "activation_trigger" || dump.value === undefined) continue;
        return {
          seq: Number(dump.value.seq ?? -1),
          cause: String(dump.value.cause ?? ""),
        };
      } catch {}
    }
  }
  throw new Error("DECISION_CALL_WITHOUT_TRIGGER");
};

/** Runtime-level: the projection reaches the first score and the child decision, once per view boundary. */
const isBatchScore = (request: ModelRequest): boolean =>
  (request.responseSchema as { properties?: Record<string, unknown> } | undefined)?.properties
    ?.evaluations !== undefined;
const isDecision = (request: ModelRequest): boolean =>
  Array.isArray((request.responseSchema as { oneOf?: unknown } | undefined)?.oneOf);
type JobsDump = {
  kind: string;
  jobs: { taskId: string; status: string; questionSeq?: number }[];
};
const jobsDumpOf = (request: ModelRequest): JobsDump | null => {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.kind !== "text") continue;
      try {
        const parsed = JSON.parse(part.text) as JobsDump;
        if (parsed?.kind === "qq_concurrent_jobs") return parsed;
      } catch {}
    }
  }
  return null;
};
const authorizedTargetOf = (request: ModelRequest): string =>
  JSON.stringify(request.messages)
    .replace(/\\/g, "")
    .match(/authorizedTargets":\["(\d+)/)?.[1] ?? A;
const inlineReply = (targetId: string, text: string) =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "inline", targetId, text }] });
const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("WAIT_TIMEOUT_PROJECTION_CASE");
    await Bun.sleep(5);
  }
};

const pendingGates: (() => void)[] = [];
const composed: ReturnType<typeof createOneBotConversationRuntime>[] = [];
const handles: BusinessDbHandle[] = [];
const controlledGate = () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
    pendingGates.push(release);
  });
  const bounded = (code: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      gate,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), 4000);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  return { gate, release, bounded };
};
afterEach(async () => {
  for (const release of pendingGates.splice(0)) release();
  for (const bot of composed.splice(0)) {
    bot.scheduler.stop();
    await bot.scheduler.waitForIdle().catch(() => {});
    bot.delivery.stop();
    await bot.delivery.waitForIdle().catch(() => {});
    bot.release();
  }
  for (const h of handles.splice(0)) h.close();
});

function composeRuntime() {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "projection-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT_ID, enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: `reply-projection-${crypto.randomUUID()}`,
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
    reply: { split_by_speaker: true },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      initiative_batch_target_count: 1,
      initiative_batch_jitter_count: 0,
      initiative_time_window_enabled: false,
      merge_window_seconds: 0,
      reply_cooldown_seconds: 1,
      judgement_interval_turns: 1,
    },
  });
  const bindingId = crypto.randomUUID();
  const now = () => new Date().toISOString();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30003',?,?,?,?)",
    )
    .run(bindingId, DEFAULT_AGENT_ID, scheme.id, now(), now());
  const journal = new ConversationEventRepository(h.db);
  const runs = new AgentRunRepository(h.db);
  const gates = new Map<number, ReturnType<typeof controlledGate>>();
  const jobDumps: { request: ModelRequest; jobs: JobsDump | null; queries: number }[] = [];
  const phases: string[] = [];
  /**
   * Real projection-read counter: counts one bounded reader READ (the rows query; its
   * exact-COUNT companion shares the predicate but lacks the overlap-priority ORDER BY and is
   * part of the same read). No other production SQL uses that combination.
   */
  let projectionQueries = 0;
  const rawQuery = h.db.query.bind(h.db) as (sql: string, ...args: unknown[]) => unknown;
  (h.db as unknown as { query: Database["query"] }).query = ((sql: string, ...args: unknown[]) => {
    if (
      sql.includes("qq_conversation_tasks") &&
      sql.includes("binding_epoch=?") &&
      sql.includes("status IN ('pending','running')") &&
      // 只数有界读的行查询（精确 COUNT 共享同一谓词，属同一次读取）：行查询独有
      // 重叠优先 ORDER BY，其余生产 SQL 无此组合。
      sql.includes("ORDER BY prio ASC")
    )
      projectionQueries += 1;
    return rawQuery(sql, ...args);
  }) as Database["query"];
  const model: ModelPort = {
    async complete(request) {
      jobDumps.push({ request, jobs: jobsDumpOf(request), queries: projectionQueries });
      if (isBatchScore(request)) {
        phases.push("autonomy-score");
        const envelope = (() => {
          for (const message of request.messages ?? [])
            for (const part of message.content ?? []) {
              if (part.kind !== "text") continue;
              try {
                const parsed = JSON.parse(part.text) as {
                  kind?: string;
                  targets?: { targetId: string }[];
                };
                if (parsed?.kind === "qq_batch_targets" && parsed.targets) return parsed;
              } catch {}
            }
          throw new Error("SCORE_TARGETS_MISSING");
        })();
        return JSON.stringify({
          evaluations: envelope.targets!.map((target) => ({
            targetId: target.targetId,
            score: 10,
            intent: `intent ${target.targetId}`,
            sourceSeqs: [],
          })),
        });
      }
      if (!isDecision(request)) return "{}";
      const targetId = authorizedTargetOf(request);
      const trigger = decisionTriggerOf(request);
      if (trigger.cause === "direct_reply") {
        phases.push("direct-decision");
        const gate = gates.get(trigger.seq);
        if (gate) await gate.bounded("DIRECT_GATE_TIMEOUT");
        return inlineReply(targetId, `direct-${targetId}`);
      }
      phases.push("autonomy-child");
      return inlineReply(targetId, `autonomy-${targetId}`);
    },
    async *streamText() {
      yield "";
    },
    async completeMultimodal() {
      return "";
    },
  };
  const runtime = new AgentRuntime({ repository: runs, model, now });
  const bot = createOneBotConversationRuntime({
    orm: h.orm,
    db: h.db,
    gateway: {
      async complete() {
        throw new Error("UNIFIED_RUNTIME_REQUIRED");
      },
      async loadedContextCapacity() {
        return 65536;
      },
    },
    agentRuntime: runtime,
    host: new ConversationHost({ runtime }),
    journal,
    store: new QqStickerStore({ directory: "synthetic-projection-stickers" }),
    port: {
      async send() {
        return { kind: "confirmed", messageId: String(50000 + Math.random()) };
      },
    },
    wake: () => {},
    policy: () => ({
      maxSteps: 20,
      deliveryTtlSeconds: 600,
      retryDelayMs: 1000,
      maxAttempts: 3,
      globalConcurrency: 4,
      modelCallConcurrency: 4,
    }),
  });
  composed.push(bot);
  const receive = (messageId: string, memberId: string, text: string, addressed: boolean) => {
    const normalized = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        time: Math.floor(Date.now() / 1000),
        self_id: Number(ACCOUNT_ID),
        user_id: Number(memberId),
        group_id: Number(GROUP_ID),
        message_id: messageId,
        message: [
          ...(addressed ? [{ type: "at", data: { qq: ACCOUNT_ID } }] : []),
          { type: "text", data: { text } },
        ],
        sender: { nickname: memberId },
      },
      ACCOUNT_ID,
    );
    return recordInbound(h.orm, normalized, {
      accountId: ACCOUNT_ID,
      conversationIngress: bot.adapter,
    });
  };
  return { h, bot, jobDumps, phases, gates, receive, counter: () => projectionQueries };
}

describe("concurrent reply projection (runtime boundaries)", () => {
  it("reaches the first batch score and the child decision, rebuilt once per view boundary — not per render, not from a global cache", async () => {
    const f = composeRuntime();
    f.receive("81001", A, "direct question from A", true);
    const direct = f.h.db
      .query("SELECT id,source_through_seq FROM qq_conversation_tasks WHERE cause='direct_reply'")
      .get() as { id: string; source_through_seq: number };
    f.gates.set(direct.source_through_seq, controlledGate());
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => f.phases.includes("direct-decision"));

    f.receive("81002", B, "ordinary note from B", false);
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => f.phases.includes("autonomy-child"));
    await waitFor(() => f.phases.filter((phase) => phase === "autonomy-child").length >= 1);

    // The projection reached the FIRST score: the gated direct job appears with truthful facts.
    const scoreEntry = f.jobDumps.find((entry) => isBatchScore(entry.request));
    expect(scoreEntry).toBeDefined();
    expect(scoreEntry!.jobs).not.toBeNull();
    expect(scoreEntry!.jobs!.jobs).toHaveLength(1);
    expect(scoreEntry!.jobs!.jobs[0]!.taskId).toBe(direct.id);
    expect(scoreEntry!.jobs!.jobs[0]!.status).toBe("running");
    expect(scoreEntry!.jobs!.jobs[0]!.questionSeq).toBe(direct.source_through_seq);

    // It also reaches the child's normal decision material (copied immutable reply view).
    const childEntry = f.jobDumps.find((entry) => isDecision(entry.request) && entry.jobs !== null);
    expect(childEntry).toBeDefined();
    expect(childEntry!.jobs!.jobs.map((job) => job.taskId)).toContain(direct.id);

    // Bounded rebuilds: view builds happen at phase boundaries only. prepareBatchEvaluation
    // renders/measures several times per build — a per-render reader would blow this bound.
    // Exact per-boundary cost: between the score call and the child decision exactly one more
    // view build happened (the reply view) — a per-render reader would add dozens.
    const scoreQueries = scoreEntry!.queries;
    const childQueries = childEntry!.queries;
    expect(scoreQueries).toBeGreaterThanOrEqual(1);
    expect(scoreQueries).toBeLessThanOrEqual(2);
    expect(childQueries).toBeGreaterThan(scoreQueries);
    expect(childQueries).toBeLessThanOrEqual(scoreQueries + 2);

    f.gates.get(direct.source_through_seq)!.release();
    await waitFor(
      () =>
        (
          f.h.db
            .query("SELECT status FROM qq_conversation_tasks WHERE cause='direct_reply'")
            .get() as { status: string }
        ).status === "completed",
    );
    await f.bot.scheduler.waitForIdle();
    expect(f.counter()).toBeLessThanOrEqual(6);
  });
});

it("looks up ordinary question keys by the bounded sequence set without scanning conversation history", () => {
  const h = cloneBusinessDb();
  const db = h.db;
  const originalQuery = db.query;
  try {
    const conversationId = conversationFor(h);
    const foreign = conversationFor(h);
    const insert =
      db.query(`INSERT INTO conversation_events(conversation_id,seq,event_key,kind,source_kind,source_id,
      source_revision,sources,addressing,occurred_at,recorded_at) VALUES(?,?,?,?,?,?,'1','[]','{}',?,?)`);
    db.transaction(() => {
      for (let seq = 1; seq <= 4000; seq++)
        insert.run(
          conversationId,
          seq,
          `event-${seq}`,
          "inbound",
          "qq_event",
          `source-${seq}`,
          NOW,
          NOW,
        );
      insert.run(
        conversationId,
        4001,
        "wrong-kind",
        "delivery",
        "qq_event",
        "wrong-kind",
        NOW,
        NOW,
      );
      insert.run(
        conversationId,
        4002,
        "wrong-source",
        "inbound",
        "qq_media",
        "wrong-source",
        NOW,
        NOW,
      );
      insert.run(foreign, 4003, "foreign", "inbound", "qq_event", "foreign-source", NOW, NOW);
    })();
    for (const [id, seq] of [
      ["ordinary-a", 3999],
      ["ordinary-b", 3999],
      ["bad-kind", 4001],
      ["bad-source", 4002],
      ["foreign-only", 4003],
    ] as const)
      seedTask(h, {
        id,
        conversationId,
        status: "pending",
        taskClass: "ordinary",
        cause: "chiming_in",
        throughSeq: seq,
      });
    let lookedUp = 0;
    (db as unknown as { query: (sql: string) => unknown }).query = (sql: string) => {
      const statement = originalQuery.call(db, sql);
      if (!sql.includes("CROSS JOIN conversation_events e")) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === "all")
            return (...bindings: unknown[]) => {
              lookedUp++;
              const plan = originalQuery
                .call(db, `EXPLAIN QUERY PLAN ${sql}`)
                .all(...(bindings as never[])) as { detail: string }[];
              expect(
                plan.some(({ detail }) => detail.includes("conversation_id=? AND seq=?")),
              ).toBe(true);
              const rows = Reflect.apply(value, target, bindings) as unknown[];
              expect(rows).toHaveLength(1);
              return rows;
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const projection = reader(h, conversationId, {
      visibleEventKeys: new Set(["source-3999", "wrong-kind", "wrong-source", "foreign-source"]),
    });
    expect(lookedUp).toBe(1);
    expect(
      projection.jobs
        .filter((job) => job.questionSeq === 3999)
        .map((job) => job.taskId)
        .sort(),
    ).toEqual(["ordinary-a", "ordinary-b"]);
    expect(
      projection.jobs
        .filter(
          (job) =>
            job.taskId === "bad-kind" ||
            job.taskId === "bad-source" ||
            job.taskId === "foreign-only",
        )
        .every((job) => job.questionSeq === undefined),
    ).toBe(true);
  } finally {
    db.query = originalQuery;
    h.close();
  }
});
it("projects question visibility repeatedly without rereading or validating facts", () => {
  const h = cloneBusinessDb();
  try {
    const conversationId = conversationFor(h);
    seedTask(h, {
      id: "visible-job",
      conversationId,
      status: "pending",
      taskClass: "ordinary",
      cause: "chiming_in",
      throughSeq: 7,
    });
    h.db
      .query(`INSERT INTO conversation_events(conversation_id,seq,event_key,kind,source_kind,source_id,source_revision,sources,addressing,occurred_at,recorded_at)
      VALUES(?,7,'visible-question','inbound','qq_event','visible-key','1','[]','{}',?,?)`)
      .run(conversationId, NOW, NOW);
    const facts = readConcurrentReplyFacts(h.db, {
      conversationId,
      bindingEpoch: 1,
      agentId: DEFAULT_AGENT_ID,
      now: NOW,
    });
    const original = h.db.query;
    let reads = 0;
    h.db.query = ((...args: Parameters<typeof original>) => {
      reads++;
      return original.apply(h.db, args);
    }) as typeof original;
    try {
      for (const keys of [new Set(["visible-key"]), new Set<string>(), new Set(["visible-key"])]) {
        const projection = projectConcurrentReplyQuestions(facts, keys);
        expect(projection.jobs[0]?.questionSeq).toBe(keys.size ? 7 : undefined);
        expect(projection.sources).toBe(facts.sources);
        expect(projection.contexts).toBe(facts.contexts);
      }
      expect(reads).toBe(0);
    } finally {
      h.db.query = original;
    }
    expect(facts.jobs[0]?.questionSeq).toBe(7);
  } finally {
    h.close();
  }
});
