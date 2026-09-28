import { AsyncLocalStorage } from "node:async_hooks";
import {
  Client,
  type FetchLike,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type McpSubscription,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type Tool,
  type Transport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { ZodError } from "zod";
import type { McpCallResult, McpServerConfig, McpToolInfo } from "../../shared/contracts/mcp";
import { processEnvironment } from "../permissions/process-environment";
import { resolveServerEnv, serverAuthorization } from "./config";
import { McpSchemaValidator, mcpError } from "./schema";
import { guardMcpTransport } from "./transport";

export interface McpSession {
  readonly serverId: string;
  readonly serverName: string;
  readonly protocolVersion: string;
  listTools(signal: AbortSignal): Promise<readonly McpToolInfo[]>;
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
    beforeSend?: () => void,
  ): Promise<McpCallResult>;
  assertToolAvailable?(tool: McpToolInfo): void;
  close(): Promise<void>;
}

export interface McpConnectOptions {
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly onToolsChanged?: () => void;
  readonly onClosed?: () => void;
  readonly onDiagnostic?: (code: string) => void;
}

function mapError(error: unknown): Error {
  if (error instanceof Error && "code" in error && String(error.code).startsWith("MCP_"))
    return error;
  if (error instanceof SdkHttpError)
    return mcpError("MCP_HTTP_ERROR", `HTTP ${error.status}`, error);
  if (error instanceof UnauthorizedError)
    return mcpError("MCP_HTTP_ERROR", "MCP 服务器需要有效授权", error);
  if (error instanceof ZodError || error instanceof SyntaxError)
    return mcpError("MCP_PROTOCOL_ERROR", "MCP 消息不符合协议", error);
  if (error instanceof ProtocolError)
    return Object.assign(mcpError("MCP_PROTOCOL_ERROR", `JSON-RPC ${error.code}`, error), {
      rpcCode: error.code,
      rpcData: error.data,
    });
  if (error instanceof SdkError) {
    if (error.code === SdkErrorCode.RequestTimeout)
      return mcpError("MCP_TIMEOUT", "MCP 请求超时", error);
    if (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected)
      return mcpError("MCP_SERVER_GONE", "MCP 连接已关闭", error);
    if (error.code === SdkErrorCode.InputRequiredRoundsExceeded)
      return mcpError("MCP_INPUT_ROUNDS_EXCEEDED", "MCP 交互轮数超限", error);
    return mcpError("MCP_PROTOCOL_ERROR", "MCP 协议响应无效", error);
  }
  return mcpError("MCP_CALL_FAILED", "MCP 请求失败", error);
}

export async function connectMcpServer(
  server: McpServerConfig,
  options: McpConnectOptions = {},
): Promise<McpSession> {
  options.signal?.throwIfAborted();
  const env = options.env ?? process.env;
  const auth = serverAuthorization(server, env);
  const lifetime = new AbortController();
  const requestLifetime = new AsyncLocalStorage<AbortSignal>();
  const callAuthority = new AsyncLocalStorage<() => void>();
  const validator = new McpSchemaValidator();
  const catalog = new Map<
    string,
    { wire: Tool; info: McpToolInfo; validate: JsonSchemaValidator<unknown> }
  >();
  let subscription: McpSubscription | undefined;
  let catalogRevision = 0;
  let closed = false;
  let connected = false;
  const client = new Client(
    { name: "superstring", version: "1" },
    {
      capabilities: {},
      versionNegotiation: {
        mode: server.transport === "sse" ? "legacy" : "auto",
        probe: { timeoutMs: Math.max(50, Math.floor(server.timeoutMs / 2)) },
      },
      supportedProtocolVersions: [
        "2026-07-28",
        "2025-11-25",
        "2025-06-18",
        "2025-03-26",
        "2024-11-05",
      ],
      jsonSchemaValidator: validator,
      inputRequired: { autoFulfill: true, maxRounds: 8 },
      listMaxPages: 64,
    },
  );
  client.onclose = () => {
    catalog.clear();
    if (connected) {
      lifetime.abort(mcpError("MCP_SERVER_GONE", "MCP 连接已关闭"));
      if (!closed) options.onClosed?.();
    }
  };
  client.onerror = (error) =>
    options.onDiagnostic?.((mapError(error) as Error & { code: string }).code);
  client.setNotificationHandler("notifications/tools/list_changed", async () => {
    catalogRevision++;
    catalog.clear();
    options.onToolsChanged?.();
  });
  let transport: Transport;
  let restartStdio: (() => Transport) | undefined;
  if (server.transport === "stdio") {
    const parameters = {
      command: server.command,
      args: server.args,
      env: {
        ...Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map((key) => [key, ""])),
        ...processEnvironment(env),
        ...resolveServerEnv(server, env),
      },
      stderr: "ignore" as const,
      maxBufferSize: 4 * 1024 * 1024,
    };
    restartStdio = () => new StdioClientTransport(parameters);
    transport = restartStdio();
  } else {
    const origin = new URL(server.url).origin;
    const fetchImpl: FetchLike = async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== origin || target.username || target.password)
        throw mcpError("MCP_PROTOCOL_ERROR", "MCP 请求改变了授权目标");
      // SDK response readers may outlive their request promise; keep cleanup request-scoped.
      const requestSignal = init?.method === "POST" ? requestLifetime.getStore() : undefined;
      const signal = AbortSignal.any([
        lifetime.signal,
        ...(requestSignal ? [requestSignal] : []),
        ...(init?.signal ? [init.signal] : []),
      ]);
      const response = await (options.fetchImpl ?? fetch)(input, {
        ...init,
        signal,
        redirect: "error",
      });
      if (!response.body) return response;
      return new Response(response.body.pipeThrough(new TransformStream(), { signal }), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    const settings = {
      fetch: fetchImpl,
      requestInit: { redirect: "error" as const },
      ...(auth === null ? {} : { authProvider: { token: async () => auth } }),
    };
    transport =
      server.transport === "http"
        ? new StreamableHTTPClientTransport(new URL(server.url), {
            ...settings,
            reconnectionOptions: {
              maxRetries: 0,
              initialReconnectionDelay: 1000,
              maxReconnectionDelay: 1000,
              reconnectionDelayGrowFactor: 1,
            },
            onInsufficientScope: "throw",
          })
        : new SSEClientTransport(new URL(server.url), settings);
  }
  let guarded = guardMcpTransport(transport, () => callAuthority.getStore()?.());
  const run = async <T>(
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    signal.throwIfAborted();
    const timeout = AbortSignal.timeout(server.timeoutMs);
    const completion = new AbortController();
    const combined = AbortSignal.any([signal, lifetime.signal, timeout, completion.signal]);
    try {
      const result = await requestLifetime.run(combined, () => operation(combined));
      combined.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      lifetime.signal.throwIfAborted();
      if (timeout.aborted) throw mcpError("MCP_TIMEOUT", "MCP 请求超时", error);
      throw mapError(error);
    } finally {
      completion.abort();
    }
  };
  const close = async () => {
    closed = true;
    lifetime.abort(mcpError("MCP_SERVER_GONE", "MCP 连接已关闭"));
    catalog.clear();
    try {
      await subscription?.close();
    } finally {
      await client.close();
    }
  };
  try {
    await run(options.signal ?? new AbortController().signal, async (signal) => {
      const abortConnect = () => {
        void guarded.transport.close().catch(() => {});
      };
      signal.addEventListener("abort", abortConnect, { once: true });
      try {
        await client.connect(guarded.transport, { signal, timeout: server.timeoutMs });
      } catch (error) {
        signal.throwIfAborted();
        if (!restartStdio || !guarded.canRestartLegacy()) throw error;
        guarded = guardMcpTransport(restartStdio(), () => callAuthority.getStore()?.());
        await client.connect(guarded.transport, {
          signal,
          timeout: server.timeoutMs,
          prior: { kind: "legacy" },
        });
      } finally {
        signal.removeEventListener("abort", abortConnect);
      }
    });
    connected = true;
    const protocolVersion = client.getNegotiatedProtocolVersion();
    if (!protocolVersion) throw mcpError("MCP_PROTOCOL_ERROR", "MCP 未确认协议版本");
    return {
      serverId: server.id,
      serverName: server.name,
      protocolVersion,
      async listTools(signal) {
        return run(signal, async (signal) => {
          const revision = catalogRevision;
          const result = await client.listTools(undefined, {
            signal,
            timeout: server.timeoutMs,
            cacheMode: "refresh",
          });
          const next = new Map<
            string,
            { wire: Tool; info: McpToolInfo; validate: JsonSchemaValidator<unknown> }
          >();
          for (const tool of result.tools) {
            if (next.has(tool.name)) throw mcpError("MCP_PROTOCOL_ERROR", "MCP 工具名称重复");
            const validate = validator.getValidator(tool.inputSchema as JsonSchemaType);
            if (tool.outputSchema) validator.getValidator(tool.outputSchema as JsonSchemaType);
            const info: McpToolInfo = {
              name: tool.name,
              description: tool.description ?? null,
              inputSchema: tool.inputSchema,
              ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
              readOnly:
                server.trustToolAnnotations === true && tool.annotations?.readOnlyHint === true,
            };
            next.set(tool.name, { wire: tool, info, validate });
          }
          if (revision !== catalogRevision)
            throw mcpError("MCP_TOOL_LIST_CHANGED", "MCP 工具目录已变化，请重新发现");
          catalog.clear();
          for (const [name, tool] of next) catalog.set(name, tool);
          if (
            !subscription &&
            client.getProtocolEra() === "modern" &&
            client.getServerCapabilities()?.tools?.listChanged
          ) {
            const opening = new AbortController();
            const abortOpening = () => opening.abort(signal.reason);
            signal.throwIfAborted();
            signal.addEventListener("abort", abortOpening, { once: true });
            const subscriptionSignal = AbortSignal.any([lifetime.signal, opening.signal]);
            try {
              subscription = await requestLifetime.run(subscriptionSignal, () =>
                client.listen(
                  { toolsListChanged: true },
                  { signal: subscriptionSignal, timeout: server.timeoutMs },
                ),
              );
            } finally {
              signal.removeEventListener("abort", abortOpening);
            }
            void subscription.closed.then((reason) => {
              subscription = undefined;
              if (reason === "remote" && !closed) {
                catalogRevision++;
                catalog.clear();
                options.onDiagnostic?.("MCP_SUBSCRIPTION_CLOSED");
                void close()
                  .finally(() => options.onClosed?.())
                  .catch(() => {});
              }
            });
          }
          if (revision !== catalogRevision)
            throw mcpError("MCP_TOOL_LIST_CHANGED", "MCP 工具目录已变化，请重新发现");
          return [...next.values()].map((entry) => entry.info);
        });
      },
      assertToolAvailable(tool) {
        if (
          closed ||
          lifetime.signal.aborted ||
          JSON.stringify(catalog.get(tool.name)?.info) !== JSON.stringify(tool)
        )
          throw mcpError("MCP_TOOL_LIST_CHANGED", "MCP 工具目录已变化，请重新发现");
      },
      async callTool(name, arguments_, signal, beforeSend) {
        return run(signal, async (signal) => {
          const tool = catalog.get(name);
          if (!tool) throw mcpError("MCP_TOOL_UNAVAILABLE", "MCP 工具未发现或已失效");
          if (!tool.validate(arguments_).valid)
            throw mcpError("MCP_ARGUMENTS_INVALID", "MCP 工具参数不符合 schema");
          const result = await callAuthority.run(
            () => {
              signal.throwIfAborted();
              if (JSON.stringify(catalog.get(name)?.info) !== JSON.stringify(tool.info))
                throw mcpError("MCP_TOOL_LIST_CHANGED", "MCP 工具目录已变化");
              beforeSend?.();
            },
            () =>
              client.callTool(
                { name, arguments: arguments_ },
                {
                  signal,
                  timeout: server.timeoutMs,
                  maxTotalTimeout: server.timeoutMs,
                  toolDefinition: tool.wire,
                },
              ),
          );
          const text = result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          const structured = result.structuredContent;
          if (
            [...text].length +
              (structured === undefined ? 0 : [...JSON.stringify(structured)].length) >
            server.maxResultChars
          )
            throw mcpError("MCP_RESULT_TOO_LARGE", "MCP 调用结果超过上限");
          return {
            text,
            isError: result.isError === true,
            omittedParts: result.content.filter((part) => part.type !== "text").length,
            ...(structured === undefined ? {} : { structuredContent: structured }),
          };
        });
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
