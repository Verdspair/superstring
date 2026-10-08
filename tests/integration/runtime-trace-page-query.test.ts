import { afterEach, describe, expect, it } from "bun:test";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { RuntimeSpanRepository } from "../../src/server/observability/span-repository";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "fixture");
  const telemetry = new RuntimeTelemetry(h.db);
  const repository = new RuntimeSpanRepository(h.db);
  cleanups.push(async () => {
    await telemetry.close();
    h.close();
  });
  return { h, telemetry, repository };
}

function countQueries(db: ReturnType<typeof openBusinessDb>["db"]) {
  const counts = { statements: 0, rows: 0 };
  const query = db.query.bind(db);
  const observed = new Proxy(db, {
    get(target, key, receiver) {
      if (key !== "query") return Reflect.get(target, key, receiver);
      return (sql: string) => {
        counts.statements++;
        const statement = query(sql);
        return new Proxy(statement, {
          get(current, method, statementReceiver) {
            const value = Reflect.get(current, method, statementReceiver);
            if (method === "all" || method === "get") {
              return (...values: unknown[]) => {
                const result = value.apply(current, values);
                counts.rows += method === "all" ? result.length : result ? 1 : 0;
                return result;
              };
            }
            return typeof value === "function" ? value.bind(current) : value;
          },
        });
      };
    },
  });
  return { db: observed, counts };
}

describe("runtime trace page query", () => {
  it("loads full visible traces for a page in a fixed number of reads and preserves per-trace results", () => {
    const { h, telemetry } = setup();
    const spans = new RuntimeSpanRepository(h.db);
    for (let index = 0; index < 100; index++) {
      const root = telemetry.start(`root-${index}`, { channel: "web", stage: "run" });
      root.within(() => {
        telemetry.record("synthetic-trigger", {
          channel: "web",
          stage: "wake",
          details: { cause: `cause-${index % 5}` },
        });
        telemetry.record("synthetic-detail", {
          channel: "web",
          stage: "context",
          model: `model-${index % 3}`,
        });
      });
      root.end(index % 11 === 0 ? "failed" : "completed");
    }

    const { db, counts } = countQueries(h.db);
    const repository = new RuntimeSpanRepository(db);
    const page = repository.traces({ stage: "wake", limit: 100 }, DEFAULT_USER_ID);
    expect(counts.statements).toBe(3);
    expect(counts.rows).toBe(401);
    expect(page.items).toHaveLength(100);
    expect(page.hasMore).toBe(false);
    expect(page.summary).toMatchObject({ totalTraces: 100, failedTraces: 10, matchedSpans: 100 });
    expect(page.nextBeforeId).toBe(page.items.at(-1)?.cursorId ?? 0);
    expect(page.items.every((trace) => trace.spanCount === 3 && trace.matchedSpanCount === 1)).toBe(
      true,
    );

    for (const trace of page.items) {
      const originalPerTrace = spans.waterfall(trace.traceId, { stage: "wake" }, DEFAULT_USER_ID);
      expect(originalPerTrace).not.toBeNull();
      expect(trace).toEqual(originalPerTrace!.trace);
    }
    const next = repository.traces(
      { stage: "wake", limit: 37, beforeId: page.items[36]!.cursorId },
      DEFAULT_USER_ID,
    );
    expect(next.items).toHaveLength(37);
    expect(next.items.every((trace) => trace.cursorId < page.items[36]!.cursorId)).toBe(true);
    expect({ ...next.summary, now: page.summary.now }).toEqual(page.summary);

    counts.statements = 0;
    const empty = repository.traces({ q: "not-present", limit: 100 }, DEFAULT_USER_ID);
    expect(counts.statements).toBe(2);
    expect(empty.items).toEqual([]);
    expect(empty.hasMore).toBe(false);
    expect(empty.summary).toMatchObject({ totalTraces: 0, matchedSpans: 0 });
  });

  it("keeps expiry, user, and source ownership filters on the batched span read", () => {
    const { h, telemetry, repository } = setup();
    const now = new Date().toISOString();
    const expired = telemetry.start("expired", { channel: "web", stage: "run" });
    expired.end("completed");
    h.db
      .query("UPDATE runtime_spans SET expires_at=? WHERE trace_id=?")
      .run(new Date(Date.now() - 1000).toISOString(), expired.traceId);

    h.db
      .query("INSERT INTO users(id,name,created_at) VALUES(?,?,?)")
      .run("someone-else", "other", now);
    telemetry.record("private-user", {
      channel: "web",
      stage: "run",
      userId: "someone-else",
    });

    const session = createSession(h.orm, "fixture", { modelName: "fixture" });
    const conversation = new ConversationEventRepository(h.db).ensureWeb(session.id)!;
    telemetry.record("bound-source", {
      channel: "web",
      stage: "run",
      conversationId: conversation.id,
      agentId: DEFAULT_AGENT_ID,
    });
    h.db.query("DELETE FROM sessions WHERE id=?").run(session.id);

    const visible = telemetry.start("visible", { channel: "web", stage: "run" });
    visible.end("completed");
    const page = repository.traces({}, DEFAULT_USER_ID, now);
    expect(page.items.map((trace) => trace.traceId)).toEqual([visible.traceId]);
    expect(page.items.some((trace) => trace.traceId === expired.traceId)).toBe(false);
    expect(page.items.some((trace) => trace.traceId === conversation.id)).toBe(false);
    expect(page.summary).toMatchObject({ totalTraces: 1, matchedSpans: 1 });
  });
});
