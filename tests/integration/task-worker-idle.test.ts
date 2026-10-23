import { afterEach, describe, expect, it } from "bun:test";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { AgentTaskService } from "../../src/server/agent/task-service";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { PermissionService } from "../../src/server/permissions/service";
import type { AgentTask } from "../../src/shared/contracts/agent-task";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import {
  type ExecutionPolicy,
  ExecutionPolicySchema,
  type PermissionPolicy,
} from "../../src/shared/contracts/permissions";

// Idle ticks skip catalog preparation and claim transactions without skipping recovery or expiry.

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function fixture() {
  const handle = openBusinessDb();
  handles.push(handle);
  ensureDefaults(handle.orm, "model");
  const session = createSession(handle.orm, "task-idle", { modelName: "model" });
  const conversation = new ConversationEventRepository(handle.db).ensureWeb(
    session.id,
    DEFAULT_USER_ID,
  ) as ConversationSummary;
  const owner = {
    kind: "conversation",
    id: conversation.id,
    agentId: conversation.agentId,
    userId: DEFAULT_USER_ID,
  };

  const executed: string[] = [];
  const read: BuiltInAction = {
    permission: { resource: "fixture.read", revision: "v1", approvalRequired: false },
    description: {
      name: "fixture.read",
      capability: "fixture",
      effect: "read",
      parameters: {},
      description: "read",
    },
    async execute() {
      executed.push("read");
      return { value: { status: "ok", text: "read" }, sources: [] };
    },
  };

  let policy: PermissionPolicy = {
    version: 1,
    grants: [{ resource: "fixture.read", revision: "v1", approved: false, directories: [] }],
  };
  const permissions = new PermissionService({
    read: () => ({ revision: "test", policy }),
    replace: (_expected, next) => {
      policy = next;
      return { revision: "test", policy };
    },
  });

  const repository = new AgentTaskRepository(handle.db);
  let now = "2026-09-28T00:00:00.000Z";
  let actionCalls = 0;
  let claimCalls = 0;

  // Passthrough proxy: observe claim calls without replacing its behavior. The service receives
  // this same object, so no test-only seam is added to the product. Enqueue itself resolves the
  // plan against the action catalog, so every non-idle test resets the counters right before the
  // tick under test.
  const observedRepository = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "claim") {
        return (
          at: string,
          leaseMs: number,
          pausedNames?: readonly string[],
          pausedPrefixes?: readonly string[],
        ) => {
          claimCalls += 1;
          return target.claim(at, leaseMs, pausedNames, pausedPrefixes);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const build = (options?: { execution?: () => ExecutionPolicy }) =>
    new AgentTaskService({
      repository: observedRepository,
      orm: handle.orm,
      executor: new ActionExecutor(permissions),
      actions: () => {
        actionCalls += 1;
        return [read];
      },
      now: () => now,
      ...(options?.execution === undefined ? {} : { execution: options.execution }),
      resolveSource: (source, actor) => permissions.sourceAccess(source, actor),
    });

  const service = build();
  const plan = { calls: [{ name: "fixture.read", arguments: {} }] };
  const enqueue = (requestId = "request") =>
    service.enqueue(conversation.id, plan, { owner, requestId });
  const totalChanges = () =>
    (handle.db.query("SELECT total_changes() AS total").get() as { total: number }).total;

  return {
    handle,
    repository,
    build,
    service,
    enqueue,
    executed,
    totalChanges,
    actionCalls: () => actionCalls,
    claimCalls: () => claimCalls,
    resetCounters: () => {
      actionCalls = 0;
      claimCalls = 0;
    },
    now: () => now,
    advanceBy: (ms: number) => {
      now = new Date(Date.parse(now) + ms).toISOString();
    },
  };
}

describe("idle tool-task worker", () => {
  it("does nothing on an empty queue: no action catalog, no claim write transaction", async () => {
    const f = fixture();
    const changesBefore = f.totalChanges();
    const idle = await f.service.runOnce();
    expect(idle).toBe(false);
    expect(f.actionCalls()).toBe(0);
    expect(f.claimCalls()).toBe(0);
    // The claim path owns the BEGIN IMMEDIATE transaction; an idle tick must not write at all.
    expect(f.totalChanges()).toBe(changesBefore);
  });

  it("keeps an idle tick idle after the only task reached a terminal state", async () => {
    const f = fixture();
    const task = f.enqueue();
    expect(await f.service.runOnce()).toBe(true);
    expect(f.repository.get(task.id)?.status).toBe("completed");
    f.resetCounters();
    const changesBefore = f.totalChanges();
    expect(await f.service.runOnce()).toBe(false);
    expect(f.actionCalls()).toBe(0);
    expect(f.claimCalls()).toBe(0);
    expect(f.totalChanges()).toBe(changesBefore);
  });

  it("still executes a queued task on the same tick", async () => {
    const f = fixture();
    const task = f.enqueue();
    f.resetCounters();
    expect(await f.service.runOnce()).toBe(true);
    expect(f.executed).toEqual(["read"]);
    expect(f.repository.get(task.id)?.status).toBe("completed");
    expect(f.actionCalls()).toBeGreaterThan(0);
    expect(f.claimCalls()).toBe(1);
  });

  it("still recovers an expired lease and runs the reclaimed task", async () => {
    const f = fixture();
    const task = f.enqueue();
    const claimed = f.repository.claim(f.now(), 1_000) as AgentTask | null;
    expect(claimed?.status).toBe("running");
    expect(claimed?.leaseToken).not.toBeNull();
    f.advanceBy(60_000);
    f.resetCounters();
    expect(await f.service.runOnce()).toBe(true);
    expect(f.executed).toEqual(["read"]);
    expect(f.repository.get(task.id)?.status).toBe("completed");
    expect(f.repository.get(task.id)?.leaseToken).toBeNull();
    expect(f.claimCalls()).toBe(1);
  });

  it("still terminates an expired queued task before it can run", async () => {
    const f = fixture();
    const task = f.enqueue();
    f.handle.db
      .query("UPDATE agent_tasks SET expires_at=? WHERE id=?")
      .run("2026-09-27T23:59:59.000Z", task.id);
    f.resetCounters();
    expect(await f.service.runOnce()).toBe(false);
    expect(f.executed).toEqual([]);
    expect(f.repository.get(task.id)?.status).toBe("failed");
    expect(f.repository.get(task.id)?.errorCode).toBe("TASK_EXPIRED");
  });

  it("still refuses a paused call and runs it once the pause is lifted", async () => {
    const f = fixture();
    const paused = f.build({
      execution: () => ExecutionPolicySchema.parse({ pausedTools: ["fixture.read"] }),
    });
    const task = f.enqueue();
    f.resetCounters();
    expect(await paused.runOnce()).toBe(false);
    expect(f.executed).toEqual([]);
    expect(f.repository.get(task.id)?.status).toBe("queued");
    // The queue is real work: the catalog is built once and claim is attempted, then refused.
    expect(f.actionCalls()).toBe(1);
    expect(f.claimCalls()).toBe(1);

    expect(await f.build().runOnce()).toBe(true);
    expect(f.executed).toEqual(["read"]);
    expect(f.repository.get(task.id)?.status).toBe("completed");
  });
});
