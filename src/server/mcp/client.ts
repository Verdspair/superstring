// MCP 客户端（0.4.0 P6）：JSON-RPC 2.0 + 三种传输（stdio / Streamable HTTP / 旧版 HTTP+SSE）。
//
// 只实现最小必需的三步：`initialize` 握手、`tools/list` 发现、`tools/call` 调用。
// 不支持的能力一律不声明（capabilities 里什么都不开），服务器因此不会反向请求我们。
//
// 三条纪律：
//   * 每个请求都有墙钟上限（服务器登记的 `timeoutMs`），超时判 `MCP_TIMEOUT`；
//   * 出错带码、不猜内容：HTTP 非 2xx＝`MCP_HTTP_ERROR`，JSON-RPC error＝`MCP_PROTOCOL_ERROR`，
//     进程退出/流中断＝`MCP_SERVER_GONE`；
//   * 凭据只从本机环境读（见 config.ts），不写日志、不进上下文。

import { createParser } from "eventsource-parser";
import type { McpCallResult, McpServerConfig, McpToolInfo } from "../../shared/contracts/mcp";
import { processEnvironment } from "../permissions/process-environment";
import { resolveServerEnv, serverAuthorization } from "./config";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "superstring", version: "1" } as const;

function coded(code: string, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

export type McpErrorCode =
  | "MCP_TIMEOUT"
  | "MCP_HTTP_ERROR"
  | "MCP_PROTOCOL_ERROR"
  | "MCP_SERVER_GONE"
  | "MCP_CREDENTIAL_MISSING"
  | "MCP_CONFIG_INVALID";

interface Channel {
  request(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  notify(method: string, params: unknown, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
  method?: unknown;
}

/** JSON-RPC 响应 → 结果；带 error 的消息一律按协议错误抛出（错误文本属于服务端，不猜）。 */
function unwrap(message: JsonRpcMessage): unknown {
  if (message.error !== undefined) {
    const code = typeof message.error.code === "number" ? message.error.code : "unknown";
    const text = typeof message.error.message === "string" ? message.error.message : "";
    throw coded("MCP_PROTOCOL_ERROR", `服务器返回错误 ${code}：${text.slice(0, 300)}`);
  }
  return message.result;
}

function withTimeout(
  timeoutMs: number,
  signal: AbortSignal,
): { signal: AbortSignal; timedOut: () => boolean } {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: AbortSignal.any([signal, timeout]),
    timedOut: () => timeout.aborted && !signal.aborted,
  };
}

/** 行分隔的 JSON-RPC：本地子进程的 stdin/stdout。 */
function stdioChannel(
  server: Extract<McpServerConfig, { transport: "stdio" }>,
  env: Record<string, string | undefined>,
): Channel {
  const process_ = Bun.spawn([server.command, ...server.args], {
    env: { ...processEnvironment(env), ...resolveServerEnv(server, env) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  let nextId = 1;
  let buffer = "";
  const decoder = new TextDecoder();
  const failAll = (error: () => Error) => {
    for (const entry of [...pending.values()]) entry.reject(error());
    pending.clear();
  };
  const settle = (message: JsonRpcMessage) => {
    if (typeof message.id !== "number") return; // 通知：这一版不消费
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    try {
      entry.resolve(unwrap(message));
    } catch (error) {
      entry.reject(error);
    }
  };
  void (async () => {
    const reader = process_.stdout.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            try {
              settle(JSON.parse(line) as JsonRpcMessage);
            } catch {
              // 非 JSON 的输出按噪音忽略：进程可能把日志写到了 stdout。
            }
          }
          newline = buffer.indexOf("\n");
        }
      }
    } catch {
      failAll(() => coded("MCP_SERVER_GONE", `服务器 ${server.id} 的输出流被中止`));
    } finally {
      reader.releaseLock();
      failAll(() => coded("MCP_SERVER_GONE", `服务器 ${server.id} 的输出流已结束`));
    }
  })();
  void process_.exited.then(() => {
    failAll(() => coded("MCP_SERVER_GONE", `服务器 ${server.id} 的进程已退出`));
  });
  return {
    request(method, params, signal) {
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        const onAbort = () => {
          pending.delete(id);
          reject(signal.reason ?? coded("MCP_SERVER_GONE", "请求被中止"));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        pending.set(id, {
          resolve: (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        });
        process_.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        void process_.stdin.flush();
      });
    },
    async notify(method, params, signal) {
      signal.throwIfAborted();
      process_.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
      await process_.stdin.flush();
    },
    async close() {
      try {
        process_.stdin.end();
      } catch {
        /* 进程可能已经退出 */
      }
      process_.kill();
      await process_.exited;
    },
  };
}

function authorizationHeaders(auth: string | null): Record<string, string> {
  return auth === null ? {} : { authorization: `Bearer ${auth}` };
}

async function readSseResponse(
  body: ReadableStream<Uint8Array>,
  id: number,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result: JsonRpcMessage | undefined;
  const parser = createParser({
    onEvent(frame) {
      if (!frame.data || result) return;
      try {
        const message = JSON.parse(frame.data) as JsonRpcMessage | null;
        if (message?.id === id) result = message;
      } catch {
        return;
      }
    },
  });
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (value) parser.feed(decoder.decode(value, { stream: true }));
      if (result) return unwrap(result);
      if (done) throw coded("MCP_SERVER_GONE", "响应流在给出结果前结束");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Streamable HTTP：一个 POST 一条请求，响应可能是 JSON，也可能是 SSE 流。 */
function httpChannel(
  server: Extract<McpServerConfig, { transport: "http" }>,
  auth: string | null,
  fetchImpl: typeof fetch,
): Channel {
  const lifetime = new AbortController();
  let nextId = 1;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  const headers = () => ({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...authorizationHeaders(auth),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
  });
  return {
    async request(method, params, callerSignal) {
      const signal = AbortSignal.any([callerSignal, lifetime.signal]);
      signal.throwIfAborted();
      const id = nextId++;
      const response = await fetchImpl(server.url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal,
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw coded("MCP_HTTP_ERROR", `服务器 ${server.id} 返回 ${response.status}`);
      }
      let result: unknown;
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        if (!response.body) throw coded("MCP_SERVER_GONE", "响应体为空");
        result = await readSseResponse(response.body, id, signal);
      } else {
        const message = (await response.json()) as JsonRpcMessage;
        if (message?.id !== id) throw coded("MCP_PROTOCOL_ERROR", "响应编号与请求不符");
        result = unwrap(message);
      }
      if (method === "initialize") {
        sessionId = response.headers.get("mcp-session-id");
        const negotiated = result as { protocolVersion?: unknown } | null;
        protocolVersion =
          typeof negotiated?.protocolVersion === "string"
            ? negotiated.protocolVersion
            : MCP_PROTOCOL_VERSION;
      }
      return result;
    },
    async notify(method, params, callerSignal) {
      const signal = AbortSignal.any([callerSignal, lifetime.signal]);
      signal.throwIfAborted();
      const response = await fetchImpl(server.url, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
        signal,
        redirect: "error",
      });
      await response.body?.cancel();
      if (!response.ok)
        throw coded("MCP_HTTP_ERROR", `服务器 ${server.id} 返回 ${response.status}`);
    },
    async close() {
      lifetime.abort(coded("MCP_SERVER_GONE", "连接已关闭"));
    },
  };
}

/** 旧版 HTTP+SSE：GET 打开事件流，服务端先给 `endpoint`，请求 POST 到那里、结果从流里回来。 */
function sseChannel(
  server: Extract<McpServerConfig, { transport: "sse" }>,
  auth: string | null,
  fetchImpl: typeof fetch,
): Channel {
  const lifetime = new AbortController();
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  let endpoint: string | null = null;
  let endpointWaiter: (() => void) | null = null;
  let closedReason: Error | null = null;
  const failAll = (error: Error) => {
    closedReason = error;
    for (const entry of [...pending.values()]) entry.reject(error);
    pending.clear();
    endpointWaiter?.();
  };
  const opened = fetchImpl(server.url, {
    headers: { accept: "text/event-stream", ...authorizationHeaders(auth) },
    signal: lifetime.signal,
  }).then(async (response) => {
    if (!response.ok) throw coded("MCP_HTTP_ERROR", `服务器 ${server.id} 返回 ${response.status}`);
    if (!response.body) throw coded("MCP_SERVER_GONE", "事件流为空");
    const parser = createParser({
      onEvent: (frame) => {
        if (frame.event === "endpoint") {
          const target = new URL(frame.data.trim(), server.url);
          if (target.origin !== new URL(server.url).origin || target.username || target.password) {
            failAll(coded("MCP_PROTOCOL_ERROR", "MCP endpoint 改变了授权目标"));
            lifetime.abort();
            return;
          }
          endpoint = target.href;
          endpointWaiter?.();
          return;
        }
        if (!frame.data) return;
        let message: JsonRpcMessage;
        try {
          message = JSON.parse(frame.data) as JsonRpcMessage;
        } catch {
          return;
        }
        if (typeof message.id !== "number") return;
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        try {
          entry.resolve(unwrap(message));
        } catch (error) {
          entry.reject(error);
        }
      },
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (value) parser.feed(decoder.decode(value, { stream: true }));
      if (done) break;
    }
    failAll(coded("MCP_SERVER_GONE", `服务器 ${server.id} 的事件流已结束`));
  });
  // 连接失败也要唤醒所有等待者，否则调用方要等到超时才知道。
  void opened.catch((error: unknown) => {
    failAll(error instanceof Error ? error : new Error(String(error)));
  });
  const waitForEndpoint = (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      if (closedReason !== null) return reject(closedReason);
      if (endpoint !== null) return resolve(endpoint);
      const onAbort = () => reject(signal.reason ?? coded("MCP_SERVER_GONE", "请求被中止"));
      endpointWaiter = () => {
        signal.removeEventListener("abort", onAbort);
        endpoint === null ? reject(closedReason ?? new Error("no endpoint")) : resolve(endpoint);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  return {
    async request(method, params, signal) {
      signal.throwIfAborted();
      const post = await waitForEndpoint(signal);
      signal.throwIfAborted();
      const id = nextId++;
      return new Promise<unknown>((resolve, reject) => {
        // 先登记等待者再 POST：快服务端可能在上一条 POST 的响应里就把结果推进事件流了，
        // 后登记会永远等不到（这条竞态就是本文件测试真实抓到的）。
        const onAbort = () => {
          pending.delete(id);
          reject(signal.reason ?? coded("MCP_SERVER_GONE", "请求被中止"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.set(id, {
          resolve: (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          reject: (error) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        });
        void fetchImpl(post, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...authorizationHeaders(auth),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal,
        })
          .then((response) => {
            if (!response.ok) {
              pending.delete(id);
              reject(coded("MCP_HTTP_ERROR", `服务器 ${server.id} 返回 ${response.status}`));
            }
          })
          .catch((error: unknown) => {
            pending.delete(id);
            reject(error);
          });
      });
    },
    async notify(method, params, callerSignal) {
      const signal = AbortSignal.any([callerSignal, lifetime.signal]);
      const post = await waitForEndpoint(signal);
      const response = await fetchImpl(post, {
        method: "POST",
        headers: { "content-type": "application/json", ...authorizationHeaders(auth) },
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
        signal,
        redirect: "error",
      });
      await response.body?.cancel();
      if (!response.ok)
        throw coded("MCP_HTTP_ERROR", `服务器 ${server.id} 返回 ${response.status}`);
    },
    async close() {
      lifetime.abort(coded("MCP_SERVER_GONE", "连接已关闭"));
      failAll(coded("MCP_SERVER_GONE", "连接已关闭"));
      await opened.catch(() => {});
    },
  };
}

export interface McpSession {
  readonly serverId: string;
  readonly serverName: string;
  readonly protocolVersion: string;
  listTools(signal: AbortSignal): Promise<readonly McpToolInfo[]>;
  callTool(
    name: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}

export interface McpConnectOptions {
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

function parseTool(value: unknown): McpToolInfo | null {
  if (value === null || typeof value !== "object") return null;
  const tool = value as {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    annotations?: { readOnlyHint?: unknown };
  };
  if (typeof tool.name !== "string" || tool.name.length === 0) return null;
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : null,
    inputSchema:
      tool.inputSchema !== null && typeof tool.inputSchema === "object"
        ? (tool.inputSchema as Record<string, unknown>)
        : { type: "object", properties: {} },
    readOnly: tool.annotations?.readOnlyHint === true,
  };
}

function parseCall(value: unknown): McpCallResult {
  if (value === null || typeof value !== "object")
    return { text: "", isError: false, omittedParts: 0 };
  const result = value as { content?: unknown; isError?: unknown };
  const parts = Array.isArray(result.content) ? result.content : [];
  const texts: string[] = [];
  let omittedParts = 0;
  for (const part of parts) {
    const entry = part as { type?: unknown; text?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") texts.push(entry.text);
    else omittedParts += 1;
  }
  return { text: texts.join("\n"), isError: result.isError === true, omittedParts };
}

/** 连接一个服务器并完成握手；失败带着码抛出，由调用方决定怎么呈现。 */
export async function connectMcpServer(
  server: McpServerConfig,
  options: McpConnectOptions = {},
): Promise<McpSession> {
  options.signal?.throwIfAborted();
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const auth = serverAuthorization(server, env);
  const channel =
    server.transport === "stdio"
      ? stdioChannel(server, env)
      : server.transport === "http"
        ? httpChannel(server, auth, fetchImpl)
        : sseChannel(server, auth, fetchImpl);
  const call = async (method: string, params: unknown, signal: AbortSignal) => {
    const { signal: timed, timedOut } = withTimeout(server.timeoutMs, signal);
    try {
      return await channel.request(method, params, timed);
    } catch (error) {
      if (timedOut())
        throw coded("MCP_TIMEOUT", `服务器 ${server.id} 在 ${server.timeoutMs}ms 内没有响应`);
      throw error;
    }
  };
  try {
    const initialized = (await call(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      options.signal ?? new AbortController().signal,
    )) as { protocolVersion?: unknown } | null;
    const notification = withTimeout(
      server.timeoutMs,
      options.signal ?? new AbortController().signal,
    );
    try {
      await channel.notify("notifications/initialized", {}, notification.signal);
    } catch (error) {
      if (notification.timedOut()) throw coded("MCP_TIMEOUT", "初始化通知超时");
      throw error;
    }
    // 协议版本以服务端协商结果为准：它给出什么就记什么，不假装我们只支持某一个版本。
    const protocolVersion =
      initialized !== null && typeof initialized?.protocolVersion === "string"
        ? initialized.protocolVersion
        : MCP_PROTOCOL_VERSION;
    return {
      serverId: server.id,
      serverName: server.name,
      protocolVersion,
      async listTools(signal) {
        const tools: McpToolInfo[] = [];
        const cursors = new Set<string>();
        let cursor: string | undefined;
        do {
          const result = (await call("tools/list", cursor ? { cursor } : {}, signal)) as {
            tools?: unknown;
            nextCursor?: unknown;
          } | null;
          if (!Array.isArray(result?.tools))
            throw coded("MCP_PROTOCOL_ERROR", "工具目录格式不正确");
          tools.push(
            ...result.tools.map(parseTool).filter((tool): tool is McpToolInfo => tool !== null),
          );
          cursor =
            typeof result.nextCursor === "string" && result.nextCursor
              ? result.nextCursor
              : undefined;
          if (cursor) {
            if (cursors.has(cursor)) throw coded("MCP_PROTOCOL_ERROR", "工具目录游标重复");
            cursors.add(cursor);
          }
        } while (cursor);
        return tools;
      },
      async callTool(name, arguments_, signal) {
        return parseCall(await call("tools/call", { name, arguments: arguments_ }, signal));
      },
      async close() {
        await channel.close();
      },
    };
  } catch (error) {
    await channel.close().catch(() => {});
    throw error;
  }
}
