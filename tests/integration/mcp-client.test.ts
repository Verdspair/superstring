// 0.4.0 P6：MCP 客户端（三种传输）与登记文件。
//
// 对端全部是本地合成件：stdio 用 `tests/fixtures/mcp/echo-server.mjs`（真子进程），
// HTTP/SSE 用 127.0.0.1 上的 `Bun.serve` 桩。只走回环，不碰外网、不读真实凭据。

import { afterEach, describe, expect, it } from "bun:test";
import path from "node:path";
import { connectMcpServer } from "../../src/server/mcp/client";
import { loadMcpRegistry, parseMcpServers } from "../../src/server/mcp/config";
import type { McpServerConfig } from "../../src/shared/contracts/mcp";

const fixture = path.join(import.meta.dir, "../fixtures/mcp/echo-server.mjs");
const encoder = new TextEncoder();
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(fetch_: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fetch_ });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const stdioServer: Extract<McpServerConfig, { transport: "stdio" }> = {
  id: "echo",
  name: "回声服务器",
  enabled: true,
  trustToolAnnotations: true,
  timeoutMs: 10_000,
  maxResultChars: 8_000,
  transport: "stdio",
  command: process.execPath,
  args: [fixture],
  env: {},
};

describe("MCP 登记文件（0.4.0 P6）", () => {
  it("缺失＝没有登记；内容哈希当修订号；坏文件带码拒绝", () => {
    expect(
      loadMcpRegistry("missing.json", () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
    ).toEqual({ revision: "", servers: [] });
    const first = loadMcpRegistry("x.json", () => '{"version":1,"servers":[]}');
    const second = loadMcpRegistry("x.json", () => '{"version":1,"servers":[]}\n');
    expect(first.revision).not.toBe("");
    expect(second.revision).not.toBe(first.revision);
    // 严格校验：多一个未知字段也要拒绝，而不是悄悄忽略。
    expect(() => loadMcpRegistry("x.json", () => '{"version":1,"servers":[],"extra":1}')).toThrow(
      /MCP_CONFIG_INVALID/,
    );
    expect(() => loadMcpRegistry("x.json", () => "not json")).toThrow(/MCP_CONFIG_INVALID/);
    // 解析器的稳定契约是码：消息只给人看，程序按 code 判断。
    try {
      parseMcpServers(
        '{"version":1,"servers":[{"id":"a","name":"A","transport":"http","url":"http://x"},{"id":"a","name":"B","transport":"http","url":"http://y"}]}',
      );
      throw new Error("duplicate ids must be rejected");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("MCP_CONFIG_INVALID");
    }
  });

  it("凭据只写变量名：值在连接时从本机环境读，缺失就拒绝", async () => {
    const missing = connectMcpServer(
      {
        ...stdioServer,
        env: { TOKEN: "$MCP_TEST_TOKEN_NOT_SET" },
      },
      { env: {} },
    );
    await expect(missing).rejects.toThrow(/MCP_CREDENTIAL_MISSING/);
    await expect(
      connectMcpServer(
        {
          ...stdioServer,
          id: "remote",
          transport: "http",
          url: "http://127.0.0.1:1/mcp",
          authorizationEnv: "MCP_TEST_TOKEN_NOT_SET",
        },
        { env: {} },
      ),
    ).rejects.toThrow(/MCP_CREDENTIAL_MISSING/);
  });
});

describe("MCP stdio 传输（0.4.0 P6）", () => {
  it("握手、发现与调用走真子进程，且容忍 stdout 上的非 JSON 噪音", async () => {
    const session = await connectMcpServer(stdioServer);
    try {
      expect(session.protocolVersion).toBe("2025-06-18");
      const tools = await session.listTools(new AbortController().signal);
      expect(tools.map((tool) => [tool.name, tool.readOnly])).toEqual([
        ["read_notes", true],
        ["save_note", false],
        ["big_result", true],
        ["failing_tool", true],
      ]);
      const result = await session.callTool(
        "read_notes",
        { query: "牛奶" },
        new AbortController().signal,
      );
      expect(result).toEqual({ text: "note: 冰箱里有牛奶", isError: false, omittedParts: 0 });
      const failing = await session.callTool("failing_tool", {}, new AbortController().signal);
      expect(failing).toMatchObject({ isError: true, text: "boom" });
    } finally {
      await session.close();
    }
  }, 20_000);

  it("旧进程拒绝预探测并退出时只重建一次后正常握手", async () => {
    const session = await connectMcpServer({
      ...stdioServer,
      args: [fixture, "--exit-before-initialize"],
    });
    try {
      expect(session.protocolVersion).toBe("2025-06-18");
      expect(await session.listTools(new AbortController().signal)).toHaveLength(4);
    } finally {
      await session.close();
    }
  }, 20_000);

  it("不响应就按时超时，而不是一直等", async () => {
    // 握手要正常返回、只有 tools/list 拖住：这才是"请求级超时"，而不是"连不上"。
    const base = serve(async (request) => {
      if (request.method === "GET") return new Response(null, { status: 405 });
      const message = (await request.json()) as { id: number; method: string };
      if (message.method === "server/discover")
        return Response.json(
          { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" } },
          { status: 400 },
        );
      if (message.method === "initialize")
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "slow", version: "1" },
          },
        });
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
    });
    const session = await connectMcpServer({
      ...stdioServer,
      id: "slow",
      transport: "http",
      url: `${base}/mcp`,
      timeoutMs: 150,
    });
    try {
      await expect(session.listTools(new AbortController().signal)).rejects.toThrow(/MCP_TIMEOUT/);
    } finally {
      await session.close();
    }
  });
});

describe("MCP HTTP 与 SSE 传输（0.4.0 P6）", () => {
  it("Streamable HTTP：JSON 响应与 SSE 响应都能读，Authorization 从环境变量带出", async () => {
    const seen: string[] = [];
    const base = serve(async (request) => {
      if (request.method === "GET") return new Response(null, { status: 405 });
      seen.push(request.headers.get("authorization") ?? "none");
      const message = (await request.json()) as { id: number; method: string; params?: unknown };
      if (message.method === "server/discover")
        return Response.json(
          { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" } },
          { status: 400 },
        );
      if (message.method === "notifications/initialized")
        return new Response(null, { status: 202 });
      if (message.method === "initialize")
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "http", version: "1" },
          },
        });
      if (message.method === "tools/list") {
        // 这一次特意用 SSE 形状回答：客户端要能从事件流里把结果读出来。
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "lookup",
                annotations: { readOnlyHint: true },
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
        return new Response(`event: message\ndata: ${payload}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "http 结果" }] },
      });
    });
    const session = await connectMcpServer(
      {
        ...stdioServer,
        id: "remote",
        transport: "http",
        url: `${base}/mcp`,
        authorizationEnv: "MCP_TEST_TOKEN",
      },
      { env: { MCP_TEST_TOKEN: "secret-token" } },
    );
    try {
      expect(session.protocolVersion).toBe("2024-11-05");
      const tools = await session.listTools(new AbortController().signal);
      expect(tools.map((tool) => tool.name)).toEqual(["lookup"]);
      await expect(
        session.callTool("lookup", {}, new AbortController().signal),
      ).resolves.toMatchObject({ text: "http 结果" });
      expect(new Set(seen)).toEqual(new Set(["Bearer secret-token"]));
    } finally {
      await session.close();
    }
  });

  it("保留 HTTP 会话和协议版本，等待初始化通知并读取全部目录页", async () => {
    const ids: number[] = [];
    let initialized = false;
    const base = serve(async (request) => {
      if (request.method === "GET") return new Response(null, { status: 405 });
      const message = (await request.json()) as {
        id?: number;
        method: string;
        params?: { cursor?: string };
      };
      if (message.id !== undefined) ids.push(message.id);
      if (message.method === "server/discover")
        return Response.json(
          { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "legacy" } },
          { status: 400 },
        );
      if (message.method === "initialize")
        return Response.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "test", version: "1" },
            },
          },
          {
            headers: { "mcp-session-id": "synthetic-session" },
          },
        );
      if (
        request.headers.get("mcp-session-id") !== "synthetic-session" ||
        request.headers.get("mcp-protocol-version") !== "2025-06-18"
      )
        return new Response(null, { status: 400 });
      if (message.method === "notifications/initialized") {
        await Bun.sleep(10);
        initialized = true;
        return new Response(null, { status: 202 });
      }
      if (!initialized) return new Response(null, { status: 409 });
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result:
          message.params?.cursor === "page-2"
            ? { tools: [{ name: "second", inputSchema: { type: "object" } }] }
            : { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "page-2" },
      });
    });
    const session = await connectMcpServer({
      ...stdioServer,
      transport: "http",
      url: `${base}/mcp`,
    });
    try {
      expect(
        (await session.listTools(new AbortController().signal)).map((tool) => tool.name),
      ).toEqual(["first", "second"]);
      expect(new Set(ids.slice(1)).size).toBe(ids.length - 1);
    } finally {
      await session.close();
    }
  });

  it("HTTP SSE 收到结果后取消响应流，关闭连接会取消在途请求", async () => {
    let cancelled = 0;
    const firstCancelled = Promise.withResolvers<void>();
    const secondCancelled = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const fetchImpl = (async (_url, init) => {
      const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (message.method === "server/discover")
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
          },
        });
      if (message.id === undefined) return new Response(null, { status: 202 });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (message.method === "tools/list")
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [{ name: "wait", inputSchema: { type: "object" } }] } })}\n\n`,
              ),
            );
          else entered.resolve();
        },
        cancel() {
          cancelled += 1;
          if (cancelled === 1) firstCancelled.resolve();
          else secondCancelled.resolve();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const session = await connectMcpServer(
      { ...stdioServer, transport: "http", url: "http://127.0.0.1/mcp" },
      { fetchImpl },
    );
    await session.listTools(new AbortController().signal);
    await firstCancelled.promise;
    expect(cancelled).toBe(1);
    const request = session.callTool("wait", {}, new AbortController().signal).then(
      () => null,
      (error: unknown) => error,
    );
    await entered.promise;
    await session.close();
    expect(await request).toMatchObject({ code: "MCP_SERVER_GONE" });
    await secondCancelled.promise;
    expect(cancelled).toBe(2);
  });

  it("非 2xx 与 JSON-RPC error 都带码失败", async () => {
    const base = serve(async () => new Response("nope", { status: 500 }));
    await expect(
      connectMcpServer({
        ...stdioServer,
        id: "broken",
        transport: "http",
        url: `${base}/mcp`,
      }),
    ).rejects.toThrow(/MCP_HTTP_ERROR/);

    const erroring = serve(async (request) => {
      const message = (await request.json()) as { id: number };
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "unknown method" },
      });
    });
    const rejected = connectMcpServer({
      ...stdioServer,
      id: "erroring",
      transport: "http",
      url: `${erroring}/mcp`,
    });
    await expect(rejected).rejects.toThrow(/MCP_PROTOCOL_ERROR/);
  });

  it("旧版 HTTP+SSE：先拿 endpoint、再 POST，结果从事件流回来", async () => {
    const received: string[] = [];
    let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
    const base = serve(async (request) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/sse") {
        return new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
              controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (request.method === "POST" && url.pathname === "/messages") {
        const message = (await request.json()) as { id: number; method: string };
        received.push(message.method);
        if (message.id === undefined) return new Response(null, { status: 202 });
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "sse", version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "ping",
                      inputSchema: { type: "object" },
                      annotations: { readOnlyHint: true },
                    },
                  ],
                }
              : { content: [{ type: "text", text: "pong" }] };
        stream?.enqueue(
          encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`),
        );
        return new Response(null, { status: 202 });
      }
      return new Response("not found", { status: 404 });
    });
    const session = await connectMcpServer({
      ...stdioServer,
      id: "legacy",
      transport: "sse",
      url: `${base}/sse`,
    });
    try {
      const tools = await session.listTools(new AbortController().signal);
      expect(tools.map((tool) => tool.name)).toEqual(["ping"]);
      await expect(
        session.callTool("ping", {}, new AbortController().signal),
      ).resolves.toMatchObject({ text: "pong" });
      // 握手（含 initialized 通知）与每次调用都真的走到了 POST 端点。
      expect(received).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
        "tools/call",
      ]);
    } finally {
      await session.close();
    }
  });
});
