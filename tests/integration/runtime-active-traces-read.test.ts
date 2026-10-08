import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  type ConversationChange,
  subscribeConversationChanges,
} from "../../src/server/conversation/conversation-changes";
import { createSession, DEFAULT_AGENT_ID, DEFAULT_USER_ID } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { RuntimeSpanRepository } from "../../src/server/observability/span-repository";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});
const at = "2026-10-08T12:00:00.000Z";
const expiry = "2099-01-01T00:00:00.000Z";
const userId = DEFAULT_USER_ID;
const filters = (conversationId: string, limit = 10, beforeId?: number) => ({
  conversationId,
  channel: "web" as const,
  stage: "model" as const,
  status: "started" as const,
  model: "fixture-model",
  limit,
  ...(beforeId === undefined ? {} : { beforeId }),
});
function fixture() {
  const h = openBusinessDb();
  handles.push(h);
  const makeConversation = (
    label: string,
    sessionId?: string,
    closedAt: string | null = null,
    bindingEpoch = 1,
  ) => {
    const sourceId = sessionId ?? createSession(h.orm, label, { modelName: "fixture" }).id;
    const id = crypto.randomUUID();
    h.db
      .query(
        "INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,created_at,updated_at,source_watermark,next_seq,closed_at) VALUES(?,'web','direct',?,?,?,?,?,?,0,1,?)",
      )
      .run(id, sourceId, DEFAULT_AGENT_ID, userId, bindingEpoch, at, at, closedAt);
    return { id, sourceId };
  };
  const current = makeConversation("current");
  const oldEpoch = makeConversation("old-epoch", current.sourceId, at, 2);
  const foreign = makeConversation("foreign");
  const spans = new RuntimeSpanRepository(h.db);
  const insert = (
    traceId: string,
    conv: string | null,
    status: string,
    stage: string,
    model: string | null = null,
    parentSpanId: string | null = null,
    expiresAt = expiry,
  ) => {
    const spanId = crypto.randomUUID().replaceAll("-", "");
    h.db
      .query(
        "INSERT INTO runtime_spans(trace_id,span_id,parent_span_id,name,user_id,agent_id,conversation_id,run_id,wake_id,output_id,source_seq,channel,stage,status,code,model,started_at,finished_at,duration_ms,expires_at,details) VALUES(?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,'web',?,?,'fixture',?,?,?, ?,?,'{}')",
      )
      .run(
        traceId,
        spanId,
        parentSpanId,
        stage,
        userId,
        DEFAULT_AGENT_ID,
        conv,
        stage,
        status,
        model,
        at,
        status === "started" ? null : at,
        status === "started" ? null : 1,
        expiresAt,
      );
    return spanId;
  };
  const activeTrace = (conversationId: string) => {
    const traceId = crypto.randomUUID().replaceAll("-", "");
    const root = insert(traceId, conversationId, "completed", "run");
    const activeChild = insert(traceId, conversationId, "started", "model", "fixture-model", root);
    insert(traceId, conversationId, "completed", "model", "fixture-model", root);
    insert(traceId, conversationId, "completed", "action", null, root);
    return { traceId, activeChild };
  };
  const currentActive = activeTrace(current.id);
  const historicActive = activeTrace(oldEpoch.id);
  activeTrace(foreign.id);
  const expiredTrace = crypto.randomUUID().replaceAll("-", "");
  insert(
    expiredTrace,
    current.id,
    "started",
    "model",
    "fixture-model",
    null,
    "2020-01-01T00:00:00.000Z",
  );
  for (let i = 0; i < 1200; i++) {
    const traceId = crypto.randomUUID().replaceAll("-", "");
    const root = insert(traceId, foreign.id, "completed", "run");
    insert(traceId, foreign.id, "completed", "model", "fixture-model", root);
  }
  return { h, spans, current, oldEpoch, currentActive, historicActive };
}

function legacyPage(f: ReturnType<typeof fixture>, query: ReturnType<typeof filters>) {
  const visibility = `s.user_id=? AND s.expires_at>? AND (s.conversation_id IS NULL OR EXISTS (
    SELECT 1 FROM conversations c WHERE c.id=s.conversation_id AND c.user_id=s.user_id AND
    ((c.channel='web' AND EXISTS(SELECT 1 FROM sessions x WHERE x.id=c.source_id AND x.agent_id=c.agent_id AND x.user_id=c.user_id)) OR
     (c.channel='onebot11' AND EXISTS(SELECT 1 FROM qq_bindings b WHERE b.id=c.source_id AND b.agent_id=c.agent_id)))))`;
  const conversation = `s.conversation_id IN(SELECT c.id FROM conversations c JOIN conversations anchor ON anchor.id=? WHERE c.channel=anchor.channel AND c.source_id=anchor.source_id AND c.agent_id=anchor.agent_id AND c.user_id=anchor.user_id)`;
  const matched = ["s.channel=?", "s.stage=?", "s.status=?", "s.model=?", conversation].join(
    " AND ",
  );
  const filterParams = [
    query.channel,
    query.stage,
    query.status,
    query.model,
    query.conversationId,
  ];
  const visibilityParams = [userId, at];
  const cte = `WITH groups AS MATERIALIZED (SELECT * FROM (SELECT s.trace_id AS traceId,MIN(s.id) AS cursorId,
    MAX(s.status='started') AS active,MAX(s.status='failed') AS failed,
    MAX(COALESCE(s.finished_at,s.started_at)) AS lastActivityAt,
    SUM(CASE WHEN ${matched} THEN 1 ELSE 0 END) AS matchedSpanCount
    FROM runtime_spans s WHERE ${visibility} GROUP BY s.trace_id) WHERE matchedSpanCount>0)`;
  const params = [...filterParams, ...visibilityParams];
  const summary = f.h.db
    .query(`${cte} SELECT COUNT(*) AS totalTraces,COALESCE(SUM(active),0) AS activeTraces,
    COALESCE(SUM(failed),0) AS failedTraces,COALESCE(SUM(matchedSpanCount),0) AS matchedSpans,MAX(lastActivityAt) AS lastActivityAt FROM groups`)
    .get(...params) as {
    totalTraces: number;
    activeTraces: number;
    failedTraces: number;
    matchedSpans: number;
    lastActivityAt: string | null;
  };
  const groups = f.h.db
    .query(`${cte} SELECT traceId,cursorId,matchedSpanCount FROM groups
    ${query.beforeId ? "WHERE cursorId<?" : ""} ORDER BY cursorId DESC LIMIT ?`)
    .all(...params, ...(query.beforeId ? [query.beforeId] : []), query.limit + 1) as {
    traceId: string;
    cursorId: number;
    matchedSpanCount: number;
  }[];
  const page = groups.slice(0, query.limit);
  const items = page.map(({ traceId }) => {
    const detail = f.spans.waterfall(traceId, query, userId, at);
    if (!detail) throw new Error("Reference trace disappeared");
    return detail.trace;
  });
  return {
    items,
    nextBeforeId: items.at(-1)?.cursorId ?? 0,
    hasMore: groups.length > query.limit,
    summary: { ...summary, now: at },
  };
}

describe("active conversation traces", () => {
  it("matches the former all-visible grouping result and keeps completed-root active-child hierarchy", () => {
    const f = fixture();
    const query = filters(f.current.id);
    const expected = legacyPage(f, query);
    const actual = f.spans.traces(query, userId, at);
    expect(actual).toEqual(expected);
    expect(actual.items.map((item) => item.traceId)).toContain(f.currentActive.traceId);
    expect(actual.items.map((item) => item.traceId)).toContain(f.historicActive.traceId);
    expect(actual.items.find((item) => item.traceId === f.currentActive.traceId)?.root.status).toBe(
      "completed",
    );
    expect(actual.items.find((item) => item.traceId === f.currentActive.traceId)?.spanCount).toBe(
      4,
    );
    expect(actual.summary).toMatchObject({
      totalTraces: 2,
      activeTraces: 2,
      matchedSpans: 2,
      now: at,
    });
    const first = f.spans.traces(filters(f.current.id, 1), userId, at);
    expect(first).toMatchObject({
      items: expected.items.slice(0, 1),
      hasMore: true,
      nextBeforeId: expected.items[0]?.cursorId,
    });
    const second = f.spans.traces(filters(f.current.id, 1, first.nextBeforeId), userId, at);
    expect(second.items).toEqual(expected.items.slice(1, 2));
  });

  it("publishes scoped child trace start and finish without requiring a model event", async () => {
    const f = fixture();
    f.h.db.query("DELETE FROM runtime_spans").run();
    const telemetry = new RuntimeTelemetry(f.h.db);
    const changes: ConversationChange[] = [];
    const unsubscribe = subscribeConversationChanges(f.h.db, (change) => changes.push(change));
    const root = telemetry.start("agent.run", {
      channel: "web",
      stage: "run",
      conversationId: f.current.id,
      agentId: DEFAULT_AGENT_ID,
      userId,
      details: { specId: "parent" },
    });
    root.end("completed");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    changes.length = 0;
    const child = telemetry.start("agent.run", {
      channel: "web",
      stage: "run",
      conversationId: f.current.id,
      agentId: DEFAULT_AGENT_ID,
      userId,
      parent: { traceId: root.traceId, spanId: root.spanId },
      details: { specId: "child" },
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.conversationId).toBe(f.current.id);
    expect(
      f.spans.traces({ conversationId: f.current.id, status: "started", limit: 10 }, userId, at)
        .items[0]?.status,
    ).toBe("started");
    child.end("completed");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(changes).toHaveLength(2);
    expect(
      f.spans.traces({ conversationId: f.current.id, status: "started", limit: 10 }, userId, at)
        .items,
    ).toHaveLength(0);
    unsubscribe();
    await telemetry.close();
  });

  it("uses the production candidate plan and compares results on a large unrelated history", () => {
    const f = fixture();
    const query = filters(f.current.id);
    const expected = legacyPage(f, query);
    const trace = spyOn(f.h.db, "query");
    const actual = f.spans.traces(query, userId, at);
    const groupedCall = trace.mock.calls.find(
      ([sql]) =>
        String(sql).startsWith("WITH candidates AS MATERIALIZED") &&
        String(sql).includes("matchedSpanCount"),
    );
    trace.mockRestore();
    expect(groupedCall).toBeDefined();
    if (!groupedCall) throw new Error("production candidate statement missing");
    const [sql, ...bindings] = groupedCall;
    const plan = f.h.db
      .query(`EXPLAIN QUERY PLAN ${String(sql)}`)
      .all(...(bindings as (string | number)[])) as { detail: string }[];
    expect(plan.some((row) => row.detail.includes("idx_runtime_spans_filter"))).toBe(true);
    expect(actual).toEqual(expected);
    const baselineTimes: number[] = [],
      optimizedTimes: number[] = [];
    for (let i = 0; i < 5; i++) {
      let start = performance.now();
      const baseline = legacyPage(f, query);
      baselineTimes.push(performance.now() - start);
      start = performance.now();
      const optimized = f.spans.traces(query, userId, at);
      optimizedTimes.push(performance.now() - start);
      expect(optimized).toEqual(baseline);
    }
    const median = (values: number[]) =>
      values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.info(
      "ACTIVE_TRACE_QUERY_BENCHMARK",
      JSON.stringify({
        fixtureSpans: 2410,
        baselineMedianMs: median(baselineTimes),
        optimizedMedianMs: median(optimizedTimes),
        baselineSamplesMs: baselineTimes,
        optimizedSamplesMs: optimizedTimes,
        candidatePlan: plan.map((row) => row.detail),
      }),
    );
  });
});
