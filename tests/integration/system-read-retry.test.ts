// System 只读重试接线短验收：真实 ActionExecutor + 真实 web / MCP 动作适配，全离线注入。
// 只证明：瞬时 HTTP 429/503 才重试；非 HTTP / 确定性 / 鉴权 / 未知失败不重试；写只调用一次；
// 取消能打断等待；权限与来源纪元翻转阻断复试；总时限包含等待且不重置。

import { describe, expect, it } from "bun:test";
import { ActionExecutor, type ActionGuard } from "../../src/server/agent/action-executor";
import {
  type ActionContext,
  type BuiltInAction,
  ReadRetryDeadlineError,
  type ReadRetryOptions,
} from "../../src/server/agent/built-in-actions";
import { createMcpActions } from "../../src/server/mcp/actions";
import type { McpSession } from "../../src/server/mcp/client";
import { mcpError } from "../../src/server/mcp/schema";
import { PermissionService } from "../../src/server/permissions/service";
import { createWebActions } from "../../src/server/web-access/actions";
import { BING_SEARCH_ENDPOINT } from "../../src/server/web-access/search";
import type { HostResolver } from "../../src/server/web-access/ssrf";
import type { McpCallResult, McpServerConfig, McpToolInfo } from "../../src/shared/contracts/mcp";
import type { PermissionPolicy } from "../../src/shared/contracts/permissions";

const SEARXNG_ENDPOINT = "http://127.0.0.1:8888";
const PUBLIC_URL = "https://public.example/page";
const publicResolver: HostResolver = async () => ["93.184.216.34"];
const TRANSIENT: ReadRetryOptions = { maxAttempts: 3, retryDelayMs: 10 };

function systemContext(
  retryPolicy?: ReadRetryOptions,
  overrides: { retryOrigin?: ActionContext["retryOrigin"]; signal?: AbortSignal } = {},
): ActionContext {
  const origin = overrides.retryOrigin === undefined ? "system" : overrides.retryOrigin;
  return {
    owner: { kind: "test", id: "run", agentId: "agent" },
    signal: overrides.signal ?? new AbortController().signal,
    ...(origin === undefined ? {} : { retryOrigin: origin }),
    ...(retryPolicy === undefined || origin !== "system" ? {} : { retryPolicy }),
  };
}

function permissionService(initial: PermissionPolicy) {
  let current = { revision: "1", policy: initial };
  const service = new PermissionService({
    read: () => current,
    replace: (_revision: string, next: PermissionPolicy) => {
      current = { revision: "2", policy: next };
      return current;
    },
  });
  return {
    service,
    revokeAll: () => {
      current = { revision: "2", policy: { version: 1, grants: [] } };
    },
  };
}

function grantsFor(...actions: readonly BuiltInAction[]): PermissionPolicy {
  return {
    version: 1,
    grants: actions.map((action) => ({
      resource: action.permission?.resource ?? "",
      revision: action.permission?.revision ?? "",
      approved: true,
      directories: [],
    })),
  };
}

function stubFetch(handler: (call: number, url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return handler(calls.length - 1, String(input));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function bingHtml(count: number): string {
  const rows = Array.from(
    { length: count },
    (_v, index) =>
      `<li class="b_algo"><h2><a href="https://site.example/${index}">结果 ${index}</a></h2>` +
      `<div class="b_caption"><p>摘要 ${index}</p></div></li>`,
  );
  return `<html><body><ol>${rows.join("")}</ol></body></html>`;
}

const bingOk = () =>
  new Response(bingHtml(1), { status: 200, headers: { "content-type": "text/html" } });
const pageOk = () =>
  new Response("<html><body><article><p>正文内容。</p></article></body></html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });
const searxngOk = () =>
  new Response(
    JSON.stringify({
      results: [{ title: "标题", url: "https://site.example/0", content: "摘要" }],
    }),
    { status: 200 },
  );

function retryAction(input: {
  operation: (signal: AbortSignal, remainingMs: number) => Promise<unknown>;
  isRetryableRejection: (error: unknown) => boolean;
  timeoutMs?: number;
}): BuiltInAction {
  return {
    description: {
      name: "fixture.read",
      description: "fixture read that exercises the executor retry loop",
      parameters: { type: "object", properties: {} },
      capability: "fixture",
      effect: "read",
    },
    async execute(_arguments_, context) {
      const value = await context.runReadWithRetry?.({
        timeoutMs: input.timeoutMs ?? 1_000,
        operation: input.operation,
        isRetryableRejection: input.isRetryableRejection,
      });
      return { value, sources: [] };
    },
  };
}

const MCP_CONFIG: McpServerConfig = {
  id: "notes",
  name: "Notes",
  transport: "stdio",
  enabled: true,
  trustToolAnnotations: true,
  command: "unused",
  args: [],
  env: {},
  timeoutMs: 5_000,
  maxResultChars: 1_000,
};
const MCP_READ: McpToolInfo = {
  name: "read",
  description: "read",
  inputSchema: { type: "object", properties: {} },
  readOnly: true,
};
const MCP_WRITE: McpToolInfo = { ...MCP_READ, name: "write", readOnly: false };

function mcpSetup(behavior: (call: number) => McpCallResult | Error, timeoutMs = 5_000) {
  let calls = 0;
  const session: McpSession = {
    serverId: "notes",
    serverName: "Notes",
    protocolVersion: "2025-06-18",
    listTools: async () => [MCP_READ, MCP_WRITE],
    async callTool() {
      calls += 1;
      const result = behavior(calls - 1);
      if (result instanceof Error) throw result;
      return result;
    },
    async close() {},
  };
  const actions = createMcpActions({
    sources: [{ config: { ...MCP_CONFIG, timeoutMs }, session, tools: [MCP_READ, MCP_WRITE] }],
  });
  const { service } = permissionService(grantsFor(...actions));
  return { actions, executor: new ActionExecutor(service), calls: () => calls };
}

const http429 = () => Object.assign(mcpError("MCP_HTTP_ERROR", "HTTP 429"), { status: 429 });
const http401 = () => Object.assign(mcpError("MCP_HTTP_ERROR", "HTTP 401"), { status: 401 });

describe("System 只读重试（真实 web 动作）", () => {
  it("瞬时 429 重试后成功：必应通道第二次尝试返回结果", async () => {
    const { calls, fetchImpl } = stubFetch((call) =>
      call === 0 ? new Response("rate", { status: 429 }) : bingOk(),
    );
    const [search] = createWebActions({ fetchImpl });
    const executor = new ActionExecutor(permissionService(grantsFor(search)).service);
    const observation = await executor.execute(search, { query: "x" }, systemContext(TRANSIENT));
    expect(observation.value).toMatchObject({ status: "ok", channel: "bing" });
    expect(calls.length).toBe(2);
    expect(calls[0]).toBe(`${BING_SEARCH_ENDPOINT}?q=${encodeURIComponent("x")}`);
  });

  it("503 抓取重试后成功", async () => {
    const { calls, fetchImpl } = stubFetch((call) =>
      call === 0 ? new Response("down", { status: 503 }) : pageOk(),
    );
    const [, fetchAction] = createWebActions({ fetchImpl, resolve: publicResolver });
    const executor = new ActionExecutor(permissionService(grantsFor(fetchAction)).service);
    const observation = await executor.execute(
      fetchAction,
      { url: PUBLIC_URL },
      systemContext(TRANSIENT),
    );
    expect(observation.value).toMatchObject({ status: "ok" });
    expect(calls.length).toBe(2);
  });

  it("非 HTTP 网络失败与 404 不重试：各只发起一次请求", async () => {
    const networkDown = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    const [down] = createWebActions({ fetchImpl: networkDown.fetchImpl });
    const downExecutor = new ActionExecutor(permissionService(grantsFor(down)).service);
    const failed = await downExecutor.execute(down, { query: "x" }, systemContext(TRANSIENT));
    expect(failed.value).toMatchObject({ status: "unavailable", code: "WEB_SEARCH_FAILED" });
    expect(networkDown.calls.length).toBe(1);

    const notFound = stubFetch(() => new Response("nope", { status: 404 }));
    const [missing] = createWebActions({ fetchImpl: notFound.fetchImpl });
    const missingExecutor = new ActionExecutor(permissionService(grantsFor(missing)).service);
    const missingValue = (
      await missingExecutor.execute(missing, { query: "x" }, systemContext(TRANSIENT))
    ).value as { status: string; code: string };
    expect(missingValue).toMatchObject({ status: "unavailable", code: "WEB_SEARCH_FAILED" });
    expect(notFound.calls.length).toBe(1);
  });

  it("多通道聚合：两次尝试状态一致（都 429）才整体重试；状态不一致（429+404）不重试", async () => {
    const mixed = stubFetch((_call, url) =>
      url.startsWith(SEARXNG_ENDPOINT)
        ? new Response("rate", { status: 429 })
        : new Response("gone", { status: 404 }),
    );
    const [inconsistent] = createWebActions({
      fetchImpl: mixed.fetchImpl,
      config: () => ({ version: 1, searxngEndpoint: SEARXNG_ENDPOINT }),
    });
    const inconsistentExecutor = new ActionExecutor(
      permissionService(grantsFor(inconsistent)).service,
    );
    const inconsistentValue = (
      await inconsistentExecutor.execute(inconsistent, { query: "x" }, systemContext(TRANSIENT))
    ).value as { status: string; attempts: { channel: string }[] };
    expect(inconsistentValue.status).toBe("unavailable");
    expect(inconsistentValue.attempts.map((attempt) => attempt.channel)).toEqual([
      "searxng",
      "bing",
    ]);
    expect(mixed.calls.length).toBe(2);

    const uniform = stubFetch((call, url) =>
      url.startsWith(SEARXNG_ENDPOINT)
        ? call === 0
          ? new Response("rate", { status: 429 })
          : searxngOk()
        : new Response("rate", { status: 429 }),
    );
    const [consistent] = createWebActions({
      fetchImpl: uniform.fetchImpl,
      config: () => ({ version: 1, searxngEndpoint: SEARXNG_ENDPOINT }),
    });
    const consistentExecutor = new ActionExecutor(permissionService(grantsFor(consistent)).service);
    const recovered = await consistentExecutor.execute(
      consistent,
      { query: "x" },
      systemContext(TRANSIENT),
    );
    expect(recovered.value).toMatchObject({ status: "ok", channel: "searxng" });
    expect(uniform.calls.length).toBe(3);
  });

  it("QQ 来源或无策略快照保持原一次调用，即使持续 429", async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response("rate", { status: 429 }));
    const [search] = createWebActions({ fetchImpl });
    const executor = new ActionExecutor(permissionService(grantsFor(search)).service);
    const qq = await executor.execute(
      search,
      { query: "x" },
      systemContext(TRANSIENT, { retryOrigin: "qq" }),
    );
    expect(qq.value).toMatchObject({ status: "unavailable", code: "WEB_SEARCH_FAILED" });
    expect(calls.length).toBe(1);

    const noPolicy = await executor.execute(search, { query: "x" }, systemContext(undefined));
    expect(noPolicy.value).toMatchObject({ status: "unavailable" });
    expect(calls.length).toBe(2);
  });

  it("权限翻转阻断复试：先按真实动作授权，首个 429 同步撤权，复试前硬失败", async () => {
    // 授权必须晚于动作构造：空授权会让首请求在发起前就 denied（0 次调用）。
    const { service, revokeAll } = permissionService({ version: 1, grants: [] });
    const { calls, fetchImpl } = stubFetch(() => {
      revokeAll();
      return new Response("rate", { status: 429 });
    });
    const [search] = createWebActions({ fetchImpl });
    service.replace("1", grantsFor(search));
    const executor = new ActionExecutor(service);
    await expect(
      executor.execute(search, { query: "x" }, systemContext(TRANSIENT)),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    expect(calls.length).toBe(1);
  });

  it("来源纪元翻转阻断复试：能力 off→on 后不复活旧结果", async () => {
    let epoch = 1;
    let attempts = 0;
    const guard: ActionGuard = {
      assert: () => {},
      allowed: () => true,
      sources: () => [],
      actionAllowed: () => true,
      assertAction: () => {},
      actionSources: () => [{ kind: "capability", id: "tasks", revision: String(epoch) }],
      assertSources: (_owner, sources) => {
        if (sources[0]?.revision !== String(epoch)) throw new Error("SOURCE_EPOCH_CHANGED");
      },
    };
    const action = retryAction({
      operation: async () => {
        attempts += 1;
        if (attempts === 1) {
          epoch = 2;
          throw Object.assign(new Error("rate"), { status: 429 });
        }
        return { ok: true };
      },
      isRetryableRejection: () => true,
    });
    const executor = new ActionExecutor(undefined, () => 1, guard);
    await expect(executor.execute(action, {}, systemContext(TRANSIENT))).rejects.toThrow(
      "SOURCE_EPOCH_CHANGED",
    );
    expect(attempts).toBe(1);
  });

  it("复试前与提交前各复验一次：可选来源回调记录两阶段顺序，成功重试照常返回", async () => {
    const events: string[] = [];
    let attempts = 0;
    let contextSourceChecks = 0;
    const guard: ActionGuard = {
      assert: () => {},
      allowed: () => true,
      sources: () => [],
      actionAllowed: () => true,
      assertAction: () => {},
      actionSources: () => [{ kind: "capability", id: "tasks", revision: "7" }],
      assertSources: () => {},
    };
    const action = retryAction({
      operation: async () => {
        events.push("operation");
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("rate"), { status: 429 });
        return { ok: true };
      },
      isRetryableRejection: () => true,
    });
    const executor = new ActionExecutor(undefined, () => 1, guard);
    const observation = await executor.execute(
      action,
      {},
      {
        ...systemContext(TRANSIENT),
        assertSources: () => {
          events.push("sources");
          contextSourceChecks += 1;
        },
      },
    );
    expect(observation.value).toEqual({ ok: true });
    expect(attempts).toBe(2);
    // 复试前与提交前各一次：两阶段顺序都要在，缺口即硬失败（不削 guard）。
    expect(events).toEqual(["operation", "sources", "operation", "sources"]);
    expect(contextSourceChecks).toBe(2);
  });
});

describe("System 只读重试（真实 MCP 动作）", () => {
  it("瞬时 429 重试后成功；401 与未知错误不重试", async () => {
    const retried = mcpSetup((call) =>
      call === 0 ? http429() : { text: "ok", isError: false, omittedParts: 0 },
    );
    const [readAction] = retried.actions;
    const observation = await retried.executor.execute(readAction, {}, systemContext(TRANSIENT));
    expect(observation.value).toEqual({ status: "ok", text: "ok" });
    expect(retried.calls()).toBe(2);

    const unauthorized = mcpSetup(() => http401());
    const unauthorizedValue = (
      await unauthorized.executor.execute(unauthorized.actions[0], {}, systemContext(TRANSIENT))
    ).value as { status: string; code: string };
    expect(unauthorizedValue).toMatchObject({ status: "unavailable", code: "MCP_HTTP_ERROR" });
    expect(unauthorized.calls()).toBe(1);

    const unknown = mcpSetup(() => mcpError("MCP_TOOL_LIST_CHANGED", "目录已变化"));
    const unknownValue = (
      await unknown.executor.execute(unknown.actions[0], {}, systemContext(TRANSIENT))
    ).value as { status: string; code: string };
    expect(unknownValue).toMatchObject({ status: "unavailable", code: "MCP_TOOL_LIST_CHANGED" });
    expect(unknown.calls()).toBe(1);
  });

  it("重试总时限（含等待）用尽按原 MCP_TIMEOUT 信封返回，不再消耗新尝试", async () => {
    // 间隔长于总时限，固定为首次调用；成功二次重试由上例覆盖。
    const setup = mcpSetup(() => http429(), 150);
    const [readAction] = setup.actions;
    const started = Date.now();
    const value = (
      await setup.executor.execute(
        readAction,
        {},
        systemContext({ maxAttempts: 10, retryDelayMs: 1_000 }),
      )
    ).value as { status: string; code: string };
    const elapsed = Date.now() - started;
    expect(value).toMatchObject({ status: "unavailable", code: "MCP_TIMEOUT" });
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(1_000);
    expect(setup.calls()).toBe(1);
  });

  it("写工具只调用一次，即使回调与策略快照都可用", async () => {
    const setup = mcpSetup(() => ({ text: "written", isError: false, omittedParts: 0 }));
    const writeAction = setup.actions[1];
    const observation = await setup.executor.execute(writeAction, {}, systemContext(TRANSIENT));
    expect(observation.value).toMatchObject({ status: "ok", text: "written" });
    expect(setup.calls()).toBe(1);
  });
});

describe("执行器重试循环守卫（真实 ActionExecutor）", () => {
  it("取消打断等待：不吞取消原因，也不按总时限误报", async () => {
    const controller = new AbortController();
    const reason = new Error("调用方取消");
    let attempts = 0;
    const action = retryAction({
      operation: async () => {
        attempts += 1;
        if (attempts === 1) {
          setTimeout(() => controller.abort(reason), 20);
          throw Object.assign(new Error("rate"), { status: 429 });
        }
        return { ok: true };
      },
      isRetryableRejection: () => true,
      timeoutMs: 10_000,
    });
    const executor = new ActionExecutor();
    await expect(
      executor.execute(
        action,
        {},
        systemContext({ maxAttempts: 3, retryDelayMs: 5_000 }, { signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
    expect(attempts).toBe(1);
  });

  it("总时限包含等待且不重置：等待耗尽预算后按守卫硬失败，且不再发起第二次操作", async () => {
    // 确定性前提：重试间隔（1000ms）远大于总时限（150ms），首次操作立即失败且可重试。
    // 总时限必须终结等待：恰好只发生一次操作；若等待不被总时限覆盖，循环会按完整间隔等待并发起第二次操作。
    // 不假设事件循环派发速度——重负载下首次等待可能耗尽全部预算，因此次数下界（>=2）由前述重试成功用例另行证明。
    // 用例内不自建 timer/signal；elapsed < 1000 同时证明执行器的等待在截止时终结，未按完整重试间隔挂起。
    let attempts = 0;
    const action = retryAction({
      operation: async () => {
        attempts += 1;
        throw Object.assign(new Error("rate"), { status: 429 });
      },
      isRetryableRejection: () => true,
      timeoutMs: 150,
    });
    const executor = new ActionExecutor();
    const started = Date.now();
    await expect(
      executor.execute(action, {}, systemContext({ maxAttempts: 10, retryDelayMs: 1_000 })),
    ).rejects.toBeInstanceOf(ReadRetryDeadlineError);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(140);
    expect(elapsed).toBeLessThan(1_000);
    expect(attempts).toBe(1);
  });

  it("守卫失败不被吞掉：复试前的能力复验失败原样抛出", async () => {
    let attempts = 0;
    let revoked = false;
    const guard: ActionGuard = {
      assert: () => {},
      allowed: () => true,
      sources: () => [],
      actionAllowed: () => !revoked,
      assertAction: () => {
        if (revoked) throw new Error("GUARD_REVOKED");
      },
      actionSources: () => [],
      assertSources: () => {},
    };
    const action = retryAction({
      operation: async () => {
        attempts += 1;
        if (attempts === 1) {
          revoked = true;
          throw Object.assign(new Error("rate"), { status: 503 });
        }
        return { ok: true };
      },
      isRetryableRejection: () => true,
    });
    const executor = new ActionExecutor(undefined, () => 1, guard);
    await expect(executor.execute(action, {}, systemContext(TRANSIENT))).rejects.toThrow(
      "GUARD_REVOKED",
    );
    expect(attempts).toBe(1);
  });

  it("无回调上下文保持原语义：动作直接执行一次", async () => {
    let attempts = 0;
    const raw: BuiltInAction = {
      description: {
        name: "fixture.once",
        description: "no callback context",
        parameters: { type: "object", properties: {} },
        capability: "fixture",
        effect: "read",
      },
      async execute() {
        attempts += 1;
        return { value: { ok: true }, sources: [] };
      },
    };
    const executor = new ActionExecutor();
    const observation = await executor.execute(
      raw,
      {},
      { owner: { kind: "test", id: "run" }, signal: new AbortController().signal },
    );
    expect(observation.value).toEqual({ ok: true });
    expect(attempts).toBe(1);
  });
});
