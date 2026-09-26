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

import { DEFAULT_LM_STUDIO_API_KEY, type LmStudioConfig } from "./model-gateway";
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
        const response = await fetchImpl(`${routed.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // Same fallback as the gateway: an empty token means the LM Studio default one.
            authorization: `Bearer ${(routed.apiKey ?? "").trim() || DEFAULT_LM_STUDIO_API_KEY}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (!response.ok) {
          // 结构化输出的自动降级要能认出"形状被拒绝"，所以状态码必须跟着错误一起走。
          const error = new Error(`vision call failed: ${response.status}`);
          (error as { status?: number }).status = response.status;
          throw error;
        }
        return (await response.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
        };
      };
      // 与网关同一条降级链（用户 2026-09-25）：严格 json_schema → json_object → 不带该字段。
      let payload: Awaited<ReturnType<typeof send>>;
      if (request.responseSchema === undefined) {
        payload = await send("none");
      } else {
        // 与网关同一条规则：形状注定被严格模式整单拒绝的 schema 直接起步于 json_object
        // （用户 2026-09-26 的云端 400）；本地模型服务不参与这个判断。
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
