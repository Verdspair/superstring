// 联网工具的装配面：工具目录、/v2/permissions 资源投影、modules.web 开关（Web 与 QQ 两通道
// 共用 AgentTaskService.conversationActions 的广告点）与授权执行（既有执行器 + 运行时）。

import { afterEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { ActionExecutor } from "../../src/server/agent/action-executor";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { ModelRequest } from "../../src/server/agent/model-port";
import { AgentTaskService } from "../../src/server/agent/task-service";
import { createToolCatalog } from "../../src/server/agent/tool-catalog";
import { handleError } from "../../src/server/api/error-handler";
import { permissionRoutes } from "../../src/server/api/permissions";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { AgentTaskRepository } from "../../src/server/db/agent-task-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_USER_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { PermissionService } from "../../src/server/permissions/service";
import { createWebActions, WEB_PERMISSION_REVISION } from "../../src/server/web-access/actions";
import {
  ExecutionPolicySchema,
  executionPolicy,
  type PermissionPolicy,
} from "../../src/shared/contracts/permissions";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

function bingHtml(count: number): string {
  const rows = Array.from(
    { length: count },
    (_value, index) =>
      `<li class="b_algo"><h2><a href="https://site.example/${index}">结果 ${index} 标题</a></h2>` +
      `<div class="b_caption"><p>结果 ${index} 的摘要文字</p></div></li>`,
  );
  return `<html><body><ol>${rows.join("")}</ol></body></html>`;
}

function fixture() {
  const handle = openBusinessDb();
  handles.push(handle);
  ensureDefaults(handle.orm, "model");
  const conversation = new ConversationEventRepository(handle.db).ensureWeb(
    createSession(handle.orm, "web-tools", { modelName: "model" }).id,
    DEFAULT_USER_ID,
  );
  if (!conversation) throw new Error("missing conversation");
  let fetchCalls = 0;
  const fetchImpl = (async () => {
    fetchCalls += 1;
    return new Response(bingHtml(1), { status: 200, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  const actions = createWebActions({ fetchImpl });
  let policy: PermissionPolicy = {
    version: 1,
    grants: [],
    execution: ExecutionPolicySchema.parse({}),
  };
  const permissions = new PermissionService({
    read: () => ({ revision: "fixture", policy }),
    replace: (_revision, next) => {
      policy = next;
      return { revision: "fixture", policy };
    },
  });
  const executor = new ActionExecutor(permissions);
  const tasks = new AgentTaskService({
    repository: new AgentTaskRepository(handle.db),
    orm: handle.orm,
    executor,
    actions: () => actions,
    execution: () => executionPolicy(policy),
  });
  const change = (patch: Parameters<typeof ExecutionPolicySchema.parse>[0]) => {
    policy = {
      ...policy,
      execution: ExecutionPolicySchema.parse({ ...executionPolicy(policy), ...(patch as object) }),
    };
  };
  const grant = () => {
    policy = {
      ...policy,
      grants: [
        { resource: "web", approved: false, revision: WEB_PERMISSION_REVISION, directories: [] },
      ],
    };
  };
  const owner = {
    kind: "web_turn",
    id: conversation.id,
    userId: DEFAULT_USER_ID,
    agentId: conversation.agentId,
  };
  return {
    handle,
    conversation,
    actions,
    permissions,
    executor,
    tasks,
    change,
    grant,
    owner,
    calls: () => fetchCalls,
  };
}

describe("联网工具的目录与投影", () => {
  it("两个动作进入工具目录：只读、可进沙箱绑定，共用一条 web 授权", () => {
    const f = fixture();
    const catalog = createToolCatalog(f.actions);
    for (const name of ["web.search", "web.fetch"]) {
      const descriptor = catalog.get(name);
      expect(descriptor?.effect).toBe("read");
      expect(descriptor?.sandboxCallable).toBe(true);
      expect(catalog.resolve(name)?.permission).toEqual({
        resource: "web",
        revision: WEB_PERMISSION_REVISION,
        approvalRequired: false,
      });
    }
  });

  it("资源投影：web 出现在内置动作组，同一授权只投影一行", async () => {
    const f = fixture();
    const app = new Hono();
    app.onError(handleError);
    app.route(
      "/v2/permissions",
      permissionRoutes(f.permissions, () => f.actions),
    );
    const response = await app.request("/v2/permissions");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      resources: {
        name: string;
        description: string;
        effect: string;
        resource: string;
        revision: string;
        approvalRequired: boolean;
      }[];
    };
    expect(body.resources.map((resource) => resource.resource)).toEqual(["web"]);
    expect(body.resources[0]).toMatchObject({
      name: "web.search",
      effect: "read",
      revision: WEB_PERMISSION_REVISION,
      approvalRequired: false,
    });
    expect(body.resources[0].description).toContain("never instructions");
  });

  it("modules.web 关闭时不广告、打开时广告（Web 与 QQ 共用的 conversationActions）", () => {
    const f = fixture();
    const names = () =>
      f.tasks.conversationActions(f.conversation.id).map((action) => action.description.name);
    expect(names()).not.toContain("web.search");
    expect(names()).not.toContain("web.fetch");
    f.change({ modules: { web: true } });
    expect(names()).toContain("web.search");
    expect(names()).toContain("web.fetch");
    f.change({ modules: { web: false } });
    expect(names()).not.toContain("web.search");
  });
});

describe("联网工具的授权执行", () => {
  it("无 grant 拒绝且不执行；有 grant 通过并附权限来源", async () => {
    const f = fixture();
    const [search] = f.actions;
    const context = { owner: f.owner, signal: new AbortController().signal };
    await expect(f.executor.execute(search, { query: "查询" }, context)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(f.calls()).toBe(0);

    f.grant();
    const result = await f.executor.execute(search, { query: "查询" }, context);
    expect(result.value).toMatchObject({ status: "ok", channel: "bing" });
    expect(result.sources).toContainEqual({
      kind: "tool_permission",
      id: "web",
      revision: expect.any(String),
    });
    expect(f.calls()).toBe(1);
  });

  it("运行时：无授权不广告也不执行；授权后广告、调用并披露结果", async () => {
    const f = fixture();
    const owner = { kind: "test", id: "run", agentId: f.conversation.agentId };
    const run = (executor: ActionExecutor) => {
      const requests: ModelRequest[] = [];
      let decisions = 0;
      const runtime = new AgentRuntime({
        repository: new AgentRunRepository(f.handle.db),
        actionExecutor: executor,
        model: {
          complete: async (request) => {
            requests.push(request);
            decisions += 1;
            if (decisions === 1)
              return JSON.stringify({
                kind: "invoke",
                calls: [{ name: "web.search", arguments: { query: "查询" } }],
              });
            // 第二次决策必须看到上一次调用留下的观测结果。
            expect(JSON.stringify(request.messages)).toContain("结果 0 标题");
            return JSON.stringify({
              kind: "final",
              outputs: [{ kind: "inline", targetId: "reply", text: "done" }],
            });
          },
          async *streamText() {},
          completeMultimodal: async () => "",
        },
      });
      return {
        requests,
        execute: () =>
          runtime.run(
            {
              id: "web-tools",
              context: "conversation",
              availableActions: f.actions.map((action) => action.description),
              limits: { steps: 3 },
            },
            {
              owner,
              actions: f.actions,
              authorizedTargets: ["reply"],
              outputMode: "buffered",
              context: {
                async read() {
                  return {};
                },
              },
            },
          ),
      };
    };

    const denied = run(f.executor);
    await expect(denied.execute()).rejects.toMatchObject({ code: "AGENT_ACTION_UNAVAILABLE" });
    // 未授权＝不可广告：本次决策在没有任何工具的情况下做出。
    expect(denied.requests[0].tools).toEqual([]);
    expect(f.calls()).toBe(0);

    f.grant();
    const allowed = run(new ActionExecutor(f.permissions));
    const result = await allowed.execute();
    expect(result.status).toBe("completed");
    expect(allowed.requests[0].tools?.map((tool) => tool.name)).toContain("web.search");
    expect(f.calls()).toBe(1);
  });
});
