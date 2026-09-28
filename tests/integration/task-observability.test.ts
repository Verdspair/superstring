import { afterEach, describe, expect, it } from "bun:test";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { AgentTaskService } from "../../src/server/agent/task-service";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { PermissionService } from "../../src/server/permissions/service";
import { PermissionPolicySchema } from "../../src/shared/contracts/permissions";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
});

type SpanRow = {
  span_id: string;
  parent_span_id: string | null;
  name: string;
  status: string;
  code: string;
  run_id: string | null;
  details: string;
};
type Span = Omit<SpanRow, "details"> & { details: Record<string, unknown> };

function spans(handle: ReturnType<typeof openBusinessDb>, name?: string): Span[] {
  const rows = handle.db
    .query(
      `SELECT span_id,parent_span_id,name,status,code,run_id,details FROM runtime_spans
       WHERE (? IS NULL OR name=?) ORDER BY id`,
    )
    .all(name ?? null, name ?? null) as SpanRow[];
  return rows.map((row) => ({
    ...row,
    details: JSON.parse(row.details) as Record<string, unknown>,
  }));
}

function setup() {
  const handle = openBusinessDb();
  handles.push(handle);
  ensureDefaults(handle.orm, "model");
  const telemetry = new RuntimeTelemetry(handle.db);
  const session = createSession(handle.orm, "observability", { modelName: "model" });
  const conversation = new ConversationEventRepository(handle.db).ensureWeb(
    session.id,
    DEFAULT_USER_ID,
  );
  if (!conversation) throw new Error("missing conversation");
  const actions: BuiltInAction[] = (["read", "write"] as const).map((effect) => ({
    permission: {
      resource: `fixture.${effect}`,
      revision: "v1",
      approvalRequired: effect === "write",
    },
    description: {
      name: `fixture.${effect}`,
      capability: "fixture",
      effect,
      parameters: {},
      description: effect,
    },
    async execute() {
      return { value: { status: "ok" }, sources: [] };
    },
  }));
  const policy = PermissionPolicySchema.parse({
    version: 1,
    grants: actions.map((action) => ({
      resource: action.description.name,
      revision: "v1",
      approved: false,
      directories: [],
    })),
  });
  const permissions = new PermissionService({
    read: () => ({ revision: "1", policy }),
    replace: () => ({ revision: "1", policy }),
  });
  const service = new AgentTaskService({
    repository: new AgentTaskRepository(handle.db),
    orm: handle.orm,
    executor: new ActionExecutor(permissions),
    actions: () => actions,
    resolveSource: (source, owner) => permissions.sourceAccess(source, owner),
    telemetry,
    now: () => "2026-09-28T00:00:00.000Z",
  });
  const owner = {
    kind: "conversation",
    id: conversation.id,
    agentId: conversation.agentId,
    userId: DEFAULT_USER_ID,
  };
  return { handle, telemetry, service, actions, owner, conversation };
}

describe("task and budget observability", () => {
  it("links task spans to each other and reports a missing parent honestly", async () => {
    const f = setup();
    const task = f.service.enqueue(
      f.conversation.id,
      { calls: [{ name: "fixture.read", arguments: {} }] },
      { owner: f.owner, requestId: "trace" },
    );
    await f.service.runOnce();
    const [run] = spans(f.handle, "task.run");
    expect(run).toMatchObject({ status: "completed", code: "TASK_COMPLETED" });
    expect(run.details).toMatchObject({ taskId: task.id, originRunId: null, parentLinked: false });
    const [call] = spans(f.handle, "task.call");
    expect(call.parent_span_id).toBe(run.span_id);
    expect(call).toMatchObject({ status: "completed", code: "TASK_CALL_COMPLETED" });
    expect(call.details).toMatchObject({ ordinal: 0, name: "fixture.read", effect: "read" });
  });

  it("attaches to the origin run when its span is still available and marks approval waits", async () => {
    const f = setup();
    // 任务外键要求原运行真实存在；追踪行模拟那次运行尚未过期。
    new AgentRunRepository(f.handle.db).createRun({
      runId: "run-1",
      specId: "synthetic",
      specVersion: "1",
      owner: { kind: "test", id: "run" },
      at: "2026-09-28T00:00:00.000Z",
    });
    f.telemetry.start("agent.run", { channel: "system", stage: "run", runId: "run-1" }).end();
    const task = f.service.enqueue(
      f.conversation.id,
      { calls: [{ name: "fixture.write", arguments: {} }] },
      { owner: f.owner, runId: "run-1", requestId: "approved-wait" },
    );
    await f.service.runOnce();
    const [run] = spans(f.handle, "task.run");
    expect(run).toMatchObject({ status: "deferred", code: "TASK_WAITING_APPROVAL" });
    expect(run.run_id).toBe("run-1");
    expect(run.details).toMatchObject({
      parentLinked: true,
      waitingOrdinal: 0,
      waitingReason: "approval",
    });
    expect(
      f.service.approve(
        task.id,
        0,
        (await f.service.detail(task.id))?.calls[0].approvalRevision ?? "",
      ),
    ).toBe(true);
    await f.service.runOnce();
    const runs = spans(f.handle, "task.run");
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ status: "completed", code: "TASK_COMPLETED" });
  });

  it("records a coded rejection when the task tree budget stops a model call", async () => {
    const handle = openBusinessDb();
    handles.push(handle);
    // 追踪行外键指向默认用户：新库要先播种。
    ensureDefaults(handle.orm, "model");
    const telemetry = new RuntimeTelemetry(handle.db);
    const runtime = new AgentRuntime({
      repository: new AgentRunRepository(handle.db),
      telemetry,
      model: {
        complete: async () =>
          JSON.stringify({ kind: "invoke", calls: [{ name: "fixture.read", arguments: {} }] }),
        async *streamText() {},
        completeMultimodal: async () => "",
      },
    });
    const action: BuiltInAction = {
      sandboxCallable: true,
      description: {
        name: "fixture.read",
        capability: "fixture",
        effect: "read",
        parameters: {},
        description: "read",
      },
      async execute() {
        return { value: { status: "ok" }, sources: [] };
      },
    };
    await expect(
      runtime.run(
        {
          id: "budget",
          context: "conversation",
          availableActions: [action.description],
          limits: { steps: 8 },
        },
        {
          owner: { kind: "test", id: "run" },
          actions: [action],
          authorizedTargets: ["reply"],
          outputMode: "buffered",
          usage: { calls: 0, inputUnits: 0 },
          budget: { maxCalls: 1 },
          context: {
            async read() {
              return {};
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AGENT_BUDGET_EXCEEDED" });
    const [rejection] = spans(handle, "agent.budget");
    expect(rejection).toMatchObject({ status: "failed", code: "AGENT_BUDGET_EXCEEDED" });
    expect(rejection.details).toMatchObject({ calls: 2, maxCalls: 1, rejected: "tree-budget" });
    const [run] = spans(handle, "agent.run");
    expect(run.details).toMatchObject({ budgetMaxCalls: 1, usageCalls: 2, stepCount: 1 });
  });

  it("records an over-context rejection that happens before a step exists", async () => {
    const handle = openBusinessDb();
    handles.push(handle);
    ensureDefaults(handle.orm, "model");
    const telemetry = new RuntimeTelemetry(handle.db);
    const runtime = new AgentRuntime({
      repository: new AgentRunRepository(handle.db),
      telemetry,
      model: {
        complete: async () => JSON.stringify({ kind: "none" }),
        async *streamText() {},
        completeMultimodal: async () => "",
      },
    });
    await expect(
      runtime.run(
        {
          id: "context",
          context: "conversation",
          availableActions: [],
          limits: { steps: 4, inputUnits: 1 },
        },
        {
          owner: { kind: "test", id: "run" },
          authorizedTargets: ["reply"],
          outputMode: "buffered",
          context: {
            async read() {
              return {};
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_LIMIT" });
    const [rejection] = spans(handle, "agent.budget");
    expect(rejection).toMatchObject({ status: "failed", code: "AGENT_CONTEXT_LIMIT" });
    expect(rejection.details).toMatchObject({ inputLimit: 1, rejected: "context" });
    expect(Number(rejection.details.inputUnits)).toBeGreaterThan(1);
  });
});
