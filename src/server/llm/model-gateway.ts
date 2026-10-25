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
import { INVOKE_BATCH_LIMIT } from "../../shared/contracts/agent-output";
import type {
  ModelMessage,
  ModelResponseMetadata,
  RunOwner,
} from "../../shared/contracts/agent-run";
import { measureContextTokens } from "../agent/context-engine";
import type {
  ModelContextBudget,
  ModelResolvedPrepareInput,
  ModelResolvedPrepareOutput,
} from "../agent/model-port";
import { AppError, ModelUnavailableError } from "../errors";
import { type ChatContentResolver, type ChatMessage, toGatewayMessages } from "./chat-content";
import {
  attemptMetadata,
  finishReasonsFromPayload,
  observeStreamFinishReason,
  reportModelResponse,
} from "./model-response";
import {
  markImageContentRejection,
  type StructuredOutputLevel,
  strictSchemaAccepted,
  structuredOutputKey,
  structuredOutputRejected,
  toStrictRequiredSchema,
  withStructuredOutputChain,
} from "./strict-json-schema";
import { loadTextTokenCounter, type TextTokenEncoding } from "./text-token-counter";
import { announceToolsFallback, rememberToolsUnavailable, toolsUnavailable } from "./tool-calling";

export type { ChatContentPart, ChatContentResolver, ChatMessage } from "./chat-content";

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

/**
 * 一次已解析模型请求的来源。由路由解析结果显式带下来，绝不从 baseUrl 的主机名或模型名反推。
 * 只用于选择用户文案；错误码、HTTP 状态、重试与降级判定都不依赖它。
 */
export interface ModelRouteContext {
  readonly kind: "local" | "external";
}

const LOCAL_MODEL_ROUTE: ModelRouteContext = { kind: "local" };
const EXTERNAL_MODEL_ROUTE: ModelRouteContext = { kind: "external" };

/** Read the new project's own LM Studio settings. Never touches the old `.env`. */
export function resolveLmStudioConfig(
  env: Record<string, string | undefined> = process.env,
): LmStudioConfig {
  const baseUrl = (env.LM_STUDIO_BASE_URL ?? "").trim() || "http://127.0.0.1:1234/v1";
  const model = (env.LM_STUDIO_MODEL ?? "").trim() || "qwen/qwen3-4b-2507";
  const apiKey = (env.LM_STUDIO_API_KEY ?? "").trim() || DEFAULT_LM_STUDIO_API_KEY;
  const rawTimeout = (env.LM_STUDIO_TIMEOUT ?? "").trim();
  const parsed = rawTimeout === "" ? Number.NaN : Number(rawTimeout);
  // Covers the full request and response body, including streaming.
  // LM_STUDIO_TIMEOUT overrides the default 1200-second wall-clock budget.
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
  listModels(options?: { signal?: AbortSignal }): Promise<string[]>;
  /** `signal` aborts the capacity probe when the caller is cancelled. */
  loadedContextCapacity(model: string, options?: { signal?: AbortSignal }): Promise<number | null>;
  /**
   * 准备某模型的上下文预算描述符（可选面；宿主 fitting 用）：解析一次实际模型，复用同一份容量
   * 读取（不做第二次回退），并在路由显式声明编码时惰性载入纯文本计数器。抛错＝本次调用不发送。
   */
  prepareContextModel?(
    model: string,
    options?: { signal?: AbortSignal },
  ): Promise<ModelContextBudget>;
  probeModelLoaded(): Promise<boolean>;
  complete(options: {
    /**
     * 初始 wire 槽（no-hook 路径 = 真实消息）。钩子路径由 ModelPort 受控传 `[]` 占位 +
     * `preparedFrom`（原始 ModelMessage[]），占位在钩子输出最终 messages 后被替换，永不落 wire。
     * `prepareWithResolved` 与 `preparedFrom` 必须成对，缺一边是装配错误（fail closed）。
     */
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
    /**
     * 每次真实模型 HTTP 发送的尝试级观察（可选）：一次 HTTP 尝试落定时报一次——含 4xx、网络
     * 失败、JSON 解析失败、未支持 finish 与响应后取消；schema/tools 受控重试各报各的，按发送
     * 顺序。目录/容量探测与发送前的准入/预检不产生回调。元数据只含传输、HTTP 状态（未见响应
     * 则缺席）、原样 finish_reason 与 [DONE] 标记，不含任何正文；观察者抛错只记一行固定警告，
     * 绝不改变结果。
     */
    onModelResponse?: (metadata: ModelResponseMetadata) => void;
    /**
     * 受信任宿主的同次准备钩子（T10 基础）：actualModel 冻结后、HTTP body 组装前调用一次。
     * 输入是原始 ModelMessage[]（未转换、只读）；输出的 messages/resolver 决定本 call 最终
     * 发送内容（在网关内完成 wire 转换，resolver 每次 resolve 仍复验 source guard）。
     * vision 闸按最终 messages 判定；抛错=请求不发出。schema/tools 受控重试共用同一次钩子
     * 结果，不重入。
     */
    prepareWithResolved?: (input: ModelResolvedPrepareInput) => Promise<ModelResolvedPrepareOutput>;
    /**
     * 钩子路径的原始请求载荷：与 `prepareWithResolved` 同进同出，由 ModelPort 填。
     * 存在时 complete/streamChat 在钩子后自行完成 wire 转换（原 `messages` 必须缺省）。
     */
    preparedFrom?: {
      messages: readonly ModelMessage[];
      runId?: string;
      owner?: RunOwner;
      imageResolver?: ChatContentResolver;
    };
    /**
     * 每次真正发送前的可信宿主复验（fix1）：每次 HTTP 尝试（schema/tools 受控重试各算一次）
     * 与 stream 发送前各调用一次；抛错=该次尝试不发出（零追加 HTTP）。provider/来源当前性
     * 由宿主闭包读真值，网关不传旧 route 判定。缺省=原行为。
     */
    assertPreparedCurrent?: (input: { model: string }) => void;
    acquireSendPermit?: (model: string, signal?: AbortSignal) => Promise<() => void>;
    /**
     * 用户配置的逻辑调用重试（可选；缺席＝旧行为，零自动重试）。`maxAttempts` 含首次逻辑
     * 尝试，即整次调用内最多 N-1 次失败重发；预算按整次逻辑调用共享（schema/tools 兼容降级
     * 子链不重置计数），每次重发沿用同一份最终 messages、不重新准备，发送前守卫与准入逐次
     * 重跑，总传输时限从第一次真正发送起算、不因重试重置。
     */
    retryPolicy?: { maxAttempts: number; retryDelayMs: number };
    /**
     * 每次额外普通重发前的回调（可选）：宿主在此计账/复验预算，抛错＝该次重发不发出。
     * 只对用户重试策略驱动的重发调用；schema/tools 兼容降级重发（既有语义）不调用。
     */
    onRetry?: () => void;
    /**
     * 宿主已准备的上下文预算（可选；缺席＝旧行为）。带它时实际模型用 `contextBudget.model`，
     * 并在每次真正发送前复验它的路由当前性；计数器供宿主后续装配使用。
     */
    contextBudget?: ModelContextBudget;
    contextInputLimit?: number;
  }): Promise<string>;
  streamChat(options: {
    /** 同 complete 的 `messages`：初始 wire 槽（no-hook = 真实消息；hook 路径 = port 受控 `[]` 占位）。 */
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
    /** Propagated to the underlying fetch so a caller cancellation aborts the stream. */
    signal?: AbortSignal;
    onModelResolved?: (model: string) => void;
    /** 同 complete 的 `onModelResponse`：transport 为 "stream"，doneMarker 只记观察到的 [DONE]。 */
    onModelResponse?: (metadata: ModelResponseMetadata) => void;
    /** 同 complete：actualModel 冻结后、组 body 前的一次受信准备钩子（原始 ModelMessage[]）。 */
    prepareWithResolved?: (input: ModelResolvedPrepareInput) => Promise<ModelResolvedPrepareOutput>;
    /** 同 complete 的 `preparedFrom`：钩子路径的原始请求载荷。 */
    preparedFrom?: {
      messages: readonly ModelMessage[];
      runId?: string;
      owner?: RunOwner;
      imageResolver?: ChatContentResolver;
    };
    /** 同 complete：每次真正发送前一次的可信宿主复验。 */
    assertPreparedCurrent?: (input: { model: string }) => void;
    acquireSendPermit?: (model: string, signal?: AbortSignal) => Promise<() => void>;
    /** 同 complete 的 `retryPolicy`：流式只在响应体开始前的请求获取阶段重试，产出后不再重试。 */
    retryPolicy?: { maxAttempts: number; retryDelayMs: number };
    /** 同 complete 的 `onRetry`：每次额外重发前调用，抛错＝不再发送。 */
    onRetry?: () => void;
    /** 同 complete：宿主已准备的上下文预算描述符。 */
    contextBudget?: ModelContextBudget;
    contextInputLimit?: number;
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
 * 原生工具调用 → invoke 决策（issue #10；0.4.0 P2 起支持**一批**调用）。
 *
 * 一次回复仍只算一个决策，但决策可以是"这批工具一起叫"：只读的会并行执行、有副作用的按顺序串行
 * （谁来定，见 `ActionDescription.effect`）。多调用**不再被丢掉**——丢掉等于模型以为自己查过了。
 *
 * 参数由服务端按函数参数 schema 校验过形状，这一层只守最后一道：只要有**一个**调用读不出来就返回
 * null（读不出就不猜，交给调用方按"读不出 = 沉默"处理），不猜着丢掉坏的那个、留下好的。超过批量上限
 * 的整批同样读不出——截断等于替模型丢掉它叫过的调用，正文 JSON 路径对超量也是直接拒绝。
 */
function decisionTextFromToolCalls(
  calls: unknown,
  wireNames?: ReadonlyMap<string, string>,
): string | null {
  if (!Array.isArray(calls) || calls.length === 0) return null;
  if (calls.length > INVOKE_BATCH_LIMIT) return null;
  const batch: { name: string; arguments: Record<string, unknown> }[] = [];
  for (const entry of calls) {
    const call = entry as { function?: { name?: unknown; arguments?: unknown } } | undefined;
    const wireName = call?.function?.name;
    if (typeof wireName !== "string" || wireName.length === 0) return null;
    const name = wireNames === undefined ? wireName : wireNames.get(wireName);
    if (name === undefined) return null;
    const rawArguments = call?.function?.arguments;
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
    batch.push({ name, arguments: parsed as Record<string, unknown> });
  }
  return JSON.stringify({ kind: "invoke", calls: batch });
}

/** OpenAI function names cannot contain the dots used by the host action catalog. */
function nativeToolDeclarations(tools: readonly ModelTool[]): {
  tools: ModelTool[];
  wireNames: ReadonlyMap<string, string>;
} {
  const validName = /^[A-Za-z0-9_-]{1,64}$/;
  const reserved = new Set(
    tools.filter((tool) => validName.test(tool.name)).map((tool) => tool.name),
  );
  const wireNames = new Map<string, string>();
  let nextAlias = 0;
  const declarations = tools.map((tool): ModelTool => {
    let name = tool.name;
    if (!validName.test(name)) {
      do {
        name = `ss_action_${nextAlias++}`;
      } while (reserved.has(name));
      reserved.add(name);
    }
    wireNames.set(name, tool.name);
    return name === tool.name
      ? tool
      : {
          ...tool,
          name,
          description: `${tool.description}\nHost action: ${tool.name}. Use ${name} for native function calls; keep the host name in JSON decisions.`,
        };
  });
  return { tools: declarations, wireNames };
}

/** Native calls carry the decision; any media fields still belong to the strict host parser. */
function nativeDecisionEnvelope(decision: string, content: string | null | undefined): string {
  if (content == null || content.trim() === "")
    return JSON.stringify({ decision: JSON.parse(decision) });
  try {
    const envelope: unknown = JSON.parse(content);
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return "";
    return JSON.stringify({ ...envelope, decision: JSON.parse(decision) });
  } catch {
    return "";
  }
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
 * 文本调用失败时的一行诊断：码与用户文案不变，provider 自己说的话（HTTP 状态 + 被 `request()`
 * 装进原始错误消息里的响应体）只进日志，避免映射后的通用错误掩盖实际失败原因。
 * 取消（调用方 abort）不是模型故障，调用点先判 `signal.aborted` 再进这里。
 */
function warnTextCallFailure(model: string, error: unknown, startedAt: number): void {
  const reason =
    (error as { providerMessage?: string } | null)?.providerMessage ?? providerReason(error);
  console.warn(
    `[model] ${model} 调用失败（HTTP ${(error as { status?: number } | null)?.status ?? "?"}，${
      Date.now() - startedAt
    }ms）：${reason}`,
  );
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

/**
 * 外部 provider 的鉴权文案：同一张错误码/状态表，但动作属于 provider 自己的 key，
 * 不能把用户指向本地 LM_STUDIO_API_KEY。文案不包含服务地址或密钥本身。
 */
const MODEL_EXTERNAL_AUTH_MESSAGE =
  "外部模型服务鉴权失败：服务可达但请求未获授权。请检查外部模型 provider 配置的 API key 是否有效";

/** 连接失败文案同样是路由专属的：外部 provider 不是本地服务。 */
const MODEL_EXTERNAL_UNAVAILABLE_MESSAGE =
  "外部模型服务暂不可用：无法连接所配置的外部 provider，请检查其服务地址与网络";

function isAuthRejection(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * 消息里有没有真实的图片 part：只有数组 content 里 `type:"image_url"` 的项算图片。
 * 数组只含文字项（纯文字数组消息）不是图片，不得触发 vision 闸门。
 */
function hasImageParts(messages: readonly ChatMessage[]): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((part) => (part as { type?: string })?.type === "image_url"),
  );
}

/**
 * 带图请求专属的 requestLifetime：只有真实携带图片 part 的调用才会传 imageRejection——
 * 图片能力/内容分类（含 markImageContentRejection 标记）以"这次请求里真的有图"为前提，
 * 纯文字请求的 4xx 不进这个分类，保留原有的形状降级资格。
 */
function imageRequestLifetime(
  timeoutMs: number,
  caller: AbortSignal | undefined,
  messages: readonly ChatMessage[],
  onRejection: (status: number, providerMessage: string) => ModelUnavailableError | null,
  route: ModelRouteContext,
) {
  if (!hasImageParts(messages)) return requestLifetime(timeoutMs, caller, route);
  return requestLifetime(timeoutMs, caller, route, onRejection);
}

/**
 * 服务自己点名「不支持图片**输入能力**」了吗？只认明确的能力拒绝句式：not supported /
 * unsupported / 不支持 这类词与 image/vision/input 同现。中文只认「不支持/不被允许」——
 * 「无法处理」在内容失败（解码、损坏）里同样出现，不构成能力证据。413（超长）、429（限流）、
 * 408（超时）、5xx/鉴权由状态位守住（见 IMAGE_CAPABILITY_STATUSES），不靠正则。
 */
const IMAGE_REJECTION_PATTERN =
  /(?:does\s+not\s+support|not\s+supported|unsupported|is\s+not\s+allowed|not\s+allowed)\s*:?\s*(?:image|vision|multimodal)|(?:image|vision|multimodal)(?:\s+\w+){0,3}?\s+(?:does\s+not\s+support|is\s+not\s+supported|is\s+not\s+allowed|not\s+supported|not\s+allowed|unsupported)|不支持(图片|图像|视觉)|(图片|图像|视觉)(输入|理解)?(不支持|不被允许)/i;
/**
 * 内容层面的错误词：格式（format）、尺寸/大小（size/过大/像素）、URL、schema、解码/损坏。
 * 命中即不是能力声明：换一张合法图片就应能发，不得据此登记负缓存。
 */
const IMAGE_CONTENT_ERROR_PATTERN =
  /format|sizes?|尺寸|大小|过大|pixels?|dimension|resolution|too\s+large|invalid|schema|decode|corrupt|损坏|解码/i;

/**
 * 允许登记「明确拒绝过图片」负缓存的 HTTP 状态窗：真实 image 请求上的非鉴权 4xx 中，
 * 只有 400/422 配合明确能力句式才可能是"这个模型不做图片"的稳定回答。408（超时）、413
 * （超长）、429（限流）是暂时/内容状态——带着能力句式也不是能力证据，401/403/5xx 由
 * `requestLifetime` 的窗口与 `mapModelError` 守住，都不写 vision 负缓存。
 */
const IMAGE_CAPABILITY_STATUSES: ReadonlySet<number> = new Set([400, 422]);

function explicitImageRejection(status: number, providerMessage: string): boolean {
  if (!IMAGE_CAPABILITY_STATUSES.has(status)) return false;
  if (!IMAGE_REJECTION_PATTERN.test(providerMessage)) return false;
  return !IMAGE_CONTENT_ERROR_PATTERN.test(providerMessage);
}

/**
 * 图片**内容**层面的拒绝（真实 image 请求上）：provider 的话同时提到图片/视觉与内容错误词
 * （格式、尺寸、像素、URL、schema、解码、损坏）。这类失败换一张合法图片就应能发——保持
 * 原 generic code/status，不写负缓存，也没有 tools/schema 降级资格（由
 * `markImageContentRejection` 标记实现）。只看图片词+内容词的交集，不用全域正则否掉
 * 真正的 tools/response_format 形状错（那些话里没有图片词）。
 */
const IMAGE_CONTEXT_PATTERN = /image|vision|multimodal|图片|图像|视觉/i;

function isImageContentRejection(providerMessage: string): boolean {
  return (
    IMAGE_CONTEXT_PATTERN.test(providerMessage) && IMAGE_CONTENT_ERROR_PATTERN.test(providerMessage)
  );
}

/** Bearer token for every call, including the capacity probe. */
function authToken(cfg: LmStudioConfig): string {
  return (cfg.apiKey ?? "").trim() || DEFAULT_LM_STUDIO_API_KEY;
}

/**
 * Translate a transport/HTTP failure into a MODEL_* `AppError`.
 * `map_model_error`.
 */
export function mapModelError(
  error: unknown,
  route: ModelRouteContext = LOCAL_MODEL_ROUTE,
): ModelUnavailableError {
  if (error instanceof ModelUnavailableError) return error;

  const name = (error as { name?: string })?.name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number } | null)?.status;
  const code = (error as { code?: unknown } | null)?.code;
  // 把 HTTP 状态带到映射后的错误上：结构化输出的自动降级要能分辨"服务端拒绝了这个
  // 请求的形状"（4xx）与"服务坏了/超时"（5xx、网络），只靠文案猜是不行的。
  const withStatus = (mapped: ModelUnavailableError): ModelUnavailableError => {
    if (typeof status === "number") (mapped as { status?: number }).status = status;
    // provider 自己说的话（HTTP 状态行 + 响应体，来自 request() 组装的原始消息）留在错误对象上，
    // 只给日志用：用户文案保持上面那张表的措辞，错误信封也只取 code/message，不会带出去。
    (mapped as { providerMessage?: string }).providerMessage = providerReason(error);
    return mapped;
  };

  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out/i.test(message)) {
    return withStatus(new ModelUnavailableError("MODEL_TIMEOUT", "本地模型响应超时，请重试"));
  }
  if (isAuthRejection(status ?? 0)) {
    return withStatus(
      new ModelUnavailableError(
        "MODEL_SERVICE_UNAVAILABLE",
        route.kind === "external" ? MODEL_EXTERNAL_AUTH_MESSAGE : MODEL_AUTH_MESSAGE,
      ),
    );
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
      new ModelUnavailableError(
        "MODEL_SERVICE_UNAVAILABLE",
        route.kind === "external" ? MODEL_EXTERNAL_UNAVAILABLE_MESSAGE : "本地模型服务暂不可用",
      ),
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
 * and fail. In a loopback check with
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

/** A request owns its timeout until body consumption (including streaming) ends.
 *
 * `imageRejection` lets a caller classify the provider's own picture rejection at the
 * HTTP boundary, BEFORE the generic mapping turns a 400 into MODEL_NOT_LOADED or a
 * structured/tools fallback consumes extra requests. It is passed only by callers
 * whose request actually carries image parts, and runs on the non-auth 4xx
 * window — it can never mask a
 * source/authorization failure or a timeout. Three outcomes, all decided here:
 * - a genuine capability rejection (400/422 + the sentence patterns) returns
 *   MODEL_IMAGE_UNSUPPORTED and the caller remembers the fingerprint;
 * - an image-content rejection (format/size/URL/schema/decode wording) throws the
 *   **mapped** error, marked via `markImageContentRejection`: original generic code
 *   and status survive, no negative cache, and neither the tools retry nor the
 *   structured-output chain treats it as a shape failure;
 * - every other in-window failure goes through `mapModelError` unchanged.
 */
function requestLifetime(
  timeoutMs: number,
  caller?: AbortSignal,
  route: ModelRouteContext = LOCAL_MODEL_ROUTE,
  imageRejection?: (status: number, providerMessage: string) => ModelUnavailableError | null,
) {
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
      if (timeout.signal.aborted) throw mapModelError(timeout.signal.reason, route);
      const status = (error as { status?: number } | null)?.status;
      if (
        imageRejection !== undefined &&
        typeof status === "number" &&
        status >= 400 &&
        status < 500 &&
        !isAuthRejection(status)
      ) {
        const classified = imageRejection(status, providerReason(error));
        if (classified !== null) throw classified;
        const mapped = mapModelError(error, route);
        if (isImageContentRejection(providerReason(error))) markImageContentRejection(mapped);
        throw mapped;
      }
      throw mapModelError(error, route);
    },
    close() {
      clearTimeout(timer);
      cleanup.abort();
    },
  };
}

/**
 * 用户 retryPolicy 的唯一重试触发条件：映射后的模型失败，status 为 429 或 503。
 * 其余失败（500/502/504、鉴权、网络、超时、取消、零输出、解析、schema/内容拒绝）一律不重试。
 */
export function isRetryableModelRefusal(error: unknown): boolean {
  if (!(error instanceof ModelUnavailableError)) return false;
  const status = (error as { status?: number }).status;
  return status === 429 || status === 503;
}

/** 固定重试间隔的等待：不轮询；`signal`（总时限或调用方取消）到点立即按原 reason 抛出。 */
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
  onResponseStatus?: (status: number) => void,
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
    // 状态码在 4xx 抛错之前交给调用方捕获：尝试级元数据要能带上失败响应的真实 HTTP 状态。
    onResponseStatus?.(response.status);
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
  route: ModelRouteContext = LOCAL_MODEL_ROUTE,
): Promise<unknown> {
  const lifetime = requestLifetime(timeoutMs, signal, route);
  try {
    const response = await request(cfg, path, init, lifetime);
    return await response.json();
  } catch (error) {
    lifetime.rethrow(error);
  } finally {
    lifetime.close();
  }
}

/** `requestJson` with a caller-owned lifetime (used by the image-aware chat path). */
async function requestJsonWithLifetime(
  cfg: LmStudioConfig,
  path: string,
  init: RequestInit,
  lifetime: ReturnType<typeof requestLifetime>,
  onResponseStatus?: (status: number) => void,
): Promise<unknown> {
  try {
    const response = await request(cfg, path, init, lifetime, onResponseStatus);
    return await response.json();
  } catch (error) {
    lifetime.rethrow(error);
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
  /**
   * Provider 行修订号：声明/登记变化后，"这个 provider+model 拒绝过图片"的负缓存指纹随之
   * 失效，不会用旧观察拦新声明。本地路由没有修订号。
   */
  readonly providerRevision?: number;
  /**
   * 该模型纯文本计数用的编码（可选）：只有配置里显式声明的编码才计数。undefined/缺席 =
   * 未声明，调用方保持旧口径，不按模型名、provider 名或 OpenAI 兼容猜编码。
   */
  readonly tokenizerEncoding?: TextTokenEncoding;
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

function assertContextInputFits(
  messages: readonly ChatMessage[],
  options: {
    contextBudget?: ModelContextBudget;
    contextInputLimit?: number;
  },
  body: Record<string, unknown>,
): void {
  if (options.contextInputLimit === undefined) return;
  const budget = options.contextBudget;
  const limit = options.contextInputLimit;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    budget?.countText === undefined ||
    budget.tokenizerEncoding === undefined ||
    budget.model !== body.model
  )
    throw new AppError("CONTEXT_BUDGET_EXCEEDED", "模型输入预算缺少一致的计量配置");
  const measured = measureContextTokens(
    messages,
    { encoding: budget.tokenizerEncoding, count: budget.countText },
    {
      ...(body.response_format === undefined
        ? {}
        : {
            responseFormat: body.response_format as Record<string, unknown>,
          }),
      ...(body.tools === undefined
        ? {}
        : {
            tools: (body.tools as Array<{ function: ModelTool }>).map((tool) => tool.function),
          }),
    },
  );
  if (measured.textTokens > limit)
    throw new AppError("CONTEXT_BUDGET_EXCEEDED", "实际请求的文本估算超过模型输入预算");
}

export function createLmStudioClient(
  config: LmStudioConfig = resolveLmStudioConfig(),
  options: {
    readonly externalModel?: (model: string) => ExternalModelRoute | null;
    readonly localModelEncoding?: (
      model: string,
    ) => { readonly tokenizerEncoding: TextTokenEncoding; readonly revision?: string } | null;
  } = {},
): ModelGateway {
  const timeoutMs = config.timeoutSeconds * 1000;
  /**
   * Resolve the request's config and explicit origin once. Callers that need both must use this
   * result rather than resolving twice: the hook may read mutable provider config, and the
   * error-wording context must describe the endpoint that actually received the request.
   */
  const resolveRouteFor = (
    model: string | undefined,
  ): {
    readonly cfg: LmStudioConfig;
    readonly external: ExternalModelRoute | null;
    readonly context: ModelRouteContext;
  } => {
    const external = model === undefined ? null : (options.externalModel?.(model) ?? null);
    if (external === null) {
      return { cfg: config, external: null, context: LOCAL_MODEL_ROUTE };
    }
    return {
      cfg: {
        ...config,
        baseUrl: external.baseUrl.replace(/\/+$/, ""),
        apiKey: external.apiKey ?? config.apiKey,
      },
      external,
      context: EXTERNAL_MODEL_ROUTE,
    };
  };

  const routeOfExternal = (model: string): ExternalModelRoute | null =>
    options.externalModel?.(model) ?? null;
  const localEncodingOf = options.localModelEncoding;

  /**
   * 预算描述符的当前性判定：准备时冻结的外部路由（providerRevision/baseUrl/apiKey/窗口/tokenizer）
   * 必须与**此刻**解析出来的一致，local 路由则要求现在仍不是外部路由。
   * 比较只做布尔判定，不回传 baseUrl/apiKey/窗口——密钥与服务地址不进错误消息。
   */
  const sameRoute = (model: string, frozen: ExternalModelRoute | null): boolean => {
    const current = routeOfExternal(model);
    if (frozen === null || current === null) return frozen === current;
    return (
      (frozen.providerRevision ?? 0) === (current.providerRevision ?? 0) &&
      frozen.baseUrl.replace(/\/+$/, "") === current.baseUrl.replace(/\/+$/, "") &&
      (frozen.apiKey ?? "") === (current.apiKey ?? "") &&
      frozen.contextWindow === current.contextWindow &&
      frozen.tokenizerEncoding === current.tokenizerEncoding
    );
  };
  const ROUTE_CHANGED_MESSAGE =
    "上下文预算已过期：模型的路由配置在准备之后发生了变化，本次请求不发出（重新准备后再试）";

  /**
   * Vision 闸门只看实际观察：进程级按 provider 修订+服务+模型指纹记住"明确拒绝过图片"的
   * 服务/模型（见 complete 内 imageRejectedKeys），不回写 provider 持久配置；不再读取用户
   * 声明的 vision 开关，未拒绝过就允许原生尝试，不猜「含 image 就不支持」。
   */
  const visionRejected = new Map<string, number>();
  const imageFingerprint = (model: string, route: ExternalModelRoute | null): string =>
    `${route?.baseUrl ?? config.baseUrl}\u0000${model}`;
  const imageFingerprintRevision = (route: ExternalModelRoute | null): number =>
    route?.providerRevision ?? 0;
  const assertVisionAllowed = (model: string, messages: readonly ChatMessage[]): void => {
    if (!hasImageParts(messages)) return;
    const route = routeOfExternal(model);
    const key = imageFingerprint(model, route);
    const rejectedAt = visionRejected.get(key);
    if (rejectedAt !== undefined && rejectedAt === imageFingerprintRevision(route)) {
      throw new ModelUnavailableError(
        "MODEL_IMAGE_UNSUPPORTED",
        `当前模型 ${model} 不支持图片输入，请改用支持视觉的模型或关闭图片输入`,
      );
    }
  };

  /**
   * 图片放行判定（T10 准备钩子用）：与消息无关——只看进程负缓存；未观察过明确拒绝就允许，
   * 最终消息是否真的带图由发送前的 assertVisionAllowed 按最终 messages 再拦。
   */
  const imagesAllowedFor = (model: string, route: ExternalModelRoute | null): boolean => {
    const rejectedAt = visionRejected.get(imageFingerprint(model, route));
    return !(rejectedAt !== undefined && rejectedAt === imageFingerprintRevision(route));
  };

  /**
   * 原始 ModelMessage[] 里有没有图片 part（钩子输入层，wire 转换前判定）。能力已拒时先拦，
   * 不进入会因缺 resolver 而报来源错误的转换——能力问题不冒充来源问题。
   */
  const hasModelImageParts = (messages: readonly ModelMessage[]): boolean =>
    messages.some((message) => message.content.some((part) => part.kind === "image"));

  // The loaded list is cached for a few seconds so one reply's several calls (judge → draft → pick)
  // do not each ask the local service again; short enough that loading a model in LM Studio shows up
  // on the next turn rather than after a restart.
  let loadedCache: { at: number; models: readonly string[] } | null = null;
  const loadedLocalModels = async (signal?: AbortSignal): Promise<readonly string[]> => {
    signal?.throwIfAborted();
    const now = Date.now();
    if (loadedCache !== null && now - loadedCache.at < 5_000) return loadedCache.models;
    try {
      const body = (await requestJson(
        config,
        "/models",
        { method: "GET" },
        timeoutMs,
        signal,
        LOCAL_MODEL_ROUTE,
      )) as {
        data?: Array<{ id?: string }>;
      };
      const models = (body.data ?? []).map((m) => String(m.id ?? "")).filter((id) => id !== "");
      loadedCache = { at: now, models };
      return models;
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
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
  const effectiveModel = async (model: string, signal?: AbortSignal): Promise<string> => {
    const chosen = pickUsableModel({
      configured: model,
      availableLocal: await loadedLocalModels(signal),
      isExternal: routeOfExternal(model) !== null,
    });
    if (chosen !== model) console.warn(`[model-fallback] ${model} 不可用，本次改用 ${chosen}`);
    return chosen;
  };

  /**
   * 容量读取的一个判定源。两种入参语义必须分开：
   * - 请求名（既有 `loadedContextCapacity` 的公开语义）：先按请求名解析实际模型，本地未加载的
   *   模型按**替补**的容量判定（替补才是真正会到达的模型），外部路由读它登记的窗口——这条
   *   回退策略原样保留。
   * - 已解析的实际模型（`prepareContextModel` 内部用）：直接按它判一次，**不再走一次回退**。
   */
  const capacityOfResolved = async (
    model: string,
    signal?: AbortSignal,
    options?: { readonly alreadyResolved?: boolean },
  ): Promise<number | null> => {
    const external = routeOfExternal(model);
    if (external !== null) return external.contextWindow;
    const used = options?.alreadyResolved === true ? model : await effectiveModel(model, signal);
    if (used !== model) {
      const substitute = routeOfExternal(used);
      if (substitute !== null) return substitute.contextWindow;
    }
    const url = `${new URL(config.baseUrl).origin}/api/v1/models`;
    const lifetime = requestLifetime(10_000, signal, LOCAL_MODEL_ROUTE);
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
        return capacityFromCatalog(JSON.parse(text), used);
      } catch (error) {
        if (error instanceof ModelUnavailableError) throw error;
        return null;
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof ModelUnavailableError) throw error;
      throw new ModelUnavailableError(
        "MODEL_CAPACITY_UNAVAILABLE",
        "无法读取LM Studio实际加载容量，请检查本地模型服务",
      );
    } finally {
      lifetime.close();
    }
  };

  return {
    config,

    async listModels(options?: { signal?: AbortSignal }): Promise<string[]> {
      const body = (await requestJson(
        config,
        "/models",
        { method: "GET" },
        timeoutMs,
        options?.signal,
        LOCAL_MODEL_ROUTE,
      )) as {
        data?: Array<{ id?: string }>;
      };
      return (body.data ?? []).map((m) => String(m.id ?? "")).filter((id) => id !== "");
    },

    /** native REST catalog, 404 means "no capability". */
    async loadedContextCapacity(
      model: string,
      options?: { signal?: AbortSignal },
    ): Promise<number | null> {
      return capacityOfResolved(model, options?.signal);
    },

    /**
     * 上下文预算准备：先按同一次 effectiveModel 解析出**实际**模型，再读**那个模型**的容量
     * （外部路由读它登记的窗口；本地走同一份目录读取，绝不做第二次回退）。计数器只在路由显式
     * 声明编码时惰性载入一次，载入后重新判定当前性；载入期间调用方取消时按原 reason 抛出。
     * 描述符只冻结描述符字段本身，不含私有键或服务地址。
     */
    async prepareContextModel(
      model: string,
      options?: { signal?: AbortSignal },
    ): Promise<ModelContextBudget> {
      const signal = options?.signal;
      const requested = model || config.model;
      const used = await effectiveModel(requested, signal);
      const resolvedRoute = routeOfExternal(used);
      const frozen = resolvedRoute === null ? null : Object.freeze({ ...resolvedRoute });
      // 已经解析出的实际模型：不再走一次回退（同名也不会触发第二次 effectiveModel 解析）。
      const capacity = await capacityOfResolved(used, signal, { alreadyResolved: true });
      const local = frozen === null ? (localEncodingOf?.(used) ?? null) : null;
      const frozenLocal = local === null ? null : Object.freeze({ ...local });
      const encoding = frozen?.tokenizerEncoding ?? frozenLocal?.tokenizerEncoding;
      // 只判定「这条实际路由还是不是当前配置的那条」：不重跑一次路由解析（否则就是第二次回退），
      // 也不看 requested 是否仍是同一个名字——描述符冻结的是实际模型本身。
      const assertCurrent = (): void => {
        if (!sameRoute(used, frozen)) {
          throw new ModelUnavailableError("MODEL_NOT_LOADED", ROUTE_CHANGED_MESSAGE);
        }
        if (frozen === null) {
          // 本地描述符的当前性只看**生效编码**与路由本身：整文件 revision 是存储层粒度，
          // 无关模型写入推高它并不使本模型的预算过期（编码未变则冻结计数器仍成立）；
          // 本模型编码变化或声明被清除（含从有到 null）才拒绝。外部改道由 sameRoute 拦下。
          const currentLocal = localEncodingOf?.(used) ?? null;
          if (currentLocal?.tokenizerEncoding !== frozenLocal?.tokenizerEncoding)
            throw new ModelUnavailableError("MODEL_NOT_LOADED", ROUTE_CHANGED_MESSAGE);
        }
      };
      const budget: ModelContextBudget = {
        model: used,
        capacity,
        ...(encoding === undefined ? {} : { tokenizerEncoding: encoding }),
        ...(frozen?.providerRevision === undefined
          ? {}
          : { routeRevision: frozen.providerRevision }),
        assertCurrent,
      };
      signal?.throwIfAborted();
      assertCurrent();
      if (encoding === undefined) return Object.freeze(budget);
      const counter = await loadTextTokenCounter(encoding);
      if (signal?.aborted) throw signal.reason ?? new Error("context budget preparation aborted");
      assertCurrent();
      return Object.freeze({ ...budget, countText: counter.count });
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
        undefined,
        LOCAL_MODEL_ROUTE,
      );
      return true;
    },

    async complete(options): Promise<string> {
      const requested = options.model || config.model;
      // 带预算的请求：实际模型就是预算描述符冻结的那个模型，不再重新解析路由。
      const used =
        options.contextBudget === undefined
          ? await effectiveModel(requested, options.signal)
          : options.contextBudget.model;
      reportResolvedModel(options.onModelResolved, used);
      const resolvedRoute = resolveRouteFor(used);
      const externalRoute = resolvedRoute.external;
      const isExternal = externalRoute !== null;
      const cfg = resolvedRoute.cfg;
      const routeContext = resolvedRoute.context;
      const key = structuredOutputKey(cfg.baseUrl, used);
      // 带预算的请求在准备钩子之前先复验一次路由当前性；复验失败＝本次请求不发出。
      options.contextBudget?.assertCurrent();
      // 受信任宿主的同次准备（T10 基础）：actualModel 冻结后、HTTP body 组装前调用一次。
      // 输入是原始 ModelMessage[]；输出的 messages/resolver 决定最终发送内容，wire 转换在
      // 这里用最终值完成（resolver 每次 resolve 仍复验 source guard）。vision 闸按最终
      // messages 判定（钩子已把 disabled 的图摘掉时不再误拦）。钩子抛错=请求不发出
      // （fail closed，来源/能力问题不降级）。schema/tools 受控重试共用同一次钩子结果：
      // 重试只降档，不换模型、不重准备。
      // prepareWithResolved 与 preparedFrom 必须成对（fix2）：缺一边是装配错误，fail closed。
      // 成对时初始 wire 槽（messages）由钩子输出最终 messages 替换；无钩子路径 messages 照旧。
      if ((options.prepareWithResolved === undefined) !== (options.preparedFrom === undefined)) {
        throw new Error("model gateway request needs prepareWithResolved and preparedFrom paired");
      }
      let preparedMessages: ChatMessage[] = options.messages;
      if (options.prepareWithResolved !== undefined && options.preparedFrom !== undefined) {
        const imagesAllowed = imagesAllowedFor(used, externalRoute);
        const prepared = await options.prepareWithResolved({
          model: used,
          imagesAllowed,
          messages: options.preparedFrom.messages,
          signal: options.signal,
        });
        options.signal?.throwIfAborted();
        const finalMessages = prepared.messages ?? options.preparedFrom.messages;
        // 负缓存已拒而钩子仍回图：转换前就拦——不取字节、不解码，能力问题不冒充来源问题
        // （缺 resolver 的转换错误是另一类缺陷）。
        if (!imagesAllowed && hasModelImageParts(finalMessages)) {
          throw new ModelUnavailableError(
            "MODEL_IMAGE_UNSUPPORTED",
            `当前模型 ${used} 不支持图片输入，请改用支持视觉的模型或关闭图片输入`,
          );
        }
        preparedMessages = await toGatewayMessages({
          messages: finalMessages,
          ...(options.preparedFrom.runId === undefined
            ? {}
            : { runId: options.preparedFrom.runId }),
          ...(options.preparedFrom.owner === undefined
            ? {}
            : { owner: options.preparedFrom.owner }),
          ...(prepared.imageResolver === undefined
            ? {}
            : { imageResolver: prepared.imageResolver }),
          ...(options.preparedFrom.imageResolver === undefined ||
          prepared.imageResolver !== undefined
            ? {}
            : { imageResolver: options.preparedFrom.imageResolver }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      }
      // resolved/fallback 后按实际使用的模型、对最终 messages 拦 vision：回退到文字 local 时
      // 不再暗发图；钩子已摘图的纯文字请求照常放行。
      assertVisionAllowed(used, preparedMessages);
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
      // 原生 tools 只发给外部路由（issue #10）：本地模型服务保持那份冻结的 JSON 决策协议。
      // 外部模型默认允许尝试原生 tools；只有服务明确拒绝过 tools 的本进程负缓存才不再带
      // （见 tool-calling.ts）。
      const toolDeclarations = options.tools ?? [];
      const nativeTools = nativeToolDeclarations(toolDeclarations);
      let sendTools = isExternal && toolDeclarations.length > 0 && !toolsUnavailable(key);
      // retryPolicy 路径的整次逻辑调用共享状态：剩余次数与一个共享 lifetime（定时器在第一次
      // 真正发送时启动，总时限横跨重试等待与后续发送、不因重试重置；收口 finally 关闭）。
      let retriesLeft =
        options.retryPolicy === undefined ? 0 : Math.max(0, options.retryPolicy.maxAttempts - 1);
      const sharedLifetime: { current: ReturnType<typeof requestLifetime> | null } = {
        current: null,
      };
      const imageClassifier = (status: number, reason: string): ModelUnavailableError | null => {
        if (!explicitImageRejection(status, reason)) return null;
        visionRejected.set(
          imageFingerprint(used, externalRoute),
          imageFingerprintRevision(externalRoute),
        );
        return new ModelUnavailableError(
          "MODEL_IMAGE_UNSUPPORTED",
          `当前模型 ${used} 不支持图片输入，请改用支持视觉的模型或关闭图片输入`,
        );
      };
      const sendOnce = async (level: StructuredOutputLevel, withTools: boolean) => {
        options.signal?.throwIfAborted();
        const body: Record<string, unknown> = {
          model: used,
          messages: preparedMessages,
          temperature: options.temperature ?? 0.7,
        };
        if (options.maxTokens !== undefined) {
          if (options.maxTokens < 1) throw new Error("max_tokens must be positive");
          body.max_tokens = options.maxTokens;
        }
        if (withTools) {
          body.tools = nativeTools.tools.map((tool) => ({
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
        // 首次发送尚无共享 lifetime，用调用方 signal（保持原起点）；重试/后续发送的准入等待
        // 用共享 lifetime 的合并 signal——总时限到点/取消能终止准入，不挂起；过期经 rethrow
        // 映射（MODEL_TIMEOUT/原 caller reason），其他准入错误原样传播。
        let release: (() => void) | undefined;
        try {
          release = options.acquireSendPermit
            ? await options.acquireSendPermit(
                used,
                sharedLifetime.current?.signal ?? options.signal,
              )
            : undefined;
        } catch (acquireError) {
          if (sharedLifetime.current?.signal.aborted) {
            sharedLifetime.current.rethrow(acquireError);
          }
          throw acquireError;
        }
        let lifetime: ReturnType<typeof requestLifetime> | null = null;
        let httpStatus: number | undefined;
        try {
          options.signal?.throwIfAborted();
          options.assertPreparedCurrent?.({ model: used });
          // 每次 HTTP 尝试（schema/tools 受控重试各一次）前复验预算对应的仍是当前路由。
          options.contextBudget?.assertCurrent();
          assertVisionAllowed(used, preparedMessages);
          assertContextInputFits(preparedMessages, options, body);
          if (options.retryPolicy === undefined) {
            lifetime = imageRequestLifetime(
              timeoutMs,
              options.signal,
              preparedMessages,
              imageClassifier,
              routeContext,
            );
          } else {
            if (sharedLifetime.current === null) {
              sharedLifetime.current = imageRequestLifetime(
                timeoutMs,
                options.signal,
                preparedMessages,
                imageClassifier,
                routeContext,
              );
            }
            lifetime = sharedLifetime.current;
          }
          const payload = (await requestJsonWithLifetime(
            cfg,
            "/chat/completions",
            { method: "POST", body: JSON.stringify(body) },
            lifetime,
            (status) => {
              httpStatus = status;
            },
          )) as {
            choices?: Array<{
              finish_reason?: string | null;
              message?: { content?: string | null; tool_calls?: unknown };
            }>;
          };
          // 尝试落定（成功路径）：原样 finish_reason，字段缺席 = []。
          reportModelResponse(
            options.onModelResponse,
            attemptMetadata("complete", httpStatus, finishReasonsFromPayload(payload)),
          );
          return payload;
        } catch (error) {
          // 尝试落定（失败路径）：lifetime 建立之后的一切失败都算一次真实发送尝试（4xx、网络、
          // 解析、响应后取消）；发送前的守卫在 lifetime 之前抛出，不算尝试、不产生回调。
          if (lifetime !== null) {
            reportModelResponse(
              options.onModelResponse,
              attemptMetadata("complete", httpStatus, []),
            );
          }
          throw error;
        } finally {
          // 共享 lifetime 不在此关闭（要横跨重试与后续发送）；无策略路径保持逐发送关闭。
          if (options.retryPolicy === undefined) lifetime?.close();
          release?.();
        }
      };
      // 用户重试策略驱动的重发：只认 429/503；失败许可已释放后才等待；onRetry 在每次额外
      // 重发前调用，抛错＝不再发送；sendOnce 逐次重跑守卫并重新准入。
      const send = async (level: StructuredOutputLevel, withTools: boolean) => {
        const policy = options.retryPolicy;
        if (policy === undefined) return sendOnce(level, withTools);
        for (;;) {
          try {
            return await sendOnce(level, withTools);
          } catch (error) {
            if (retriesLeft <= 0 || !isRetryableModelRefusal(error)) throw error;
            retriesLeft -= 1;
            const shared = sharedLifetime.current;
            if (shared === null) throw error;
            try {
              await abortableDelay(policy.retryDelayMs, shared.signal);
            } catch (delayError) {
              shared.rethrow(delayError);
            }
            options.onRetry?.();
          }
        }
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
      const startedAt = Date.now();
      try {
        payload = await withStructuredOutputChain({
          key,
          model: used,
          hasSchema: options.responseSchema !== undefined,
          // 形状注定被严格模式整单拒绝的 schema（判别联合的 oneOf）不去白撞一次 400：直接起步于
          // json_object。本地路由不参与这个判断。
          strictAccepted: !isExternal || strictSchemaAccepted(outboundSchema),
          send: attempt,
          rejectionDetail: providerReason,
        });
      } catch (error) {
        if (!options.signal?.aborted) warnTextCallFailure(used, error, startedAt);
        throw error;
      } finally {
        // 收口共享 lifetime（仅 retryPolicy 路径创建）：成功、失败与重试中止都不留定时器。
        sharedLifetime.current?.close();
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
      // A readable call is not permission to execute a truncated or rejected completion.
      if (choice?.finish_reason === "length") {
        throw new ModelUnavailableError(
          "MODEL_OUTPUT_LIMIT",
          "模型达到输出上限，内容未完整生成；同请求重试沿用原预算，修改预算仅对新轮生效",
        );
      }
      if (
        choice?.finish_reason != null &&
        choice.finish_reason !== "stop" &&
        choice.finish_reason !== "tool_calls"
      ) {
        throw new ModelUnavailableError(
          "MODEL_FINISH_UNSUPPORTED",
          "模型未正常完成文本回复",
          choice.finish_reason,
        );
      }
      const toolCalls = choice?.message?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        const decision = decisionTextFromToolCalls(
          toolCalls,
          toolDeclarations.length > 0 ? nativeTools.wireNames : undefined,
        );
        if (decision === null) {
          console.warn(
            `[model-tools] ${used} 的工具调用读不出参数：${summariseToolCalls(toolCalls)}`,
          );
          return "";
        }
        const properties = options.responseSchema?.properties as
          | Record<string, unknown>
          | undefined;
        return properties?.decision === undefined
          ? decision
          : nativeDecisionEnvelope(decision, choice?.message?.content);
      }
      if (choice?.finish_reason === "tool_calls") {
        throw new ModelUnavailableError(
          "MODEL_FINISH_UNSUPPORTED",
          "模型工具调用未完整返回",
          choice.finish_reason,
        );
      }
      return choice?.message?.content ?? "";
    },

    async *streamChat(options): AsyncGenerator<string, void, unknown> {
      const requested = options.model || config.model;
      const used =
        options.contextBudget === undefined
          ? await effectiveModel(requested, options.signal)
          : options.contextBudget.model;
      reportResolvedModel(options.onModelResolved, used);
      // 同 complete：准备钩子之前先复验路由当前性。
      options.contextBudget?.assertCurrent();
      // 流式同钩子（T10 基础）：actualModel 冻结后、组 body 前一次受信准备；抛错=流不启动。
      // wire 转换用最终 messages/resolver 在这里完成（同 complete）。
      // prepareWithResolved 与 preparedFrom 必须成对（fix2）：缺一边是装配错误，fail closed。
      if ((options.prepareWithResolved === undefined) !== (options.preparedFrom === undefined)) {
        throw new Error(
          "model gateway stream request needs prepareWithResolved and preparedFrom paired",
        );
      }
      let preparedMessages: ChatMessage[] = options.messages;
      if (options.prepareWithResolved !== undefined && options.preparedFrom !== undefined) {
        const imagesAllowed = imagesAllowedFor(used, routeOfExternal(used));
        const prepared = await options.prepareWithResolved({
          model: used,
          imagesAllowed,
          messages: options.preparedFrom.messages,
          signal: options.signal,
        });
        options.signal?.throwIfAborted();
        const finalMessages = prepared.messages ?? options.preparedFrom.messages;
        // 同 complete：能力已拒而钩子仍回图，转换前拦截（不取字节、不冒充来源错误）。
        if (!imagesAllowed && hasModelImageParts(finalMessages)) {
          throw new ModelUnavailableError(
            "MODEL_IMAGE_UNSUPPORTED",
            `当前模型 ${used} 不支持图片输入，请改用支持视觉的模型或关闭图片输入`,
          );
        }
        preparedMessages = await toGatewayMessages({
          messages: finalMessages,
          ...(options.preparedFrom.runId === undefined
            ? {}
            : { runId: options.preparedFrom.runId }),
          ...(options.preparedFrom.owner === undefined
            ? {}
            : { owner: options.preparedFrom.owner }),
          ...(prepared.imageResolver === undefined
            ? {}
            : { imageResolver: prepared.imageResolver }),
          ...(options.preparedFrom.imageResolver === undefined ||
          prepared.imageResolver !== undefined
            ? {}
            : { imageResolver: options.preparedFrom.imageResolver }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      }
      const resolvedRoute = resolveRouteFor(used);
      const cfg = resolvedRoute.cfg;
      const routeContext = resolvedRoute.context;
      // 流式同闸：resolved 后回退到文字模型时不再暗发图；vision 闸按最终 messages 判定。
      assertVisionAllowed(used, preparedMessages);
      const body: Record<string, unknown> = {
        model: used,
        messages: preparedMessages,
        temperature: options.temperature ?? 0.7,
        stream: true,
      };
      if (options.maxTokens !== undefined) {
        if (options.maxTokens < 1) throw new Error("max_tokens must be positive");
        body.max_tokens = options.maxTokens;
      }

      const streamRoute = resolvedRoute.external;
      // 发送前同守卫（fix2 前移）：guard 抛错发生在 lifetime 创建之前，不留待清理定时器。
      // retryPolicy（可选）：只在响应体开始前的获取阶段、且只对 429/503 重试；产出后不重试。
      // 策略路径整条流共用一个 lifetime，总时限从第一次真正发送起算、覆盖重试等待。
      const streamPolicy = options.retryPolicy;
      let streamRetriesLeft =
        streamPolicy === undefined ? 0 : Math.max(0, streamPolicy.maxAttempts - 1);
      const streamSharedLifetime: { current: ReturnType<typeof requestLifetime> | null } = {
        current: null,
      };
      // 流式同边界：只有真实带图请求才传图片分类回调；纯文字不进该分类，不标能力。
      const streamImageClassifier = (
        status: number,
        reason: string,
      ): ModelUnavailableError | null => {
        if (!explicitImageRejection(status, reason)) return null;
        visionRejected.set(
          imageFingerprint(used, streamRoute),
          imageFingerprintRevision(streamRoute),
        );
        return new ModelUnavailableError(
          "MODEL_IMAGE_UNSUPPORTED",
          `当前模型 ${used} 不支持图片输入，请改用支持视觉的模型或关闭图片输入`,
        );
      };
      try {
        for (;;) {
          options.signal?.throwIfAborted();
          // 同 complete：重试后的准入等待用共享 lifetime 的合并 signal，过期经 rethrow 映射
          // （MODEL_TIMEOUT/原 caller reason）；其他准入错误原样传播。准入失败不算发送、
          // 不产生尝试元数据。
          let release: (() => void) | undefined;
          try {
            release = options.acquireSendPermit
              ? await options.acquireSendPermit(
                  used,
                  streamSharedLifetime.current?.signal ?? options.signal,
                )
              : undefined;
          } catch (acquireError) {
            if (streamSharedLifetime.current?.signal.aborted) {
              streamSharedLifetime.current.rethrow(acquireError);
            }
            throw acquireError;
          }
          try {
            options.signal?.throwIfAborted();
            options.assertPreparedCurrent?.({ model: used });
            options.contextBudget?.assertCurrent();
            assertVisionAllowed(used, preparedMessages);
            assertContextInputFits(preparedMessages, options, body);
            let lifetime: ReturnType<typeof requestLifetime>;
            if (streamPolicy === undefined) {
              lifetime = imageRequestLifetime(
                timeoutMs,
                options.signal,
                preparedMessages,
                streamImageClassifier,
                routeContext,
              );
            } else {
              if (streamSharedLifetime.current === null) {
                streamSharedLifetime.current = imageRequestLifetime(
                  timeoutMs,
                  options.signal,
                  preparedMessages,
                  streamImageClassifier,
                  routeContext,
                );
              }
              lifetime = streamSharedLifetime.current;
            }
            const startedAt = Date.now();
            // 尝试级观察面：httpStatus 在 4xx 抛错前捕获；finishReasons 按到达顺序收原样值
            // （显式 null 保留，缺席 chunk 忽略）；doneMarker 只记真实观察到的 [DONE]。
            let httpStatus: number | undefined;
            const finishReasons: (string | null)[] = [];
            let doneMarker: boolean | undefined;
            let response: Response;
            try {
              response = await request(
                cfg,
                "/chat/completions",
                { method: "POST", body: JSON.stringify(body) },
                lifetime,
                (status) => {
                  httpStatus = status;
                },
              );
            } catch (error) {
              // 获取阶段失败：本次真实发送照报一次尝试元数据；429/503 且有预算才
              // 释放许可→固定间隔等待→onRetry 后重发；否则按原路径抛出。
              if (!options.signal?.aborted) warnTextCallFailure(used, error, startedAt);
              reportModelResponse(
                options.onModelResponse,
                attemptMetadata("stream", httpStatus, []),
              );
              if (
                streamPolicy === undefined ||
                streamRetriesLeft <= 0 ||
                !isRetryableModelRefusal(error)
              ) {
                // 无策略路径在此关闭本次发送的 lifetime（原 finally 语义）；共享 lifetime 由收口关闭。
                if (streamPolicy === undefined) lifetime.close();
                throw error;
              }
              streamRetriesLeft -= 1;
              release?.();
              release = undefined;
              try {
                await abortableDelay(streamPolicy.retryDelayMs, lifetime.signal);
              } catch (delayError) {
                lifetime.rethrow(delayError);
              }
              options.onRetry?.();
              continue;
            }
            try {
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
                  doneMarker = true;
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
                // 观察面：原样值按到达顺序去重收集，不影响下面的既有判定。
                observeStreamFinishReason(finishReasons, choice.finish_reason);
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
              if (!options.signal?.aborted) warnTextCallFailure(used, error, startedAt);
              lifetime.rethrow(error);
            } finally {
              reportModelResponse(
                options.onModelResponse,
                attemptMetadata("stream", httpStatus, finishReasons, doneMarker),
              );
              lifetime.close();
            }
            break;
          } finally {
            release?.();
          }
        }
      } finally {
        // 收口共享 lifetime（成功路径上方已 close 过，幂等）；重试中止/失败不留定时器。
        streamSharedLifetime.current?.close();
      }
    },
  };
}
