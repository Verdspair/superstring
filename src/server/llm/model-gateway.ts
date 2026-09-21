// LM Studio gateway — 1:1 with `llm/model_gateway.py`.
//
// Everything the model can report is mapped onto a MODEL_* error code so the
// API layer never has to know about HTTP status codes from the model server.
// The mapping is the contract: a timeout is MODEL_TIMEOUT, a connection refusal
// is MODEL_SERVICE_UNAVAILABLE, an unknown/missing model is MODEL_NOT_LOADED,
// and anything else is MODEL_ERROR.
//
// One addition on top of the source mapping: LM Studio can require an API token
// (`tokenMode: "required"`). A 401/403 means the service IS reachable and
// rejected the call, so it stays MODEL_SERVICE_UNAVAILABLE with an auth-specific
// message instead of being folded into "the service is down" — or, on the
// capacity probe, into MODEL_CAPACITY_UNAVAILABLE. The inherited 66-code
// taxonomy is deliberately not extended (tests pin its size).
//
// The token itself is configurable (`LM_STUDIO_API_KEY`), because requiring a
// token is a legitimate LM Studio setting and the previous hard-coded
// `Bearer lm-studio` made that configuration unusable. Every call carries it —
// including the `/api/v1/models` capacity probe, which used to be sent with no
// Authorization header at all and therefore failed the moment a token was
// required, even after the chat path had been given the right one.
//
// Two source behaviours worth calling out:
//   1. `capacity_from_catalog` reads the capacity of the LOADED INSTANCE, never
//      the model's theoretical maximum, and refuses to guess when several
//      instances match (MODEL_CAPACITY_AMBIGUOUS) instead of taking min/max.
//   2. `stream_chat` treats an unterminated stream as an error
//      (MODEL_STREAM_INTERRUPTED) and a `length` finish as MODEL_OUTPUT_LIMIT —
//      a truncated answer must never be saved as a successful completion.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

import { ModelUnavailableError } from "../errors";

export interface ChatMessage {
  role: string;
  content: string;
}

export interface LmStudioConfig {
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  /**
   * Bearer token sent to the model service. Optional so test doubles and
   * pre-existing config literals stay valid; `resolveLmStudioConfig` always
   * fills it. Empty/absent falls back to the LM Studio default token.
   */
  apiKey?: string;
}

/** LM Studio accepts any bearer token while `Require API token` is off. */
export const DEFAULT_LM_STUDIO_API_KEY = "lm-studio";

/** Read the new project's own LM Studio settings. Never touches the old `.env`. */
export function resolveLmStudioConfig(
  env: Record<string, string | undefined> = process.env,
): LmStudioConfig {
  const baseUrl = (env.LM_STUDIO_BASE_URL ?? "").trim() || "http://127.0.0.1:1234/v1";
  const model = (env.LM_STUDIO_MODEL ?? "").trim() || "qwen/qwen3-4b-2507";
  const apiKey = (env.LM_STUDIO_API_KEY ?? "").trim() || DEFAULT_LM_STUDIO_API_KEY;
  const rawTimeout = (env.LM_STUDIO_TIMEOUT ?? "").trim();
  const parsed = rawTimeout === "" ? Number.NaN : Number(rawTimeout);
  // Default 1200s, not 60s: `requestLifetime` keeps its timer until the response
  // body has been fully consumed (streaming included), so this value is the
  // wall-clock budget of one whole turn. Measured on a local 27B model, one
  // memory-consolidation call takes 53-110s, and a long answer on slower
  // hardware (a few tokens/second) legitimately runs into the hundreds of
  // seconds — a 60s default made turns fail at random (P2 acceptance evidence:
  // outputs/p2-memory-repro-*). Cancelling a turn still works immediately, so a
  // generous default costs little; `LM_STUDIO_TIMEOUT` lowers it.
  const timeoutSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 1200;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), model, timeoutSeconds, apiKey };
}

export interface ModelGateway {
  listModels(): Promise<string[]>;
  /** `signal` aborts the capacity probe when the caller is cancelled. */
  loadedContextCapacity(model: string, options?: { signal?: AbortSignal }): Promise<number | null>;
  probeModelLoaded(): Promise<boolean>;
  complete(options: {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /**
     * `response_schema` (model_gateway.py:154,164-167) — sent as a strict
     * `json_schema` response format. The memory worker relies on this to get a
     * machine-checkable consolidation result.
     */
    responseSchema?: Record<string, unknown>;
    /** Propagated to the underlying fetch so a caller cancellation aborts the call. */
    signal?: AbortSignal;
  }): Promise<string>;
  streamChat(options: {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /** Propagated to the underlying fetch so a caller cancellation aborts the stream. */
    signal?: AbortSignal;
  }): AsyncGenerator<string, void, unknown>;
  readonly config: LmStudioConfig;
}

/**
 * LM Studio rejects every unauthenticated call with 401 once its server is set
 * to require an API token. Shares `MODEL_SERVICE_UNAVAILABLE` (the inherited
 * taxonomy has no auth code) but says what actually happened AND what to do:
 * the token is configurable, so the fix is a setting rather than a guess.
 * Without this branch the capacity probe reported "cannot read the loaded
 * capacity, check the local model service" and sent the user looking for a
 * service that was running fine.
 */
const MODEL_AUTH_MESSAGE =
  "LM Studio 需要 API token（鉴权失败）：服务可达但请求未获授权。请在 LM Studio 的 " +
  "Developer → Server 设置中复制 API token，设为环境变量 LM_STUDIO_API_KEY 后重启；" +
  "或关闭 LM Studio 的 Require API token";

function isAuthRejection(status: number): boolean {
  return status === 401 || status === 403;
}

/** Bearer token for every call, including the capacity probe. */
function authToken(cfg: LmStudioConfig): string {
  return (cfg.apiKey ?? "").trim() || DEFAULT_LM_STUDIO_API_KEY;
}

/**
 * Translate a transport/HTTP failure into the source's `ModelUnavailableError`.
 * `map_model_error` (model_gateway.py:44-61).
 */
export function mapModelError(error: unknown): ModelUnavailableError {
  if (error instanceof ModelUnavailableError) return error;

  const name = (error as { name?: string })?.name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number } | null)?.status;
  const code = (error as { code?: unknown } | null)?.code;

  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(message)) {
    return new ModelUnavailableError("MODEL_TIMEOUT", "本地模型响应超时，请重试");
  }
  if (isAuthRejection(status ?? 0)) {
    return new ModelUnavailableError("MODEL_SERVICE_UNAVAILABLE", MODEL_AUTH_MESSAGE);
  }
  if (status === 404 || ((status === 400 || status === 404) && /model/i.test(message))) {
    return new ModelUnavailableError("MODEL_NOT_LOADED", "LM Studio 未加载指定模型");
  }
  if (
    name === "ConnectionRefused" ||
    (typeof code === "string" &&
      ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(code)) ||
    /ECONNREFUSED|fetch failed|Unable to connect|socket hang up/i.test(message)
  ) {
    return new ModelUnavailableError("MODEL_SERVICE_UNAVAILABLE", "本地模型服务暂不可用");
  }
  return new ModelUnavailableError("MODEL_ERROR", "本地模型调用失败");
}

/**
 * model_gateway.py:64-83. Reads the loaded instance's `context_length`.
 *
 * Returns null when the model simply is not present in the catalog (unknown
 * capacity — the caller fails closed). Throws MODEL_CAPACITY_AMBIGUOUS when two
 * loaded instances match, because guessing would mean reporting a budget that
 * generation will not actually use.
 */
export function capacityFromCatalog(payload: unknown, model: string): number | null {
  const models = (payload as { models?: unknown[] })?.models;
  if (!Array.isArray(models)) return null;

  const exact: unknown[] = [];
  const byKey: unknown[] = [];
  for (const item of models) {
    const entry = item as {
      type?: string;
      key?: string;
      loaded_instances?: Array<{ id?: string; config?: { context_length?: unknown } }>;
    };
    if (entry?.type !== "llm") continue;
    for (const instance of entry.loaded_instances ?? []) {
      if (instance?.id === model) exact.push(instance);
      if (entry.key === model) byKey.push(instance);
    }
  }

  const matches = exact.length > 0 ? exact : byKey;
  if (matches.length > 1) {
    throw new ModelUnavailableError(
      "MODEL_CAPACITY_AMBIGUOUS",
      "同一模型存在多个加载实例，请选择具体实例标识",
    );
  }
  if (matches.length === 0) return null;

  const value = (matches[0] as { config?: { context_length?: unknown } })?.config?.context_length;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * True for hosts that always resolve to the local machine. The LM Studio
 * endpoint is, by construction, one of these.
 */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

/**
 * `fetch` for the local model service that NEVER routes loopback traffic through
 * an HTTP(S) proxy.
 *
 * Why this exists: Bun's global `fetch` honours `HTTP_PROXY` even for
 * 127.0.0.1, so on machines where `HTTP_PROXY` is set (and `NO_PROXY` is unset)
 * every call to the local LM Studio endpoint can be silently sent to the proxy
 * and fail. Empirically (probe under artifacts/validation): with
 * `HTTP_PROXY=http://127.0.0.1:1` (dead), `fetch` to 127.0.0.1 fails with
 * "Unable to connect", while `node:http` reaches the stub — and Bun 1.4.2's
 * `fetch` ignores `NO_PROXY`, so that is not a reliable bypass.
 *
 * `node:http`/`node:https` do not consult proxy env vars, so for loopback hosts
 * we talk to the service directly and wrap the response in a standards-shaped
 * `Response` (status, headers, json/text/body). Non-loopback URLs fall back to
 * the normal `fetch`, preserving proxy behaviour for genuine remote callers.
 */
export function localhostFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  const target = typeof url === "string" ? new URL(url) : url;
  if (!isLoopbackHost(target.hostname)) {
    return fetch(target, init);
  }

  const lib = target.protocol === "https:" ? httpsRequest : httpRequest;
  const method = (init.method ?? "GET").toUpperCase();

  const headers: Record<string, string> = {};
  const initHeaders = init.headers;
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(initHeaders)) {
      for (const [key, value] of initHeaders) headers[key] = value;
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (value != null) headers[key] = String(value);
      }
    }
  }

  const body =
    init.body == null
      ? undefined
      : typeof init.body === "string"
        ? Buffer.from(init.body)
        : Buffer.from(init.body as ArrayBuffer);

  return new Promise<Response>((resolve, reject) => {
    const req = lib(
      target,
      { method, headers, signal: init.signal as AbortSignal | undefined },
      (res) => {
        const webStream = Readable.toWeb(res) as unknown as BodyInit;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else if (value != null) responseHeaders.set(key, value);
        }
        resolve(
          new Response(webStream, {
            status: res.statusCode ?? 0,
            headers: responseHeaders,
          }),
        );
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** A request owns its timeout until body consumption (including streaming) ends. */
function requestLifetime(timeoutMs: number, caller?: AbortSignal) {
  const timeout = new AbortController();
  const cleanup = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new DOMException("Model response timed out", "TimeoutError")),
    timeoutMs,
  );
  const signal = AbortSignal.any([timeout.signal, cleanup.signal, ...(caller ? [caller] : [])]);
  return {
    signal,
    rethrow(error: unknown): never {
      if (caller?.aborted) throw caller.reason ?? error;
      if (error instanceof ModelUnavailableError) throw error;
      if (timeout.signal.aborted) throw mapModelError(timeout.signal.reason);
      throw mapModelError(error);
    },
    close() {
      clearTimeout(timer);
      cleanup.abort();
    },
  };
}

/**
 * Narrow `fetch` so both text and streamed responses share the error mapping.
 *
 * The internal timeout is combined with a caller-provided `signal` so that a
 * cancellation anywhere (timeout OR external abort) terminates the underlying
 * fetch — mirroring Python `asyncio.wait_for(gateway(...), timeout)`, which
 * cancels the inner task on either condition rather than merely rejecting the
 * awaiting wrapper. Without this, an aborted request would keep consuming the
 * model stream in the background (#95).
 */
async function request(
  cfg: LmStudioConfig,
  path: string,
  init: RequestInit,
  lifetime: ReturnType<typeof requestLifetime>,
): Promise<Response> {
  try {
    const response = await localhostFetch(`${cfg.baseUrl}${path}`, {
      ...init,
      signal: lifetime.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken(cfg)}`,
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      const err = new Error(`LM Studio ${response.status}: ${await response.text()}`);
      (err as { status?: number }).status = response.status;
      throw err;
    }
    return response;
  } catch (error) {
    lifetime.rethrow(error);
  }
}

async function requestJson(
  cfg: LmStudioConfig,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  const lifetime = requestLifetime(timeoutMs, signal);
  try {
    const response = await request(cfg, path, init, lifetime);
    return await response.json();
  } catch (error) {
    lifetime.rethrow(error);
  } finally {
    lifetime.close();
  }
}

/** Minimal SSE/NDJSON line reader over a fetch body. */
async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) yield line;
        index = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* retain the original read error */
    }
    reader.releaseLock();
  }
}

export function createLmStudioClient(
  config: LmStudioConfig = resolveLmStudioConfig(),
): ModelGateway {
  const timeoutMs = config.timeoutSeconds * 1000;

  return {
    config,

    /** model_gateway.py:64-72 */
    async listModels(): Promise<string[]> {
      const body = (await requestJson(config, "/models", { method: "GET" }, timeoutMs)) as {
        data?: Array<{ id?: string }>;
      };
      return (body.data ?? []).map((m) => String(m.id ?? "")).filter((id) => id !== "");
    },

    /** model_gateway.py:86-104 — native REST catalog, 404 means "no capability". */
    async loadedContextCapacity(
      model: string,
      options?: { signal?: AbortSignal },
    ): Promise<number | null> {
      const url = `${new URL(config.baseUrl).origin}/api/v1/models`;
      const lifetime = requestLifetime(10_000, options?.signal);
      try {
        // The native catalog sits on the same origin as the OpenAI-compatible
        // API and needs the same bearer token once a token is required.
        const response = await localhostFetch(url, {
          signal: lifetime.signal,
          headers: { authorization: `Bearer ${authToken(config)}` },
        });
        if (response.status === 404) return null;
        if (isAuthRejection(response.status)) {
          throw new ModelUnavailableError("MODEL_SERVICE_UNAVAILABLE", MODEL_AUTH_MESSAGE);
        }
        if (!response.ok) throw new Error(`Capacity HTTP ${response.status}`);
        // Read transport bytes before the parse-only fallback, as httpx.get does.
        const text = await response.text();
        try {
          return capacityFromCatalog(JSON.parse(text), model);
        } catch (error) {
          if (error instanceof ModelUnavailableError) throw error;
          return null;
        }
      } catch (error) {
        if (options?.signal?.aborted) throw options.signal.reason ?? error;
        if (error instanceof ModelUnavailableError) throw error;
        throw new ModelUnavailableError(
          "MODEL_CAPACITY_UNAVAILABLE",
          "无法读取LM Studio实际加载容量，请检查本地模型服务",
        );
      } finally {
        lifetime.close();
      }
    },

    /** model_gateway.py:107-120 */
    async probeModelLoaded(): Promise<boolean> {
      await requestJson(
        config,
        "/chat/completions",
        {
          method: "POST",
          body: JSON.stringify({
            model: config.model,
            messages: [{ role: "user", content: "ping" }],
            temperature: 0,
            max_tokens: 1,
          }),
        },
        timeoutMs,
      );
      return true;
    },

    /** model_gateway.py:138-177 */
    async complete(options): Promise<string> {
      const body: Record<string, unknown> = {
        model: options.model || config.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
      };
      if (options.maxTokens !== undefined) {
        if (options.maxTokens < 1) throw new Error("max_tokens must be positive");
        body.max_tokens = options.maxTokens;
      }
      if (options.responseSchema !== undefined) {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: "superstring_result",
            strict: true,
            schema: options.responseSchema,
          },
        };
      }
      const payload = (await requestJson(
        config,
        "/chat/completions",
        { method: "POST", body: JSON.stringify(body) },
        timeoutMs,
        options.signal,
      )) as {
        choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null } }>;
      };
      const choice = payload.choices?.[0];
      if (choice?.finish_reason === "length") {
        throw new ModelUnavailableError(
          "MODEL_OUTPUT_LIMIT",
          "模型达到输出上限，内容未完整生成；同请求重试沿用原预算，修改预算仅对新轮生效",
        );
      }
      if (choice?.finish_reason != null && choice.finish_reason !== "stop") {
        throw new ModelUnavailableError("MODEL_FINISH_UNSUPPORTED", "模型未正常完成文本回复");
      }
      return choice?.message?.content ?? "";
    },

    /** model_gateway.py:180-235 */
    async *streamChat(options): AsyncGenerator<string, void, unknown> {
      const body: Record<string, unknown> = {
        model: options.model || config.model,
        messages: options.messages,
        temperature: options.temperature ?? 0.7,
        stream: true,
      };
      if (options.maxTokens !== undefined) {
        if (options.maxTokens < 1) throw new Error("max_tokens must be positive");
        body.max_tokens = options.maxTokens;
      }

      const lifetime = requestLifetime(timeoutMs, options.signal);
      try {
        const response = await request(
          config,
          "/chat/completions",
          { method: "POST", body: JSON.stringify(body) },
          lifetime,
        );
        if (!response.body) {
          throw new ModelUnavailableError(
            "MODEL_STREAM_INTERRUPTED",
            "本地模型流式响应意外中断，请重试",
          );
        }

        let finished = false;
        let outputLimited = false;
        let unsupportedFinish = false;

        for await (const line of readLines(response.body)) {
          const payload = line.startsWith("data:") ? line.slice(5).trim() : line;
          if (payload === "[DONE]") {
            finished = true;
            continue;
          }
          let chunk: {
            choices?: Array<{
              finish_reason?: string | null;
              delta?: { content?: string | null };
            }>;
          };
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason != null) {
            finished = true;
            outputLimited = outputLimited || choice.finish_reason === "length";
            unsupportedFinish =
              unsupportedFinish || !["stop", "length"].includes(choice.finish_reason);
          }
          const delta = choice.delta?.content;
          if (delta) yield delta;
        }

        if (outputLimited) {
          throw new ModelUnavailableError(
            "MODEL_OUTPUT_LIMIT",
            "模型达到输出上限，已显示内容尚不完整；同请求重试沿用原预算，修改预算仅对新轮生效",
          );
        }
        if (unsupportedFinish) {
          throw new ModelUnavailableError(
            "MODEL_FINISH_UNSUPPORTED",
            "模型未正常完成文本回复，不能确认保存为成功",
          );
        }
        if (!finished) {
          throw new ModelUnavailableError(
            "MODEL_STREAM_INTERRUPTED",
            "本地模型流式响应意外中断，请重试",
          );
        }
      } catch (error) {
        lifetime.rethrow(error);
      } finally {
        lifetime.close();
      }
    },
  };
}
