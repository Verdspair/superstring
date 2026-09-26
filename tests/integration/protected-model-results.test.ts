import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { AgentRuntime, AgentRuntimeError } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { inspectContext } from "../../src/server/agent/context-access";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelPort } from "../../src/server/agent/model-port";
import { handleError } from "../../src/server/api/error-handler";
import { runRoutes } from "../../src/server/api/runs";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { RuntimeSpanRepository } from "../../src/server/observability/span-repository";
import { type ContextHandle, InspectedContextSchema } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
const owner = { kind: "fixture", id: "test", userId: DEFAULT_USER_ID };
const spec: AgentSpec = {
  id: "main",
  model: "decision-requested",
  instructions: "system",
  context: "conversation",
  availableActions: [],
  limits: { steps: 4 },
  generation: { model: "writer-requested" },
};
const final =
  '{"kind":"final","outputs":[{"kind":"generate","targetId":"reply","instructions":"write"}]}';
function setup(port: Partial<ModelPort> = {}) {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "fixture");
  const runs = new AgentRunRepository(h.db),
    telemetry = new RuntimeTelemetry(h.db),
    spans = new RuntimeSpanRepository(h.db);
  const runtime = new AgentRuntime({
    repository: runs,
    telemetry,
    model: {
      async complete(request) {
        request.onModelResolved?.("decision-actual");
        return final;
      },
      async *streamText(request) {
        request.onModelResolved?.("writer-actual");
        yield "PRIVATE_ANSWER";
      },
      async completeMultimodal() {
        return "PRIVATE_VISION";
      },
      ...port,
    },
  });
  const app = new Hono().onError(handleError).route("/v2/runs", runRoutes(h.db, runs));
  cleanup.push(async () => {
    await telemetry.close();
    h.close();
  });
  const read = (handle: ContextHandle) =>
    inspectContext(h.db, runs, handle, { userId: DEFAULT_USER_ID });
  const direct = {
    owner,
    authorizedTargets: ["reply"],
    outputMode: "stream" as const,
    context: {
      async read() {
        return { pending: [textMessage("user", "PRIVATE_INPUT")] };
      },
    },
  };
  return { h, runs, telemetry, spans, runtime, app, read, direct };
}

describe("source-bound model results", () => {
  it("captures exact next/leaf/vision/generate output separately from inputs and resolves the actual model", async () => {
    const f = setup({
      async complete(request) {
        request.onModelResolved?.(
          request.model === "leaf-requested" ? "leaf-actual" : "decision-actual",
        );
        return request.model === "leaf-requested" ? "PRIVATE_LEAF" : final;
      },
    });
    let loaded = false;
    const result = await f.runtime.run(spec, {
      ...f.direct,
      context: {
        async read() {
          if (!loaded) {
            loaded = true;
            await f.runtime.completeLeaf(
              { id: "memory-organize", model: "leaf-requested" },
              {
                owner: { ...owner, kind: "memory_job" },
                messages: [{ role: "user", content: "PRIVATE_MEMORY_INPUT" }],
              },
            );
            await f.runtime.completeVisionLeaf(
              { id: "vision" },
              {
                owner,
                model: "vision-model",
                prompt: "PRIVATE_IMAGE_INPUT",
                images: [{ mimeType: "image/png", bytes: new Uint8Array([1, 2]) }],
              },
            );
          }
          return { pending: [textMessage("user", "PRIVATE_INPUT")] };
        },
      },
    });
    const all = f.spans.page({ limit: 100 }).items;
    const models = all.filter((span) => span.stage === "model");
    expect(new Set(all.map((span) => span.traceId)).size).toBe(1);
    expect(models).toHaveLength(4);
    for (const model of models) {
      const response = await f.app.request(
        `/v2/runs/${model.runId}/context/${model.details.stepId}`,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      const detail = InspectedContextSchema.parse(await response.json());
      const expectedByPhase: Record<string, string> = {
        next: final,
        leaf: "PRIVATE_LEAF",
        vision: "PRIVATE_VISION",
        generate: "PRIVATE_ANSWER",
      };
      const expected = expectedByPhase[String(model.details.phase)];
      expect(detail.result).toEqual({
        status: "exact",
        text: expected,
        format: model.details.phase === "next" ? "json" : "text",
      });
      expect(model.details.modelResolved).toBe(true);
      expect(JSON.stringify(detail.exactMessages)).not.toContain(expected);
    }
    expect(f.runs.getRun(result.runId)?.steps.map((step) => step.model)).toEqual([
      "decision-actual",
      "writer-actual",
    ]);
    expect(models.find((model) => model.model === "writer-actual")?.details.requestedModel).toBe(
      "writer-requested",
    );
    expect(JSON.stringify(f.h.db.query("SELECT * FROM runtime_spans").all())).not.toContain(
      "PRIVATE_",
    );
    expect(JSON.stringify(f.h.db.query("SELECT decision FROM agent_steps").all())).not.toContain(
      "PRIVATE_",
    );
    expect(JSON.stringify(f.h.db.query("SELECT payload FROM run_events").all())).not.toContain(
      "PRIVATE_",
    );
  });

  it("keeps malformed returned JSON and domain-invalid leaf text available for failed-step inspection", async () => {
    const raw = '```json\n{"kind":"none","invalid":"PRIVATE_BAD_JSON"}\n```';
    const f = setup({ complete: async () => raw });
    await expect(f.runtime.run(spec, f.direct)).rejects.toMatchObject({
      code: "AGENT_DECISION_INVALID",
    });
    await expect(
      f.runtime.completeLeaf(
        { id: "validator" },
        {
          owner,
          messages: [],
          validate() {
            throw new Error("invalid");
          },
        },
      ),
    ).rejects.toThrow("invalid");
    for (const run of f.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id })) {
      expect(run.status).toBe("failed");
      expect(f.read(run.steps[0].context)?.result).toMatchObject({ status: "exact", text: raw });
    }
  });

  it("retains a non-stream response rejected by the gateway's finish-reason validator", async () => {
    const f = setup({
      async complete(request) {
        request.onResponseText?.("PRIVATE_LIMITED_RESULT", false);
        throw new AgentRuntimeError("MODEL_OUTPUT_LIMIT", "limited");
      },
    });
    await expect(f.runtime.run(spec, f.direct)).rejects.toMatchObject({
      code: "MODEL_OUTPUT_LIMIT",
    });
    await expect(
      f.runtime.completeLeaf({ id: "limited-leaf" }, { owner, messages: [] }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_LIMIT" });
    for (const run of f.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id })) {
      expect(f.read(run.steps[0].context)?.result).toMatchObject({
        status: "partial",
        text: "PRIVATE_LIMITED_RESULT",
      });
    }
  });

  it("captures streamed partial output on failure without changing failure propagation", async () => {
    const f = setup({
      async *streamText() {
        yield "PRIVATE_PART_1";
        yield "_PART_2";
        throw new AgentRuntimeError("MODEL_FAILED", "private failure");
      },
    });
    await expect(f.runtime.run(spec, f.direct)).rejects.toMatchObject({ code: "MODEL_FAILED" });
    const run = f.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(run.status).toBe("failed");
    expect(f.read(run.steps[1].context)?.result).toEqual({
      status: "partial",
      format: "text",
      text: "PRIVATE_PART_1_PART_2",
    });
    expect(f.read(run.steps[0].context)?.result.status).toBe("exact");
  });

  it("distinguishes pending, historical absent output and a failed request that returned no response", async () => {
    const f = setup({
      complete: async () => {
        throw new Error("network failed");
      },
    });
    const handle = { runId: crypto.randomUUID(), stepId: crypto.randomUUID() },
      at = new Date().toISOString();
    f.runs.createRun({ runId: handle.runId, specId: "legacy", specVersion: "1", owner, at });
    f.runs.startStep({
      ...handle,
      stepNo: 1,
      model: "m",
      phase: "leaf",
      at,
      messages: [textMessage("user", "old input")],
      sources: [],
    });
    expect(f.read(handle)?.result).toEqual({ status: "unavailable", reason: "pending" });
    f.h.db.query("UPDATE agent_steps SET status='completed' WHERE step_id=?").run(handle.stepId);
    expect(f.read(handle)?.result).toEqual({ status: "unavailable", reason: "not_recorded" });
    await expect(
      f.runtime.completeLeaf({ id: "no-response" }, { owner, messages: [] }),
    ).rejects.toThrow("network failed");
    const failed = f.runs
      .listRuns({ ownerKind: owner.kind, ownerId: owner.id })
      .find((run) => run.status === "failed")!;
    expect(f.read(failed.steps[0].context)?.result).toEqual({
      status: "unavailable",
      reason: "no_response",
    });
  });

  it("atomically erases outputs on grant revocation and never resurrects output returned after revocation", async () => {
    const f = setup();
    const knowledge = new KnowledgeRepository(f.h.db),
      category = knowledge.createCategory("test");
    const document = knowledge.importDocument({
      category_id: category.id,
      name: "source",
      original_text: "source body",
    });
    const granted = knowledge.replaceGrants(document.id, document.revision, [DEFAULT_USER_ID]);
    const grant = f.h.db
      .query("SELECT token FROM knowledge_grants WHERE document_id=?")
      .get(document.id) as { token: string };
    const sources: SourceRef[] = [
      { kind: "knowledge_document", id: document.id, revision: String(document.content_version) },
      {
        kind: "knowledge_grant",
        id: JSON.stringify([document.id, DEFAULT_USER_ID]),
        revision: grant.token,
      },
    ];
    await f.runtime.completeLeaf({ id: "library" }, { owner, messages: [], sources });
    const first = f.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].steps[0].context;
    expect(f.read(first)?.result.status).toBe("exact");
    // The second model revokes the source while its call is in flight.
    const runtime = new AgentRuntime({
      repository: f.runs,
      model: {
        async complete() {
          knowledge.replaceGrants(document.id, granted.revision, []);
          return "PRIVATE_LATE";
        },
        async *streamText() {},
        async completeMultimodal() {
          return "";
        },
      },
    });
    await runtime.completeLeaf({ id: "late" }, { owner, messages: [], sources });
    for (const run of f.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id })) {
      const context = f.runs.getContext(run.steps[0].context)!;
      expect(context.messages).toBeNull();
      expect(context.output).toBeNull();
      expect(f.read(run.steps[0].context)?.result).toEqual({ status: "revoked" });
    }
    expect(
      JSON.stringify(f.h.db.query("SELECT protected_output FROM context_snapshots").all()),
    ).not.toContain("PRIVATE_");
    expect(
      (await f.app.request(`/v2/runs/${first.runId}/context/${crypto.randomUUID()}`)).status,
    ).toBe(404);
  });

  it("expires and deletes protected results with their sources, and rejects foreign owners", async () => {
    const f = setup();
    const expiresAt = new Date(Date.now() + 1000).toISOString();
    await f.runtime.completeLeaf(
      { id: "ttl" },
      {
        owner,
        messages: [],
        sources: [{ kind: "external", id: "fixture", revision: "1", expiresAt }],
      },
    );
    const handle = f.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].steps[0]
      .context;
    expect(f.runs.expireContexts(expiresAt)).toBe(1);
    expect(f.runs.getContext(handle)?.output).toBeNull();
    expect(f.read(handle)?.result).toEqual({ status: "expired" });
    f.h.db
      .query("INSERT INTO users(id,name,created_at) VALUES(?,?,?)")
      .run("another-user", "other", new Date().toISOString());
    await f.runtime.completeLeaf(
      { id: "foreign" },
      { owner: { ...owner, userId: "another-user" }, messages: [] },
    );
    const foreign = f.runs
      .listRuns({ ownerKind: owner.kind, ownerId: owner.id })
      .find((run) => run.owner.userId === "another-user")!;
    expect(
      (await f.app.request(`/v2/runs/${foreign.runId}/context/${foreign.steps[0].stepId}`)).status,
    ).toBe(404);
    f.h.db.query("DELETE FROM agent_runs WHERE run_id=?").run(handle.runId);
    expect(f.runs.getContext(handle)).toBeNull();
  });
});
