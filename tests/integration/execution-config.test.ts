import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type {
  ActionContext,
  BuiltInAction,
  RetryOrigin,
} from "../../src/server/agent/built-in-actions";
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
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { FilePermissionStore, PermissionService } from "../../src/server/permissions/service";
import { QQ_PROMPT_DEFAULTS } from "../../src/server/services/qq-prompt-contract";
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
      // 出站期限缺省 600 秒（2026-10-09 放宽）；10..3600 的范围没动，已存显式值按存储值生效。
      qq: { retryDelayMs: 15_000, maxAttempts: 3, deliveryTtlSeconds: 600 },
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
      { qq: { deliveryTtlSeconds: 9 } },
      { qq: { deliveryTtlSeconds: 3601 } },
    ])
      expect(ExecutionPolicySchema.safeParse(invalid).success).toBe(false);
    // 放宽缺省不等于放开上限，也不等于改写已存的显式值：两个边界仍可存，旧的 120 仍照用。
    for (const seconds of [10, 120, 600, 3600]) {
      expect(ExecutionPolicySchema.parse({ qq: { deliveryTtlSeconds: seconds } }).qq).toMatchObject(
        { deliveryTtlSeconds: seconds },
      );
    }
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

  it("defaults system retry limits, keeps the frozen bounds, and parses legacy policies without system", () => {
    const defaults = ExecutionPolicySchema.parse({});
    expect(defaults.system).toEqual({ maxAttempts: 3, retryDelayMs: 2_000 });
    // 旧策略没有 system 组：解析时补齐缺省值，QQ 已存显式值原样保留，不需要迁移。
    const legacy = PermissionPolicySchema.parse({
      version: 1,
      grants: [],
      execution: { qq: { maxAttempts: 4, retryDelayMs: 20_000 } },
    }).execution;
    expect(legacy?.system).toEqual({ maxAttempts: 3, retryDelayMs: 2_000 });
    expect(legacy?.qq).toEqual({ maxAttempts: 4, retryDelayMs: 20_000, deliveryTtlSeconds: 600 });
    // 与 QQ 同形的冻结边界：1..10 次（含首次）、1000..300000ms，超界与非整数拒绝。
    const systemOf = (system: Record<string, unknown>) =>
      ExecutionPolicySchema.parse({ system }).system;
    for (const value of [1, 10]) {
      expect(systemOf({ maxAttempts: value }).maxAttempts).toBe(value);
      expect(systemOf({ retryDelayMs: value * 1_000 }).retryDelayMs).toBe(value * 1_000);
    }
    for (const invalid of [
      { system: { maxAttempts: 0 } },
      { system: { maxAttempts: 11 } },
      { system: { maxAttempts: 2.5 } },
      { system: { retryDelayMs: 999 } },
      { system: { retryDelayMs: 300_001 } },
      { system: { jitter: true } },
    ])
      expect(ExecutionPolicySchema.safeParse(invalid).success).toBe(false);
    // system 组不借给 QQ：QQ 的次数上限仍是 10，缺省仍是 3 次/15 秒。
    expect(ExecutionPolicySchema.safeParse({ qq: { maxAttempts: 11 } }).success).toBe(false);
    expect(ExecutionPolicySchema.parse({ system: { maxAttempts: 10 } }).qq).toMatchObject({
      maxAttempts: 3,
      retryDelayMs: 15_000,
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

  it("preserves legacy explicit QQ retry values and saves explicit system values through GET/PUT with CAS", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "exec-config-retry-"));
    dirs.push(dir);
    const file = path.join(dir, "permissions.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        grants: [],
        execution: { qq: { maxAttempts: 4, retryDelayMs: 20_000 } },
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
    expect(initial.policy.execution.qq).toEqual({
      maxAttempts: 4,
      retryDelayMs: 20_000,
      deliveryTtlSeconds: 600,
    });
    expect(initial.policy.execution.system).toEqual({ maxAttempts: 3, retryDelayMs: 2_000 });
    const policy = {
      ...initial.policy,
      execution: {
        ...initial.policy.execution,
        system: { maxAttempts: 5, retryDelayMs: 8_000 },
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
    // 同一 revision 重放被 CAS 拒绝。
    expect(
      (
        await app.request("/v2/permissions", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expectedRevision: initial.revision, policy }),
        })
      ).status,
    ).toBe(409);
    // 已存显式 system/QQ 值再读原样保留。
    const reread = await (await app.request("/v2/permissions")).json();
    expect(reread.policy.execution.system).toEqual({ maxAttempts: 5, retryDelayMs: 8_000 });
    expect(reread.policy.execution.qq).toEqual({
      maxAttempts: 4,
      retryDelayMs: 20_000,
      deliveryTtlSeconds: 600,
    });
  });

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
          // 新端口协议：整机/服务帽的获准发生在真实发送边界，由 gateway 调
          // acquireSendPermit；fake 必须照做，否则帽不生效（peak 2 假象）。
          const actualModel = request.model ?? "mockdefault";
          const key = serviceOf(actualModel);
          const release = request.acquireSendPermit
            ? await request.acquireSendPermit(actualModel, request.signal)
            : undefined;
          try {
            total += 1;
            totalPeak = Math.max(totalPeak, total);
            bump(key, 1);
            await new Promise((resolve) => setTimeout(resolve, 10));
          } finally {
            bump(key, -1);
            total -= 1;
            release?.();
          }
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

  it("widens model and provider request caps to 256 while keeping defaults and old loop bounds", async () => {
    // 缺省 4/2 与下界 1 不变；256 合法，257 与 0 拒绝。
    expect(ExecutionPolicySchema.parse({}).loop).toMatchObject({
      concurrency: 4,
      modelConcurrency: 4,
      providerConcurrency: 2,
      readBatch: 3,
    });
    for (const value of [1, 16, 256]) {
      expect(
        ExecutionPolicySchema.parse({ loop: { modelConcurrency: value } }).loop.modelConcurrency,
      ).toBe(value);
      expect(
        ExecutionPolicySchema.parse({ loop: { providerConcurrency: value } }).loop
          .providerConcurrency,
      ).toBe(value);
    }
    for (const invalid of [
      { loop: { modelConcurrency: 257 } },
      { loop: { modelConcurrency: 0 } },
      { loop: { providerConcurrency: 257 } },
      { loop: { providerConcurrency: 0 } },
    ])
      expect(ExecutionPolicySchema.safeParse(invalid).success).toBe(false);
    // 上限放宽不借用给相邻的 loop 字段：跨会话唤醒并发仍 max 16，只读并行仍 max 3。
    expect(ExecutionPolicySchema.parse({ loop: { concurrency: 16 } }).loop.concurrency).toBe(16);
    expect(ExecutionPolicySchema.safeParse({ loop: { concurrency: 17 } }).success).toBe(false);
    expect(ExecutionPolicySchema.safeParse({ loop: { readBatch: 4 } }).success).toBe(false);
    // 放宽后的值经 GET/PUT 保存，CAS revision 照常推进。
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
    const saved = await app.request("/v2/permissions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: initial.revision,
        policy: {
          version: 1,
          grants: [],
          execution: { code: true, loop: { modelConcurrency: 256, providerConcurrency: 256 } },
        },
      }),
    });
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.policy.execution.loop).toMatchObject({
      modelConcurrency: 256,
      providerConcurrency: 256,
      concurrency: 4,
      readBatch: 3,
    });
    const reread = await (await app.request("/v2/permissions")).json();
    expect(reread.policy.execution.loop.modelConcurrency).toBe(256);
    expect(reread.policy.execution.loop.providerConcurrency).toBe(256);
  });
});
describe("queued task claim origin and policy snapshot", () => {
  interface ClaimCapture {
    origin?: RetryOrigin;
    /** 实际 context.retryPolicy 引用：证明领取时复制一次、跨调用共享且不随原对象变化。 */
    policyRef?: { maxAttempts: number; retryDelayMs: number };
    executionReads: number;
  }

  const grantedPermissions = (resource: string) =>
    new PermissionService({
      read: () => ({
        revision: "1",
        policy: PermissionPolicySchema.parse({
          version: 1,
          grants: [{ resource, approved: true, directories: [] }],
        }),
      }),
      replace: () => {
        throw new Error("permissions are not replaced in this fixture");
      },
    });

  const claimProbe = (
    captured: ClaimCapture[],
    reads: () => number,
    onCall?: (index: number) => void,
  ): BuiltInAction => ({
    ...readAction("fixture.read"),
    async execute(_arguments_: Record<string, unknown>, context: ActionContext) {
      captured.push({
        origin: context.retryOrigin,
        policyRef: context.retryPolicy,
        executionReads: reads(),
      });
      onCall?.(captured.length - 1);
      return { value: { status: "ok" }, sources: [] };
    },
  });

  it("claims a web conversation as system with one claim-time policy snapshot shared by both calls", async () => {
    const handle = openBusinessDb();
    handles.push(handle);
    ensureDefaults(handle.orm, "model");
    const conversation = new ConversationEventRepository(handle.db).ensureWeb(
      createSession(handle.orm, "queue-web", { modelName: "model" }).id,
      DEFAULT_USER_ID,
    );
    if (!conversation) throw new Error("missing conversation");
    const policy = ExecutionPolicySchema.parse({
      system: { maxAttempts: 5, retryDelayMs: 1_234 },
    });
    let executionReads = 0;
    const captured: ClaimCapture[] = [];
    const probe = claimProbe(
      captured,
      () => executionReads,
      (index) => {
        // 第一次调用后改写 getter 返回的原对象：快照不得跟随变化，也不得重新读 getter。
        if (index === 0) policy.system.maxAttempts = 9;
      },
    );
    const service = new AgentTaskService({
      repository: new AgentTaskRepository(handle.db),
      orm: handle.orm,
      executor: new ActionExecutor(grantedPermissions("fixture.read")),
      actions: () => [probe],
      execution: () => {
        executionReads += 1;
        return policy;
      },
      now: () => "2026-09-28T00:00:00.000Z",
    });
    const owner = {
      kind: "conversation",
      id: conversation.id,
      agentId: conversation.agentId,
      userId: DEFAULT_USER_ID,
    };
    service.enqueue(
      conversation.id,
      {
        calls: [
          { name: "fixture.read", arguments: {} },
          { name: "fixture.read", arguments: {} },
        ],
      },
      { owner, requestId: "queue-web" },
    );
    expect(await service.runOnce()).toBe(true);
    expect(captured.length).toBe(2);
    expect(captured[0]?.origin).toBe("system");
    expect(captured[1]?.origin).toBe("system");
    expect(captured[0]?.policyRef).toEqual({ maxAttempts: 5, retryDelayMs: 1_234 });
    expect(captured[1]?.policyRef).toEqual({ maxAttempts: 5, retryDelayMs: 1_234 });
    // 领取时复制：context 持有的是副本，不是 getter 返回的原对象。
    expect(captured[0]?.policyRef).not.toBe(policy.system);
    expect(captured[1]?.policyRef).toBe(captured[0]?.policyRef);
    // 两次调用之间不重新读 execution getter（策略在领取时读一次快照）。
    expect(captured[1]?.executionReads).toBe(captured[0]?.executionReads);
  });

  it("claims a QQ conversation as qq with no System policy even when an execution getter exists", async () => {
    const handle = openBusinessDb();
    handles.push(handle);
    ensureDefaults(handle.orm, "model");
    updateQqSettings(handle.orm, { accountId: "10001", enabled: true, expectedRevision: 1 });
    const scheme = createQqScheme(handle.orm, {
      name: "queue-qq-scheme",
      triggers: { direct_reply: false, follow_up: false, chiming_in: false, idle_topic: true },
      prompts: { ...QQ_PROMPT_DEFAULTS, judge: "synthetic" },
    });
    const bindingId = "22222222-2222-4222-8222-222222222222";
    handle.orm
      .insert(schema.qqBindings)
      .values({
        id: bindingId,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        schemeId: scheme.id,
        paused: 0,
        shareWebMemory: 0,
        memoryBatchSize: null,
        ownerIdentityRevision: null,
        revision: 1,
        authorityRevision: 1,
        createdAt: "2026-09-28T00:00:00.000Z",
        updatedAt: "2026-09-28T00:00:00.000Z",
      })
      .run();
    const conversation = new ConversationEventRepository(handle.db).ensureOneBot(bindingId);
    if (!conversation) throw new Error("missing conversation");
    const captured: ClaimCapture[] = [];
    const probe = claimProbe(captured, () => 0);
    const service = new AgentTaskService({
      repository: new AgentTaskRepository(handle.db),
      orm: handle.orm,
      executor: new ActionExecutor(grantedPermissions("fixture.read")),
      actions: () => [probe],
      execution: () =>
        ExecutionPolicySchema.parse({ system: { maxAttempts: 5, retryDelayMs: 1_234 } }),
      now: () => "2026-09-28T00:00:00.000Z",
    });
    const owner = {
      kind: "conversation",
      id: conversation.id,
      agentId: conversation.agentId,
      userId: DEFAULT_USER_ID,
    };
    service.enqueue(
      conversation.id,
      { calls: [{ name: "fixture.read", arguments: {} }] },
      { owner, requestId: "queue-qq" },
    );
    expect(await service.runOnce()).toBe(true);
    // QQ 领取＝qq 来源、无 System 策略（执行配置 getter 存在也不带）。
    expect(captured.length).toBe(1);
    expect(captured[0]?.origin).toBe("qq");
    expect(captured[0]?.policyRef).toBeUndefined();
  });

  it("claims a web conversation as system without a policy when no execution getter is configured", async () => {
    const handle = openBusinessDb();
    handles.push(handle);
    ensureDefaults(handle.orm, "model");
    const conversation = new ConversationEventRepository(handle.db).ensureWeb(
      createSession(handle.orm, "queue-web-no-getter", { modelName: "model" }).id,
      DEFAULT_USER_ID,
    );
    if (!conversation) throw new Error("missing conversation");
    const captured: ClaimCapture[] = [];
    const probe = claimProbe(captured, () => 0);
    const service = new AgentTaskService({
      repository: new AgentTaskRepository(handle.db),
      orm: handle.orm,
      executor: new ActionExecutor(grantedPermissions("fixture.read")),
      actions: () => [probe],
      now: () => "2026-09-28T00:00:00.000Z",
    });
    const owner = {
      kind: "conversation",
      id: conversation.id,
      agentId: conversation.agentId,
      userId: DEFAULT_USER_ID,
    };
    service.enqueue(
      conversation.id,
      { calls: [{ name: "fixture.read", arguments: {} }] },
      { owner, requestId: "queue-plain" },
    );
    expect(await service.runOnce()).toBe(true);
    expect(captured.length).toBe(1);
    expect(captured[0]?.origin).toBe("system");
    expect(captured[0]?.policyRef).toBeUndefined();
  });
});
