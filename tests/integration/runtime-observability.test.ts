import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { handleError } from "../../src/server/api/error-handler";
import { observabilityRoutes } from "../../src/server/api/observability";
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
import {
  RuntimeSpansPageSchema,
  RuntimeTraceDetailSchema,
  RuntimeTracesPageSchema,
} from "../../src/shared/contracts/runtime-observability";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
function setup() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "fixture");
  const telemetry = new RuntimeTelemetry(h.db);
  const repository = new RuntimeSpanRepository(h.db);
  const app = new Hono().onError(handleError).route("/v2/observability", observabilityRoutes(h.db));
  cleanups.push(async () => {
    await telemetry.close();
    h.close();
  });
  return { h, telemetry, repository, app };
}

describe("execution observability", () => {
  it("pages independent traces by stable creation cursor and expands complete filter-matched causality", async () => {
    const { telemetry, repository, app } = setup();
    const first = telemetry.start("request-one", { channel: "web", stage: "ingress" });
    first.within(() => {
      telemetry.record("selector", {
        channel: "memory",
        stage: "model",
        model: "target-model",
        status: "completed",
      });
      for (let i = 0; i < 205; i++)
        telemetry.record("context", { channel: "web", stage: "context" });
    });
    first.end("completed");
    telemetry.record("request-two", { channel: "onebot11", stage: "run", status: "no_output" });
    const read = async (query: string) =>
      RuntimeTracesPageSchema.parse(
        await (await app.request(`/v2/observability/traces?${query}`)).json(),
      );
    const newest = await read("limit=1");
    expect(newest.items).toHaveLength(1);
    expect(newest.summary.totalTraces).toBe(2);
    expect(newest.hasMore).toBe(true);
    // A late continuation must not move the old trace back to the newest page.
    telemetry.record("delivery", { channel: "web", stage: "delivery", parent: first });
    expect((await read("limit=1")).items[0]!.traceId).toBe(newest.items[0]!.traceId);
    const older = await read(`limit=1&beforeId=${newest.nextBeforeId}`);
    expect(older.items[0]!.traceId).toBe(first.traceId);
    expect(older.hasMore).toBe(false);
    const filtered = await read("model=target-model&stage=model");
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]).toMatchObject({
      spanCount: 208,
      matchedSpanCount: 1,
      traceId: first.traceId,
    });
    expect(filtered.summary).toMatchObject({ totalTraces: 1, matchedSpans: 1 });
    const detail = RuntimeTraceDetailSchema.parse(
      await (
        await app.request(
          `/v2/observability/traces/${first.traceId}/waterfall?model=target-model&limit=1`,
        )
      ).json(),
    );
    expect(detail.items).toHaveLength(208);
    expect(detail.matchedSpanIds).toHaveLength(1);
    expect(
      detail.items.find((item) => item.spanId === detail.matchedSpanIds[0])?.parentSpanId,
    ).toBe(first.spanId);
    expect(detail.items.some((item) => item.name === "request-two")).toBe(false);
    expect(repository.waterfall(first.traceId, { q: "not-matched" })?.items).toHaveLength(208);
    expect(repository.waterfall(first.traceId, { q: "not-matched" })?.matchedSpanIds).toEqual([]);
  });
  it("keeps the owning run's no_output outcome when its nested model task completed", () => {
    const { telemetry, repository } = setup();
    const root = telemetry.start("wake.activate", { channel: "onebot11", stage: "wake" });
    root.within(() => {
      const main = telemetry.start("agent.run", { channel: "onebot11", stage: "run" });
      main.within(() =>
        telemetry.record("agent.run", { channel: "onebot11", stage: "run", status: "completed" }),
      );
      main.end("no_output");
    });
    root.end("no_output");
    expect(repository.traces({}).items[0].status).toBe("no_output");
  });
  it("uses the same ownership and retention boundary for trace counts, detail and match identifiers", async () => {
    const { telemetry, repository, h, app } = setup();
    h.db
      .query("INSERT INTO users(id,name,created_at) VALUES(?,?,?)")
      .run("someone-else", "other", new Date().toISOString());
    telemetry.record("private", { channel: "memory", stage: "run", userId: "someone-else" });
    const privateTrace = (
      h.db.query("SELECT trace_id FROM runtime_spans").get() as { trace_id: string }
    ).trace_id;
    expect(repository.traces({}).summary.totalTraces).toBe(0);
    expect(repository.waterfall(privateTrace, {})).toBeNull();
    expect((await app.request(`/v2/observability/traces/${privateTrace}/waterfall`)).status).toBe(
      404,
    );
    const expiry = new Date(Date.now() + 1000).toISOString();
    const root = telemetry.start("retained", {
      channel: "onebot11",
      stage: "run",
      sources: [{ kind: "qq_observation", id: "source", revision: "1", expiresAt: expiry }],
    });
    root.end("completed");
    expect(repository.traces({}).summary.totalTraces).toBe(1);
    expect(repository.traces({}, DEFAULT_USER_ID, expiry).summary.totalTraces).toBe(0);
    expect(repository.waterfall(root.traceId, {}, DEFAULT_USER_ID, expiry)).toBeNull();
  });
  it("persists live stages, isolates parallel traces and propagates parent spans through awaits", async () => {
    const { telemetry, repository } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const root = telemetry.observe(
      "web.request",
      { channel: "web", stage: "ingress" },
      async () => {
        await gate;
        await telemetry.observe(
          "memory.retrieve",
          { channel: "memory", stage: "model", model: "local" },
          async () => 1,
        );
      },
    );
    expect(repository.page({ status: "started" }).summary.active).toBe(1);
    await telemetry.observe(
      "onebot.ingress",
      { channel: "onebot11", stage: "ingress" },
      async () => 2,
    );
    release();
    await root;
    const spans = RuntimeSpansPageSchema.parse(repository.page({})).items;
    const web = spans.find((s) => s.name === "web.request")!;
    const child = spans.find((s) => s.name === "memory.retrieve")!;
    expect(child).toMatchObject({
      traceId: web.traceId,
      parentSpanId: web.spanId,
      status: "completed",
      model: "local",
    });
    expect(spans.find((s) => s.channel === "onebot11")!.traceId).not.toBe(web.traceId);
    expect(repository.page({}).summary.active).toBe(0);
  });
  it("resumes queue causality across provider instances without retrying unknown operations", async () => {
    const { h, telemetry, repository } = setup();
    telemetry.record("wake.scheduled", {
      channel: "onebot11",
      stage: "wake",
      status: "scheduled",
      wakeId: "wake-fixture",
    });
    const parent = telemetry.parentFor("wake_id", "wake-fixture")!;
    const restarted = new RuntimeTelemetry(h.db);
    const span = restarted.start("wake.activate", {
      channel: "onebot11",
      stage: "wake",
      wakeId: "wake-fixture",
      parent,
    });
    restarted.recover();
    expect(repository.page({ status: "unknown" }).items[0]).toMatchObject({
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      code: "PROCESS_INTERRUPTED",
    });
    expect(repository.page({}).items).toHaveLength(2);
    span.end("unknown", "PROCESS_INTERRUPTED");
    await restarted.close();
  });
  it("filters/searches the whole authorized dataset, not only the loaded page", async () => {
    const { telemetry, app } = setup();
    telemetry.record("desired", {
      channel: "knowledge",
      stage: "maintenance",
      status: "failed",
      code: "JOB_LOST",
      model: "local",
      details: { jobId: "find-me" },
    });
    for (let i = 0; i < 4; i++)
      telemetry.record("recent", { channel: "web", stage: "model", status: "completed" });
    const read = async (query: string) =>
      RuntimeSpansPageSchema.parse(
        await (await app.request(`/v2/observability/spans?${query}`)).json(),
      );
    const first = await read("limit=2");
    expect(first.items).toHaveLength(2);
    expect(first.summary.total).toBe(5);
    expect(first.hasMore).toBe(true);
    const older = await read(`limit=2&beforeId=${first.nextBeforeId}`);
    expect(older.summary.total).toBe(5);
    expect(older.items.every((s) => s.id < first.nextBeforeId)).toBe(true);
    const hit = await read("q=find-me&model=local&channel=knowledge&status=failed");
    expect(hit.items.map((s) => s.name)).toEqual(["desired"]);
    expect(hit.summary.total).toBe(1);
    expect((await read("q=%25")).items).toHaveLength(0);
    expect((await app.request("/v2/observability/spans?limit=100000")).status).toBe(422);
    expect(
      (
        await app.request(
          "/v2/observability/spans?from=2026-10-01T00:00:00Z&to=2026-09-01T00:00:00Z",
        )
      ).status,
    ).toBe(422);
    expect((await app.request("/v2/observability/traces/not-a-trace")).status).toBe(422);
  });
  it("keeps error plaintext out of records and preserves original failures", async () => {
    const { telemetry, repository, h } = setup();
    const error = Object.assign(new Error("SECRET_PROMPT token=private"), { code: "MODEL_FAILED" });
    await expect(
      telemetry.observe("model", { channel: "web", stage: "model" }, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    const result = repository.page({}).items[0]!;
    expect(result).toMatchObject({ status: "failed", code: "MODEL_FAILED" });
    expect(JSON.stringify(h.db.query("SELECT * FROM runtime_spans").all())).not.toContain(
      "SECRET_PROMPT",
    );
  });
  it("normalizes timestamp precision on both list and trace filters", async () => {
    const { telemetry, repository, h, app } = setup();
    telemetry.record("fractional", { channel: "web", stage: "run" });
    const row = repository.page({}).items[0]!;
    h.db
      .query("UPDATE runtime_spans SET started_at=? WHERE id=?")
      .run("2026-09-01T12:00:00.123Z", row.id);
    expect(repository.page({ from: "2026-09-01T12:00:00Z" }).summary.total).toBe(1);
    expect(repository.page({ to: "2026-09-01T12:00:00Z" }).summary.total).toBe(0);
    for (const path of ["spans", `traces/${row.traceId}`]) {
      const valid = await app.request(
        `/v2/observability/${path}?from=2026-09-01T12:00:00Z&to=2026-09-01T12:00:00.999Z`,
      );
      expect(valid.status).toBe(200);
      expect(RuntimeSpansPageSchema.parse(await valid.json()).summary.total).toBe(1);
      expect(
        (
          await app.request(
            `/v2/observability/${path}?from=2026-09-01T12:00:00.999Z&to=2026-09-01T12:00:00Z`,
          )
        ).status,
      ).toBe(422);
    }
  });
  it("does not resurrect an expired trace while its parent is still running", () => {
    const { telemetry, repository, h } = setup();
    const root = telemetry.start("root", { channel: "onebot11", stage: "run" });
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    root.within(() =>
      telemetry.record("context", {
        channel: "onebot11",
        stage: "context",
        sources: [{ kind: "qq_observation", id: "source", revision: "1", expiresAt }],
      }),
    );
    telemetry.expire(expiresAt);
    expect(h.db.query("SELECT count(*) AS n FROM runtime_spans").get()).toEqual({ n: 0 });
    root.update({ code: "STILL_RUNNING" });
    root.within(() => telemetry.record("later", { channel: "onebot11", stage: "delivery" }));
    root.end();
    expect(repository.page({}).summary.total).toBe(0);
    expect(h.db.query("SELECT count(*) AS n FROM runtime_spans").get()).toEqual({ n: 0 });
  });
  it("releases ended metadata even if diagnostic persistence fails", () => {
    const { telemetry, h } = setup();
    const scope = telemetry.start("root", { channel: "web", stage: "run" });
    expect(scope.within(() => telemetry.activeMetadata())).toBeDefined();
    h.db.exec(
      "CREATE TRIGGER reject_diagnostic_write BEFORE INSERT ON runtime_spans BEGIN SELECT RAISE(FAIL, 'diagnostic unavailable'); END",
    );
    scope.end();
    expect(scope.within(() => telemetry.activeMetadata())).toBeUndefined();
    h.db.exec("DROP TRIGGER reject_diagnostic_write");
  });
  it("applies source expiry to the whole trace including subsequently-created stages", async () => {
    const { telemetry, repository, h } = setup();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await telemetry.observe("root", { channel: "onebot11", stage: "run" }, async () => {
      telemetry.record("context", {
        channel: "onebot11",
        stage: "context",
        sources: [{ kind: "qq_observation", id: "source", revision: "1", expiresAt }],
      });
      telemetry.record("later", { channel: "onebot11", stage: "delivery" });
    });
    expect(h.db.query("SELECT DISTINCT expires_at FROM runtime_spans").all()).toEqual([
      { expires_at: expiresAt },
    ]);
    expect(repository.page({}, DEFAULT_USER_ID, expiresAt).items).toHaveLength(0);
    telemetry.expire(expiresAt);
    expect(h.db.query("SELECT count(*) AS n FROM runtime_spans").get()).toEqual({ n: 0 });
  });
  it("protects conversation ownership, hides inactive assistant bindings and cascades deletion", () => {
    const { h, telemetry, repository } = setup();
    const session = createSession(h.orm, "fixture", { modelName: "fixture" });
    const conversation = new ConversationEventRepository(h.db).ensureWeb(session.id)!;
    telemetry.record("web", {
      channel: "web",
      stage: "run",
      conversationId: conversation.id,
      agentId: DEFAULT_AGENT_ID,
    });
    expect(repository.page({ conversationId: conversation.id }).summary.total).toBe(1);
    expect(repository.page({}, "another-user").summary.total).toBe(0);
    h.db.query("DELETE FROM sessions WHERE id=?").run(session.id);
    expect(repository.page({}).summary.total).toBe(0);
    expect(h.db.query("SELECT count(*) AS n FROM runtime_spans").get()).toEqual({ n: 0 });
  });
});
