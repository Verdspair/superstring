import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Hono } from "hono";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { AgentTaskService } from "../../src/server/agent/task-service";
import { handleError } from "../../src/server/api/error-handler";
import { permissionRoutes } from "../../src/server/api/permissions";
import { createApp } from "../../src/server/app";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { PermissionService } from "../../src/server/permissions/service";
import { type AgentTask, TaskListSchema } from "../../src/shared/contracts/agent-task";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import type { PermissionPolicy } from "../../src/shared/contracts/permissions";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
function setup() {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "model");
  const session = createSession(h.orm, "task", { modelName: "model" });
  const conversation = new ConversationEventRepository(h.db).ensureWeb(
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
  const actions: BuiltInAction[] = ["read", "write"].map((effect) => ({
    permission: {
      resource: `fixture.${effect}`,
      revision: "v1",
      approvalRequired: effect === "write",
    },
    description: {
      name: `fixture.${effect}`,
      capability: "fixture",
      effect: effect as "read" | "write",
      parameters: {},
      description: effect,
    },
    async execute() {
      executed.push(effect);
      return { value: { status: "ok", text: effect }, sources: [] };
    },
  }));
  let policy: PermissionPolicy = {
    version: 1,
    grants: actions.map((a) => ({
      resource: a.description.name,
      revision: "v1",
      approved: false,
      directories: [],
    })),
  };
  const permissions = new PermissionService({
    read: () => ({ revision: "test", policy }),
    replace: (_expected, next) => {
      policy = next;
      return { revision: "test", policy };
    },
  });
  const repository = new AgentTaskRepository(h.db);
  let now = "2026-09-28T00:00:00.000Z";
  const build = () =>
    new AgentTaskService({
      repository,
      orm: h.orm,
      executor: new ActionExecutor(permissions),
      actions: () => actions,
      now: () => now,
      resolveSource: (source, actor) => permissions.sourceAccess(source, actor),
    });
  const service = build();
  const plan = { calls: actions.map((a) => ({ name: a.description.name, arguments: {} })) };
  const enqueue = (requestId = "request") =>
    service.enqueue(conversation.id, plan, { owner, requestId });
  return {
    h,
    service,
    build,
    repository,
    actions,
    permissions,
    executed,
    enqueue,
    owner,
    conversation,
    advance: () => {
      now = "2026-09-28T00:01:00.000Z";
    },
  };
}

describe("durable tool tasks", () => {
  it("checkpoints reads and releases its lease for one-call approval, without changing grants", async () => {
    const f = setup();
    const task = f.enqueue();
    expect(f.enqueue().id).toBe(task.id);
    await f.service.runOnce();
    const waiting = f.service.inspect(task.id) as AgentTask;
    expect(waiting.status).toBe("waiting_approval");
    expect(waiting.leaseToken).toBeNull();
    expect(f.executed).toEqual(["read"]);
    const restarted = f.build();
    expect(restarted.approve(task.id, 1, waiting.calls[1].approvalRevision as string)).toBe(true);
    expect(restarted.approve(task.id, 1, waiting.calls[1].approvalRevision as string)).toBe(false);
    await restarted.runOnce();
    expect(f.executed).toEqual(["read", "write"]);
    expect(f.repository.get(task.id)?.status).toBe("completed");
    expect(f.permissions.snapshot().policy.grants[1].approved).toBe(false);
    const next = f.enqueue("another-request");
    await restarted.runOnce();
    expect(f.repository.get(next.id)?.status).toBe("waiting_approval");
    expect(() =>
      restarted.approve(next.id, 1, waiting.calls[1].approvalRevision as string),
    ).toThrow();
  });
  it("queues from Web without waiting for approval and keeps approval off the model surface", async () => {
    const f = setup();
    let calls = 0;
    const gateway: ModelGateway = {
      config: { baseUrl: "http://synthetic.invalid", model: "model", timeoutSeconds: 1 },
      async loadedContextCapacity() {
        return 200_000;
      },
      async listModels() {
        return ["model"];
      },
      async probeModelLoaded() {
        return true;
      },
      async complete() {
        return ++calls === 1
          ? JSON.stringify({
              kind: "invoke",
              calls: [{ name: "fixture.write", arguments: { note: "synthetic" } }],
            })
          : JSON.stringify({
              kind: "final",
              outputs: [
                { kind: "generate", targetId: "reply", instructions: "acknowledge queued task" },
              ],
            });
      },
      async *streamChat() {
        yield "queued";
      },
    };
    const app = createApp({
      business: f.h,
      gateway,
      permissions: f.permissions,
      externalActions: () => f.actions,
      tasks: f.service,
    });
    const response = await app.request("http://localhost/v2/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: f.conversation.sourceId,
        client_request_id: crypto.randomUUID(),
        message: "write a note",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("completed");
    expect(f.executed).toEqual([]);
    await f.service.runOnce();
    const task = f.repository.list(f.conversation.id)[0];
    expect(task.status).toBe("waiting_approval");
    expect(task.leaseToken).toBeNull();
    const approval = {
      ordinal: 0,
      expectedApproval: task.calls[0].approvalRevision,
      approve: true,
    };
    const rejected = await app.request(
      `http://localhost/v2/permissions/tasks/${task.id}/approval`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://untrusted.invalid" },
        body: JSON.stringify(approval),
      },
    );
    expect(rejected.status).toBe(403);
    const approved = await app.request(
      `http://localhost/v2/permissions/tasks/${task.id}/approval`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost" },
        body: JSON.stringify(approval),
      },
    );
    expect(approved.status).toBe(200);
    await f.service.runOnce();
    expect(f.executed).toEqual(["write"]);
    expect(f.repository.get(task.id)?.status).toBe("completed");
  });

  it("never replays an interrupted write, while an interrupted read can be reclaimed", async () => {
    const f = setup();
    const task = f.enqueue();
    const claimed = f.repository.claim("2026-09-28T00:00:00.000Z", 1000) as AgentTask;
    f.repository.beginCall(task.id, claimed.leaseToken as string, 1, "2026-09-28T00:00:00.000Z");
    f.advance();
    await f.service.runOnce();
    expect(f.repository.get(task.id)?.status).toBe("unknown");
    expect(f.executed).toEqual([]);
    const second = f.enqueue("read-recovery");
    const read = f.repository.claim("2026-09-28T00:01:00.000Z", 1000) as AgentTask;
    f.repository.beginCall(second.id, read.leaseToken as string, 0, "2026-09-28T00:01:00.000Z");
    f.repository.recover("2026-09-28T00:02:00.000Z");
    expect(f.repository.get(second.id)?.status).toBe("queued");
    expect(f.repository.get(second.id)?.calls[0].status).toBe("pending");
  });
  it("revocation redacts task arguments and checkpoints and prevents approval", async () => {
    const f = setup();
    const task = f.enqueue();
    await f.service.runOnce();
    f.permissions.replace("test", { version: 1, grants: [] });
    const redacted = f.service.inspect(task.id) as AgentTask;
    expect(redacted.status).toBe("failed");
    expect(redacted.calls.every((call) => call.arguments === null && call.result === null)).toBe(
      true,
    );
    expect(f.service.approve(task.id, 1, "stale")).toBe(false);
  });
  it("keeps checkpoints readable when paused, but blocks execution without deleting the result", async () => {
    const f = setup();
    const task = f.enqueue();
    await f.service.runOnce();
    f.h.db.query("UPDATE agents SET is_active=0 WHERE id=?").run(f.owner.agentId);
    expect(f.service.inspect(task.id)?.calls[0].result).toMatchObject({ text: "read" });
    expect(f.service.cancel(task.id)).toBe(true);
    expect(f.repository.get(task.id)?.status).toBe("cancelled");
    expect(f.repository.get(task.id)?.calls[0].result).toMatchObject({ text: "read" });
  });
  it("invalidates a task observation when its state changes within the same clock tick", async () => {
    const f = setup();
    const task = f.enqueue();
    await f.service.runOnce();
    const read = f.service
      .actions(f.conversation.id)
      .find((action) => action.description.name === "task.read");
    if (!read) throw new Error("missing task reader");
    const result = await read.execute(
      { taskId: task.id },
      { owner: f.owner, signal: new AbortController().signal },
    );
    const ref = result.sources.find((source) => source.kind === "agent_task");
    if (!ref) throw new Error("missing task source");
    expect(f.service.sourceAccess(ref, f.owner)).toBe("available");
    f.service.approve(task.id, 1, f.repository.get(task.id)?.calls[1].approvalRevision as string);
    await f.service.runOnce();
    expect(f.service.sourceAccess(ref, f.owner)).toBe("revoked");
  });
  it("pages result bodies without splitting Unicode and revalidates each page", async () => {
    const f = setup();
    f.actions[0].execute = async () => ({ value: { text: "资料🧪".repeat(100) }, sources: [] });
    const task = f.enqueue();
    await f.service.runOnce();
    const read = f.service
      .actions(f.conversation.id)
      .find((action) => action.description.name === "task.read");
    if (!read) throw new Error("missing task reader");
    const context = { owner: f.owner, signal: new AbortController().signal };
    const expected = JSON.stringify(f.repository.get(task.id)?.calls[0].result);
    const parts: string[] = [];
    let offset: number | null = 0;
    do {
      const page = await read.execute({ taskId: task.id, ordinal: 0, offset, limit: 37 }, context);
      const result = (page.value as { result: { text: string; nextOffset: number | null } }).result;
      expect([...result.text].length).toBeLessThanOrEqual(37);
      parts.push(result.text);
      offset = result.nextOffset;
    } while (offset !== null);
    expect(parts.join("")).toBe(expected);
    f.permissions.replace("test", { version: 1, grants: [] });
    await expect(read.execute({ taskId: task.id, ordinal: 0 }, context)).rejects.toMatchObject({
      code: "TASK_SOURCE_INVALID",
    });
  });
  it("does not store source-invalid input, or accept another conversation's actor", () => {
    const f = setup();
    const calls = [{ name: "fixture.read", arguments: { secret: "synthetic" } }];
    expect(() =>
      f.service.enqueue(
        f.conversation.id,
        { calls },
        {
          owner: f.owner,
          sources: [{ kind: "missing", id: "gone", revision: "1" }],
        },
      ),
    ).toThrow("TASK_SOURCE_INVALID");
    expect(f.repository.list(f.conversation.id)).toEqual([]);
    expect(() =>
      f.service.enqueue(
        f.conversation.id,
        { calls },
        {
          owner: { ...f.owner, id: "another-conversation" },
        },
      ),
    ).toThrow("TASK_AUTHORITY_CHANGED");
  });
  it("does not claim two external tasks from one conversation at once", () => {
    const f = setup();
    f.enqueue("one");
    f.enqueue("two");
    expect(f.repository.claim("2026-09-28T00:00:00.000Z", 1000)).not.toBeNull();
    expect(f.repository.claim("2026-09-28T00:00:00.000Z", 1000)).toBeNull();
  });
  it("binds tasks to their conversation and denies undeclared tools rather than widening grants", () => {
    const f = setup();
    const task = f.enqueue();
    expect(f.service.inspect(task.id, "another-conversation")).toBeNull();
    expect(() =>
      f.service.enqueue(
        f.conversation.id,
        { calls: [{ name: "install.skill", arguments: {} }] },
        { owner: f.owner },
      ),
    ).toThrow("TASK_ACTION_UNAVAILABLE");
    expect(f.service.actions(f.conversation.id).map((action) => action.description.name)).toEqual([
      "task.start",
      "task.read",
    ]);
  });
  it("revalidates every planned tool revision before starting the first call", async () => {
    const f = setup();
    const task = f.enqueue();
    f.actions[1] = {
      ...f.actions[1],
      permission: { resource: "fixture.write", revision: "v2", approvalRequired: true },
    };
    await f.service.runOnce();
    expect(f.executed).toEqual([]);
    expect(f.repository.get(task.id)?.errorCode).toBe("PERMISSION_REVISION_CHANGED");
  });
  it("expires task payloads and never persists arbitrary failure text as a diagnostic code", async () => {
    const f = setup();
    f.actions[0].execute = async () => {
      throw Object.assign(new Error("private provider text"), { code: "private provider text" });
    };
    const failed = f.enqueue();
    await f.service.runOnce();
    expect(f.repository.get(failed.id)?.errorCode).toBe("TASK_FAILED");
    f.repository.expire("2026-10-01T00:00:00.000Z");
    expect(
      f.repository
        .get(failed.id)
        ?.calls.every((call) => call.arguments === null && call.result === null),
    ).toBe(true);
  });
  it("expires waiting approvals without letting the stale task block new ones", async () => {
    const f = setup();
    const task = f.enqueue();
    await f.service.runOnce();
    const waiting = f.repository.get(task.id) as AgentTask;
    expect(waiting.status).toBe("waiting_approval");
    f.h.db
      .query("UPDATE agent_tasks SET expires_at=? WHERE id=?")
      .run("2026-09-27T23:59:59.000Z", task.id);
    // 过期后旧 payload 不能再用：批准 fail-closed 地终态化任务并给出 TASK_EXPIRED。
    expect(f.service.approve(task.id, 1, waiting.calls[1].approvalRevision as string)).toBe(false);
    expect(f.repository.get(task.id)?.status).toBe("failed");
    expect(f.repository.get(task.id)?.errorCode).toBe("TASK_EXPIRED");
    // 同一会话的新任务照常入队运行，不被过期任务挡住。
    const next = f.enqueue("another-request");
    await f.service.runOnce();
    expect(f.repository.get(next.id)?.status).toBe("waiting_approval");
  });
  it("cancels an in-flight write without accepting its late result or retrying", async () => {
    const f = setup();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    f.actions[1].execute = async () => {
      entered.resolve();
      await finish.promise;
      return { value: { status: "ok" }, sources: [] };
    };
    const task = f.enqueue();
    await f.service.runOnce();
    f.service.approve(task.id, 1, f.repository.get(task.id)?.calls[1].approvalRevision as string);
    const running = f.service.runOnce();
    await entered.promise;
    expect(f.service.cancel(task.id)).toBe(true);
    finish.resolve();
    await running;
    expect(f.repository.get(task.id)?.status).toBe("unknown");
    expect(f.repository.get(task.id)?.calls[1].result).toBeNull();
    expect(await f.service.runOnce()).toBe(false);
  });
});

function management(f: ReturnType<typeof setup>) {
  const app = new Hono();
  app.onError(handleError);
  app.route(
    "/v2/permissions",
    permissionRoutes(f.permissions, () => f.actions, f.service),
  );
  return app;
}

describe("task management projections", () => {
  it("pages authorized summaries without reading call bodies or exposing worker leases", async () => {
    const f = setup();
    const first = f.enqueue("first");
    const second = f.enqueue("second");
    const third = f.enqueue("third");
    f.repository.claim("2026-09-28T00:00:00.000Z", 30_000);
    const app = management(f);
    const read = spyOn(f.repository, "get");
    try {
      const response = await app.request("/v2/permissions/tasks?limit=2");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const page = await response.json();
      expect(page.items).toHaveLength(2);
      expect(page.hasMore).toBe(true);
      expect(page.items[0].callCount).toBe(2);
      expect(read).not.toHaveBeenCalled();
      expect(JSON.stringify(page)).not.toMatch(
        /leaseToken|leaseExpiresAt|arguments|result|sources/,
      );
      const next = await (
        await app.request(
          `/v2/permissions/tasks?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`,
        )
      ).json();
      expect(next.hasMore).toBe(false);
      expect(next.nextCursor).toBeNull();
      expect(new Set([...page.items, ...next.items].map((task) => task.id))).toEqual(
        new Set([first.id, second.id, third.id]),
      );
    } finally {
      read.mockRestore();
    }
  });

  it("filters visibility before paging and supports conversation, Agent, status and source-run filters", async () => {
    const f = setup();
    const hidden = f.enqueue("hidden");
    f.h.db
      .query("UPDATE conversations SET closed_at=? WHERE id=?")
      .run("2026-09-28T00:00:01.000Z", f.conversation.id);
    const session = createSession(f.h.orm, "visible", { modelName: "model" });
    const conversation = new ConversationEventRepository(f.h.db).ensureWeb(
      session.id,
      DEFAULT_USER_ID,
    ) as ConversationSummary;
    const task = f.service.enqueue(
      conversation.id,
      { calls: [{ name: "fixture.read", arguments: {} }] },
      {
        owner: { ...f.owner, id: conversation.id },
        requestId: "visible",
      },
    );
    const app = management(f);
    const page = TaskListSchema.parse(
      await (await app.request("/v2/permissions/tasks?limit=1")).json(),
    );
    expect(page.items.map((item) => item.id)).toEqual([task.id]);
    expect(page.hasMore).toBe(false);
    expect((await app.request(`/v2/permissions/tasks/${hidden.id}`)).status).toBe(404);
    const matching = TaskListSchema.parse(
      await (
        await app.request(
          `/v2/permissions/tasks?conversationId=${conversation.id}&agentId=${conversation.agentId}&status=queued`,
        )
      ).json(),
    );
    expect(matching.items.map((item) => item.id)).toEqual([task.id]);
    expect(
      (await (await app.request("/v2/permissions/tasks?status=completed")).json()).items,
    ).toEqual([]);
    expect(
      (await (await app.request(`/v2/permissions/tasks?originRunId=${crypto.randomUUID()}`)).json())
        .items,
    ).toEqual([]);
  });

  it("returns bounded argument previews and paged bodies with approval tickets but no internal fields", async () => {
    const f = setup();
    f.actions[0].execute = async () => ({
      value: { text: "资料\u{1D11E}".repeat(50) },
      sources: [],
    });
    const task = f.service.enqueue(
      f.conversation.id,
      {
        calls: [
          { name: "fixture.read", arguments: { text: "x".repeat(3000) } },
          { name: "fixture.write", arguments: { text: "synthetic" } },
        ],
      },
      { owner: f.owner },
    );
    await f.service.runOnce();
    const app = management(f);
    const detail = await (await app.request(`/v2/permissions/tasks/${task.id}`)).json();
    expect(detail.dataStatus).toBe("available");
    expect(detail.calls[1].approvalRevision).toBeTruthy();
    expect(detail.calls[0].argumentsPreview.text.length).toBeLessThanOrEqual(512);
    expect(detail.calls[0].argumentsPreview.nextOffset).toBe(512);
    expect(detail.calls[0].resultStatus).toBe("available");
    expect(JSON.stringify(detail)).not.toMatch(/leaseToken|leaseExpiresAt|"result":|"sources":/);
    const expected = JSON.stringify(f.repository.get(task.id)?.calls[0].result);
    let offset: number | null = 0;
    const parts: string[] = [];
    do {
      const page = await (
        await app.request(
          `/v2/permissions/tasks/${task.id}/calls/0/result?offset=${offset}&limit=17`,
        )
      ).json();
      expect(page.status).toBe("available");
      expect([...page.text].length).toBeLessThanOrEqual(17);
      parts.push(page.text);
      offset = page.nextOffset;
    } while (offset !== null);
    expect(parts.join("")).toBe(expected);
    const args = await (
      await app.request(`/v2/permissions/tasks/${task.id}/calls/0/arguments?offset=512&limit=100`)
    ).json();
    expect(args.offset).toBe(512);
    expect(args.text).toHaveLength(100);
    f.permissions.replace("test", { version: 1, grants: [] });
    const revoked = await (
      await app.request(`/v2/permissions/tasks/${task.id}/calls/0/result`)
    ).json();
    expect(revoked).toMatchObject({ status: "revoked", text: null, nextOffset: null });
    const redacted = await (await app.request(`/v2/permissions/tasks/${task.id}`)).json();
    expect(redacted.calls[1].approvalRevision).toBeNull();
    expect(redacted.calls[0].argumentsPreview.text).toBeNull();
  });

  it("keeps completed null results distinct from pending and expired bodies", async () => {
    const f = setup();
    f.actions[0].execute = async () => ({ value: null, sources: [] });
    const task = f.enqueue();
    const app = management(f);
    const endpoint = `/v2/permissions/tasks/${task.id}/calls/0/result`;
    expect(await (await app.request(endpoint)).json()).toMatchObject({
      status: "pending",
      text: null,
    });
    await f.service.runOnce();
    expect(await (await app.request(endpoint)).json()).toMatchObject({
      status: "available",
      text: "null",
    });
    f.h.db
      .query("UPDATE agent_tasks SET expires_at=? WHERE id=?")
      .run("2026-09-27T00:00:00.000Z", task.id);
    expect(await (await app.request(endpoint)).json()).toMatchObject({
      status: "expired",
      text: null,
    });
  });

  it("rejects malformed filters, cursors, identifiers and oversized body pages", async () => {
    const f = setup();
    const task = f.enqueue();
    const app = management(f);
    for (const query of [
      "limit=0",
      "limit=201",
      "cursor=invalid",
      "status=made-up",
      "extra=true",
      "agentId=other",
    ])
      expect((await app.request(`/v2/permissions/tasks?${query}`)).status).toBe(422);
    expect((await app.request("/v2/permissions/tasks/not-an-id")).status).toBe(422);
    expect((await app.request(`/v2/permissions/tasks/${task.id}/calls/-1/result`)).status).toBe(
      422,
    );
    expect(
      (await app.request(`/v2/permissions/tasks/${task.id}/calls/0/result?limit=4097`)).status,
    ).toBe(422);
    expect((await app.request(`/v2/permissions/tasks/${task.id}/calls/15/result`)).status).toBe(
      404,
    );
  });
});
