// Dynamic suppression packing integration tests (REV2).
//
// Contract: under the auto auxiliary profile, when the full consolidation draft
// request fits the model capacity, but the entire legacy fixed chunk of 8
// blocked entries plus candidate draft and schema exceeds the capacity ceiling,
// the suppression loop greedily packs contiguous blocked prefixes according
// to the actual measured request cost so that legal smaller batches fit instead
// of failing prematurely at the gate.
//
// Semantics:
// 1. Full OR comparison: all blocked entries are evaluated across contiguous
//    batches. If no entry matches, the candidate is published.
// 2. Early exit: if any batch encounters a matching entry, comparison halts
//    immediately and the candidate is rejected.
// 3. Provenance and alignment: every batch carries exact source references
//    matching the active slice of blocked sources, and live turn sources.
// 4. Fixed and absent modes: fixed mode retains its explicit limit without
//    dynamic repacking; absent profile retains the legacy fixed 8-batch loop.
// 5. Indivisibility: a single blocked entry whose mandatory full request truly
//    exceeds capacity must fail closed with an explicit budget error and never
//    be truncated.
//
// Synthetic test: in-memory sqlite database, scripted gateway double, declared
// synthetic counter. No live model calls, no network, relative imports only.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { ModelContextBudget } from "../../src/server/agent/model-port";
import type { ContextMessage } from "../../src/server/db/context-repository";
import { enqueue, entries } from "../../src/server/db/memory-repository";
import {
  createSession,
  DEFAULT_USER_ID,
  ensureDefaults,
  getTurnByRequest,
  immediate,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { measureContextTokens } from "../../src/server/llm/request-format";
import {
  DRAFT_RESULT_JSON_SCHEMA,
  type MemoryDraft,
  type PromptMessage,
  SUPPRESSION_RESULT_JSON_SCHEMA,
  suppressionPrompt,
} from "../../src/server/services/memory-contract";
import { MemoryService } from "../../src/server/services/memory-service";
import { estimateTokens } from "../../src/server/services/token-estimate";

const MODEL = "qwen/qwen3-4b-2507";
const OUTPUT_RESERVED = 512;
const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const encoding = "o200k_base" as const;

/** Synthetic declared tokenizer: one token per code point. */
const countTokens = (text: string): number => [...text].length;

const CANDIDATE_DRAFT: MemoryDraft = {
  name: "偏好记录",
  summary: "用户简明回复偏好",
  tags: ["偏好"],
  kinds: ["semantic"],
  body: "用户希望答复使用中文，表达简明扼要，先给出结论再补充原因。",
};

const DRAFT_JSON = JSON.stringify({
  memory: CANDIDATE_DRAFT,
});

const USER_TEXT = "用户偏好整理：后续回复请使用中文，回答简明扼要，先给出结论再补充原因。";
const ASSISTANT_TEXT = "好的，后续将采用中文简短作答，先给出结论并补充原因。";

type MeasurableMessage = ContextMessage | PromptMessage;

type WireCall = {
  messages: ContextMessage[];
  model?: string;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  contextBudget?: ModelContextBudget;
  contextInputLimit?: number;
};

/** Scriptable gateway double supporting declared counter and queued replies. */
class ScriptedGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  capacity: number | null = 1_000_000;
  calls: WireCall[] = [];
  suppressionReplies: string[] = [];
  draftReply: string = DRAFT_JSON;
  preparations = 0;
  capacityProbes = 0;

  async listModels(): Promise<string[]> {
    return [MODEL];
  }
  async loadedContextCapacity(): Promise<number | null> {
    this.capacityProbes += 1;
    return this.capacity;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async prepareContextModel(): Promise<ModelContextBudget> {
    this.preparations += 1;
    return Object.freeze({
      model: MODEL,
      capacity: this.capacity,
      tokenizerEncoding: encoding,
      countText: countTokens,
      assertCurrent: () => {},
    });
  }
  async complete(options: WireCall): Promise<string> {
    this.calls.push(options);
    const schemaText = JSON.stringify(options.responseSchema ?? {});
    if (schemaText.includes("MemoryDraft")) {
      return this.draftReply;
    }
    if (schemaText.includes("blocked")) {
      return this.suppressionReplies.shift() ?? JSON.stringify({ blocked: false });
    }
    return "{}";
  }
  async *streamChat(): AsyncGenerator<string> {
    yield "unused";
  }
}

/** Measures the full request in the declared token domain. */
function measureRequestTokens(
  messages: readonly MeasurableMessage[],
  responseSchema: Record<string, unknown>,
): number {
  return measureContextTokens(messages, { encoding, count: countTokens }, { responseSchema })
    .textTokens;
}

/** Measures the full request in the legacy byte domain. */
function measureRequestBytes(
  messages: readonly MeasurableMessage[],
  responseSchema: Record<string, unknown>,
): number {
  const messageBytes =
    3 +
    messages.reduce(
      (sum, message) => sum + 12 + estimateTokens(message.role) + estimateTokens(message.content),
      0,
    );
  return messageBytes + estimateTokens(JSON.stringify(responseSchema));
}

function setup(gateway: ModelGateway) {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const service = new MemoryService({
    orm: business.orm,
    db: business.db,
    gateway,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 5,
    jobTimeoutMs: 2_000,
  });
  return { business, orm: business.orm, db: business.db, service };
}

type Ctx = ReturnType<typeof setup>;

function completedTurn(orm: Ctx["orm"], sessionId: string, key: string): string {
  const prepared = prepareTurn(orm, sessionId, USER_TEXT, key);
  if (prepared.generationToken === null) throw new Error("fresh token expected");
  saveCompletedAssistantMessage(orm, sessionId, ASSISTANT_TEXT, key, prepared.generationToken);
  const turn = getTurnByRequest(orm, sessionId, key);
  if (!turn) throw new Error("turn missing");
  return turn.id;
}

async function runOne(ctx: Ctx, requestKey: string): Promise<string> {
  const sessionId = createSession(ctx.orm, "动态抑制分组", { modelName: MODEL }).id;
  const turnId = completedTurn(ctx.orm, sessionId, requestKey);
  const blocked = ctx.orm
    .select()
    .from(schema.memoryEntries)
    .where(eq(schema.memoryEntries.status, "suppressed"))
    .all();
  if (blocked.length > 0) {
    const sourceTurnId = completedTurn(ctx.orm, sessionId, `${requestKey}-blocked-source`);
    const messages = ctx.orm
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.turnId, sourceTurnId))
      .all();
    const user = messages.find((message) => message.role === "user");
    const assistant = messages.find((message) => message.role === "assistant");
    if (!user || !assistant) throw new Error("completed blocked source messages missing");
    for (const entry of blocked) {
      ctx.orm
        .insert(schema.memorySources)
        .values({
          memoryId: entry.id,
          turnId: sourceTurnId,
          userMessageId: user.id,
          assistantMessageId: assistant.id,
          sequenceNo: user.sequenceNo,
        })
        .run();
    }
  }
  const job = immediate(ctx.db, () =>
    enqueue(ctx.orm, AGENT_ID, requestKey, { kind: "manual", sessionId, turnIds: [turnId] }),
  );
  await ctx.service.runJob(job.id);
  return job.id;
}

function jobOf(ctx: Ctx, jobId: string) {
  const row = ctx.orm.select().from(schema.memoryJobs).where(eq(schema.memoryJobs.id, jobId)).get();
  if (!row) throw new Error("job missing");
  return row;
}

function setAgentAuxProfile(orm: Ctx["orm"], profile: Record<string, unknown> | undefined): void {
  const row = orm.select().from(schema.agents).where(eq(schema.agents.id, AGENT_ID)).get();
  if (!row) throw new Error("default agent missing");
  const p5 = JSON.parse(row.p5Config) as Record<string, unknown>;
  const aux = (p5.auxiliary_allocation ?? {}) as Record<string, unknown>;
  const next = { ...p5, auxiliary_allocation: { ...aux, memory_consolidate: profile } };
  orm
    .update(schema.agents)
    .set({ p5Config: JSON.stringify(next) })
    .where(eq(schema.agents.id, AGENT_ID))
    .run();
}

function makeBlockedItem(index: number) {
  return {
    name: `历史配置记录${index}`,
    summary: `配置摘要${index}`,
    body: `生产系统只读备份节点参数第${index}项备忘说明：数据库端口为808${index}，主机地址为db-replica-${index}.internal，连接超时限制设为30秒，只读副本无需保留归档事务日志。`,
  };
}

function seedSuppressedEntries(
  ctx: Ctx,
  items: Array<{ name: string; summary: string; body: string }>,
): void {
  immediate(ctx.db, () => {
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      const id = crypto.randomUUID();
      ctx.orm
        .insert(schema.memoryEntries)
        .values({
          id,
          agentId: AGENT_ID,
          userId: DEFAULT_USER_ID,
          name: item.name,
          summary: item.summary,
          tags: JSON.stringify(["semantic"]),
          kinds: JSON.stringify(["semantic"]),
          body: item.body,
          status: "suppressed",
          scope: "reality_user",
          scopeKey: AGENT_ID,
          configSnapshot: "{}",
          createdAt: new Date(Date.now() - (items.length - index) * 1000).toISOString(),
        } satisfies typeof schema.memoryEntries.$inferInsert)
        .run();
    }
  });
}

/** Queries actual blocked records in the exact order MemoryService.loadInputs retrieves them. */
function getOrderedDbBlocked(ctx: Ctx): {
  items: Array<{ name: string; summary: string; body: string }>;
  ids: string[];
} {
  const dbEntries = entries(ctx.orm, AGENT_ID, undefined, { scopeKeys: [AGENT_ID] });
  return {
    items: dbEntries.map((e) => ({
      name: e.name,
      summary: e.summary,
      body: e.body,
    })),
    ids: dbEntries.map((e) => e.id),
  };
}

/** Verifies context_snapshots using real SQLite schema table columns. */
function querySuppressionSnapshots(ctx: Ctx) {
  return ctx.db
    .query<
      {
        step_id: string;
        source_refs: string;
        status: string;
        step_no: number;
        phase: string;
        spec_id: string;
        started_at: string;
      },
      []
    >(
      `SELECT c.step_id, c.source_refs, c.status, s.step_no, s.phase, r.spec_id, s.started_at
       FROM context_snapshots c
       JOIN agent_steps s ON s.step_id = c.step_id
       JOIN agent_runs r ON r.run_id = s.run_id
       WHERE r.spec_id = 'memory.suppression'
       ORDER BY s.started_at ASC, s.step_no ASC`,
    )
    .all();
}

/** Asserts maximal greedy contiguous partitioning across flexible batch boundaries. */
function assertFlexibleGreedyPartition(
  suppressionCalls: WireCall[],
  snapshots: ReturnType<typeof querySuppressionSnapshots>,
  orderedBlocked: Array<{ name: string; summary: string; body: string }>,
  orderedIds: string[],
  ceiling: number,
  options: { earlyExit?: boolean } = {},
): void {
  expect(suppressionCalls.length).toBeGreaterThanOrEqual(2);
  expect(snapshots.length).toBe(suppressionCalls.length);

  let offset = 0;
  for (let i = 0; i < suppressionCalls.length; i++) {
    const call = suppressionCalls[i];
    const snapshot = snapshots[i];

    // 1. Each complete suppression call fits strictly within capacity ceiling.
    const callTokens = measureRequestTokens(call.messages, SUPPRESSION_RESULT_JSON_SCHEMA);
    expect(callTokens).toBeLessThanOrEqual(ceiling);

    // 2. Chunks are contiguous non-empty slices of the actual DB retrieval order.
    const callBody = JSON.parse(call.messages[1].content) as {
      candidate: MemoryDraft;
      candidate_context?: Record<string, unknown>;
      blocked: Array<{ name: string; summary: string; body: string }>;
    };
    const chunk = callBody.blocked;
    expect(chunk.length).toBeGreaterThan(0);
    const expectedSlice = orderedBlocked.slice(offset, offset + chunk.length);
    expect(chunk.map((c) => ({ name: c.name, summary: c.summary, body: c.body }))).toEqual(
      expectedSlice,
    );

    // 3. Maximality proof: adding the next contiguous item would have exceeded the ceiling.
    const nextIndex = offset + chunk.length;
    const isTerminalEvaluated = i === suppressionCalls.length - 1;
    if (!isTerminalEvaluated && nextIndex < orderedBlocked.length) {
      const nextBody = JSON.parse(suppressionCalls[i + 1].messages[1].content) as {
        blocked: Array<{ name: string; summary: string; body: string }>;
      };
      const nextItem = nextBody.blocked[0];
      expect(nextItem).toBeDefined();
      expect({ name: nextItem.name, summary: nextItem.summary, body: nextItem.body }).toEqual(
        orderedBlocked[nextIndex],
      );
      const overflowPrompt = suppressionPrompt(
        callBody.candidate,
        [...chunk, nextItem],
        callBody.candidate_context ?? null,
      );
      expect(call.responseSchema).toEqual(SUPPRESSION_RESULT_JSON_SCHEMA);
      const overflowCost = measureRequestTokens(overflowPrompt, call.responseSchema!);
      expect(overflowCost).toBeGreaterThan(ceiling);
    }

    // 4. Context snapshot memory refs match the exact IDs of the current slice.
    const memRefs = (
      JSON.parse(snapshot.source_refs) as Array<{ kind: string; id: string }>
    ).filter((s) => s.kind === "memory");
    expect(memRefs.map((s) => s.id)).toEqual(orderedIds.slice(offset, offset + chunk.length));

    // 5. Context snapshot carries live turn sources as well (full provenance).
    const turnRefs = (
      JSON.parse(snapshot.source_refs) as Array<{ kind: string; id: string }>
    ).filter((s) => s.kind === "web_turn");
    expect(turnRefs.length).toBeGreaterThan(0);

    offset += chunk.length;
  }

  if (!options.earlyExit) {
    // Full coverage: every seeded blocked item evaluated when no match occurs.
    expect(offset).toBe(orderedBlocked.length);
  } else {
    // Early exit: comparison halted without requiring redundant evaluations.
    expect(offset).toBeLessThanOrEqual(orderedBlocked.length);
  }
}

describe("dynamic suppression packing (C4)", () => {
  const all8Items = Array.from({ length: 8 }, (_, i) => makeBlockedItem(i));
  const autoItems = all8Items.map((item) => ({
    ...item,
    // Synthetic source detail makes the eight-entry request exceed the probed draft cost.
    body: `${item.body}该项还有单独的维护窗口记录和访问范围说明，需要结合配置的原始上下文核对。维护记录还注明变更须经值班人员确认，核对备份状态、网络访问规则、恢复步骤和监控告警；完成后登记检查结果，并在下一次例行巡检时复核。`,
  }));
  const autoPrompt8 = suppressionPrompt(CANDIDATE_DRAFT, autoItems);
  const autoPrompt4First = suppressionPrompt(CANDIDATE_DRAFT, autoItems.slice(0, 4));
  const autoPrompt4Second = suppressionPrompt(CANDIDATE_DRAFT, autoItems.slice(4, 8));
  const prompt8 = suppressionPrompt(CANDIDATE_DRAFT, all8Items);
  const prompt4First = suppressionPrompt(CANDIDATE_DRAFT, all8Items.slice(0, 4));
  const prompt4Second = suppressionPrompt(CANDIDATE_DRAFT, all8Items.slice(4, 8));

  it("auto mode: evaluates all blocked entries across smaller contiguous batches when fixed 8-chunk overflows, and publishes on no match", async () => {
    // Step 1: Probe the consolidation request cost using a generous capacity gateway.
    const probeGateway = new ScriptedGateway();
    probeGateway.capacity = 1_000_000;
    const probeCtx = setup(probeGateway);
    let consolidateCost = 0;
    try {
      setAgentAuxProfile(probeCtx.orm, { mode: "auto", output_reserved: OUTPUT_RESERVED });
      seedSuppressedEntries(probeCtx, [autoItems[0]]);
      const probeId = await runOne(probeCtx, "probe-auto-no-match");
      expect(jobOf(probeCtx, probeId)?.status).toBe("succeeded");
      expect(probeGateway.calls.length).toBe(2);
      consolidateCost = measureRequestTokens(
        probeGateway.calls[0].messages,
        DRAFT_RESULT_JSON_SCHEMA,
      );
    } finally {
      probeCtx.business.close();
    }

    // Step 2: Measure suppression request costs via the production prompt builder.
    const cost8 = measureRequestTokens(autoPrompt8, SUPPRESSION_RESULT_JSON_SCHEMA);
    const cost4First = measureRequestTokens(autoPrompt4First, SUPPRESSION_RESULT_JSON_SCHEMA);
    const cost4Second = measureRequestTokens(autoPrompt4Second, SUPPRESSION_RESULT_JSON_SCHEMA);
    const maxCost4 = Math.max(cost4First, cost4Second);

    // Baseline conditions: consolidate and 4-batches fit, while the 8-batch overflows.
    const ceiling = Math.max(consolidateCost, maxCost4) + 60;
    expect(ceiling).toBeGreaterThanOrEqual(consolidateCost);
    expect(ceiling).toBeGreaterThanOrEqual(maxCost4);
    expect(ceiling).toBeLessThan(cost8);

    // Step 3: Run target job under tight capacity.
    const gateway = new ScriptedGateway();
    gateway.capacity = ceiling + OUTPUT_RESERVED;
    gateway.suppressionReplies = [
      JSON.stringify({ blocked: false }),
      JSON.stringify({ blocked: false }),
      JSON.stringify({ blocked: false }),
    ];
    const ctx = setup(gateway);
    try {
      setAgentAuxProfile(ctx.orm, { mode: "auto", output_reserved: OUTPUT_RESERVED });
      seedSuppressedEntries(ctx, autoItems);
      const { items: orderedBlocked, ids: orderedIds } = getOrderedDbBlocked(ctx);
      expect(orderedBlocked.length).toBe(8);

      const jobId = await runOne(ctx, "auto-no-match-target");
      const job = jobOf(ctx, jobId);

      // Precondition proof: consolidate wire call must succeed first.
      expect(gateway.calls.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(gateway.calls[0].responseSchema ?? {})).toContain("MemoryDraft");

      // Boundary proof: if job failed in pre-fix state, failure is strictly CONTEXT_AUX_BUDGET
      // on suppression gate, with exactly 1 call made (consolidate).
      if (job.status === "failed") {
        expect(job.errorCode).toBe("CONTEXT_AUX_BUDGET");
        expect(gateway.calls.length).toBe(1);
      }

      // Target invariant after dynamic suppression packing: job succeeds cleanly.
      expect(job.status).toBe("succeeded");
      expect(job.errorCode).toBeNull();

      // Flexible greedy partition assertions:
      const suppressionCalls = gateway.calls.slice(1);
      const snapshots = querySuppressionSnapshots(ctx);
      assertFlexibleGreedyPartition(
        suppressionCalls,
        snapshots,
        orderedBlocked,
        orderedIds,
        ceiling,
        { earlyExit: false },
      );

      // Candidate draft is published because no entry matched.
      const active = entries(ctx.orm, AGENT_ID).filter((e) => e.status === "active");
      expect(active).toHaveLength(1);
      expect(active[0].body).toBe(CANDIDATE_DRAFT.body);
    } finally {
      ctx.business.close();
    }
  });

  it("auto mode: early exits when a later batch reports a matching entry, rejecting candidate", async () => {
    // Step 1: Probe consolidation cost.
    const probeGateway = new ScriptedGateway();
    probeGateway.capacity = 1_000_000;
    const probeCtx = setup(probeGateway);
    let consolidateCost = 0;
    try {
      setAgentAuxProfile(probeCtx.orm, { mode: "auto", output_reserved: OUTPUT_RESERVED });
      seedSuppressedEntries(probeCtx, [autoItems[0]]);
      const probeId = await runOne(probeCtx, "probe-auto-later-match");
      expect(jobOf(probeCtx, probeId)?.status).toBe("succeeded");
      consolidateCost = measureRequestTokens(
        probeGateway.calls[0].messages,
        DRAFT_RESULT_JSON_SCHEMA,
      );
    } finally {
      probeCtx.business.close();
    }

    const cost8 = measureRequestTokens(autoPrompt8, SUPPRESSION_RESULT_JSON_SCHEMA);
    const maxCost4 = Math.max(
      measureRequestTokens(autoPrompt4First, SUPPRESSION_RESULT_JSON_SCHEMA),
      measureRequestTokens(autoPrompt4Second, SUPPRESSION_RESULT_JSON_SCHEMA),
    );
    const ceiling = Math.max(consolidateCost, maxCost4) + 60;
    expect(ceiling).toBeLessThan(cost8);

    const gateway = new ScriptedGateway();
    gateway.capacity = ceiling + OUTPUT_RESERVED;
    // Batch 1 returns blocked: false, Batch 2 returns blocked: true -> triggers early exit.
    gateway.suppressionReplies = [
      JSON.stringify({ blocked: false }),
      JSON.stringify({ blocked: true }),
    ];
    const ctx = setup(gateway);
    try {
      setAgentAuxProfile(ctx.orm, { mode: "auto", output_reserved: OUTPUT_RESERVED });
      seedSuppressedEntries(ctx, autoItems);
      const { items: orderedBlocked, ids: orderedIds } = getOrderedDbBlocked(ctx);
      expect(orderedBlocked.length).toBe(8);

      const jobId = await runOne(ctx, "auto-later-match-target");
      const job = jobOf(ctx, jobId);

      // Precondition proof: consolidate wire call must succeed first.
      expect(gateway.calls.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(gateway.calls[0].responseSchema ?? {})).toContain("MemoryDraft");

      // Boundary proof: if job failed in pre-fix state, failure is strictly CONTEXT_AUX_BUDGET
      // on suppression gate, with exactly 1 call made (consolidate).
      if (job.status === "failed") {
        expect(job.errorCode).toBe("CONTEXT_AUX_BUDGET");
        expect(gateway.calls.length).toBe(1);
      }

      // In MemoryService: suppression rejection results in null draft and clean job completion.
      expect(job.status).toBe("succeeded");
      expect(job.errorCode).toBeNull();

      // Flexible partition with early exit verified:
      const suppressionCalls = gateway.calls.slice(1);
      const snapshots = querySuppressionSnapshots(ctx);
      assertFlexibleGreedyPartition(
        suppressionCalls,
        snapshots,
        orderedBlocked,
        orderedIds,
        ceiling,
        { earlyExit: true },
      );

      // No active entry published because matching batch blocked it.
      const active = entries(ctx.orm, AGENT_ID).filter((e) => e.status === "active");
      expect(active).toHaveLength(0);
    } finally {
      ctx.business.close();
    }
  });

  it("preserves legacy chunking of 8 under fixed and absent modes", async () => {
    // (a) Fixed mode with limit that accommodates 4 items but not 8:
    // Fixed mode must not dynamically repack; it attempts the chunk of 8 and fails closed.
    const byteCost4Max = Math.max(
      measureRequestBytes(prompt4First, SUPPRESSION_RESULT_JSON_SCHEMA),
      measureRequestBytes(prompt4Second, SUPPRESSION_RESULT_JSON_SCHEMA),
    );
    const byteCost8 = measureRequestBytes(prompt8, SUPPRESSION_RESULT_JSON_SCHEMA);
    const byteCeiling = byteCost4Max + 50;
    expect(byteCeiling).toBeLessThan(byteCost8);

    const fixedGateway = new ScriptedGateway();
    fixedGateway.capacity = 1_000_000;
    const fixedCtx = setup(fixedGateway);
    try {
      setAgentAuxProfile(fixedCtx.orm, {
        mode: "fixed",
        input_limit: byteCeiling,
        output_reserved: OUTPUT_RESERVED,
      });
      seedSuppressedEntries(fixedCtx, all8Items);
      const jobId = await runOne(fixedCtx, "fixed-no-dynamic-pack");
      const job = jobOf(fixedCtx, jobId);
      expect(job.status).toBe("failed");
      expect(job.errorCode).toBe("CONTEXT_AUX_BUDGET");
      const suppressionCalls = fixedGateway.calls.filter((c) =>
        JSON.stringify(c.responseSchema ?? {}).includes("blocked"),
      );
      expect(suppressionCalls).toHaveLength(0);
    } finally {
      fixedCtx.business.close();
    }

    // (b) Absent mode: chunk size remains legacy 8.
    // 9 items yield 2 suppression calls: first of 8 items, second of 1 item.
    const absentGateway = new ScriptedGateway();
    absentGateway.capacity = 1_000_000;
    const absentCtx = setup(absentGateway);
    try {
      setAgentAuxProfile(absentCtx.orm, undefined);
      const all9Items = Array.from({ length: 9 }, (_, i) => makeBlockedItem(i));
      seedSuppressedEntries(absentCtx, all9Items);
      const jobId = await runOne(absentCtx, "absent-chunk-8");
      const job = jobOf(absentCtx, jobId);
      expect(job.status).toBe("succeeded");
      const suppressionCalls = absentGateway.calls.filter((c) =>
        JSON.stringify(c.responseSchema ?? {}).includes("blocked"),
      );
      expect(suppressionCalls).toHaveLength(2);
      const firstCount = (
        JSON.parse(suppressionCalls[0].messages[1].content) as { blocked: unknown[] }
      ).blocked.length;
      const secondCount = (
        JSON.parse(suppressionCalls[1].messages[1].content) as { blocked: unknown[] }
      ).blocked.length;
      expect(firstCount).toBe(8);
      expect(secondCount).toBe(1);
    } finally {
      absentCtx.business.close();
    }
  });

  it("refuses and never truncates when a single mandatory blocked item truly overflows capacity", async () => {
    const giantItem = {
      name: "不可分单条记忆",
      summary: "超限正文",
      body: "超长不可分割正文段落，用于验证即使单条目达到最小批次仍超出容量时的硬性拒绝行为。".repeat(
        30,
      ),
    };
    const giantPrompt = suppressionPrompt(CANDIDATE_DRAFT, [giantItem]);
    const giantCost = measureRequestTokens(giantPrompt, SUPPRESSION_RESULT_JSON_SCHEMA);

    const maxCost4 = Math.max(
      measureRequestTokens(prompt4First, SUPPRESSION_RESULT_JSON_SCHEMA),
      measureRequestTokens(prompt4Second, SUPPRESSION_RESULT_JSON_SCHEMA),
    );
    const ceiling = maxCost4 + 60;
    expect(giantCost).toBeGreaterThan(ceiling);

    const gateway = new ScriptedGateway();
    gateway.capacity = ceiling + OUTPUT_RESERVED;
    const ctx = setup(gateway);
    try {
      setAgentAuxProfile(ctx.orm, { mode: "auto", output_reserved: OUTPUT_RESERVED });
      seedSuppressedEntries(ctx, [giantItem]);
      const jobId = await runOne(ctx, "single-item-overflow");
      const job = jobOf(ctx, jobId);
      expect(job.status).toBe("failed");
      expect(job.errorCode).toBe("CONTEXT_AUX_BUDGET");

      const suppressionCalls = gateway.calls.filter((c) =>
        JSON.stringify(c.responseSchema ?? {}).includes("blocked"),
      );
      expect(suppressionCalls).toHaveLength(0);
    } finally {
      ctx.business.close();
    }
  });
});
