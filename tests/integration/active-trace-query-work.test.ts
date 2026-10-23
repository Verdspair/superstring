import type { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { RuntimeSpanRepository } from "../../src/server/observability/span-repository";
import type { RuntimeSpanFilters } from "../../src/shared/contracts/runtime-observability";
import { cloneBusinessDb } from "../harness/business-db";

const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
const now = "2026-10-16T12:00:00.000Z";
const expiry = "2099-01-01T00:00:00.000Z";

function fixture() {
  const h = cloneBusinessDb();
  closes.push(() => h.close());
  ensureDefaults(h.orm, now);
  const session = createSession(h.orm, "active-trace-fixture", { modelName: "fixture" });
  const conversation = new ConversationEventRepository(h.db).ensureWeb(session.id)!;
  const insert = (
    traceId: string,
    status: string,
    options: {
      conversationId?: string | null;
      expiresAt?: string;
      parentSpanId?: string;
      name?: string;
      stage?: string;
      model?: string;
    } = {},
  ) => {
    const spanId = crypto.randomUUID().replaceAll("-", "");
    h.db
      .query(`INSERT INTO runtime_spans
      (trace_id,span_id,parent_span_id,name,user_id,agent_id,conversation_id,channel,stage,status,code,model,started_at,finished_at,duration_ms,expires_at,details)
      VALUES(?,?,?,?,?,?,?,'web',?,?,'fixture',?,?,?,NULL,?,'{}')`)
      .run(
        traceId,
        spanId,
        options.parentSpanId ?? null,
        options.name ?? "needle",
        DEFAULT_USER_ID,
        DEFAULT_AGENT_ID,
        options.conversationId === undefined ? conversation.id : options.conversationId,
        options.stage ?? "model",
        status,
        options.model ?? "fixture-model",
        now,
        status === "started" ? null : now,
        options.expiresAt ?? expiry,
      );
    return spanId;
  };
  h.db.transaction(() => {
    for (let index = 0; index < 1500; index++) insert(`history-${index}`, "completed");
  })();
  const root = insert("active-a", "completed", { name: "root-a", stage: "run" });
  insert("active-a", "started", { parentSpanId: root });
  insert("active-a", "failed", { parentSpanId: root, name: "failed-sibling", stage: "action" });
  insert("active-a", "started", { parentSpanId: root, expiresAt: "2020-01-01T00:00:00.000Z" });
  insert("active-b", "started");
  insert("expired-only", "started", { expiresAt: "2020-01-01T00:00:00.000Z" });
  const staleSession = createSession(h.orm, "stale-source", { modelName: "fixture" });
  const staleConversation = new ConversationEventRepository(h.db).ensureWeb(staleSession.id)!;
  insert("stale-source", "started", { conversationId: staleConversation.id });
  insert("active-a", "started", { conversationId: staleConversation.id, parentSpanId: root });
  h.db.query("DELETE FROM sessions WHERE id=?").run(staleSession.id);
  return { h, conversation, repository: new RuntimeSpanRepository(h.db) };
}

function observe(db: Database) {
  const query = db.query.bind(db);
  const calls: { sql: string; plan: string[] }[] = [];
  const observed = new Proxy(db, {
    get(target, key) {
      if (key !== "query") {
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const statement = query(sql);
        return new Proxy(statement, {
          get(current, method) {
            const value = Reflect.get(current, method, current);
            if (method === "get" || method === "all") {
              return (...args: unknown[]) => {
                const explain = query(`EXPLAIN QUERY PLAN ${sql}`);
                const rows = Reflect.apply(explain.all, explain, args) as { detail: string }[];
                calls.push({ sql, plan: rows.map((row) => row.detail) });
                return Reflect.apply(value, current, args);
              };
            }
            return typeof value === "function" ? value.bind(current) : value;
          },
        });
      };
    },
  });
  return { db: observed, calls };
}

it("seeds status candidates through covering ids before the shared group read", () => {
  const f = fixture();
  const observed = observe(f.h.db);
  const page = new RuntimeSpanRepository(observed.db).traces(
    { conversationId: f.conversation.id, status: "started", limit: 1 },
    DEFAULT_USER_ID,
    now,
  );
  expect(page.items).toHaveLength(1);
  expect(observed.calls).toHaveLength(2);
  for (const call of observed.calls.slice(0, 1)) {
    expect(
      call.plan.some((detail) => /USING COVERING INDEX idx_runtime_spans_filter/.test(detail)),
    ).toBe(true);
    expect(
      call.plan.some((detail) => /SEARCH s USING INTEGER PRIMARY KEY.*rowid=\?/.test(detail)),
    ).toBe(true);
  }
  observed.calls.length = 0;
  const empty = new RuntimeSpanRepository(observed.db).traces(
    { status: "unknown", conversationId: f.conversation.id },
    DEFAULT_USER_ID,
    now,
  );
  expect(empty.items).toEqual([]);
  expect(empty.summary).toMatchObject({ totalTraces: 0, matchedSpans: 0 });
  expect(observed.calls).toHaveLength(1);
});

it("retains full visible siblings, exact combined matches, expiry, ownership and whole-trace cursors", () => {
  const { repository, conversation } = fixture();
  const filters: RuntimeSpanFilters = {
    conversationId: conversation.id,
    status: "started",
    stage: "model",
    channel: "web",
    model: "fixture-model",
    agentId: DEFAULT_AGENT_ID,
    q: "needle",
    from: now,
    to: now,
    limit: 1,
  };
  const first = repository.traces(filters, DEFAULT_USER_ID, now);
  expect(first.items.map((item) => item.traceId)).toEqual(["active-b"]);
  expect(first.summary).toMatchObject({ totalTraces: 2, activeTraces: 2, matchedSpans: 2 });
  expect(first.hasMore).toBe(true);
  const second = repository.traces(
    { ...filters, beforeId: first.nextBeforeId },
    DEFAULT_USER_ID,
    now,
  );
  expect(second.items.map((item) => item.traceId)).toEqual(["active-a"]);
  expect(second.summary).toEqual(first.summary);
  expect(second.hasMore).toBe(false);
  const detail = repository.waterfall("active-a", filters, DEFAULT_USER_ID, now);
  if (!detail) throw new Error("fixture trace missing");
  expect(second.items[0]).toEqual(detail.trace);
  expect(second.items[0]).toMatchObject({ spanCount: 3, matchedSpanCount: 1, status: "started" });
  expect(second.items[0].root.name).toBe("root-a");
  expect(second.nextBeforeId).toBe(detail.items[0].id);
  const failed = repository.traces({ status: "failed", q: "failed-sibling" }, DEFAULT_USER_ID, now);
  expect(failed.items.map((item) => item.traceId)).toEqual(["active-a"]);
  expect(failed.items[0]).toMatchObject({ spanCount: 3, matchedSpanCount: 1, status: "started" });
  expect(
    repository.traces({ ...filters, q: "failed-sibling" }, DEFAULT_USER_ID, now).items,
  ).toEqual([]);
  expect(
    repository.traces({ traceId: "active-a", status: "started" }, DEFAULT_USER_ID, now).items[0],
  ).toEqual(detail.trace);
  expect(repository.traces({ traceId: "active-a" }, DEFAULT_USER_ID, now).items[0].spanCount).toBe(
    3,
  );
});
