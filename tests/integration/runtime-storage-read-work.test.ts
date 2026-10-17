import { afterEach, describe, expect, it } from "bun:test";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { RuntimeSpanRepository } from "../../src/server/observability/span-repository";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const now = "2030-01-01T00:00:00.000Z";
function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "synthetic");
  h.db.query("INSERT INTO users(id,name,created_at) VALUES('other-user','synthetic',?)").run(now);
  const repo = new RuntimeSpanRepository(h.db);
  const seed = (
    trace: string,
    span: string,
    expiry: string,
    status = "completed",
    user = DEFAULT_USER_ID,
  ) => {
    h.db
      .query(
        `INSERT INTO runtime_spans(trace_id,span_id,name,user_id,agent_id,channel,stage,status,code,started_at,expires_at,details) VALUES(?,?,'synthetic',?,?,'web','run',?,'SYNTHETIC',?,?,'{}')`,
      )
      .run(trace, span, user, DEFAULT_AGENT_ID, status, now, expiry);
  };
  return { h, repo, seed };
}
describe("runtime storage metadata read work", () => {
  it("keeps full siblings, exact expiry/status, principal scope and stable creation cursors", () => {
    const { repo, seed } = setup();
    seed("old", "old-root", "2099-01-01T00:00:00.000Z");
    seed("expired", "expired-root", now);
    seed("unknown", "unknown-root", "2099-01-01T00:00:00.000Z", "unknown");
    seed("foreign", "foreign-root", now, "failed", "other-user");
    seed("old", "old-late", "2099-01-01T00:00:00.000Z", "failed");
    expect(repo.storageCounts(now)).toEqual({
      traces: { live: 2, expired: 1, started: 0, unknown: 1 },
      spans: { live: 3, expired: 1 },
    });
    const first = repo.storageItems({ status: "all", limit: 2 }, now);
    expect(first.items.map((x) => x.traceId)).toEqual(["unknown", "expired"]);
    expect(first.summary).toEqual({ total: 3, live: 2, expired: 1 });
    expect(first.hasMore).toBe(true);
    const second = repo.storageItems(
      { status: "all", limit: 2, beforeId: first.nextBeforeId },
      now,
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({ traceId: "old", spanCount: 2, status: "failed" });
    expect(second.hasMore).toBe(false);
    expect(
      repo.storageItems({ status: "expired", limit: 2 }, now).items.map((x) => x.traceId),
    ).toEqual(["expired"]);
    expect(
      repo.storageItems({ status: "live", limit: 2 }, now).items.map((x) => x.traceId),
    ).toEqual(["unknown", "old"]);
    expect(repo.storageCounts(now, "other-user").traces).toEqual({
      live: 0,
      expired: 1,
      started: 0,
      unknown: 0,
    });
  });
  it("uses covering metadata for summary and restricts full aggregation to the selected page", () => {
    const { h, repo, seed } = setup();
    for (let i = 0; i < 120; i++) {
      seed(`trace-${i}`, `root-${i}`, "2099-01-01T00:00:00.000Z");
      seed(`trace-${i}`, `child-${i}`, "2099-01-01T00:00:00.000Z");
    }
    const query = h.db.query.bind(h.db);
    const executions: { sql: string; args: string[]; rows?: number }[] = [];
    h.db.query = ((sql: string) => {
      const st = query(sql);
      return new Proxy(st, {
        get(t, k) {
          const value = Reflect.get(t, k);
          if (k === "get" || k === "all")
            return (...args: string[]) => {
              const result = value.apply(t, args);
              executions.push({ sql, args, rows: k === "all" ? result.length : undefined });
              return result;
            };
          return typeof value === "function" ? value.bind(t) : value;
        },
      });
    }) as typeof h.db.query;
    const page = repo.storageItems({ status: "all", limit: 5 }, now);
    h.db.query = query;
    expect(page.items).toHaveLength(5);
    expect(page.items.every((x) => x.spanCount === 2)).toBe(true);
    const full = executions.find((x) => x.rows !== undefined);
    expect(full?.rows).toBe(6);
    if (!full) throw new Error("page statement missing");
    const plan = query(`EXPLAIN QUERY PLAN ${full.sql}`).all(...full.args) as { detail: string }[];
    expect(
      plan.some((x) => x.detail.includes("USING COVERING INDEX ix_runtime_storage_metadata")),
    ).toBe(true);
    expect(
      plan.some(
        (x) => x.detail.includes("idx_runtime_spans_trace") && x.detail.includes("trace_id=?"),
      ),
    ).toBe(true);
    const summary = executions.find((x) => x.rows === undefined);
    if (!summary) throw new Error("summary missing");
    expect(
      (
        query(`EXPLAIN QUERY PLAN ${summary.sql}`).all(...summary.args) as { detail: string }[]
      ).some((x) => x.detail.includes("USING COVERING INDEX ix_runtime_storage_metadata")),
    ).toBe(true);
  });
});
