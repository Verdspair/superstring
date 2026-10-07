import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { createCodeMode } from "../../src/server/agent/code-mode";
import {
  createModelAdmission,
  createModelPort,
  type TextModelGateway,
} from "../../src/server/agent/model-port";
import { createResearchAction } from "../../src/server/agent/research-action";
import { AgentTaskService, DEFAULT_TASK_LIMITS } from "../../src/server/agent/task-service";
import { handleError } from "../../src/server/api/error-handler";
import { permissionRoutes } from "../../src/server/api/permissions";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { FilePermissionStore, PermissionService } from "../../src/server/permissions/service";
import {
  ExecutionPolicySchema,
  PermissionPolicySchema,
} from "../../src/shared/contracts/permissions";

const handles: ReturnType<typeof openBusinessDb>[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const readAction = (name = "fixture.read"): BuiltInAction => ({
  sandboxCallable: true,
  permission: { resource: name, revision: "v1", approvalRequired: false },
  description: {
    name,
    capability: "fixture",
    effect: "read",
    parameters: {},
    description: name,
  },
  async execute() {
    return { value: { status: "ok" }, sources: [] };
  },
});

describe("execution configuration", () => {
  it("carries the documented defaults and refuses values outside the frozen bounds", () => {
    const defaults = ExecutionPolicySchema.parse({});
    expect(defaults).toMatchObject({
      research: false,
      code: false,
      tasks: { concurrency: 2, retentionHours: 24, leaseSeconds: 30, pollMs: 500 },
      researchLimits: { maxPerRun: 2, maxSteps: 6, deadlineMs: 60_000, maxConclusionChars: 4_000 },
      codeLimits: { concurrency: 3 },
      loop: {
        maxSteps: 16,
        readBatch: 3,
        noProgress: 3,
        concurrency: 4,
        modelConcurrency: 4,
        providerConcurrency: 2,
      },
      qq: { retryDelayMs: 15_000, maxAttempts: 3, deliveryTtlSeconds: 120 },
    });
    for (const invalid of [
      { loop: { readBatch: 4 } },
      { loop: { maxSteps: 0 } },
      { tasks: { concurrency: 9 } },
      { tasks: { retentionHours: 0.001 } },
      { researchLimits: { maxSteps: 7 } },
      { codeLimits: { memoryBytes: 1_024 } },
      { codeLimits: { concurrency: 0 } },
      { codeLimits: { concurrency: 9 } },
      { codeLimits: { concurrency: 1.5 } },
      { qq: { maxAttempts: 0 } },
    ])
      expect(ExecutionPolicySchema.safeParse(invalid).success).toBe(false);
    for (const concurrency of [1, 8])
      expect(
        ExecutionPolicySchema.parse({ codeLimits: { concurrency } }).codeLimits.concurrency,
      ).toBe(concurrency);
    const partial = PermissionPolicySchema.parse({
      version: 1,
      grants: [],
      execution: { code: true, loop: { readBatch: 1 } },
    });
    expect(partial.execution).toMatchObject({
      code: true,
      loop: { readBatch: 1, maxSteps: 16 },
      tasks: { concurrency: 2 },
    });
  });

  it("fills effective values on GET and persists explicit ones through PUT", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "exec-config-"));
    dirs.push(dir);
    const service = new PermissionService(
      new FilePermissionStore(path.join(dir, "permissions.json")),
    );
    const app = new Hono();
    app.onError(handleError);
    app.route(
      "/v2/permissions",
      permissionRoutes(service, () => []),
    );
    const initial = await (await app.request("/v2/permissions")).json();
    expect(initial.revision).toBe("");
    expect(initial.policy.execution.loop.maxSteps).toBe(16);
    const update = {
      expectedRevision: "",
      policy: {
        version: 1,
        grants: [],
        execution: { code: true, loop: { maxSteps: 8, readBatch: 1 } },
      },
    };
    const saved = await app.request("/v2/permissions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).policy.execution).toMatchObject({
      code: true,
      loop: { maxSteps: 8, readBatch: 1, noProgress: 3 },
      qq: { retryDelayMs: 15_000 },
    });
    const reread = await (await app.request("/v2/permissions")).json();
    expect(reread.policy.execution.loop.maxSteps).toBe(8);
    expect(
      (
        await app.request("/v2/permissions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(update),
        })
      ).status,
    ).toBe(409);
  });

  it.each([false, true])(
    "defaults legacy code concurrency and preserves other settings through GET/PUT with code=%s",
    async (code) => {
      const dir = mkdtempSync(path.join(tmpdir(), "exec-config-"));
      dirs.push(dir);
      const file = path.join(dir, "permissions.json");
      const codeLimits = {
        timeoutMs: 7_000,
        maxCalls: 7,
        memoryBytes: 33_554_433,
        maxTransferBytes: 1_048_577,
        maxConclusionChars: 2_000,
      };
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          grants: [],
          execution: { code, codeLimits, tasks: { concurrency: 4 }, loop: { readBatch: 1 } },
        }),
      );
      const service = new PermissionService(new FilePermissionStore(file));
      const app = new Hono();
      app.onError(handleError);
      app.route(
        "/v2/permissions",
        permissionRoutes(service, () => []),
      );
      const initial = await (await app.request("/v2/permissions")).json();
      expect(initial.policy.execution.code).toBe(code);
      expect(initial.policy.execution.codeLimits).toEqual({ ...codeLimits, concurrency: 3 });
      const policy = {
        ...initial.policy,
        execution: {
          ...initial.policy.execution,
          codeLimits: { ...initial.policy.execution.codeLimits, concurrency: 5 },
        },
      };
      const response = await app.request("/v2/permissions", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedRevision: initial.revision, policy }),
      });
      expect(response.status).toBe(200);
      const saved = await response.json();
      expect(saved.policy).toEqual(policy);
      expect(saved.revision).not.toBe(initial.revision);
      const reread = await (await app.request("/v2/permissions")).json();
      expect(reread.policy).toEqual(policy);
      expect(reread.revision).toBe(saved.revision);
    },
  );

  it("reads task retention, concurrency and lease from the live configuration", async () => {
    const handle = openBusinessDb();
    handles.push(handle);
    ensureDefaults(handle.orm, "model");
    const events = new ConversationEventRepository(handle.db);
    const first = events.ensureWeb(
      createSession(handle.orm, "limits-a", { modelName: "model" }).id,
      DEFAULT_USER_ID,
    );
    const second = events.ensureWeb(
      createSession(handle.orm, "limits-b", { modelName: "model" }).id,
      DEFAULT_USER_ID,
    );
    const conversation = first;
    if (!conversation || !second) throw new Error("missing conversation");
    const actions = [readAction()];
    const policy = PermissionPolicySchema.parse({
      version: 1,
      grants: [{ resource: "fixture.read", approved: false, directories: [] }],
    });
    const permissions = new PermissionService({
      read: () => ({ revision: "1", policy }),
      replace: () => ({ revision: "1", policy }),
    });
    const repository = new AgentTaskRepository(handle.db);
    let limits = { concurrency: 1, retentionMs: 3_600_000, leaseMs: 60_000, pollMs: 500 };
    const service = new AgentTaskService({
      repository,
      orm: handle.orm,
      executor: new ActionExecutor(permissions),
      actions: () => actions,
      now: () => "2026-09-28T00:00:00.000Z",
      limits: () => limits,
    });
    const owner = {
      kind: "conversation",
      id: conversation.id,
      agentId: conversation.agentId,
      userId: DEFAULT_USER_ID,
    };
    const secondOwner = { ...owner, id: second.id };
    const plan = { calls: [{ name: "fixture.read", arguments: {} }] };
    const gate = Promise.withResolvers<void>();
    actions[0].execute = async () => {
      await gate.promise;
      return { value: { status: "ok" }, sources: [] };
    };
    const queued = service.enqueue(conversation.id, plan, { owner, requestId: "one" });
    expect(queued.expiresAt).toBe("2026-09-28T01:00:00.000Z");
    service.enqueue(second.id, plan, { owner: secondOwner, requestId: "two" });
    const running = service.runOnce();
    expect(await service.runOnce()).toBe(false); // 并发 1：第二条不领
    limits = { ...limits, concurrency: 2 };
    const parallel = service.runOnce(); // 重新读取后可以再领（另一间会话）
    expect(parallel).not.toBe(false);
    gate.resolve();
    expect(await parallel).toBe(true);
    await running;
    limits = { ...limits, retentionMs: 60_000 };
    const short = service.enqueue(second.id, plan, { owner: secondOwner, requestId: "three" });
    expect(short.expiresAt).toBe("2026-09-28T00:01:00.000Z");
    expect(DEFAULT_TASK_LIMITS.concurrency).toBe(2);
  });

  it("gives the research subtask its configured limits and per-run ceiling", async () => {
    const captured: { limits: { steps: number; deadlineMs?: number } }[] = [];
    const conclusion = "ok";
    const runtime = {
      async run(spec: { limits: { steps: number; deadlineMs?: number } }) {
        captured.push({ limits: spec.limits });
        return {
          status: "completed" as const,
          outputs: [{ status: "prepared" as const, text: conclusion }],
          runId: "synthetic-run",
        };
      },
    };
    const spec = {
      id: "conversation",
      context: "conversation" as const,
      availableActions: [],
      limits: { steps: 10 },
    };
    const input = {
      conversationId: "conversation-1",
      context: { assertCurrent: () => {}, assertSources: () => {} },
    };
    const action = createResearchAction({
      // The stub only serves the two calls the action makes; the real runtime owns the rest.
      runtime: runtime as unknown as Parameters<typeof createResearchAction>[0]["runtime"],
      executor: new ActionExecutor(),
      spec: spec as Parameters<typeof createResearchAction>[0]["spec"],
      input: input as unknown as Parameters<typeof createResearchAction>[0]["input"],
      actions: [readAction("fixture.tool")],
      limits: { maxPerRun: 1, maxSteps: 4, deadlineMs: 30_000, maxConclusionChars: 4_000 },
    });
    const context = {
      owner: { kind: "conversation", id: "conversation-1" },
      signal: new AbortController().signal,
    };
    const result = await action.execute({ question: "why" }, context);
    expect(result.value).toMatchObject({ status: "ok", conclusion: "ok" });
    expect(captured[0].limits).toMatchObject({ steps: 4, deadlineMs: 30_000 });
    await expect(action.execute({ question: "again" }, context)).rejects.toMatchObject({
      code: "AGENT_SUBTASK_LIMIT",
    });
    const limited = createResearchAction({
      runtime: runtime as unknown as Parameters<typeof createResearchAction>[0]["runtime"],
      executor: new ActionExecutor(),
      spec: spec as Parameters<typeof createResearchAction>[0]["spec"],
      input: input as unknown as Parameters<typeof createResearchAction>[0]["input"],
      actions: [readAction("fixture.tool")],
      limits: { maxConclusionChars: 1 },
    });
    await expect(limited.execute({ question: "why" }, context)).rejects.toMatchObject({
      code: "AGENT_SUBTASK_RESULT_LIMIT",
    });
  });

  it("passes the configured sandbox limits to the runner and keeps the conclusion bound", async () => {
    const seen: { timeoutMs: number; maxCalls: number; concurrency: number }[] = [];
    const mode = createCodeMode({
      actions: [readAction("fixture.tool")],
      limits: { timeoutMs: 5_000, maxCalls: 7, concurrency: 5, maxConclusionChars: 5 },
      runner: {
        available: true,
        async run({ limits }) {
          seen.push({
            timeoutMs: limits.timeoutMs,
            maxCalls: limits.maxCalls,
            concurrency: limits.concurrency,
          });
          return { conclusion: "123456" };
        },
      },
    });
    if (!mode.action) throw new Error("missing code action");
    const context = {
      owner: { kind: "conversation", id: "c1" },
      signal: new AbortController().signal,
    };
    const result = await mode.action.execute({ script: "return 1" }, context);
    expect(seen[0]).toEqual({ timeoutMs: 5_000, maxCalls: 7, concurrency: 5 });
    expect(result.value).toMatchObject({
      status: "unavailable",
      code: "CODE_CONCLUSION_TOO_LARGE",
    });
  });

  it("caps read parallelism per batch and re-reads the limiter value", async () => {
    let batch = 1;
    let concurrent = 0;
    let peak = 0;
    // 没有 permission 的动作在未配置策略下可用；这里只考并行上限。
    const slow = (name: string): BuiltInAction => ({
      sandboxCallable: true,
      description: {
        name,
        capability: "fixture",
        effect: "read",
        parameters: {},
        description: name,
      },
      async execute() {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 5));
        concurrent -= 1;
        return { value: { status: "ok" }, sources: [] };
      },
    });
    const executor = new ActionExecutor(undefined, () => batch);
    const context = { owner: { kind: "test", id: "run" }, signal: new AbortController().signal };
    await executor.executeBatch(
      [slow("a.read"), slow("b.read"), slow("c.read")].map((action) => ({ action, arguments: {} })),
      context,
    );
    expect(peak).toBe(1);
    batch = 3;
    peak = 0;
    await executor.executeBatch(
      [slow("a.read"), slow("b.read"), slow("c.read")].map((action) => ({ action, arguments: {} })),
      context,
    );
    expect(peak).toBe(3);
  });

  it("ends a repeating call at the configured no-progress threshold", async () => {
    const handle = openBusinessDb();
    handles.push(handle);
    let executed = 0;
    // 没有 permission 的动作在任何策略下都可用；本用例只考无进展阈值。
    const action: BuiltInAction = {
      sandboxCallable: true,
      description: {
        name: "fixture.read",
        capability: "fixture",
        effect: "read",
        parameters: {},
        description: "fixture.read",
      },
      async execute() {
        executed += 1;
        return { value: { status: "ok" }, sources: [] };
      },
    };
    const runtime = new AgentRuntime({
      repository: new AgentRunRepository(handle.db),
      actions: [action],
      model: {
        complete: async () =>
          JSON.stringify({ kind: "invoke", calls: [{ name: "fixture.read", arguments: {} }] }),
        async *streamText() {},
        completeMultimodal: async () => "",
      },
      noProgressLimit: () => 4,
    });
    await expect(
      runtime.run(
        {
          id: "no-progress",
          context: "conversation",
          availableActions: [action.description],
          limits: { steps: 8 },
        },
        {
          owner: { kind: "test", id: "run" },
          actions: [action],
          authorizedTargets: ["reply"],
          outputMode: "buffered",
          context: {
            async read() {
              return {};
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AGENT_NO_PROGRESS" });
    expect(executed).toBe(3);
  });

  it("applies a per-service pool beneath the process-wide model cap", async () => {
    const counts = new Map<string, number>();
    const peaks = new Map<string, number>();
    let total = 0;
    let totalPeak = 0;
    const serviceOf = (model?: string) =>
      model === "a1" || model === "a2" ? "service-a" : "service-b";
    const bump = (key: string, delta: number) => {
      const next = (counts.get(key) ?? 0) + delta;
      counts.set(key, next);
      peaks.set(key, Math.max(peaks.get(key) ?? 0, next));
    };
    const port = createModelPort({
      gateway: {
        async complete(request) {
          const key = serviceOf(request.model);
          total += 1;
          totalPeak = Math.max(totalPeak, total);
          bump(key, 1);
          await new Promise((resolve) => setTimeout(resolve, 10));
          bump(key, -1);
          total -= 1;
          return "ok";
        },
      } as TextModelGateway,
      modelCallConcurrency: 4,
      providerConcurrency: 1,
      providerKey: serviceOf,
    });
    await Promise.all(
      ["a1", "a2", "b1", "b2"].map((model) =>
        port.complete({
          messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
          model,
        }),
      ),
    );
    // 同一服务内串行（1），两个服务之间可以并行（整机帽 4 不拦）。
    expect(peaks.get("service-a")).toBe(1);
    expect(peaks.get("service-b")).toBe(1);
    expect(totalPeak).toBe(2);
  });

  it("re-reads the model call limit on every acquisition", async () => {
    let limit = 1;
    const admission = createModelAdmission({ total: () => limit });
    const first = await admission.acquire(undefined);
    let entered = false;
    const second = admission.acquire(undefined).then((release) => {
      entered = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(entered).toBe(false);
    first();
    const release = await second;
    expect(entered).toBe(true);
    release();
    limit = 2;
    const a = await admission.acquire(undefined);
    const b = await admission.acquire(undefined);
    expect(admission.available()).toBe(false);
    a();
    b();
    expect(admission.available()).toBe(true);
  });
});
