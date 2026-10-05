import type { ModelMessage, RunOwner } from "../../shared/contracts/agent-run";
import { toGatewayMessages } from "../llm/chat-content";
import type {
  ChatContentResolver,
  ChatMessage,
  ModelGateway,
  ModelTool,
} from "../llm/model-gateway";
import type { VisionClient, VisionImage } from "../llm/vision-client";

/**
 * 受信任宿主的同次准备钩子入参（T10 基础）：actualModel 已冻结（与 HTTP body 的 model 同值），
 * 请求尚未发出。宿主据此准备最终 messages/resolver；这里的 model 是唯一真源，不另造解析链。
 */
export interface ModelResolvedPrepareInput {
  /** 本次实际模型（effectiveModel 结果，与发送 body 的 model 逐字同值）。 */
  readonly model: string;
  /**
   * 能力维度的图片放行判定：外部声明 vision!==false 且进程负缓存未记该模型。
   * 未声明（undefined）=== true；与明确 vision:false 区分。消息无关——最终消息若仍含图，
   * 由发送前的 assertVisionAllowed 按最终 messages 再拦。
   */
  readonly imagesAllowed: boolean;
  /** 原始请求消息（只读；最终发送内容以钩子输出为准）。 */
  readonly messages: readonly ModelMessage[];
  readonly signal?: AbortSignal;
}

/**
 * 钩子输出：替换本 call 的最终发送内容。省略字段=沿用原值。
 * metadata 由调用方（Runtime 宿主）白名单解析为安全 primitive 后自持；port/gateway 不转发、不进 wire。
 */
export interface ModelResolvedPrepareOutput {
  readonly messages?: readonly ModelMessage[];
  readonly imageResolver?: ChatContentResolver;
  readonly metadata?: Record<string, unknown>;
}

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
  /**
   * 受信任宿主的同次准备钩子（T10）：actualModel 冻结后、HTTP body 组装前调用一次。
   * 输出的 messages/resolver 决定本 call 最终发送内容；抛错=请求不发出（fail closed）。
   * 省略=零行为变化。schema/tools 受控重试共用同一次钩子结果，不重入。
   */
  prepareWithResolved?: (input: ModelResolvedPrepareInput) => Promise<ModelResolvedPrepareOutput>;
  /**
   * 每次真正发送前的可信宿主复验：每次 HTTP 尝试（schema/tools 受控重试各算一次）
   * 与 stream 发送前各调用一次；抛错=该次尝试不发出（零追加 HTTP）。来源纪元/provider 配置
   * 当前性由 Runtime 宿主闭包读真值；缺省=原行为。
   */
  assertPreparedCurrent?: (input: { model: string }) => void;
  /**
   * 可信运行标识注入（由 Runtime 宿主填，模型/调用方不能自造）。带图片的请求必须有
   * runId+owner+imageResolver 三件套才能在发送边界解析字节；text-only 请求不需要它们。
   */
  runId?: string;
  owner?: RunOwner;
  imageResolver?: ChatContentResolver;
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
    // 先 type narrow（T09 union）：本助手只构造字符串 content 的文字消息。
    if (typeof message.content !== "string") {
      throw new Error("textMessages only accepts string content");
    }
    return {
      role: message.role as ModelMessage["role"],
      content: [{ kind: "text", text: message.content }],
    };
  });
}

/** 多模态转换：completion 与 stream 复用同一 content 转换（chat-content.ts）。text-only
 * 保持字符串旧行为；含图且缺可信 resolver 的请求在这里明确拒绝（CONTEXT_SOURCE_INVALID，
 * 来源/宿主缺陷），不会暗发字符串化的图片元数据。 */
async function gatewayMessagesAsync(
  messages: readonly ModelMessage[],
  request: Pick<ModelRequest, "runId" | "owner" | "imageResolver" | "signal">,
): Promise<ChatMessage[]> {
  return toGatewayMessages({
    messages,
    ...(request.runId === undefined ? {} : { runId: request.runId }),
    ...(request.owner === undefined ? {} : { owner: request.owner }),
    ...(request.imageResolver === undefined ? {} : { imageResolver: request.imageResolver }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
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
      // 准备钩子路径（T10）：原始 ModelMessage[] 走 preparedFrom，钩子输出最终 messages 后
      // 在网关内完成 wire 转换（used 冻结后）；无钩子路径保持先转换的旧行为逐字不变。
      // messages 必填：hook 路径显式传 `[]` 占位（仅 port 受控路径合法；
      // 占位被钩子输出替换，永不落 wire），preparedFrom 携带真实原始 readonly 数组。
      if (request.prepareWithResolved !== undefined) {
        return guarded(
          () =>
            gateway.complete({
              ...request,
              messages: [],
              preparedFrom: {
                messages: request.messages,
                ...(request.runId === undefined ? {} : { runId: request.runId }),
                ...(request.owner === undefined ? {} : { owner: request.owner }),
                ...(request.imageResolver === undefined
                  ? {}
                  : { imageResolver: request.imageResolver }),
              },
            }),
          request.model,
          request.signal,
        );
      }
      const messages = await gatewayMessagesAsync(request.messages, request);
      return guarded(
        () => gateway.complete({ ...request, messages }),
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
        // 准备钩子路径（T10）：同 complete——原始消息走 preparedFrom，转换在钩子后按最终值完成。
        // messages 槽传 `[]` 占位（仅 port 受控路径合法），成对契约同 complete。
        if (request.prepareWithResolved !== undefined) {
          yield* options.gateway.streamChat({
            ...request,
            messages: [],
            preparedFrom: {
              messages: request.messages,
              ...(request.runId === undefined ? {} : { runId: request.runId }),
              ...(request.owner === undefined ? {} : { owner: request.owner }),
              ...(request.imageResolver === undefined
                ? {}
                : { imageResolver: request.imageResolver }),
            },
          });
          return;
        }
        const messages = await gatewayMessagesAsync(request.messages, request);
        yield* options.gateway.streamChat({
          ...request,
          messages,
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
