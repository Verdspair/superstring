// P7 验收链（§4.11.5 场景示例）：登记 MCP 服务 → 启用并发现 → 未授权不可调用 →
// 授予调用资格但不持续批准 → 会话返回任务 → 待审批 → 单次批准 → worker 执行 → 按需读结果。
//
// 用真实的本地 stdio MCP 对端（合成夹具）与真实 HTTP 管理接口；不接触网络与真实数据。
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentTaskService } from "../../src/server/agent/task-service";
import { createApp } from "../../src/server/app";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { McpToolHost } from "../../src/server/mcp/host";
import { createMcpManagement } from "../../src/server/mcp/management";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { FilePermissionStore, PermissionService } from "../../src/server/permissions/service";
import type { TaskDetail } from "../../src/shared/contracts/agent-task";
import type { McpStatusResponse } from "../../src/shared/contracts/mcp";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";

const echoFixture = path.join(import.meta.dir, "../fixtures/mcp/echo-server.mjs");
const handles: ReturnType<typeof openBusinessDb>[] = [];
const dirs: string[] = [];
const hosts: McpToolHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "p7-chain-"));
  dirs.push(dir);
  const mcpConfigPath = path.join(dir, "mcp-servers.json");
  const permissionPath = path.join(dir, "permissions.json");
  // 起始状态：登记存在但停用——"没有启用就没有工具"。
  writeFileSync(
    mcpConfigPath,
    `${JSON.stringify(
      {
        version: 1,
        servers: [
          {
            id: "echo",
            name: "Echo",
            transport: "stdio",
            enabled: false,
            command: process.execPath,
            args: [echoFixture],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const handle = openBusinessDb();
  handles.push(handle);
  ensureDefaults(handle.orm, "model");
  const session = createSession(handle.orm, "acceptance", { modelName: "model" });
  const conversation = new ConversationEventRepository(handle.db).ensureWeb(
    session.id,
    DEFAULT_USER_ID,
  );
  if (!conversation) throw new Error("missing conversation");
  const host = new McpToolHost({ configPath: mcpConfigPath });
  hosts.push(host);
  const permissions = new PermissionService(new FilePermissionStore(permissionPath));
  const telemetry = new RuntimeTelemetry(handle.db);
  const tasks = new AgentTaskService({
    repository: new AgentTaskRepository(handle.db),
    orm: handle.orm,
    executor: new ActionExecutor(permissions),
    actions: () => host.current(),
    resolveSource: (source, owner) => permissions.sourceAccess(source, owner),
    telemetry,
  });
  const externalActions = () => host.current();
  // 脚本化模型：调用序列固定——未授权那次整轮失败；授权后先拿任务回执再收尾。
  const script = ["invoke", "invoke", "final"] as const;
  let step = 0;
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
      const next = script[step];
      step += 1;
      if (next === undefined) throw new Error("model script exhausted");
      if (next === "invoke")
        return JSON.stringify({
          kind: "invoke",
          calls: [{ name: "mcp.echo.save_note", arguments: { text: "synthetic" } }],
        });
      return JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: "reply", instructions: "acknowledge" }],
      });
    },
    async *streamChat() {
      yield "queued";
    },
  };
  const app = createApp({
    business: handle,
    gateway,
    permissions,
    tasks,
    externalActions,
    mcpManagement: createMcpManagement({ configPath: mcpConfigPath, host }),
  });
  const chat = () =>
    app.request("http://localhost/v2/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: session.id,
        client_request_id: crypto.randomUUID(),
        message: "save a note",
      }),
    });
  const say = (method: string, target: string, body?: unknown) =>
    app.request(`http://localhost${target}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { handle, host, tasks, app, chat, say, mcpConfigPath, conversation, telemetry };
}

describe("P7 acceptance chain", () => {
  it("runs register → discover → grant → task → approval → result through the real interfaces", async () => {
    const f = setup();
    const snapshot = async () =>
      (await (await f.say("GET", "/v2/mcp/servers")).json()) as McpStatusResponse;
    // ① 未启用：登记可见、没有任何工具。
    const disabled = await snapshot();
    expect(disabled.servers[0]).toMatchObject({ state: "disabled", tools: [] });

    // ② 启用并重新发现：真实子进程、真实握手。
    const enabled = await (
      await f.say("PUT", "/v2/mcp/servers", {
        expectedRevision: disabled.revision,
        servers: [
          {
            id: "echo",
            name: "Echo",
            transport: "stdio",
            enabled: true,
            command: process.execPath,
            args: [echoFixture],
          },
        ],
      })
    ).json();
    expect(enabled.servers[0].state).toBe("pending"); // 保存不等于连接
    const discovered = (await (await f.say("POST", "/v2/mcp/reload")).json()) as McpStatusResponse;
    expect(discovered.servers[0]).toMatchObject({ state: "connected" });
    const toolNames = discovered.servers[0].tools.map((tool) => tool.name).sort();
    expect(toolNames).toEqual(["big_result", "failing_tool", "read_notes", "save_note"]);

    // ③ 未授权不可调用：工具没有 grant，模型调用它整轮失败。
    const before = await f.chat();
    expect(before.status).toBe(200);
    const beforeBody = await before.text();
    expect(beforeBody).toContain("event: failed");
    expect(beforeBody).not.toContain("event: completed");

    // ④ 授予调用资格但不持续批准。
    const policy = (await (await f.say("GET", "/v2/permissions")).json()) as PermissionsResponse;
    const write = policy.resources.find((resource) => resource.resource === "mcp.echo.save_note");
    if (!write) throw new Error("write tool not advertised as a permission resource");
    expect(write.approvalRequired).toBe(true);
    const granted = (await (
      await f.say("PUT", "/v2/permissions", {
        expectedRevision: policy.revision,
        policy: {
          ...policy.policy,
          grants: [
            ...policy.policy.grants,
            {
              resource: "mcp.echo.save_note",
              revision: write.revision,
              approved: false,
              directories: [],
            },
          ],
        },
      })
    ).json()) as { policy: PermissionsResponse["policy"] };
    expect(granted.policy.grants.some((grant) => grant.resource === "mcp.echo.save_note")).toBe(
      true,
    );

    // ⑤ 会话返回任务：写工具以持久任务执行，前台正常收尾。
    const queued = await f.chat();
    expect(queued.status).toBe(200);
    const queuedBody = await queued.text();
    expect(queuedBody).toContain("event: completed");
    expect(queuedBody).toContain("queued");

    // ⑥ 待审批：worker 领取后发现需要单次批准。
    await f.tasks.runOnce();
    const listing = (await (await f.say("GET", "/v2/permissions/tasks")).json()) as {
      items: { id: string; status: string }[];
    };
    expect(listing.items).toHaveLength(1);
    const taskId = listing.items[0].id;
    expect(listing.items[0].status).toBe("waiting_approval");
    const detail = (await (
      await f.say("GET", `/v2/permissions/tasks/${taskId}`)
    ).json()) as TaskDetail;
    expect(detail.calls[0].status).toBe("waiting_approval");
    expect(detail.calls[0].argumentsPreview.text).toContain("synthetic");
    const ticket = detail.calls[0].approvalRevision;
    if (!ticket) throw new Error("missing approval ticket");

    // ⑦ 单次批准（旧票据会被拒绝），worker 执行真实工具。
    const stale = await f.say("POST", `/v2/permissions/tasks/${taskId}/approval`, {
      ordinal: 0,
      expectedApproval: "stale-ticket",
      approve: true,
    });
    expect(stale.status).toBe(409);
    const approved = await f.say("POST", `/v2/permissions/tasks/${taskId}/approval`, {
      ordinal: 0,
      expectedApproval: ticket,
      approve: true,
    });
    expect(approved.status).toBe(200);
    await f.tasks.runOnce();
    const done = (await (
      await f.say("GET", `/v2/permissions/tasks/${taskId}`)
    ).json()) as TaskDetail;
    expect(done.status).toBe("completed");
    expect(done.calls[0].status).toBe("completed");
    expect(done.calls[0].approvalRevision).toBeNull();

    // ⑧ 按需读取结果正文；票据消费后不再回传。
    const body = (await (
      await f.say("GET", `/v2/permissions/tasks/${taskId}/calls/0/result`)
    ).json()) as { status: string; text: string | null };
    expect(body.status).toBe("available");
    expect(body.text).toContain("saved");

    // ⑨ 追踪：任务 span 与父子关系（B06）。
    const taskSpan = f.handle.db
      .query("SELECT status,code,details FROM runtime_spans WHERE name='task.run' ORDER BY id DESC")
      .get() as { status: string; code: string; details: string };
    expect(taskSpan).toMatchObject({ status: "completed", code: "TASK_COMPLETED" });
    // 任务由真实 Web 轮次排队，其运行 span 尚在保质期内——父链应当接上而不是留空。
    const taskDetails = JSON.parse(taskSpan.details) as {
      parentLinked: boolean;
      originRunId: string;
    };
    expect(taskDetails).toMatchObject({ taskId, parentLinked: true });
    expect(taskDetails.originRunId.length).toBeGreaterThan(0);
    const callSpan = f.handle.db
      .query("SELECT name,status FROM runtime_spans WHERE name='task.call' AND details LIKE ?")
      .get(`%${taskId}%`) as { name: string; status: string } | null;
    expect(callSpan).toMatchObject({ status: "completed" });
  });
});
