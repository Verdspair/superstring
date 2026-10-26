// The multimodal half of the model gateway (ADR0018 P5i).
//
// The gateway's `complete()` carries text only, so a picture cannot travel through it. This module
// is the smallest thing that can: an OpenAI-compatible chat completion whose user message holds the
// prompt and the images as data URLs. The wire format uses PNG for animations and one entry
// per sampled frame; this shared transport lives beside the gateway rather than inside the
// sticker feature.
//
// The conventions match the gateway, because the two talk to the same service: the Bearer token is
// always sent (LM Studio rejects unauthenticated calls once it requires a token), the timeout is
// the config's whole-turn budget, and a non-2xx answer is an error rather than an empty string.

import type { ModelResponseMetadata } from "../../shared/contracts/agent-run";
import type { ModelContextBudget } from "../agent/model-port";
import { AppError } from "../errors";
import {
  abortableDelay,
  assertContextInputFits,
  type ChatMessage,
  DEFAULT_LM_STUDIO_API_KEY,
  isRetryableModelRefusal,
  type LmStudioConfig,
  localhostFetch,
  mapModelError,
} from "./model-gateway";
import {
  attemptMetadata,
  finishReasonsFromPayload,
  parseProviderUsage,
  reportModelResponse,
} from "./model-response";
import { modelRequestFormat, type PreparedRequestFormat } from "./request-format";
import {
  type StructuredOutputLevel,
  strictSchemaAccepted,
  structuredOutputKey,
  structuredOutputStart,
  withStructuredOutputChain,
} from "./strict-json-schema";

export interface VisionImage {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface VisionRequest {
  readonly requestFormat?: PreparedRequestFormat;
  readonly contextBudget?: ModelContextBudget;
  readonly contextInputLimit?: number;
  readonly assertPreparedCurrent?: (input: { model: string }) => void;
  readonly systemPrompt?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly model: string;
  readonly signal?: AbortSignal;
  readonly prompt: string;
  readonly images: readonly VisionImage[];
  /** Sent as a strict `json_schema` response format, the same shape the gateway uses. */
  readonly responseSchema?: Record<string, unknown>;
  /** ModelPort's sole admission state, acquired for the actual model HTTP attempt. */
  readonly acquireSendPermit?: (model: string, signal?: AbortSignal) => Promise<() => void>;
  /**
   * 每次真实 HTTP 发送的尝试级观察（vision 传输）：一次尝试落定（含 4xx、网络失败、JSON 解析
   * 失败）时报一次；schema 降级重试各报各的，按发送顺序。只观察，不改变任何结果——vision 对
   * finish 的既有接受语义原样保留。
   */
  readonly onModelResponse?: (metadata: ModelResponseMetadata) => void;
  /**
   * 用户配置的重试（可选；缺席＝旧行为，零自动重试）：只认真实 HTTP 429/503 拒绝。
   * `maxAttempts` 含首次，重发沿用同一 body，准入逐次重跑；共享 timeoutSignal（首次准入即
   * 启动）横跨发送与等待，总时限不因重试重置。
   */
  readonly retryPolicy?: { maxAttempts: number; retryDelayMs: number };
  /** 每次额外重发前调用：宿主在此计账/复验预算，抛错＝该次重发不发出。 */
  readonly onRetry?: () => void;
}

export interface VisionClient {
  prepareRequestFormat?(input: {
    model: string;
    responseSchema?: Record<string, unknown>;
  }): PreparedRequestFormat;
  annotate(request: VisionRequest): Promise<string>;
}

/** Base64 for a data URL. `Buffer` keeps a few hundred KB of PNG off the argument stack. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** 一行、截断的失败摘要：日志要能一眼看完，也不许把整页 HTML 灌进去。 */
function summariseBody(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return "(空响应体)";
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * 外部模型的路由钩子（0032 后续）：与聊天调用同一条规则——声明过的外部模型走它的 provider，
 * 其他名字仍走本地。
 *
 * 这个钩子后加是有原因的：起初只有聊天调用接了路由，视觉调用（图片理解、素材标注）仍写死本地
 * 地址。于是"把视觉模型设成外部模型"看起来配好了，实际却把图发给本地服务——本地没开就全部失败，
 * 用户看到的就是"看不到图片"。
 */
export interface VisionExternalRoute {
  readonly baseUrl: string;
  readonly apiKey: string | null;
}

/** `fetchImpl` is injected so the request shape can be asserted without a model service. */
export function createLmStudioVisionClient(
  config: LmStudioConfig,
  fetchImpl?: typeof fetch,
  options: { readonly externalModel?: (model: string) => VisionExternalRoute | null } = {},
): VisionClient {
  const routeFor = (model: string): LmStudioConfig => {
    const external = options.externalModel?.(model) ?? null;
    if (external === null) return config;
    return {
      ...config,
      baseUrl: external.baseUrl.replace(/\/+$/, ""),
      apiKey: external.apiKey ?? config.apiKey,
    };
  };
  const prepareRequestFormat = (input: {
    model: string;
    responseSchema?: Record<string, unknown>;
  }): PreparedRequestFormat => {
    const routed = routeFor(input.model);
    const external = options.externalModel?.(input.model) ?? null;
    return Object.freeze({
      level:
        input.responseSchema === undefined
          ? "none"
          : structuredOutputStart(
              structuredOutputKey(routed.baseUrl, input.model),
              external === null || strictSchemaAccepted(input.responseSchema),
            ),
      schema: input.responseSchema,
      tools: undefined,
      wireNames: new Map<string, string>(),
    });
  };
  return {
    prepareRequestFormat,
    async annotate(request: VisionRequest): Promise<string> {
      request.signal?.throwIfAborted();
      let timeoutSignal: AbortSignal | undefined;
      let runSignal: AbortSignal | undefined;
      let admitted = request.acquireSendPermit === undefined;
      const startRequestTimeout = (): AbortSignal => {
        timeoutSignal ??= AbortSignal.timeout(config.timeoutSeconds * 1000);
        runSignal ??=
          request.signal === undefined
            ? timeoutSignal
            : AbortSignal.any([request.signal, timeoutSignal]);
        return runSignal;
      };
      if (admitted) startRequestTimeout();
      const content: unknown[] = [{ type: "text", text: request.prompt }];
      for (const image of request.images) {
        content.push({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${toBase64(image.bytes)}` },
        });
      }
      const external = options.externalModel?.(request.model) ?? null;
      const routed = routeFor(request.model);
      const routeContext = { kind: external === null ? "local" : "external" } as const;
      const key = structuredOutputKey(routed.baseUrl, request.model);
      const requestFormat = request.requestFormat ?? prepareRequestFormat(request);
      // 默认走 localhostFetch：本地模型服务不经过 HTTP 代理（与网关同一条规则）。
      const sendFetch = fetchImpl ?? localhostFetch;
      const send = async (level: StructuredOutputLevel) => {
        const body: Record<string, unknown> = {
          model: request.model,
          messages: [
            ...(request.systemPrompt === undefined
              ? []
              : [{ role: "system", content: request.systemPrompt }]),
            { role: "user", content },
          ],
          temperature: request.temperature ?? 0.2,
          ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
        };
        Object.assign(body, modelRequestFormat(requestFormat.schema, level));
        const admissionSignal = admitted ? runSignal : request.signal;
        let release: (() => void) | undefined;
        try {
          release = request.acquireSendPermit
            ? await request.acquireSendPermit(request.model, admissionSignal)
            : undefined;
        } catch (error) {
          if (request.signal?.aborted) throw request.signal.reason ?? error;
          if (runSignal?.aborted) throw mapModelError(runSignal.reason ?? error, routeContext);
          throw error;
        }
        if (!admitted) {
          admitted = true;
          startRequestTimeout();
        }
        const signalForAttempt = startRequestTimeout();
        const startedAt = Date.now();
        let httpStatus: number | undefined;
        let attempted = false;
        try {
          if (signalForAttempt.aborted) {
            if (request.signal?.aborted) throw request.signal.reason ?? signalForAttempt.reason;
            throw mapModelError(signalForAttempt.reason, routeContext);
          }
          request.assertPreparedCurrent?.({ model: request.model });
          request.contextBudget?.assertCurrent();
          if (request.contextBudget && request.contextBudget.model !== request.model)
            throw new AppError("CONTEXT_BUDGET_EXCEEDED", "视觉预算与已授权模型不一致");
          assertContextInputFits(body.messages as ChatMessage[], request, body);
          attempted = true;
          const response = await sendFetch(`${routed.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${(routed.apiKey ?? "").trim() || DEFAULT_LM_STUDIO_API_KEY}`,
            },
            body: JSON.stringify(body),
            signal: signalForAttempt,
          }).catch((error: unknown) => {
            if (request.signal?.aborted) throw request.signal.reason ?? error;
            console.warn(
              `[vision] ${request.model} 调用失败（${Date.now() - startedAt}ms）：${describeError(error)}`,
            );
            throw mapModelError(error, routeContext);
          });
          // 状态码在 4xx 抛错之前捕获：尝试级元数据要能带上失败响应的真实 HTTP 状态。
          httpStatus = response.status;
          if (!response.ok) {
            const text = await response.text().catch(() => "");
            console.warn(
              `[vision] ${request.model} 调用被拒 HTTP ${response.status}（${Date.now() - startedAt}ms）：${summariseBody(text)}`,
            );
            const error = new Error(`vision call failed: ${response.status}`);
            (error as { status?: number }).status = response.status;
            throw mapModelError(error, routeContext);
          }
          const raw = await response.text().catch(() => "");
          try {
            const payload = JSON.parse(raw) as {
              choices?: Array<{ message?: { content?: string | null } }>;
              usage?: unknown;
            };
            // 尝试落定（成功路径）：原样 finish_reason，缺席 = []；usage 只解析本次尝试
            // 自己的载荷（D1/D2 独立可选，缺/坏字段不造数）。只观察——vision 对 finish
            // 的既有接受语义原样保留，不因此新增拒绝。
            reportModelResponse(
              request.onModelResponse,
              attemptMetadata(
                "vision",
                httpStatus,
                finishReasonsFromPayload(payload),
                undefined,
                parseProviderUsage(payload.usage),
              ),
            );
            return payload;
          } catch {
            console.warn(
              `[vision] ${request.model} 响应不是 JSON（${Date.now() - startedAt}ms）：${summariseBody(raw)}`,
            );
            throw mapModelError(new SyntaxError("vision response was not JSON"), routeContext);
          }
        } catch (error) {
          // 尝试落定（失败路径）：网络失败、4xx、JSON 解析失败都算一次真实发送尝试。
          if (attempted)
            reportModelResponse(request.onModelResponse, attemptMetadata("vision", httpStatus, []));
          throw error;
        } finally {
          release?.();
        }
      };
      // 剩余重发次数按整次逻辑调用共享：schema 降级子链换档不重置（与网关 complete 同口径）。
      const retryPolicy = request.retryPolicy;
      let retriesLeft = retryPolicy === undefined ? 0 : Math.max(0, retryPolicy.maxAttempts - 1);
      // 用户 retryPolicy 驱动的重发：只认 429/503；等待用共享 runSignal（总时限含等待），
      // onRetry 在每次额外重发前调用，抛错＝不再发送；send 逐次重新准入。
      const sendWithRetry = async (level: StructuredOutputLevel) => {
        if (retryPolicy === undefined) return send(level);
        for (;;) {
          try {
            return await send(level);
          } catch (error) {
            if (retriesLeft <= 0 || !isRetryableModelRefusal(error)) throw error;
            retriesLeft -= 1;
            try {
              await abortableDelay(retryPolicy.retryDelayMs, startRequestTimeout());
            } catch (delayError) {
              if (request.signal?.aborted) throw request.signal.reason ?? delayError;
              throw mapModelError(delayError, routeContext);
            }
            request.onRetry?.();
          }
        }
      };
      // 与网关同一条降级链：严格 json_schema → json_object → 不带该字段。
      const payload = await withStructuredOutputChain({
        key,
        model: request.model,
        hasSchema: requestFormat.schema !== undefined,
        strictAccepted: external === null || strictSchemaAccepted(requestFormat.schema),
        startLevel: requestFormat.level,
        send: sendWithRetry,
      });
      return payload.choices?.[0]?.message?.content ?? "";
    },
  };
}
