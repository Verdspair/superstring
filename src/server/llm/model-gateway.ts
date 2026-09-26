// LM Studio gateway
// Everything the model can report is mapped onto a MODEL_* error code so the
// API layer never has to know about HTTP status codes from the model server.
// The mapping is the contract: a timeout is MODEL_TIMEOUT, a connection refusal
// is MODEL_SERVICE_UNAVAILABLE, an unknown/missing model is MODEL_NOT_LOADED
// and anything else is MODEL_ERROR.
// One addition on top of the base mapping: LM Studio can require an API token
// (`tokenMode: "required"`). A 401/403 means the service IS reachable and
// rejected the call, so it stays MODEL_SERVICE_UNAVAILABLE with an auth-specific
// message instead of being folded into "the service is down" — or, on the
// capacity probe, into MODEL_CAPACITY_UNAVAILABLE. The 66-code
// taxonomy is deliberately not extended (tests pin its size).
// The token itself is configurable (`LM_STUDIO_API_KEY`), because requiring a
// token is a legitimate LM Studio setting and the previous hard-coded
// `Bearer lm-studio` made that configuration unusable. Every call carries it
// including the `/api/v1/models` capacity probe, which used to be sent with no
// Authorization header at all and therefore failed the moment a token was
// required, even after the chat path had been given the right one.
// Two behaviours worth calling out:
// 1. `capacity_from_catalog` reads the capacity of the LOADED INSTANCE, never
// the model's theoretical maximum, and refuses to guess when several
// instances match (MODEL_CAPACITY_AMBIGUOUS) instead of taking min/max.
// 2. `stream_chat` treats an unterminated stream as an error
// (MODEL_STREAM_INTERRUPTED) and a `length` finish as MODEL_OUTPUT_LIMIT
// a truncated answer must never be saved as a successful completion.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { ModelUnavailableError } from "../errors";
import {
  announceStrictSchemaSkip,
  nextStructuredOutputLevel,
  rememberStructuredOutput,
  type StructuredOutputLevel,
  strictSchemaAccepted,
  structuredOutputKey,
  structuredOutputRejected,
  structuredOutputStart,
  toStrictRequiredSchema,
} from "./strict-json-schema";
import { announceToolsFallback, rememberToolsUnavailable, toolsUnavailable } from "./tool-calling";

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

/** 声明给模型的原生工具（OpenAI 形状的 function 部分）。 */
export interface ModelTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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
     * `response_schema` — sent as a strict
     * `json_schema` response format. The memory worker relies on this to get a
     * machine-checkable consolidation result.
     */
    responseSchema?: Record<string, unknown>;
    /**
     * 原生工具声明（issue #10）：决策步骤把已广告的动作按 function 形状发给模型，模型的
     * `tool_calls` 会被映射回现有 invoke 决策。只对外部路由发送；本地服务保持冻结的 JSON 决策。
     */
    tools?: readonly ModelTool[];
    /** Propagated to the underlying fetch so a caller cancellation aborts the call. */
    signal?: AbortSignal;
    onModelResolved?: (model: string) => void;
    onResponseText?: (text: string, complete: boolean) => void;
  }): Promise<string>;
  streamChat(options: {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /** Propagated to the underlying fetch so a caller cancellation aborts the stream. */
    signal?: AbortSignal;
    onModelResolved?: (model: string) => void;
  }): AsyncGenerator<string, void, unknown>;
  readonly config: LmStudioConfig;
}

/** Routing diagnostics cannot change whether an authorized model request executes. */
function reportResolvedModel(callback: ((model: string) => void) | undefined, model: string): void {
  try {
    callback?.(model);
  } catch {
    console.warn("model routing diagnostic write failed");
  }
}

/**
 * 原生工具调用 → 现有 invoke 决策（issue #10）。
 *
 * 一次回复只认一个决策，所以只有第一个调用算数（多调用是并行意图，本协议一步一个动作；后续步骤
 * 会重新决策）。参数由服务端按函数参数 schema 校验过形状，这一层只守最后一道：读不出就不猜，
 * 返回 null 交给调用方按"读不出 = 沉默"处理。
 */
function decisionTextFromToolCalls(calls: unknown): string | null {
  const first = Array.isArray(calls)
    ? (calls[0] as { function?: { name?: unknown; arguments?: unknown } } | undefined)
    : undefined;
  const name = first?.function?.name;
  if (typeof name !== "string" || name.length === 0) return null;
  const rawArguments = first?.function?.arguments;
  let parsed: unknown;
  if (rawArguments === undefined || rawArguments === null || rawArguments === "") parsed = {};
  else if (typeof rawArguments === "string") {
    try {
      parsed = JSON.parse(rawArguments);
    } catch {
      return null;
    }
  } else parsed = rawArguments;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return JSON.stringify({ kind: "invoke", name, arguments: parsed });
}

/** 读不出的调用只记一个摘要：这是诊断，不是内容。 */
function summariseToolCalls(calls: unknown): string {
  try {
    return JSON.stringify(calls).slice(0, 300);
  } catch {
    return "(unserialisable)";
  }
}

/**
 * 服务拒绝时它自己说的话（`LM Studio 400: {…}` → `{…}`）：只报状态码猜不出为什么被拒，
 * 要求"报错码要能定位"。整条消息兜底，一行、截断。
 */
function providerReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

/**
 * LM Studio rejects every unauthenticated call with 401 once its server is set
 * to require an API token. Shares `MODEL_SERVICE_UNAVAILABLE` (the
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
 * Translate a transport/HTTP failure into a MODEL_* `AppError`.
 * `map_model_error`.
 */
export function mapModelError(error: unknown): ModelUnavailableError {
  if (error instanceof ModelUnavailableError) return error;

  const name = (error as { name?: string })?.name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number } | null)?.status;
  const code = (error as { code?: unknown } | null)?.code;
  // 把 HTTP 状态带到映射后的错误上（2026-09-25）：结构化输出的自动降级要能分辨"服务端拒绝了这个
  // 请求的形状"（4xx）与"服务坏了/超时"（5xx、网络），只靠文案猜是不行的。
  const withStatus = (mapped: ModelUnavailableError): ModelUnavailableError => {
    if (typeof status === "number") (mapped as { status?: number }).status = status;
    return mapped;
  };

  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(message)) {
    return withStatus(new ModelUnavailableError("MODEL_TIMEOUT", "本地模型响应超时，请重试"));
  }
  if (isAuthRejection(status ?? 0)) {
    return withStatus(new ModelUnavailableError("MODEL_SERVICE_UNAVAILABLE", MODEL_AUTH_MESSAGE));
  }
  if (status === 404 || ((status === 400 || status === 404) && /model/i.test(message))) {
    return withStatus(new ModelUnavailableError("MODEL_NOT_LOADED", "LM Studio 未加载指定模型"));
  }
  if (
    name === "ConnectionRefused" ||
    (typeof code === "string" &&
      ["ECONNREFUSED", "ECONNRESET", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(code)) ||
    /ECONNREFUSED|fetch failed|Unable to connect|socket hang up/i.test(message)
  ) {
    return withStatus(
      new ModelUnavailableError("MODEL_SERVICE_UNAVAILABLE", "本地模型服务暂不可用"),
    );
  }
  return withStatus(new ModelUnavailableError("MODEL_ERROR", "本地模型调用失败"));
}

/**
 * 83. Reads the loaded instance's `context_length`.
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
 * Why this exists: Bun's global `fetch` honours `HTTP_PROXY` even for
 * 127.0.0.1, so on machines where `HTTP_PROXY` is set (and `NO_PROXY` is unset)
 * every call to the local LM Studio endpoint can be silently sent to the proxy
 * and fail. Empirically (probe under artifacts/validation): with
 * `HTTP_PROXY=http://127.0.0.1:1` (dead), `fetch` to 127.0.0.1 fails with
 * "Unable to connect", while `node:http` reaches the stub — and Bun 1.4.2's
 * `fetch` ignores `NO_PROXY`, so that is not a reliable bypass.
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
 * The internal timeout is combined with a caller-provided `signal` so that a
 * cancellation anywhere (timeout OR external abort) terminates the underlying
 * fetch. Either condition (timeout or external abort) cancels the underlying
 * request rather than merely rejecting the
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
      /* retain the underlying read error */
    }
    reader.releaseLock();
  }
}

/**
 * 外部模型 API 的解析钩子（0032）：给一个模型名，回答它由哪个外部 provider 服务，或 `null`
 * 表示"不是外部模型，仍走本地服务"。注入而不是在这里读库，是为了让网关保持"一个 HTTP 客户端"
 * 的本分——路由是配置的事，不是传输的事。
 */
export interface ExternalModelRoute {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly contextWindow: number;
}

/**
 * 配置的模型不可用时的替补规则。
 *
 * "Unavailable" is decided by this side, not guessed: a model declared on the 外部模型API page is
 * used as configured (its provider is the user's own choice and its window is on record), while a
 * local name has to appear in what the local service reports as loaded. When it does not, the call
 * uses an available local model instead — and because this is decided per call, the configured model
 * is used again the moment it is loaded, with no sticky switch to undo.
 *
 * `null` means "nothing to fall back to": with no model loaded at all, the configured name travels
 * unchanged so the existing capacity error can explain the situation instead of a silent invention.
 */
export function pickUsableModel(input: {
  configured: string;
  availableLocal: readonly string[];
  isExternal: boolean;
}): string {
  if (input.isExternal) return input.configured;
  if (input.availableLocal.includes(input.configured)) return input.configured;
  return input.availableLocal[0] ?? input.configured;
}

export function createLmStudioClient(
  config: LmStudioConfig = resolveLmStudioConfig(),
  options: { readonly externalModel?: (model: string) => ExternalModelRoute | null } = {},
): ModelGateway {
  const timeoutMs = config.timeoutSeconds * 1000;
  /** The config a given model name talks to: the local one, or a declared external provider. */
  const routeFor = (model: string | undefined): LmStudioConfig => {
    const external = model === undefined ? null : (options.externalModel?.(model) ?? null);
    if (external === null) return config;
    return {
      ...config,
      baseUrl: external.baseUrl.replace(/\/+$/, ""),
      apiKey: external.apiKey ?? config.apiKey,
    };
  };

  const routeOfExternal = (model: string): ExternalModelRoute | null =>
    options.externalModel?.(model) ?? null;

  // The loaded list is cached for a few seconds so one reply's several calls (judge → draft → pick)
  // do not each ask the local service again; short enough that loading a model in LM Studio shows up
  // on the next turn rather than after a restart.
  let loadedCache: { at: number; models: readonly string[] } | null = null;
  const loadedLocalModels = async (): Promise<readonly string[]> => {
    const now = Date.now();
    if (loadedCache !== null && now - loadedCache.at < 5_000) return loadedCache.models;
    try {
      const body = (await requestJson(config, "/models", { method: "GET" }, timeoutMs)) as {
        data?: Array<{ id?: string }>;
      };
      const models = (body.data ?? []).map((m) => String(m.id ?? "")).filter((id) => id !== "");
      loadedCache = { at: now, models };
      return models;
    } catch {
      // A catalogue we cannot read is not a licence to invent a substitute; the configured name
      // travels and the call's own error explains what happened.
      return [];
    }
  };
  /**
   * The model a call actually uses: the configured one whenever it can be used, an available local
   * model when it cannot (see `pickUsableModel`), and — when the substitute is in play — a warning
   * line in the server console, because a silent swap would make "it answered differently today"
   * impossible to explain.
   */
  const effectiveModel = async (model: string): Promise<string> => {
    const chosen = pickUsableModel({
      configured: model,
      availableLocal: await loadedLocalModels(),
      isExternal: routeOfExternal(model) !== null,
    });
    if (chosen !== model) console.warn(`[model-fallback] ${model} 不可用，本次改用 ${chosen}`);
    return chosen;
  };

  return {
    config,

    async listModels(): Promise<string[]> {
      const body = (await requestJson(config, "/models", { method: "GET" }, timeoutMs)) as {
        data?: Array<{ id?: string }>;
      };
      return (body.data ?? []).map((m) => String(m.id ?? "")).filter((id) => id !== "");
    },

    /** native REST catalog, 404 means "no capability". */
    async loadedContextCapacity(
      model: string,
      options?: { signal?: AbortSignal },
    ): Promise<number | null> {
      // A declared external model carries the window the user typed. That is the whole point of
      // asking for it: external services have no catalogue to read, and an unknown capacity would
      // make the QQ chain refuse to call at all.
      const external = routeOfExternal(model);
      if (external !== null) return external.contextWindow;
      // A configured local model that is not loaded is judged by its substitute's capacity, because
      // that substitute is the model the call will actually reach (see `effectiveModel`).
      const used = await effectiveModel(model);
      if (used !== model) {
        const substitute = routeOfExternal(used);
        if (substitute !== null) return substitute.contextWindow;
      }
      const capacityModel = used;
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
          return capacityFromCatalog(JSON.parse(text), capacityModel);
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

    async complete(options): Promise<string> {
      const requested = options.model || config.model;
      const used = await effectiveModel(requested);
      reportResolvedModel(options.onModelResolved, used);
      const isExternal = routeOfExternal(used) !== null;
      const cfg = routeFor(used);
      const key = structuredOutputKey(cfg.baseUrl, used);
      // External providers that proxy OpenAI's strict mode reject an optional property
      // (`required` must list every key). The rewritten schema says the same thing in their
      // dialect — required, but nullable — and this side reads both the same way. The local
      // service keeps the frozen schema byte for byte. Rewritten once per call, not per attempt.
      const outboundSchema =
        options.responseSchema === undefined
          ? undefined
          : isExternal
            ? toStrictRequiredSchema(options.responseSchema)
            : options.responseSchema;
      // 原生 tools 只发给外部路由（issue #10）：本地模型服务保持那份冻结的 JSON 决策协议，本次改动
      // 不动它。某个服务明确拒绝过 tools 之后，本进程不再带（见 tool-calling.ts）。
      const toolDeclarations = options.tools ?? [];
      let sendTools = isExternal && toolDeclarations.length > 0 && !toolsUnavailable(key);
      const send = async (level: StructuredOutputLevel, withTools: boolean) => {
        const body: Record<string, unknown> = {
          model: used,
          messages: options.messages,
          temperature: options.temperature ?? 0.7,
        };
        if (options.maxTokens !== undefined) {
          if (options.maxTokens < 1) throw new Error("max_tokens must be positive");
          body.max_tokens = options.maxTokens;
        }
        if (withTools) {
          body.tools = toolDeclarations.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          }));
        }
        if (options.responseSchema !== undefined && level !== "none") {
          body.response_format =
            level === "json_object"
              ? { type: "json_object" }
              : {
                  type: "json_schema",
                  json_schema: { name: "superstring_result", strict: true, schema: outboundSchema },
                };
        }
        return (await requestJson(
          cfg,
          "/chat/completions",
          { method: "POST", body: JSON.stringify(body) },
          timeoutMs,
          options.signal,
        )) as {
          choices?: Array<{
            finish_reason?: string | null;
            message?: { content?: string | null; tool_calls?: unknown };
          }>;
        };
      };
      // 带 tools 的请求被 4xx 拒绝（不是鉴权问题）→ 记忆并去掉 tools 重发一次。撞的是"服务不接受
      // 这个字段"，不是内容问题，所以重发安全；档位按服务+模型记住，后续调用不再白撞。
      const attempt = async (level: StructuredOutputLevel) => {
        try {
          return await send(level, sendTools);
        } catch (error) {
          if (!sendTools || !structuredOutputRejected(error)) throw error;
          const status = (error as { status?: number }).status;
          rememberToolsUnavailable(key);
          announceToolsFallback(key, used, status, providerReason(error));
          sendTools = false;
          return await send(level, false);
        }
      };
      // 结构化输出的自动降级：有些服务不接受严格的 json_schema 而直接 4xx，
      // 而我们的解析本来就是严格的，所以退回 json_object、再退回不带该字段都是安全的。
      let payload: Awaited<ReturnType<typeof send>>;
      if (options.responseSchema === undefined) {
        payload = await attempt("none");
      } else {
        // 形状注定被严格模式整单拒绝的 schema（判别联合的 oneOf）不去白撞一次 400：直接起步于
        // json_object。本地路由不参与这个判断。
        const strictAccepted = !isExternal || strictSchemaAccepted(outboundSchema);
        if (!strictAccepted) announceStrictSchemaSkip(key, used);
        let level = structuredOutputStart(key, strictAccepted);
        // 只有"这一轮真的撞过更严的档"才值得记住并提示；直接跳过不算。
        const attemptedStrict = level === "json_schema";
        for (;;) {
          try {
            payload = await attempt(level);
            if (level !== "json_schema" && attemptedStrict) {
              rememberStructuredOutput(key, level);
              console.warn(
                `[model-structured] ${used} 本进程起改用 ${level}（该服务不接受更严的档）`,
              );
            }
            break;
          } catch (error) {
            if (!structuredOutputRejected(error)) throw error;
            const next = nextStructuredOutputLevel(level);
            if (next === null) throw error;
            const status = (error as { status?: number }).status;
            console.warn(
              `[model-structured] ${used} 拒绝 ${level}（HTTP ${status ?? "?"}），降级到 ${next}：${providerReason(error)}`,
            );
            level = next;
          }
        }
      }
      const choice = payload.choices?.[0];
      if (typeof choice?.message?.content === "string") {
        try {
          options.onResponseText?.(
            choice.message.content,
            choice.finish_reason == null || choice.finish_reason === "stop",
          );
        } catch {
          console.warn("model response diagnostic write failed");
        }
      }
      // 原生调用优先于正文：它是模型对"要做什么"最直接的表达。读不出参数的调用不算决策——
      // 记下摘要（诊断）后按空正文处理，让严格解析照旧失败（读不出 = 沉默，不猜）。
      const toolCalls = choice?.message?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        const decision = decisionTextFromToolCalls(toolCalls);
        if (decision === null) {
          console.warn(
            `[model-tools] ${used} 的工具调用读不出参数：${summariseToolCalls(toolCalls)}`,
          );
          return "";
        }
        return decision;
      }
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

    async *streamChat(options): AsyncGenerator<string, void, unknown> {
      const used = await effectiveModel(options.model || config.model);
      reportResolvedModel(options.onModelResolved, used);
      const cfg = routeFor(used);
      const body: Record<string, unknown> = {
        model: used,
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
          cfg,
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
