import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { textMessage } from "../../src/server/agent/context-engine";
import { handleError } from "../../src/server/api/error-handler";
import { observabilityRoutes } from "../../src/server/api/observability";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import {
  RuntimeStorageCleanupResultSchema,
  RuntimeStorageItemsPageSchema,
  RuntimeStorageSummarySchema,
} from "../../src/shared/contracts/runtime-observability";

type Handle = ReturnType<typeof openBusinessDb>;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

// 相对真实时钟的边界：到期判定一律由服务端 now 决定，测试不能依赖绝对日期。
const NOW = Date.now();
const PAST = new Date(NOW - 3_600_000).toISOString();
const FUTURE = new Date(NOW + 30 * 86_400_000).toISOString();
const SECRET_CONTEXT = "SECRET_CONTEXT_PROMPT";
const SECRET_ARGUMENT = "SECRET_TASK_ARGUMENT";
const SECRET_RESULT = "SECRET_TASK_RESULT";
const SECRET_CODE = "SECRET_TRACE_CODE";

function setup(options: { retentionDays?: () => number } = {}) {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "fixture");
  const telemetry = new RuntimeTelemetry(
    h.db,
    options.retentionDays ? { retentionDays: options.retentionDays } : {},
  );
  const app = new Hono()
    .onError(handleError)
    .route(
      "/v2/observability",
      observabilityRoutes(h.db, { retentionDays: options.retentionDays }),
    );
  const session = createSession(h.orm, "storage", { modelName: "fixture" });
  const conversation = new ConversationEventRepository(h.db).ensureWeb(session.id, DEFAULT_USER_ID);
  if (!conversation) throw new Error("missing conversation");
  cleanups.push(async () => {
    await telemetry.close();
    h.close();
  });
  return { h, telemetry, app, conversation };
}

const storage = async (app: Hono) =>
  RuntimeStorageSummarySchema.parse(await (await app.request("/v2/observability/storage")).json());
const items = async (app: Hono, query: string) =>
  RuntimeStorageItemsPageSchema.parse(
    await (await app.request(`/v2/observability/storage/items?${query}`)).json(),
  );
const cleanupRequest = (app: Hono, dryRun: boolean, body: unknown) =>
  app.request(`/v2/observability/storage/cleanup${dryRun ? "/preview" : ""}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function insertSpan(
  h: Handle,
  input: {
    traceId: string;
    spanId: string;
    status: string;
    expiresAt: string;
    conversationId?: string;
  },
) {
  h.db
    .query(`INSERT INTO runtime_spans(trace_id,span_id,parent_span_id,name,user_id,agent_id,conversation_id,run_id,wake_id,output_id,source_seq,channel,stage,status,code,model,started_at,finished_at,duration_ms,expires_at,details)
    VALUES(?,?,NULL,'fixture',?,?,?,NULL,NULL,NULL,NULL,'web','run',?,?,NULL,?,NULL,NULL,?,'{}')`)
    .run(
      input.traceId,
      input.spanId,
      DEFAULT_USER_ID,
      DEFAULT_AGENT_ID,
      input.conversationId ?? null,
      input.status,
      SECRET_CODE,
      PAST,
      input.expiresAt,
    );
}

const spanStartedAt = (h: Handle, spanId: string) =>
  (
    h.db.query("SELECT started_at AS at FROM runtime_spans WHERE span_id=?").get(spanId) as {
      at: string;
    }
  ).at;
const expiries = (h: Handle, traceId: string) =>
  (
    h.db
      .query("SELECT DISTINCT expires_at AS at FROM runtime_spans WHERE trace_id=? ORDER BY at")
      .all(traceId) as { at: string }[]
  ).map((row) => row.at);
const traceSpanCount = (h: Handle, traceId: string) =>
  (
    h.db.query("SELECT COUNT(*) AS n FROM runtime_spans WHERE trace_id=?").get(traceId) as {
      n: number;
    }
  ).n;

/** 建一个 exact 快照（正文＝SECRET_CONTEXT）；`at` 与来源到期都由调用方控制。 */
function startContext(
  h: Handle,
  conversation: { id: string; agentId: string },
  input: { runId: string; stepId: string; sourceExpiry: string; at?: string },
) {
  const runs = new AgentRunRepository(h.db);
  runs.createRun({
    runId: input.runId,
    specId: "fixture",
    specVersion: "1",
    owner: {
      kind: "conversation",
      id: conversation.id,
      userId: DEFAULT_USER_ID,
      agentId: conversation.agentId,
    },
    at: input.at ?? PAST,
  });
  runs.startStep({
    runId: input.runId,
    stepId: input.stepId,
    stepNo: 1,
    model: "fixture",
    phase: "leaf",
    at: input.at ?? PAST,
    messages: [textMessage("user", SECRET_CONTEXT)],
    sources: [
      {
        kind: "qq_observation",
        id: "fixture-source",
        revision: "1",
        expiresAt: input.sourceExpiry,
      },
    ],
  });
}

function enqueueTask(
  h: Handle,
  conversationId: string,
  input: { key: string; expiresAt: string; at?: string; calls?: number },
) {
  const tasks = new AgentTaskRepository(h.db);
  return tasks.enqueue({
    conversationId,
    agentId: DEFAULT_AGENT_ID,
    dedupeKey: input.key,
    sources: [],
    at: input.at ?? PAST,
    expiresAt: input.expiresAt,
    calls: Array.from({ length: input.calls ?? 1 }, (_, ordinal) => ({
      name: `fixture.call-${ordinal}`,
      revision: "v1",
      effect: "write" as const,
      arguments: { token: SECRET_ARGUMENT },
    })),
  });
}

const completeTask = (h: Handle, id: string) => {
  h.db.query("UPDATE agent_tasks SET status='completed',updated_at=? WHERE id=?").run(PAST, id);
  h.db
    .query("UPDATE agent_task_calls SET status='completed',result=? WHERE task_id=?")
    .run(JSON.stringify({ value: SECRET_RESULT }), id);
};

/** 参与清理判定的全部物理状态：预览前后必须逐字相同。 */
function diskState(h: Handle) {
  return JSON.stringify({
    spans: h.db.query("SELECT * FROM runtime_spans ORDER BY id").all(),
    contexts: h.db.query("SELECT * FROM context_snapshots ORDER BY step_id").all(),
    steps: h.db.query("SELECT step_id,decision FROM agent_steps ORDER BY step_id").all(),
    tasks: h.db.query("SELECT * FROM agent_tasks ORDER BY id").all(),
    calls: h.db.query("SELECT * FROM agent_task_calls ORDER BY task_id,ordinal").all(),
  });
}

describe("trace retention freeze", () => {
  it("freezes a new trace's cap and never re-reads the setting for it", async () => {
    let days = 14;
    const f = setup({ retentionDays: () => days });
    const root = f.telemetry.start("root", { channel: "web", stage: "run" });
    const cap = new Date(
      Date.parse(spanStartedAt(f.h, root.spanId)) + 14 * 86_400_000,
    ).toISOString();
    expect(expiries(f.h, root.traceId)).toEqual([cap]);
    days = 1;
    root.update({ code: "CHANGED" });
    expect(expiries(f.h, root.traceId)).toEqual([cap]);
    root.end();
    expect(expiries(f.h, root.traceId)).toEqual([cap]);
    days = 3_650;
    const fresh = f.telemetry.start("fresh", { channel: "web", stage: "run" });
    const freshCap = new Date(
      Date.parse(spanStartedAt(f.h, fresh.spanId)) + 3_650 * 86_400_000,
    ).toISOString();
    expect(expiries(f.h, fresh.traceId)).toEqual([freshCap]);
    fresh.end();
    // 存储端点报告的当前值就是执行配置的有效值。
    expect((await storage(f.app)).retention.traceRetentionDays).toBe(3_650);
  });

  it("keeps an already-written trace's expiry when a later setting would change it", () => {
    let days = 14;
    const f = setup({ retentionDays: () => days });
    const root = f.telemetry.start("root", { channel: "web", stage: "run" });
    const frozen = expiries(f.h, root.traceId);
    expect(frozen).toEqual([
      new Date(Date.parse(spanStartedAt(f.h, root.spanId)) + 14 * 86_400_000).toISOString(),
    ]);
    root.end();
    days = 60;
    const restarted = new RuntimeTelemetry(f.h.db, { retentionDays: () => days });
    cleanups.push(async () => {
      await restarted.close();
    });
    // 模拟重启后按同一 trace 续写：行还在，就绝不读新设置。
    restarted.start("resume", { channel: "web", stage: "run", parent: root }).end();
    expect(expiries(f.h, root.traceId)).toEqual(frozen);
    days = 1;
    restarted.start("again", { channel: "web", stage: "run", parent: root }).end();
    expect(expiries(f.h, root.traceId)).toEqual(frozen);
    expect(traceSpanCount(f.h, root.traceId)).toBe(3);
  });

  it("keeps the shortest source lifetime as the trace cap", () => {
    const f = setup();
    const sourceExpiry = new Date(NOW + 60_000).toISOString();
    const capped = f.telemetry.start("capped", {
      channel: "onebot11",
      stage: "run",
      sources: [{ kind: "qq_observation", id: "s1", revision: "1", expiresAt: sourceExpiry }],
    });
    expect(expiries(f.h, capped.traceId)).toEqual([sourceExpiry]);
    const longerThanCap = new Date(NOW + 60 * 86_400_000).toISOString();
    const bounded = f.telemetry.start("bounded", {
      channel: "onebot11",
      stage: "run",
      sources: [{ kind: "qq_observation", id: "s2", revision: "1", expiresAt: longerThanCap }],
    });
    expect(expiries(f.h, bounded.traceId)).toEqual([
      new Date(Date.parse(spanStartedAt(f.h, bounded.spanId)) + 14 * 86_400_000).toISOString(),
    ]);
  });
});

describe("storage summary and items", () => {
  it("reports disk counts, retention bounds and the manual cleanup scope", async () => {
    const f = setup();
    f.telemetry.record("live", { channel: "web", stage: "run" });
    insertSpan(f.h, {
      traceId: "t-expired",
      spanId: "s-expired-1",
      status: "completed",
      expiresAt: PAST,
    });
    insertSpan(f.h, {
      traceId: "t-expired",
      spanId: "s-expired-2",
      status: "completed",
      expiresAt: PAST,
    });
    insertSpan(f.h, {
      traceId: "t-started",
      spanId: "s-started",
      status: "started",
      expiresAt: PAST,
    });
    insertSpan(f.h, {
      traceId: "t-unknown",
      spanId: "s-unknown",
      status: "unknown",
      expiresAt: PAST,
    });

    startContext(f.h, f.conversation, {
      runId: "run-live",
      stepId: "step-live",
      sourceExpiry: FUTURE,
    });
    startContext(f.h, f.conversation, {
      runId: "run-expired",
      stepId: "step-expired",
      sourceExpiry: FUTURE,
    });
    f.h.db
      .query("UPDATE context_snapshots SET expires_at=? WHERE step_id='step-expired'")
      .run(PAST);
    startContext(f.h, f.conversation, {
      runId: "run-revoked",
      stepId: "step-revoked",
      sourceExpiry: FUTURE,
    });
    new AgentRunRepository(f.h.db).redactContext(
      { runId: "run-revoked", stepId: "step-revoked" },
      "revoked",
    );

    enqueueTask(f.h, f.conversation.id, {
      key: "live",
      expiresAt: FUTURE,
      at: new Date(NOW - 60_000).toISOString(),
    });
    const done = enqueueTask(f.h, f.conversation.id, {
      key: "done",
      expiresAt: PAST,
      at: new Date(NOW - 120_000).toISOString(),
    });
    completeTask(f.h, done.id);
    const waiting = enqueueTask(f.h, f.conversation.id, {
      key: "waiting",
      expiresAt: PAST,
      at: new Date(NOW - 180_000).toISOString(),
    });
    f.h.db.query("UPDATE agent_tasks SET status='waiting_approval' WHERE id=?").run(waiting.id);
    f.h.db
      .query("UPDATE agent_task_calls SET status='waiting_approval' WHERE task_id=?")
      .run(waiting.id);
    const cleared = enqueueTask(f.h, f.conversation.id, {
      key: "cleared",
      expiresAt: PAST,
      at: new Date(NOW - 240_000).toISOString(),
    });
    f.h.db.query("UPDATE agent_task_calls SET arguments=NULL WHERE task_id=?").run(cleared.id);

    const summary = await storage(f.app);
    expect(summary.retention).toEqual({
      traceRetentionDays: 14,
      traceRetentionDefaultDays: 14,
      traceRetentionMinDays: 1,
      traceRetentionMaxDays: 3_650,
    });
    expect(summary.traces).toEqual({ live: 1, expired: 3, started: 1, unknown: 1 });
    expect(summary.spans).toEqual({ live: 1, expired: 4 });
    expect(summary.contexts).toEqual({
      live: 1,
      expired: 1,
      revoked: 1,
      withProtectedBody: 2,
      expiredProtectedBodies: 1,
    });
    expect(summary.taskPayloads).toEqual({ live: 1, expired: 2, protected: 1, removable: 1 });
    expect(summary.cleanupScope).toEqual({
      categories: ["traces", "contexts", "task_payloads"],
      protectedTraceStatuses: ["started", "unknown"],
      protectedTaskStatuses: ["queued", "running", "waiting_tool", "waiting_approval", "unknown"],
      protectedCallStatuses: ["running", "waiting_approval", "unknown"],
      contextClearedFields: ["protected_messages", "protected_output"],
      taskClearedFields: ["arguments", "result"],
    });
    expect(JSON.stringify(summary)).not.toContain("SECRET");
  });

  it("pages metadata-only items with filters and stable cursors, never bodies", async () => {
    const f = setup();
    insertSpan(f.h, {
      traceId: "t1",
      spanId: "s1a",
      status: "completed",
      expiresAt: PAST,
      conversationId: f.conversation.id,
    });
    insertSpan(f.h, {
      traceId: "t1",
      spanId: "s1b",
      status: "completed",
      expiresAt: PAST,
      conversationId: f.conversation.id,
    });
    insertSpan(f.h, { traceId: "t2", spanId: "s2a", status: "completed", expiresAt: PAST });
    insertSpan(f.h, { traceId: "t3", spanId: "s3a", status: "completed", expiresAt: FUTURE });
    insertSpan(f.h, {
      traceId: "t4",
      spanId: "s4a",
      status: "started",
      expiresAt: PAST,
      conversationId: f.conversation.id,
    });

    const first = await items(f.app, "category=traces&limit=2");
    expect(first.summary).toEqual({ total: 4, live: 1, expired: 3 });
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = await items(f.app, `category=traces&limit=2&cursor=${first.nextCursor}`);
    expect(second.hasMore).toBe(false);
    const traceIds = [...first.items, ...second.items].flatMap((item) =>
      item.kind === "trace" ? [item.traceId] : [],
    );
    expect(new Set(traceIds).size).toBe(4);
    const expired = await items(
      f.app,
      `category=traces&status=expired&conversationId=${f.conversation.id}`,
    );
    const expiredTraces = expired.items.filter((item) => item.kind === "trace");
    expect(expiredTraces.map((item) => item.traceId).sort()).toEqual(["t1", "t4"]);
    expect(expiredTraces.find((item) => item.traceId === "t4")?.protected).toBe(true);
    expect(expiredTraces.find((item) => item.traceId === "t1")?.protected).toBe(false);
    expect((await items(f.app, `category=traces&agentId=${DEFAULT_AGENT_ID}`)).summary.total).toBe(
      4,
    );
    expect(JSON.stringify(first)).not.toContain(SECRET_CODE);

    startContext(f.h, f.conversation, { runId: "run-1", stepId: "step-1", sourceExpiry: FUTURE });
    f.h.db.query("UPDATE context_snapshots SET expires_at=? WHERE step_id='step-1'").run(PAST);
    startContext(f.h, f.conversation, { runId: "run-2", stepId: "step-2", sourceExpiry: FUTURE });
    const contexts = await items(f.app, "category=contexts&status=expired");
    expect(contexts.summary).toEqual({ total: 2, live: 1, expired: 1 });
    expect(contexts.items).toHaveLength(1);
    expect(contexts.items[0]).toMatchObject({
      kind: "context",
      stepId: "step-1",
      runId: "run-1",
      status: "exact",
      expired: true,
      hasProtectedBody: true,
      conversationId: f.conversation.id,
    });
    expect(JSON.stringify(contexts)).not.toContain(SECRET_CONTEXT);

    enqueueTask(f.h, f.conversation.id, {
      key: "t-done",
      expiresAt: PAST,
      at: new Date(NOW - 120_000).toISOString(),
    });
    const done = (
      f.h.db.query("SELECT id FROM agent_tasks WHERE dedupe_key='t-done'").get() as { id: string }
    ).id;
    completeTask(f.h, done);
    enqueueTask(f.h, f.conversation.id, {
      key: "t-wait",
      expiresAt: PAST,
      at: new Date(NOW - 60_000).toISOString(),
    });
    const waiting = (
      f.h.db.query("SELECT id FROM agent_tasks WHERE dedupe_key='t-wait'").get() as { id: string }
    ).id;
    f.h.db.query("UPDATE agent_tasks SET status='waiting_approval' WHERE id=?").run(waiting);
    f.h.db
      .query("UPDATE agent_task_calls SET status='waiting_approval' WHERE task_id=?")
      .run(waiting);
    enqueueTask(f.h, f.conversation.id, {
      key: "t-live",
      expiresAt: FUTURE,
      at: new Date(NOW - 30_000).toISOString(),
    });

    const taskFirst = await items(f.app, "category=task_payloads&status=expired&limit=1");
    expect(taskFirst.summary).toEqual({ total: 3, live: 1, expired: 2 });
    expect(taskFirst.hasMore).toBe(true);
    const taskSecond = await items(
      f.app,
      `category=task_payloads&limit=1&cursor=${encodeURIComponent(taskFirst.nextCursor ?? "")}`,
    );
    expect(taskSecond.items).toHaveLength(1);
    expect(taskFirst.items[0]).toMatchObject({ kind: "task_payload", protected: true });
    expect(taskSecond.items[0]).toMatchObject({ kind: "task_payload", protected: false });
    expect(JSON.stringify([taskFirst, taskSecond])).not.toContain(SECRET_ARGUMENT);
    expect(JSON.stringify([taskFirst, taskSecond])).not.toContain(SECRET_RESULT);
  });
});

describe("manual cleanup", () => {
  it("previews without writing, then clears only eligible rows and keeps identities", async () => {
    const f = setup();
    insertSpan(f.h, { traceId: "clean", spanId: "clean-1", status: "completed", expiresAt: PAST });
    insertSpan(f.h, { traceId: "clean", spanId: "clean-2", status: "completed", expiresAt: PAST });
    insertSpan(f.h, {
      traceId: "protected",
      spanId: "protected-1",
      status: "started",
      expiresAt: PAST,
    });
    insertSpan(f.h, { traceId: "live", spanId: "live-1", status: "completed", expiresAt: FUTURE });
    startContext(f.h, f.conversation, {
      runId: "run-clean",
      stepId: "step-clean",
      sourceExpiry: FUTURE,
    });
    f.h.db.query("UPDATE context_snapshots SET expires_at=? WHERE step_id='step-clean'").run(PAST);
    f.h.db
      .query("UPDATE agent_steps SET decision=? WHERE step_id='step-clean'")
      .run(JSON.stringify({ kept: "SECRET_DECISION" }));
    startContext(f.h, f.conversation, {
      runId: "run-live",
      stepId: "step-live",
      sourceExpiry: FUTURE,
    });
    const done = enqueueTask(f.h, f.conversation.id, {
      key: "done",
      expiresAt: PAST,
      at: new Date(NOW - 120_000).toISOString(),
    });
    completeTask(f.h, done.id);
    const waiting = enqueueTask(f.h, f.conversation.id, {
      key: "waiting",
      expiresAt: PAST,
      at: new Date(NOW - 60_000).toISOString(),
    });
    f.h.db.query("UPDATE agent_tasks SET status='waiting_approval' WHERE id=?").run(waiting.id);
    f.h.db
      .query("UPDATE agent_task_calls SET status='waiting_approval' WHERE task_id=?")
      .run(waiting.id);
    const unknownCall = enqueueTask(f.h, f.conversation.id, {
      key: "unknown-call",
      expiresAt: PAST,
      at: new Date(NOW - 180_000).toISOString(),
      calls: 2,
    });
    f.h.db.query("UPDATE agent_tasks SET status='failed' WHERE id=?").run(unknownCall.id);
    f.h.db
      .query("UPDATE agent_task_calls SET status='unknown' WHERE task_id=? AND ordinal=1")
      .run(unknownCall.id);
    const live = enqueueTask(f.h, f.conversation.id, {
      key: "live",
      expiresAt: FUTURE,
      at: new Date(NOW - 30_000).toISOString(),
    });

    const before = diskState(f.h);
    const tracePreview = RuntimeStorageCleanupResultSchema.parse(
      await (await cleanupRequest(f.app, true, { category: "traces" })).json(),
    );
    expect(tracePreview).toMatchObject({
      dryRun: true,
      expired: 2,
      removable: 1,
      protected: 1,
      removed: 0,
      ids: ["clean"],
      truncated: false,
    });
    const contextPreview = RuntimeStorageCleanupResultSchema.parse(
      await (await cleanupRequest(f.app, true, { category: "contexts" })).json(),
    );
    expect(contextPreview).toMatchObject({
      dryRun: true,
      expired: 1,
      removable: 1,
      protected: 0,
      removed: 0,
      ids: ["step-clean"],
    });
    const taskPreview = RuntimeStorageCleanupResultSchema.parse(
      await (await cleanupRequest(f.app, true, { category: "task_payloads" })).json(),
    );
    expect(taskPreview).toMatchObject({
      dryRun: true,
      expired: 3,
      removable: 1,
      protected: 2,
      removed: 0,
      ids: [done.id],
    });
    // 预览零写：全部物理状态逐字相同。
    expect(diskState(f.h)).toBe(before);

    const traceCleanup = RuntimeStorageCleanupResultSchema.parse(
      await (await cleanupRequest(f.app, false, { category: "traces" })).json(),
    );
    expect(traceCleanup.removed).toBe(1);
    expect(traceSpanCount(f.h, "clean")).toBe(0);
    // 在跑（started）与未到期 trace 的行原封不动。
    expect(traceSpanCount(f.h, "protected")).toBe(1);
    expect(traceSpanCount(f.h, "live")).toBe(1);

    const contextCleanup = RuntimeStorageCleanupResultSchema.parse(
      await (await cleanupRequest(f.app, false, { category: "contexts" })).json(),
    );
    expect(contextCleanup.removed).toBe(1);
    const clearedContext = f.h.db
      .query(
        "SELECT status,protected_messages,protected_output,source_refs FROM context_snapshots WHERE step_id='step-clean'",
      )
      .get() as {
      status: string;
      protected_messages: string | null;
      protected_output: string | null;
      source_refs: string;
    };
    expect(clearedContext.status).toBe("expired");
    expect(clearedContext.protected_messages).toBeNull();
    expect(clearedContext.protected_output).toBeNull();
    // 来源引用身份保留，触发器把 decision 一并清掉。
    expect(JSON.parse(clearedContext.source_refs)).toHaveLength(1);
    expect(
      (
        f.h.db.query("SELECT decision FROM agent_steps WHERE step_id='step-clean'").get() as {
          decision: string | null;
        }
      ).decision,
    ).toBeNull();
    expect(
      (
        f.h.db
          .query("SELECT protected_messages FROM context_snapshots WHERE step_id='step-live'")
          .get() as {
          protected_messages: string | null;
        }
      ).protected_messages,
    ).not.toBeNull();

    const taskCleanup = RuntimeStorageCleanupResultSchema.parse(
      await (
        await cleanupRequest(f.app, false, {
          category: "task_payloads",
          ids: [done.id, "00000000-0000-4000-8000-000000000000"],
        })
      ).json(),
    );
    expect(taskCleanup).toMatchObject({ matched: 1, missing: 1, removed: 1, ids: [done.id] });
    const clearedTask = f.h.db
      .query("SELECT status,sources,expires_at FROM agent_tasks WHERE id=?")
      .get(done.id) as { status: string; sources: string; expires_at: string };
    expect(clearedTask.status).toBe("completed");
    expect(JSON.parse(clearedTask.sources)).toEqual([]);
    expect(clearedTask.expires_at).toBe(PAST);
    expect(
      f.h.db
        .query("SELECT arguments,result FROM agent_task_calls WHERE task_id=?")
        .get(done.id) as {
        arguments: string | null;
        result: string | null;
      },
    ).toEqual({ arguments: null, result: null });
    // 待批准与未知结果调用的 payload 与任务身份必须保留。
    for (const id of [waiting.id, unknownCall.id]) {
      const task = f.h.db.query("SELECT status FROM agent_tasks WHERE id=?").get(id) as {
        status: string;
      };
      expect(task.status).not.toBe("completed");
      const payloads = f.h.db
        .query(
          "SELECT COUNT(*) AS n FROM agent_task_calls WHERE task_id=? AND arguments IS NOT NULL",
        )
        .get(id) as { n: number };
      expect(payloads.n).toBeGreaterThan(0);
    }
    expect(
      (f.h.db.query("SELECT status FROM agent_tasks WHERE id=?").get(live.id) as { status: string })
        .status,
    ).toBe("queued");
  });

  it("rejects empty selections and the client's own clock", async () => {
    const f = setup();
    for (const category of ["traces", "contexts", "task_payloads"]) {
      expect((await cleanupRequest(f.app, true, { category, ids: [] })).status).toBe(422);
      expect((await cleanupRequest(f.app, false, { category, ids: [] })).status).toBe(422);
    }
    expect((await cleanupRequest(f.app, true, {})).status).toBe(422);
    // body 里不能自带时钟：到期只由服务端 now 判定。
    expect((await cleanupRequest(f.app, true, { category: "traces", now: PAST })).status).toBe(422);
    expect(
      (
        await f.app.request(
          "/v2/observability/storage/items?category=traces&now=2000-01-01T00:00:00Z",
        )
      ).status,
    ).toBe(422);
    expect(
      (await f.app.request("/v2/observability/storage/items?category=traces&limit=201")).status,
    ).toBe(422);
    // 非法游标不静默回到第一页；数值边界与任务 JSON 游标形状同样是 422。
    expect(
      (await f.app.request("/v2/observability/storage/items?category=traces&cursor=abc")).status,
    ).toBe(422);
    expect(
      (await f.app.request("/v2/observability/storage/items?category=traces&cursor=1e3")).status,
    ).toBe(422);
    expect(
      (await f.app.request("/v2/observability/storage/items?category=task_payloads&cursor=nope"))
        .status,
    ).toBe(422);
    const page = await f.app.request("/v2/observability/storage/items?category=traces");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
  });

  it("requires the same-origin management guard", async () => {
    const f = setup();
    const crossOrigin = await f.app.request("/v2/observability/storage", {
      headers: { origin: "https://evil.example" },
    });
    expect(crossOrigin.status).toBe(403);
    const crossSite = await f.app.request("/v2/observability/storage/items?category=traces", {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    const write = await f.app.request("/v2/observability/storage/cleanup/preview", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ category: "traces" }),
    });
    expect(write.status).toBe(422);
  });

  it("keeps the existing physical sweep independent of manual cleanup", () => {
    const f = setup();
    insertSpan(f.h, {
      traceId: "sweep-expired",
      spanId: "sweep-1",
      status: "completed",
      expiresAt: PAST,
    });
    insertSpan(f.h, {
      traceId: "sweep-live",
      spanId: "sweep-2",
      status: "started",
      expiresAt: FUTURE,
    });
    // 与手动清理同一保全判定：started/unknown 的行不因到期被自动清扫。
    insertSpan(f.h, {
      traceId: "sweep-started",
      spanId: "sweep-3",
      status: "started",
      expiresAt: PAST,
    });
    insertSpan(f.h, {
      traceId: "sweep-unknown",
      spanId: "sweep-4",
      status: "unknown",
      expiresAt: PAST,
    });
    f.telemetry.expire();
    expect(traceSpanCount(f.h, "sweep-expired")).toBe(0);
    expect(traceSpanCount(f.h, "sweep-live")).toBe(1);
    expect(traceSpanCount(f.h, "sweep-started")).toBe(1);
    expect(traceSpanCount(f.h, "sweep-unknown")).toBe(1);
  });
});

describe("automatic expiry protection", () => {
  it("keeps a trace that is already past its source TTL while it is still running", () => {
    const f = setup();
    const expiry = new Date(NOW - 60_000).toISOString();
    const root = f.telemetry.start("late", {
      channel: "onebot11",
      stage: "run",
      sources: [{ kind: "qq_observation", id: "late-source", revision: "1", expiresAt: expiry }],
    });
    // 出生即到期的在跑 trace：started 行仍写入并受保护，停止后才被物理清扫。
    f.telemetry.expire();
    expect(traceSpanCount(f.h, root.traceId)).toBe(1);
    root.end();
    f.telemetry.expire();
    expect(traceSpanCount(f.h, root.traceId)).toBe(0);
  });

  it("interrupts expired non-terminal tasks once and clears payload on the next pass", () => {
    const f = setup();
    const tasks = new AgentTaskRepository(f.h.db);
    const done = enqueueTask(f.h, f.conversation.id, { key: "auto-done", expiresAt: PAST });
    completeTask(f.h, done.id);
    const queued = enqueueTask(f.h, f.conversation.id, { key: "auto-queued", expiresAt: PAST });
    const waiting = enqueueTask(f.h, f.conversation.id, { key: "auto-waiting", expiresAt: PAST });
    f.h.db.query("UPDATE agent_tasks SET status='waiting_approval' WHERE id=?").run(waiting.id);
    f.h.db
      .query("UPDATE agent_task_calls SET status='waiting_approval' WHERE task_id=?")
      .run(waiting.id);
    const runningRead = enqueueTask(f.h, f.conversation.id, {
      key: "auto-running-read",
      expiresAt: PAST,
      at: new Date(NOW - 90_000).toISOString(),
    });
    f.h.db
      .query(
        "UPDATE agent_tasks SET status='running',lease_token='fixture',lease_expires_at=? WHERE id=?",
      )
      .run(FUTURE, runningRead.id);
    f.h.db
      .query("UPDATE agent_task_calls SET status='running',effect='read' WHERE task_id=?")
      .run(runningRead.id);
    const runningWrite = enqueueTask(f.h, f.conversation.id, {
      key: "auto-running-write",
      expiresAt: PAST,
      at: new Date(NOW - 80_000).toISOString(),
    });
    f.h.db
      .query(
        "UPDATE agent_tasks SET status='running',lease_token='fixture',lease_expires_at=? WHERE id=?",
      )
      .run(FUTURE, runningWrite.id);
    f.h.db
      .query("UPDATE agent_task_calls SET status='running' WHERE task_id=?")
      .run(runningWrite.id);
    const unknown = enqueueTask(f.h, f.conversation.id, {
      key: "auto-unknown",
      expiresAt: PAST,
      calls: 2,
    });
    f.h.db.query("UPDATE agent_tasks SET status='failed' WHERE id=?").run(unknown.id);
    f.h.db
      .query("UPDATE agent_task_calls SET status='unknown' WHERE task_id=? AND ordinal=1")
      .run(unknown.id);

    tasks.expire(new Date(NOW + 1000).toISOString());

    const payloadCalls = (id: string) =>
      (
        f.h.db
          .query(
            "SELECT COUNT(*) AS n FROM agent_task_calls WHERE task_id=? AND (arguments IS NOT NULL OR result IS NOT NULL)",
          )
          .get(id) as { n: number }
      ).n;
    const status = (id: string) =>
      (f.h.db.query("SELECT status FROM agent_tasks WHERE id=?").get(id) as { status: string })
        .status;
    const code = (id: string) =>
      (
        f.h.db.query("SELECT error_code AS code FROM agent_tasks WHERE id=?").get(id) as {
          code: string | null;
        }
      ).code;
    const callStatus = (id: string, ordinal: number) =>
      (
        f.h.db
          .query("SELECT status FROM agent_task_calls WHERE task_id=? AND ordinal=?")
          .get(id, ordinal) as { status: string }
      ).status;

    // 终态且无保全调用的任务照旧在本相位清 payload，身份（状态）保留。
    expect(payloadCalls(done.id)).toBe(0);
    expect(status(done.id)).toBe("completed");
    // 到期非终态：本相位安全 interrupt → failed/TASK_EXPIRED（running write → unknown），
    // 但物理 payload 在本相位仍保全，不能被同一相位清掉。
    expect(status(queued.id)).toBe("failed");
    expect(code(queued.id)).toBe("TASK_EXPIRED");
    expect(payloadCalls(queued.id)).toBeGreaterThan(0);
    expect(status(waiting.id)).toBe("failed");
    expect(code(waiting.id)).toBe("TASK_EXPIRED");
    expect(callStatus(waiting.id, 0)).toBe("failed");
    expect(payloadCalls(waiting.id)).toBeGreaterThan(0);
    expect(status(runningRead.id)).toBe("failed");
    expect(code(runningRead.id)).toBe("TASK_EXPIRED");
    expect(callStatus(runningRead.id, 0)).toBe("failed");
    expect(payloadCalls(runningRead.id)).toBeGreaterThan(0);
    expect(status(runningWrite.id)).toBe("unknown");
    expect(code(runningWrite.id)).toBe("TASK_EXPIRED");
    expect(callStatus(runningWrite.id, 0)).toBe("unknown");
    expect(payloadCalls(runningWrite.id)).toBeGreaterThan(0);
    // unknown 调用恒保 payload，且不会被重放/再次改写。
    expect(payloadCalls(unknown.id)).toBe(2);
    expect(status(unknown.id)).toBe("failed");

    // 过期任务不再占活动状态：同一会话的新任务照常入队并被领取（busy guard 只看未终态）。
    const fresh = enqueueTask(f.h, f.conversation.id, {
      key: "auto-fresh",
      expiresAt: FUTURE,
      at: new Date(NOW).toISOString(),
    });
    expect(tasks.claim(new Date(NOW + 1000).toISOString(), 30_000)?.id).toBe(fresh.id);

    // 下一 pass：已终态且无 unknown 调用的任务才清 payload；unknown 与 running write→unknown 恒保。
    tasks.expire(new Date(NOW + 2000).toISOString());
    expect(payloadCalls(queued.id)).toBe(0);
    expect(status(queued.id)).toBe("failed");
    expect(payloadCalls(waiting.id)).toBe(0);
    expect(payloadCalls(runningRead.id)).toBe(0);
    expect(payloadCalls(runningWrite.id)).toBeGreaterThan(0);
    expect(payloadCalls(unknown.id)).toBe(2);
  });
});
