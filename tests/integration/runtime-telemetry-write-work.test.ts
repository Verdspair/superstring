import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

function setup(options: { retentionDays?: () => number } = {}) {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "fixture");
  const telemetry = new RuntimeTelemetry(
    h.db,
    options.retentionDays ? { retentionDays: options.retentionDays } : {},
  );
  cleanups.push(async () => {
    await telemetry.close();
    h.close();
  });
  return { h, telemetry };
}

interface RecordedStatement {
  sql: string;
  op: "get" | "all" | "run";
  args: unknown[];
  changes?: number;
}

const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** Capture executed SQL and UPDATE change counts without changing results. */
function instrument(db: Database) {
  const original = db.query.bind(db);
  const records: RecordedStatement[] = [];
  (db as unknown as { query: (sql: string) => unknown }).query = (sql: string) => {
    const statement = original(sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "get" || property === "all" || property === "run") {
          return (...args: unknown[]) => {
            const result = (value as (...values: unknown[]) => unknown).apply(target, args);
            records.push({
              sql: normalize(sql),
              op: property as "get" | "all" | "run",
              args,
              changes:
                property === "run"
                  ? Number((result as { changes?: number }).changes ?? 0)
                  : undefined,
            });
            return result;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return {
    records,
    restore: () => {
      (db as unknown as { query: typeof original }).query = original;
    },
  };
}

const expiries = (h: ReturnType<typeof openBusinessDb>, traceId: string) =>
  (
    h.db
      .query("SELECT DISTINCT expires_at AS at FROM runtime_spans WHERE trace_id=? ORDER BY at")
      .all(traceId) as { at: string }[]
  ).map((row) => row.at);

const spanCount = (h: ReturnType<typeof openBusinessDb>, traceId: string) =>
  (
    h.db.query("SELECT COUNT(*) AS n FROM runtime_spans WHERE trace_id=?").get(traceId) as {
      n: number;
    }
  ).n;

const startedAt = (h: ReturnType<typeof openBusinessDb>, spanId: string) =>
  (
    h.db.query("SELECT started_at AS at FROM runtime_spans WHERE span_id=?").get(spanId) as {
      at: string;
    }
  ).at;

const aggregateRecords = (records: RecordedStatement[]) =>
  records.filter((record) => record.sql.startsWith("SELECT MIN(expires_at)"));
const updateRecords = (records: RecordedStatement[]) =>
  records.filter((record) => record.sql.startsWith("UPDATE runtime_spans SET expires_at="));

const CONDITIONAL_UPDATE =
  "UPDATE runtime_spans SET expires_at=? WHERE trace_id=? AND expires_at>?";

describe("runtime telemetry write work", () => {
  it("retains trace-wide expiry checks and avoids steady-state rewrites", () => {
    const f = setup();
    const probe = instrument(f.h.db);
    const root = f.telemetry.start("root", { channel: "web", stage: "run" });
    root.within(() => {
      for (let index = 0; index < 6; index++) {
        const child = f.telemetry.start("child", { channel: "web", stage: "model" });
        child.update({ details: { index } });
        child.end("completed");
      }
    });
    root.end("completed");
    probe.restore();

    // 1 root start + 6 * (start, update, end) + 1 root end.
    expect(spanCount(f.h, root.traceId)).toBe(7);
    expect(expiries(f.h, root.traceId)).toHaveLength(1);

    const aggregates = aggregateRecords(probe.records);
    expect(aggregates).toHaveLength(20);
    for (const record of aggregates) {
      expect(record.sql).toBe(
        "SELECT MIN(expires_at) AS expiry,COALESCE(MAX(status IN('started','unknown')),0) AS protected FROM runtime_spans WHERE trace_id=?",
      );
      expect(record.args).toEqual([root.traceId]);
    }

    const updates = updateRecords(probe.records);
    expect(updates).toHaveLength(20);
    for (const record of updates) {
      expect(record.sql).toBe(CONDITIONAL_UPDATE);
      expect(record.changes).toBe(0);
    }
  });

  it("propagates an earlier source lifetime with one conditional update", () => {
    const f = setup();
    const longSource = new Date(Date.now() + 120_000).toISOString();
    const shortSource = new Date(Date.now() + 60_000).toISOString();
    const probe = instrument(f.h.db);
    const root = f.telemetry.start("source-root", {
      channel: "onebot11",
      stage: "run",
      sources: [{ kind: "qq_observation", id: "long", revision: "1", expiresAt: longSource }],
    });
    root.within(() => {
      const child = f.telemetry.start("source-child", {
        channel: "onebot11",
        stage: "model",
        sources: [{ kind: "qq_observation", id: "short", revision: "1", expiresAt: shortSource }],
      });
      child.end("completed");
    });
    root.end("completed");
    probe.restore();

    expect(expiries(f.h, root.traceId)).toEqual([shortSource]);
    expect(spanCount(f.h, root.traceId)).toBe(2);
    const updates = updateRecords(probe.records);
    expect(updates.every((record) => record.sql === CONDITIONAL_UPDATE)).toBe(true);
    expect(updates.reduce((sum, record) => sum + (record.changes ?? 0), 0)).toBe(1);
  });

  it("keeps the earliest expiry and started/unknown protection across users", () => {
    const f = setup();
    f.h.db
      .query("INSERT INTO users(id,name,created_at) VALUES('other-user','other',?)")
      .run(new Date().toISOString());
    const rootExpiry = new Date(Date.now() - 60_000).toISOString();
    const otherExpiry = new Date(Date.now() - 120_000).toISOString();
    const probe = instrument(f.h.db);

    const root = f.telemetry.start("mixed-root", {
      channel: "web",
      stage: "run",
      sources: [{ kind: "qq_observation", id: "root", revision: "1", expiresAt: rootExpiry }],
    });
    root.within(() => {
      const other = f.telemetry.start("mixed-other", {
        channel: "web",
        stage: "model",
        userId: "other-user",
        sources: [{ kind: "qq_observation", id: "other", revision: "1", expiresAt: otherExpiry }],
      });
      other.end("completed");
    });
    root.end("completed");

    // A recovered in-flight span from the other principal, as recover() would leave it.
    f.h.db
      .query(`INSERT INTO runtime_spans(trace_id,span_id,parent_span_id,name,user_id,agent_id,conversation_id,run_id,wake_id,output_id,source_seq,channel,stage,status,code,model,started_at,finished_at,duration_ms,expires_at,details)
        VALUES(?,?,?,'recovered','other-user',NULL,NULL,NULL,NULL,NULL,NULL,'web','run','unknown','PROCESS_INTERRUPTED',NULL,?,NULL,NULL,?,'{}')`)
      .run(root.traceId, "mixed-unknown", root.spanId, rootExpiry, otherExpiry);

    const continuation = f.telemetry.start("mixed-continuation", {
      channel: "web",
      stage: "run",
      parent: { traceId: root.traceId, spanId: root.spanId },
      sources: [{ kind: "qq_observation", id: "cont", revision: "1", expiresAt: otherExpiry }],
    });
    continuation.update({ status: "completed" });
    continuation.end("completed");

    // All rows share the earliest source lifetime, including both users.
    expect(expiries(f.h, root.traceId)).toEqual([otherExpiry]);
    expect(spanCount(f.h, root.traceId)).toBe(4);

    // The mixed trace never uses the single-user covering aggregate.
    const tracedAggregates = aggregateRecords(probe.records).filter((record) =>
      record.args.includes(root.traceId),
    );
    expect(tracedAggregates.length).toBeGreaterThan(0);
    expect(tracedAggregates.every((record) => !record.sql.includes("INDEXED BY"))).toBe(true);

    // Control: the same terminal sequence without the other principal's unknown row
    // reaches the delete branch and removes the trace.
    const controlRoot = f.telemetry.start("control-root", {
      channel: "web",
      stage: "run",
      sources: [{ kind: "qq_observation", id: "control", revision: "1", expiresAt: rootExpiry }],
    });
    controlRoot.end("completed");
    const control = f.telemetry.start("control-continuation", {
      channel: "web",
      stage: "run",
      parent: { traceId: controlRoot.traceId, spanId: controlRoot.spanId },
      sources: [{ kind: "qq_observation", id: "control-2", revision: "1", expiresAt: rootExpiry }],
    });
    control.update({ status: "completed" });
    control.end("completed");
    probe.restore();
    expect(spanCount(f.h, controlRoot.traceId)).toBe(0);
  });

  it("preserves cap freeze, resumed expiry and started/unknown protection", async () => {
    let days = 14;
    const f = setup({ retentionDays: () => days });
    const root = f.telemetry.start("freeze-root", { channel: "web", stage: "run" });
    const cap = new Date(Date.parse(startedAt(f.h, root.spanId)) + 14 * 86_400_000).toISOString();
    expect(expiries(f.h, root.traceId)).toEqual([cap]);

    days = 1;
    root.update({ code: "CHANGED" });
    expect(expiries(f.h, root.traceId)).toEqual([cap]);
    root.end("completed");
    expect(expiries(f.h, root.traceId)).toEqual([cap]);

    const restarted = new RuntimeTelemetry(f.h.db, { retentionDays: () => 1 });
    try {
      const resumed = restarted.start("resume", {
        channel: "web",
        stage: "run",
        parent: { traceId: root.traceId, spanId: root.spanId },
      });
      resumed.end("completed");
    } finally {
      await restarted.close();
    }
    expect(expiries(f.h, root.traceId)).toEqual([cap]);
    expect(spanCount(f.h, root.traceId)).toBe(2);

    const now = new Date().toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const late = f.telemetry.start("protected", {
      channel: "onebot11",
      stage: "run",
      sources: [{ kind: "qq_observation", id: "late", revision: "1", expiresAt: past }],
    });
    f.telemetry.expire(now);
    expect(spanCount(f.h, late.traceId)).toBe(1);
    late.end("completed");
    f.telemetry.expire(now);
    expect(spanCount(f.h, late.traceId)).toBe(0);
  });
});
