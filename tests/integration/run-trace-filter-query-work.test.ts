import type { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { RuntimeSpanRepository } from "../../src/server/observability/span-repository";
import { cloneBusinessDb } from "../harness/business-db";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function fixture() {
  const h = cloneBusinessDb();
  ensureDefaults(h.orm, "fixture");
  const telemetry = new RuntimeTelemetry(h.db);
  cleanups.push(async () => {
    await telemetry.close();
    h.close();
  });
  const runId = crypto.randomUUID();
  new AgentRunRepository(h.db).createRun({
    runId,
    specId: "test.target",
    specVersion: "1",
    owner: { kind: "fixture", id: "fixture", userId: DEFAULT_USER_ID, agentId: DEFAULT_AGENT_ID },
    at: new Date().toISOString(),
  });
  const root = telemetry.start("target-root", { channel: "web", stage: "run" });
  root.within(() => {
    telemetry.record("needle-match", { channel: "web", stage: "model", runId, model: "model-a" });
    telemetry.record("failed-sibling", {
      channel: "web",
      stage: "action",
      status: "failed",
      code: "FIXTURE_FAILURE",
    });
  });
  root.end("completed");
  for (let i = 0; i < 1000; i++) telemetry.record("unrelated", { channel: "web", stage: "run" });
  return { h, runId, root, telemetry };
}
function observedPlans(db: Database) {
  const query = db.query.bind(db);
  const plans: string[] = [];
  const proxy = new Proxy(db, {
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
            if (method === "get" || method === "all")
              return (...args: unknown[]) => {
                const plan = Reflect.apply(
                  query("EXPLAIN QUERY PLAN " + sql).all,
                  query("EXPLAIN QUERY PLAN " + sql),
                  args,
                ) as { detail: string }[];
                plans.push(...plan.map((x) => x.detail));
                return Reflect.apply(value, current, args);
              };
            return typeof value === "function" ? value.bind(current) : value;
          },
        });
      };
    },
  });
  return { db: proxy, plans };
}
it("run-filtered traces use the run index before grouping while keeping the full visible trace", () => {
  const { h, runId, root } = fixture();
  const observed = observedPlans(h.db);
  const repository = new RuntimeSpanRepository(observed.db);
  const now = new Date().toISOString();
  const page = repository.traces({ runId, limit: 1 }, DEFAULT_USER_ID, now);
  expect(page.items).toHaveLength(1);
  expect(page.items[0].traceId).toBe(root.traceId);
  expect(page.items[0].spanCount).toBe(3);
  expect(page.items[0].matchedSpanCount).toBe(1);
  expect(page.items[0].status).toBe("failed");
  expect(page.summary).toMatchObject({ totalTraces: 1, failedTraces: 1, matchedSpans: 1 });
  expect(
    observed.plans.some(
      (detail) => detail.includes("idx_runtime_spans_run") && detail.includes("run_id=?"),
    ),
  ).toBe(true);
  const detail = repository.waterfall(root.traceId, { runId }, DEFAULT_USER_ID, now);
  if (!detail) throw new Error("Fixture trace must remain visible");
  expect(page.items[0]).toEqual(detail.trace);
});
it("combined span filters retain sibling status and the whole-trace pagination cursor", () => {
  const { h, runId, root } = fixture();
  const repository = new RuntimeSpanRepository(h.db);
  const now = new Date().toISOString();
  const page = repository.traces(
    { runId, stage: "model", channel: "web", q: "needle", limit: 10 },
    DEFAULT_USER_ID,
    now,
  );
  expect(page.items).toHaveLength(1);
  const trace = page.items[0];
  expect(trace.root.name).toBe("target-root");
  expect(trace.spanCount).toBe(3);
  expect(trace.status).toBe("failed");
  expect(trace.matchedSpanCount).toBe(1);
  expect(
    repository.traces({ runId, beforeId: trace.cursorId, limit: 10 }, DEFAULT_USER_ID, now).items,
  ).toEqual([]);
  expect(
    repository.traces({ runId, stage: "sticker", limit: 10 }, DEFAULT_USER_ID, now).items,
  ).toEqual([]);
  expect(trace.traceId).toBe(root.traceId);
});
