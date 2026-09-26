// The multimodal half of the model gateway (ADR0018 P5i).
//
// The gateway's `complete()` carries text only, so a picture cannot travel through it. This module
// is the smallest thing that can: an OpenAI-compatible chat completion whose user message holds the
// prompt and the images as data URLs. The protocol pieces are the ones the user approved on
// 2026-09-24 for U05 — data URLs, PNG for animations, one entry per sampled frame — and they are
// the reason this lives beside the gateway rather than inside the sticker feature.
//
// The conventions match the gateway, because the two talk to the same service: the Bearer token is
// always sent (LM Studio rejects unauthenticated calls once it requires a token), the timeout is
// the config's whole-turn budget, and a non-2xx answer is an error rather than an empty string.

import { DEFAULT_LM_STUDIO_API_KEY, type LmStudioConfig, mapModelError } from "./model-gateway";
import {
  announceStrictSchemaSkip,
  nextStructuredOutputLevel,
  rememberStructuredOutput,
  type StructuredOutputLevel,
  strictSchemaAccepted,
  structuredOutputKey,
  structuredOutputRejected,
  structuredOutputStart,
} from "./strict-json-schema";

export interface VisionImage {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface VisionRequest {
  readonly systemPrompt?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly model: string;
  readonly signal?: AbortSignal;
  readonly prompt: string;
  readonly images: readonly VisionImage[];
  /** Sent as a strict `json_schema` response format, the same shape the gateway uses. */
  readonly responseSchema?: Record<string, unknown>;
}

export interface VisionClient {
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
  fetchImpl: typeof fetch = fetch,
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
  return {
    async annotate(request: VisionRequest): Promise<string> {
      request.signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(config.timeoutSeconds * 1000);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const content: unknown[] = [{ type: "text", text: request.prompt }];
      for (const image of request.images) {
        content.push({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${toBase64(image.bytes)}` },
        });
      }
      const external = options.externalModel?.(request.model) ?? null;
      const routed = routeFor(request.model);
      const key = structuredOutputKey(routed.baseUrl, request.model);
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
        if (request.responseSchema !== undefined && level !== "none") {
          body.response_format =
            level === "json_object"
              ? { type: "json_object" }
              : {
                  type: "json_schema",
                  json_schema: {
                    name: "superstring_result",
                    strict: true,
                    schema: request.responseSchema,
                  },
                };
        }
        const startedAt = Date.now();
        let response: Response;
        try {
          response = await fetchImpl(`${routed.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              // Same fallback as the gateway: an empty token means the LM Studio default one.
              authorization: `Bearer ${(routed.apiKey ?? "").trim() || DEFAULT_LM_STUDIO_API_KEY}`,
            },
            body: JSON.stringify(body),
            signal,
          });
        } catch (error) {
          // 取消不是模型故障：与网关同一条规则，把调用方的理由原样交回去。
          if (request.signal?.aborted) throw request.signal.reason ?? error;
          console.warn(
            `[vision] ${request.model} 调用失败（${Date.now() - startedAt}ms）：${describeError(error)}`,
          );
          throw mapModelError(error);
        }
        if (!response.ok) {
          // 报告：图片读不出来，记录里只有 AGENT_FAILED，查不到为什么——以前这里
          // 把状态码和响应体一起丢了。现在原因进日志（服务、HTTP 状态、耗时、截断的响应体），
          // 错误码交给网关那张表，取消/超时/鉴权/网络各自的分类与文本调用完全一致。
          //
          // 响应体不进错误消息：它会被 mapModelError 的正则一起读，"4xx 且含 model 字样" 那条
          // 判据会把普通的形状拒绝误报成"未加载指定模型"。保留 `.status` 是给结构化输出降级用的。
          const body = await response.text().catch(() => "");
          console.warn(
            `[vision] ${request.model} 调用被拒 HTTP ${response.status}（${Date.now() - startedAt}ms）：${summariseBody(body)}`,
          );
          const error = new Error(`vision call failed: ${response.status}`);
          (error as { status?: number }).status = response.status;
          throw mapModelError(error);
        }
        // 200 但正文不是 JSON（中转层回 HTML、或误开了流式）走这里：与上面同一处理——原因进日志、
        // 码走同一张表。不做这一步的话，运行时的 SyntaxError 分支会把它记成"决策不合法"，
        // 而视觉调用根本没有决策这回事。
        const raw = await response.text().catch(() => "");
        try {
          return JSON.parse(raw) as { choices?: Array<{ message?: { content?: string | null } }> };
        } catch {
          console.warn(
            `[vision] ${request.model} 响应不是 JSON（${Date.now() - startedAt}ms）：${summariseBody(raw)}`,
          );
          throw mapModelError(new SyntaxError("vision response was not JSON"));
        }
      };
      // 与网关同一条降级链：严格 json_schema → json_object → 不带该字段。
      let payload: Awaited<ReturnType<typeof send>>;
      if (request.responseSchema === undefined) {
        payload = await send("none");
      } else {
        // 与网关同一条规则：形状注定被严格模式整单拒绝的 schema 直接起步于 json_object
        // ；本地模型服务不参与这个判断。
        const strictAccepted = external === null || strictSchemaAccepted(request.responseSchema);
        if (!strictAccepted) announceStrictSchemaSkip(key, request.model);
        let level = structuredOutputStart(key, strictAccepted);
        const attemptedStrict = level === "json_schema";
        for (;;) {
          try {
            payload = await send(level);
            if (level !== "json_schema" && attemptedStrict) {
              rememberStructuredOutput(key, level);
              console.warn(
                `[model-structured] ${request.model} 本进程起改用 ${level}（该服务不接受更严的档）`,
              );
            }
            break;
          } catch (error) {
            if (!structuredOutputRejected(error)) throw error;
            const next = nextStructuredOutputLevel(level);
            if (next === null) throw error;
            const status = (error as { status?: number }).status;
            console.warn(
              `[model-structured] ${request.model} 拒绝 ${level}（HTTP ${status ?? "?"}），降级到 ${next}`,
            );
            level = next;
          }
        }
      }
      return payload.choices?.[0]?.message?.content ?? "";
    },
  };
}
