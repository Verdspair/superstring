import { afterEach, describe, expect, it } from "bun:test";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { AgentTaskService } from "../../src/server/agent/task-service";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { PermissionService } from "../../src/server/permissions/service";
import {
  ExecutionPolicySchema,
  executionPolicy,
  type PermissionPolicy,
} from "../../src/shared/contracts/permissions";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function fixture() {
  const handle = openBusinessDb();
  handles.push(handle);
  ensureDefaults(handle.orm, "model");
  const journal = new ConversationEventRepository(handle.db);
  const conversations = ["a", "b"].map(
    (name) =>
      journal.ensureWeb(
        createSession(handle.orm, name, { modelName: "model" }).id,
        DEFAULT_USER_ID,
      )!,
  );
  const calls: string[] = [];
  const actions: BuiltInAction[] = ["mcp.demo.read", "skill.demo.write"].map((name) => ({
    permission: { resource: name, revision: "v1", approvalRequired: name.startsWith("skill.") },
    description: {
      name,
      capability: "fixture",
      description: name,
      effect: name.startsWith("skill.") ? "write" : "read",
      parameters: {},
    },
    async execute() {
      calls.push(name);
      return { value: { status: "ok" }, sources: [] };
    },
  }));
  let policy: PermissionPolicy = {
    version: 1,
    grants: actions.map((action) => ({
      resource: action.description.name,
      revision: "v1",
      approved: true,
      directories: [],
    })),
    execution: ExecutionPolicySchema.parse({}),
  };
  const permissions = new PermissionService({
    read: () => ({ revision: "fixture", policy }),
    replace: (_revision, next) => {
      policy = next;
      return { revision: "fixture", policy };
    },
  });
  const repository = new AgentTaskRepository(handle.db);
  let clock = Date.parse("2026-09-28T12:00:00.000Z");
  const create = () =>
    new AgentTaskService({
      repository,
      orm: handle.orm,
      executor: new ActionExecutor(permissions),
      actions: () => actions,
      execution: () => executionPolicy(policy),
      now: () => new Date(clock).toISOString(),
    });
  const service = create();
  const owner = (index = 0) => ({
    kind: "conversation",
    id: conversations[index].id,
    agentId: conversations[index].agentId,
    userId: DEFAULT_USER_ID,
  });
  const enqueue = (names = actions.map((action) => action.description.name), index = 0) => {
    clock += 1;
    return service.enqueue(
      conversations[index].id,
      { calls: names.map((name) => ({ name, arguments: {} })) },
      { owner: owner(index), requestId: crypto.randomUUID() },
    );
  };
  const change = (patch: Parameters<typeof ExecutionPolicySchema.parse>[0]) =>
    permissions.replace("fixture", {
      ...policy,
      execution: ExecutionPolicySchema.parse({ ...executionPolicy(policy), ...(patch as object) }),
    });
  return {
    conversations,
    actions,
    service,
    repository,
    calls,
    enqueue,
    change,
    create,
    permissions,
    owner,
  };
}

describe("module soft pause", () => {
  it("keeps the current whole task running, stops new claims and resumes queued work", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const execute = f.actions[0].execute;
    f.actions[0].execute = async (...args) => {
      entered.resolve();
      await release.promise;
      return execute(...args);
    };
    const first = f.enqueue();
    const second = f.enqueue(undefined, 1);
    const running = f.service.runOnce();
    await entered.promise;
    f.change({ modules: { tasks: false } });
    expect(await f.service.runOnce()).toBe(false);
    expect(f.repository.get(second.id)?.status).toBe("queued");
    release.resolve();
    await running;
    expect(f.repository.get(first.id)?.status).toBe("completed");
    expect(f.calls).toEqual(["mcp.demo.read", "skill.demo.write"]);
    expect(
      f.service.conversationActions(f.conversations[0].id).map((action) => action.description.name),
    ).not.toContain("task.start");
    f.change({ modules: { tasks: true } });
    await f.create().runOnce();
    expect(f.repository.get(second.id)?.status).toBe("completed");
  });

  it("expires queued payloads even while task execution is paused", async () => {
    const f = fixture();
    const task = f.enqueue();
    f.change({ modules: { tasks: false } });
    f.repository.db
      .query("UPDATE agent_tasks SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?")
      .run(task.id);
    expect(await f.service.runOnce()).toBe(false);
    expect(f.repository.get(task.id)?.calls.every((call) => call.arguments === null)).toBe(true);
  });

  it("rejects unavailable configuration asynchronously without claiming queued work", async () => {
    const f = fixture();
    const task = f.enqueue();
    const service = new AgentTaskService({
      repository: f.repository,
      orm: handles[handles.length - 1].orm,
      executor: new ActionExecutor(f.permissions),
      actions: () => f.actions,
      now: () => "2026-09-28T12:00:01.000Z",
      execution: () => {
        throw new Error("PERMISSION_POLICY_INVALID");
      },
    });
    const attempt = service.runOnce();
    expect(attempt).toBeInstanceOf(Promise);
    await expect(attempt).rejects.toThrow("PERMISSION_POLICY_INVALID");
    expect(f.repository.get(task.id)?.status).toBe("queued");
  });

  it("pauses undetected module tasks without marking them failed", async () => {
    const f = fixture();
    const task = f.enqueue(["mcp.demo.read"]);
    f.change({ modules: { mcp: false } });
    f.actions.splice(0, 1);
    expect(await f.service.runOnce()).toBe(false);
    expect(f.repository.get(task.id)?.status).toBe("queued");
  });

  it("does not invalidate evidence or approval when usage is paused", async () => {
    const f = fixture();
    const ref = f.permissions.source(f.actions[0].permission!);
    const task = f.enqueue(["mcp.demo.read"]);
    f.change({ pausedTools: ["mcp.demo.read"] });
    expect(f.permissions.sourceAccess(ref, f.owner())).toBe("available");
    expect(await f.service.runOnce()).toBe(false);
    expect(f.repository.get(task.id)?.status).toBe("queued");
    expect(
      f.service.conversationActions(f.conversations[0].id).map((action) => action.description.name),
    ).not.toContain("mcp.demo.read");
    f.change({ pausedTools: [] });
    await f.service.runOnce();
    expect(f.repository.get(task.id)?.status).toBe("completed");
  });

  it("skips a paused module without starving runnable tasks and blocks forged plans", async () => {
    const f = fixture();
    const paused = f.enqueue(["mcp.demo.read"]);
    const ready = f.enqueue(["skill.demo.write"], 1);
    f.change({ modules: { mcp: false } });
    await f.service.runOnce();
    expect(f.repository.get(paused.id)?.status).toBe("queued");
    expect(f.repository.get(ready.id)?.status).toBe("completed");
    const start = f.service
      .actions(f.conversations[0].id)
      .find((action) => action.description.name === "task.start")!;
    await expect(
      start.execute(
        { calls: [{ name: "mcp.demo.read", arguments: {} }] },
        { owner: f.owner(), signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "TASK_ACTION_UNAVAILABLE" });
    f.permissions.replace("fixture", {
      version: 1,
      grants: [],
      execution: ExecutionPolicySchema.parse({}),
    });
    await f.service.runOnce();
    expect(f.repository.get(paused.id)?.status).not.toBe("completed");
  });
});
