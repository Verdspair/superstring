import type { ModelMessage } from "../../shared/contracts/agent-run";
import type { ChatMessage, ModelGateway, ModelTool } from "../llm/model-gateway";
import type { VisionClient, VisionImage } from "../llm/vision-client";

export interface ModelRequest {
  messages: readonly ModelMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  /** 原生工具声明（issue #10）：只有决策步骤带；叶子任务继续只用 responseSchema。 */
  tools?: readonly ModelTool[];
  signal?: AbortSignal;
  /** Reports the model sent by the adapter after routing or local fallback. */
  onModelResolved?: (model: string) => void;
  /** Retains returned text even when a completion terminates with a protocol error. */
  onResponseText?: (text: string, complete: boolean) => void;
}
export interface MultimodalRequest {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  model: string;
  prompt: string;
  images: readonly VisionImage[];
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}
/** Protocol adapters are replaceable; inference ownership always stays in AgentRuntime. */
export interface ModelPort {
  readonly defaultModel?: string;
  complete(request: ModelRequest): Promise<string>;
  streamText(request: ModelRequest): AsyncGenerator<string, void, unknown>;
  completeMultimodal(request: MultimodalRequest): Promise<string>;
}
export type TextModelGateway = Pick<ModelGateway, "complete"> &
  Partial<Pick<ModelGateway, "streamChat" | "config">>;

export function textMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (!["system", "user", "assistant"].includes(message.role)) {
      throw new Error(`Unsupported text message role: ${message.role}`);
    }
    return {
      role: message.role as ModelMessage["role"],
      content: [{ kind: "text", text: message.content }],
    };
  });
}

function gatewayMessages(messages: readonly ModelMessage[]): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
      .map((part) => {
        if (part.kind !== "text") throw new Error("Use completeMultimodal for image inputs");
        return part.text;
      })
      .join(""),
  }));
}

/**
 * 同时最多几条模型调用。它是**进程级**的闸，不区分服务：本地模型服务通常只该有一条在飞
 * （排队比并发更快，也不折腾显存），登记的外部服务可以调大。
 *
 * 放在端口层而不是各调用点，是因为"能不能同时发"是传输事实，不是业务判断；将来按服务分级
 * （见 0.4.0 计划的 Provider 限额）也只需换一个实现，不动上层。
 */
export interface ModelCallLimiter {
  acquire(signal?: AbortSignal): Promise<() => void>;
  /** 当前生效上限——传函数时每次 acquire 重新读取，改配置对新调用生效。 */
  readonly limit: () => number;
}

export function createModelCallLimiter(limit: number | (() => number)): ModelCallLimiter {
  const limitOf =
    typeof limit === "function"
      ? () => Math.max(1, Math.floor(limit()))
      : () => {
          if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error("MODEL_CALL_LIMIT_INVALID");
          return limit;
        };
  let active = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return {
    limit: limitOf,
    async acquire(signal) {
      signal?.throwIfAborted();
      if (active < limitOf()) {
        active += 1;
        return release;
      }
      return new Promise<() => void>((resolve, reject) => {
        const enter = () => {
          signal?.removeEventListener("abort", abort);
          resolve(release);
        };
        const abort = () => {
          const index = waiting.indexOf(enter);
          if (index >= 0) waiting.splice(index, 1);
          reject(signal?.reason);
        };
        waiting.push(enter);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
}

/**
 * Keeps existing routing, strict-schema fallback, interruption and output-limit behavior.
 *
 * 两道并发闸：整机上限（`modelCallConcurrency`）先拿，按服务分级的池（`providerConcurrency`
 * × `providerKey`）后拿。服务级只可能在整机帽之下收紧，不可能靠调大它超过整机上限——
 * 而且整机帽省略时就是旧行为（不限），不由本函数另加默认。
 */
export function createModelPort(options: {
  gateway?: TextModelGateway;
  vision?: VisionClient;
  /** 省略＝不限并发（沿用旧行为）；传入 `1`（或返回值的函数）表示整机同时只发一条。 */
  modelCallConcurrency?: number | (() => number);
  /** 每个服务同时几条；省略＝不限（沿用旧行为）。 */
  providerConcurrency?: number | (() => number);
  /** 模型名 → 服务键；同一键共享一个名额池。省略＝全部模型共用一个池。 */
  providerKey?: (model: string | undefined) => string;
}): ModelPort {
  const limiter =
    options.modelCallConcurrency === undefined
      ? null
      : createModelCallLimiter(options.modelCallConcurrency);
  const providerLimiters = new Map<string, ModelCallLimiter>();
  const providerLimiter = (model: string | undefined): ModelCallLimiter | null => {
    if (options.providerConcurrency === undefined) return null;
    const key = options.providerKey?.(model) ?? "all";
    let limiter = providerLimiters.get(key);
    if (!limiter) {
      limiter = createModelCallLimiter(options.providerConcurrency);
      providerLimiters.set(key, limiter);
    }
    return limiter;
  };
  /** 先整机后服务；中途失败把已拿到的名额还回去。 */
  const acquire = async (model: string | undefined, signal?: AbortSignal) => {
    const releases: (() => void)[] = [];
    try {
      if (limiter) releases.unshift(await limiter.acquire(signal));
      const perProvider = providerLimiter(model);
      if (perProvider) releases.unshift(await perProvider.acquire(signal));
    } catch (error) {
      for (const release of releases) release();
      throw error;
    }
    return () => {
      for (const release of releases) release();
    };
  };
  const guarded = async <T>(
    run: () => Promise<T>,
    model: string | undefined,
    signal?: AbortSignal,
  ): Promise<T> => {
    signal?.throwIfAborted();
    if (limiter === null && options.providerConcurrency === undefined) return run();
    const release = await acquire(model, signal);
    try {
      signal?.throwIfAborted();
      return await run();
    } finally {
      release();
    }
  };
  return {
    defaultModel: options.gateway?.config?.model,
    async complete(request) {
      const gateway = options.gateway;
      if (!gateway) throw new Error("Text model gateway is not configured");
      return guarded(
        () => gateway.complete({ ...request, messages: gatewayMessages(request.messages) }),
        request.model,
        request.signal,
      );
    },
    async *streamText(request) {
      if (!options.gateway?.streamChat)
        throw new Error("Streaming text model gateway is not configured");
      // 流式调用整段占名额：否则"并发 1"会在第一条还没读完时放进第二条。
      const release =
        limiter === null && options.providerConcurrency === undefined
          ? null
          : await acquire(request.model, request.signal);
      try {
        request.signal?.throwIfAborted();
        yield* options.gateway.streamChat({
          ...request,
          messages: gatewayMessages(request.messages),
        });
      } finally {
        release?.();
      }
    },
    async completeMultimodal(request) {
      const vision = options.vision;
      if (!vision) throw new Error("Vision model gateway is not configured");
      return guarded(() => vision.annotate(request), request.model, request.signal);
    },
  };
}
