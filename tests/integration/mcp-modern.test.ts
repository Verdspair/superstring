import { describe, expect, it } from "bun:test";
import path from "node:path";
import { createMcpActions } from "../../src/server/mcp/actions";
import { connectMcpServer } from "../../src/server/mcp/client";
import { McpSchemaValidator } from "../../src/server/mcp/schema";
import type { McpServerConfig } from "../../src/shared/contracts/mcp";

const config: McpServerConfig = {
  id: "modern",
  name: "Modern",
  transport: "http",
  enabled: true,
  url: "http://127.0.0.1/mcp",
  timeoutMs: 1000,
  maxResultChars: 8000,
};
const tool = {
  name: "lookup",
  inputSchema: {
    type: "object" as const,
    properties: { region: { type: "string", "x-mcp-header": "Region" } },
  },
  annotations: { readOnlyHint: true },
};
type Message = { id: number | string; method: string; params: Record<string, unknown> };
function peer(
  options: {
    tools?: unknown[];
    call?: (message: Message, init: RequestInit) => Response | Promise<Response>;
    version?: string;
    listChanged?: boolean;
    listen?: (message: Message) => Response;
  } = {},
) {
  const seen: { message: Message; headers: Headers }[] = [];
  const fetchImpl = (async (_url, init) => {
    const message = JSON.parse(String(init?.body)) as Message;
    const headers = new Headers(init?.headers);
    seen.push({ message, headers });
    const meta = message.params?._meta as Record<string, unknown>;
    expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(meta["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
    expect(headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(headers.get("mcp-method")).toBe(message.method);
    const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "server/discover") {
      if (options.version)
        return Response.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32022,
              message: "Unsupported protocol version",
              data: { requested: "2026-07-28", supported: [options.version] },
            },
          },
          { status: 400 },
        );
      return reply({
        resultType: "complete",
        ttlMs: 0,
        cacheScope: "private",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: { listChanged: options.listChanged ?? false } },
      });
    }
    if (message.method === "tools/list")
      return reply({
        resultType: "complete",
        tools: options.tools ?? [tool],
        ttlMs: 0,
        cacheScope: "private",
      });
    if (message.method === "subscriptions/listen" && options.listen) return options.listen(message);
    if (message.method === "tools/call") {
      expect(headers.get("mcp-name")).toBe(message.params.name as string);
      return (
        options.call?.(message, init ?? {}) ??
        reply({ resultType: "complete", content: [{ type: "text", text: "ok" }] })
      );
    }
    throw new Error(`Unexpected request ${message.method}`);
  }) as typeof fetch;
  return { fetchImpl, seen };
}
const signal = () => new AbortController().signal;

describe("MCP 2026-07-28", () => {
  it("uses per-request metadata and mirrored encoded headers without initialization or sessions", async () => {
    const p = peer();
    const session = await connectMcpServer(config, { fetchImpl: p.fetchImpl });
    try {
      expect(session.protocolVersion).toBe("2026-07-28");
      expect((await session.listTools(signal()))[0].readOnly).toBe(false);
      await session.callTool("lookup", { region: "Hello, 世界" }, signal());
      const last = p.seen.at(-1);
      expect(last?.headers.get("mcp-param-region")).toBe(
        `=?base64?${Buffer.from("Hello, 世界").toString("base64")}?=`,
      );
      expect(last?.headers.has("mcp-session-id")).toBe(false);
      expect(p.seen.map((entry) => entry.message.method)).toEqual([
        "server/discover",
        "tools/list",
        "tools/call",
      ]);
    } finally {
      await session.close();
    }
  });

  it("runs modern discovery and calls over a real loopback HTTP endpoint", async () => {
    const p = peer();
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        return p.fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: await request.text(),
          signal: request.signal,
        });
      },
    });
    const session = await connectMcpServer({
      ...config,
      url: `http://127.0.0.1:${endpoint.port}/mcp`,
    });
    try {
      expect(session.protocolVersion).toBe("2026-07-28");
      await session.listTools(signal());
      expect((await session.callTool("lookup", { region: "test" }, signal())).text).toBe("ok");
    } finally {
      await session.close();
      endpoint.stop(true);
    }
  });

  it("trusts read-only annotations only after explicit configuration", async () => {
    const p = peer();
    const session = await connectMcpServer(
      { ...config, trustToolAnnotations: true },
      { fetchImpl: p.fetchImpl },
    );
    try {
      expect((await session.listTools(signal()))[0].readOnly).toBe(true);
    } finally {
      await session.close();
    }
  });

  it("rejects unsupported versions rather than advertising support", async () => {
    const p = peer({ version: "2099-01-01" });
    await expect(connectMcpServer(config, { fetchImpl: p.fetchImpl })).rejects.toMatchObject({
      code: "MCP_PROTOCOL_ERROR",
    });
  });

  for (const [name, result] of [
    ["unknown resultType", { resultType: "alien", content: [] }],
    ["invalid tool content", { resultType: "complete", content: [null] }],
    ["missing content", { resultType: "complete" }],
  ] as const)
    it(`rejects ${name}`, async () => {
      const p = peer({
        call: (message) => Response.json({ jsonrpc: "2.0", id: message.id, result }),
      });
      const session = await connectMcpServer(config, { fetchImpl: p.fetchImpl });
      try {
        await session.listTools(signal());
        await expect(session.callTool("lookup", {}, signal())).rejects.toMatchObject({
          code: "MCP_PROTOCOL_ERROR",
        });
      } finally {
        await session.close();
      }
    });

  it("rejects undeclared client input capabilities without sending a retry", async () => {
    const p = peer({
      call: (message) =>
        Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "input_required",
            inputRequests: {
              input: {
                method: "elicitation/create",
                params: {
                  mode: "form",
                  message: "synthetic",
                  requestedSchema: { type: "object", properties: {} },
                },
              },
            },
          },
        }),
    });
    const session = await connectMcpServer(config, { fetchImpl: p.fetchImpl });
    try {
      await session.listTools(signal());
      await expect(session.callTool("lookup", {}, signal())).rejects.toBeDefined();
      expect(p.seen.filter((entry) => entry.message.method === "tools/call")).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  for (const envelope of [
    { jsonrpc: "1.0", result: { resultType: "complete", content: [] } },
    { jsonrpc: "2.0" },
  ])
    it("rejects malformed JSON-RPC envelopes instead of returning an empty success", async () => {
      const p = peer({ call: (message) => Response.json({ ...envelope, id: message.id }) });
      const session = await connectMcpServer(config, { fetchImpl: p.fetchImpl });
      try {
        await session.listTools(signal());
        await expect(session.callTool("lookup", {}, signal())).rejects.toBeDefined();
      } finally {
        await session.close();
      }
    });

  it("does not downgrade a valid discovery response with no supported version", async () => {
    const methods: string[] = [];
    const fetchImpl = (async (_url, init) => {
      const message = JSON.parse(String(init?.body)) as Message;
      methods.push(message.method);
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          resultType: "complete",
          supportedVersions: ["2099-01-01"],
          capabilities: { tools: {} },
          ttlMs: 0,
          cacheScope: "private",
        },
      });
    }) as typeof fetch;
    await expect(connectMcpServer(config, { fetchImpl })).rejects.toMatchObject({
      code: "MCP_PROTOCOL_ERROR",
    });
    expect(methods).toEqual(["server/discover"]);
  });

  for (const code of [-32020, -32021])
    it(`does not downgrade modern discovery error ${code}`, async () => {
      const methods: string[] = [];
      const fetchImpl = (async (_url, init) => {
        const message = JSON.parse(String(init?.body)) as Message;
        methods.push(message.method);
        return Response.json(
          { jsonrpc: "2.0", id: message.id, error: { code, message: "modern rejection" } },
          { status: 400 },
        );
      }) as typeof fetch;
      await expect(connectMcpServer(config, { fetchImpl })).rejects.toMatchObject({
        code: "MCP_PROTOCOL_ERROR",
        rpcCode: code,
      });
      expect(methods).toEqual(["server/discover"]);
    });

  it("preserves structured false and validates output schemas", async () => {
    let value: unknown = false;
    const p = peer({
      tools: [{ ...tool, outputSchema: { type: "boolean" } }],
      call: (message) =>
        Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { resultType: "complete", content: [], structuredContent: value },
        }),
    });
    const session = await connectMcpServer(config, { fetchImpl: p.fetchImpl });
    try {
      const tools = await session.listTools(signal());
      const action = createMcpActions({ sources: [{ config, session, tools }] })[0];
      expect(
        (await action.execute({}, { owner: { kind: "test", id: "result" }, signal: signal() }))
          .value,
      ).toEqual({ status: "ok", text: "", structuredContent: false });
      value = "invalid";
      await expect(session.callTool("lookup", {}, signal())).rejects.toMatchObject({
        code: "MCP_PROTOCOL_ERROR",
      });
    } finally {
      await session.close();
    }
  });

  it("counts structured data toward the result limit", async () => {
    const p = peer({
      call: (message) =>
        Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { resultType: "complete", content: [], structuredContent: "x".repeat(50) },
        }),
    });
    const session = await connectMcpServer(
      { ...config, maxResultChars: 10 },
      { fetchImpl: p.fetchImpl },
    );
    try {
      await session.listTools(signal());
      await expect(session.callTool("lookup", {}, signal())).rejects.toMatchObject({
        code: "MCP_RESULT_TOO_LARGE",
      });
    } finally {
      await session.close();
    }
  });

  it("validates arguments before sending and removes invalid header declarations", async () => {
    const p = peer({
      tools: [
        tool,
        {
          ...tool,
          name: "bad",
          inputSchema: {
            type: "object",
            properties: { x: { type: "string", "x-mcp-header": "" } },
          },
        },
      ],
    });
    const session = await connectMcpServer(config, { fetchImpl: p.fetchImpl });
    try {
      expect((await session.listTools(signal())).map((entry) => entry.name)).toEqual(["lookup"]);
      await expect(session.callTool("lookup", { region: 1 }, signal())).rejects.toMatchObject({
        code: "MCP_ARGUMENTS_INVALID",
      });
      expect(p.seen.some((entry) => entry.message.method === "tools/call")).toBe(false);
    } finally {
      await session.close();
    }
  });

  it("rejects bad schemas and never fetches network references", async () => {
    const validator = new McpSchemaValidator();
    expect(() => validator.getValidator({ type: 7 } as never)).toThrow("MCP_SCHEMA_INVALID");
    expect(() => validator.getValidator({ $schema: "https://invalid.test/schema" })).toThrow(
      "MCP_SCHEMA_DIALECT_UNSUPPORTED",
    );
    expect(() => validator.getValidator({ $ref: "http://127.0.0.1/private" })).toThrow(
      "MCP_SCHEMA_INVALID",
    );
    const validate = validator.getValidator({
      type: "object",
      properties: { n: { $ref: "#/$defs/count" } },
      $defs: { count: { type: "integer" } },
      unevaluatedProperties: false,
    });
    expect(validate({ n: 1 }).valid).toBe(true);
    expect(validate({ n: 1, extra: 1 }).valid).toBe(false);
    for (const $schema of [
      "http://json-schema.org/draft-07/schema#",
      "https://json-schema.org/draft-07/schema#",
    ]) {
      expect(validator.getValidator({ $schema, type: "string" })("ok").valid).toBe(true);
    }
  });

  it("follows state-only MRTR with fresh IDs and exact opaque state", async () => {
    const calls: Message[] = [];
    const state = "opaque==不要解析";
    const p = peer({
      call: (message) => {
        calls.push(message);
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result:
            calls.length === 1
              ? { resultType: "input_required", requestState: state }
              : { resultType: "complete", content: [{ type: "text", text: "done" }] },
        });
      },
    });
    const session = await connectMcpServer(config, { fetchImpl: p.fetchImpl });
    try {
      await session.listTools(signal());
      expect((await session.callTool("lookup", {}, signal())).text).toBe("done");
      expect(calls).toHaveLength(2);
      expect(calls[1].id).not.toBe(calls[0].id);
      expect(calls[1].params.requestState).toBe(state);
    } finally {
      await session.close();
    }
  });

  it("rechecks authority before every MRTR continuation", async () => {
    let checks = 0;
    const p = peer({
      call: (message) =>
        Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { resultType: "input_required", requestState: "opaque" },
        }),
    });
    const session = await connectMcpServer(config, { fetchImpl: p.fetchImpl });
    try {
      await session.listTools(signal());
      await expect(
        session.callTool("lookup", {}, signal(), () => {
          if (++checks === 2) throw new Error("revoked");
        }),
      ).rejects.toBeDefined();
      expect(checks).toBe(2);
      expect(p.seen.filter((entry) => entry.message.method === "tools/call")).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it("bounds MRTR loops without treating unfinished work as success", async () => {
    const p = peer({
      call: (message) =>
        Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { resultType: "input_required", requestState: "again" },
        }),
    });
    const session = await connectMcpServer(
      { ...config, timeoutMs: 4000 },
      { fetchImpl: p.fetchImpl },
    );
    try {
      await session.listTools(signal());
      await expect(session.callTool("lookup", {}, signal())).rejects.toMatchObject({
        code: "MCP_INPUT_ROUNDS_EXCEEDED",
      });
    } finally {
      await session.close();
    }
  });

  it("preserves modern HTTP protocol errors without retrying tool calls", async () => {
    const p = peer({
      call: (message) =>
        Response.json(
          { jsonrpc: "2.0", id: message.id, error: { code: -32020, message: "mismatch" } },
          { status: 400 },
        ),
    });
    const session = await connectMcpServer(config, { fetchImpl: p.fetchImpl });
    try {
      await session.listTools(signal());
      await expect(session.callTool("lookup", {}, signal())).rejects.toMatchObject({
        code: "MCP_PROTOCOL_ERROR",
        rpcCode: -32020,
      });
      expect(p.seen.filter((entry) => entry.message.method === "tools/call")).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  it("invalidates captured tools on subscribed catalog changes", async () => {
    const changed = Promise.withResolvers<void>();
    const encoder = new TextEncoder();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let subscriptionId: string | number | undefined;
    const p = peer({
      listChanged: true,
      listen: (message) => {
        subscriptionId = message.id;
        return new Response(
          new ReadableStream({
            start(controller) {
              stream = controller;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: { "io.modelcontextprotocol/subscriptionId": message.id }, notifications: { toolsListChanged: true } } })}\n\n`,
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const session = await connectMcpServer(config, {
      fetchImpl: p.fetchImpl,
      onToolsChanged: () => changed.resolve(),
    });
    try {
      const tools = await session.listTools(signal());
      session.assertToolAvailable?.(tools[0]);
      stream?.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId } } })}\n\n`,
        ),
      );
      await changed.promise;
      expect(() => session.assertToolAvailable?.(tools[0])).toThrow("MCP_TOOL_LIST_CHANGED");
      await expect(session.callTool("lookup", {}, signal())).rejects.toMatchObject({
        code: "MCP_TOOL_UNAVAILABLE",
      });
    } finally {
      await session.close();
    }
  });

  it("stops a silent connection promptly when its caller cancels", async () => {
    const entered = Promise.withResolvers<void>();
    const controller = new AbortController();
    const pending = connectMcpServer(
      { ...config, timeoutMs: 20000 },
      {
        signal: controller.signal,
        fetchImpl: (async (_url, init) => {
          entered.resolve();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        }) as typeof fetch,
      },
    );
    const failure = pending.then(
      () => null,
      (error: Error) => error,
    );
    await entered.promise;
    controller.abort(new Error("cancel setup"));
    expect((await failure)?.message).toBe("cancel setup");
  });

  it("sends cancellation for a real modern stdio request and keeps the shared process alive", async () => {
    const session = await connectMcpServer({
      ...config,
      transport: "stdio",
      command: process.execPath,
      args: [path.join(import.meta.dir, "../fixtures/mcp/modern-server.mjs")],
      env: {},
      timeoutMs: 10000,
    });
    try {
      await session.listTools(signal());
      const controller = new AbortController();
      const pending = session.callTool("hold", {}, controller.signal).then(
        () => "unexpected",
        (error: Error) => error.message,
      );
      await session.callTool("echo", {}, signal());
      controller.abort(new Error("cancelled by test"));
      expect(await pending).toBe("cancelled by test");
      const status = await session.callTool("status", {}, signal());
      expect(JSON.parse(status.text)).toHaveLength(1);
    } finally {
      await session.close();
    }
  }, 20000);
});
