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
  /**
   * 准入观察面（只读提示，不预留、不代替 acquire）；由 `createModelPort` 装配，
   * 手工构造的夹具可省略。
   */
  readonly admission?: ModelAdmission;
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
 * 模型准入：整机总帽与服务帽同时可用才占名额，等待服务名额时不占整机名额。放在端口层
 * 是因为"能不能同时发"是传输事实；`available()` 只是当前提示，不预留、不构成派发保证，
 * 真正占名额只有 `acquire()`。变更通知在状态落定后同步触发，供 worker 唤醒后复查。
 */
export interface ModelAdmission {
  available(model?: string): boolean;
  /** 返回退订；订阅随进程存活（准入实例无 dispose 语义）。 */
  subscribe(listener: () => void): () => void;
}

export interface ManagedModelAdmission extends ModelAdmission {
  /** 两个名额同时可用才 resolve 释放函数；等待中取消按 signal.reason reject 并摘队。 */
  acquire(model: string | undefined, signal?: AbortSignal): Promise<() => void>;
  /** 上限被外部改写后重新判定并唤醒等待队列；无定时轮询。 */
  refresh(): void;
}

export function createModelAdmission(options: {
  total?: number | (() => number);
  perProvider?: number | (() => number);
  providerKey?: (model: string | undefined) => string;
}): ManagedModelAdmission {
  const limitOf = (limit: number | (() => number) | undefined): (() => number) => {
    if (limit === undefined) return () => Number.POSITIVE_INFINITY;
    if (typeof limit === "function")
      return () => {
        const value = Math.floor(limit());
        if (!Number.isSafeInteger(value) || value < 1) throw new Error("MODEL_LIMIT_INVALID");
        return value;
      };
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("MODEL_LIMIT_INVALID");
    return () => limit;
  };
  const totalOf = limitOf(options.total);
  const providerOf = limitOf(options.perProvider);
  const keyOf = (model: string | undefined) => options.providerKey?.(model) ?? "all";
  let activeTotal = 0;
  const activeByProvider = new Map<string, number>();
  /** 单一 FIFO：保持到达序；释放时从队首扫描，跳过暂时不可用的服务以推进空闲服务。 */
  const waiting: { key: string; enter: () => void; abort: () => void }[] = [];
  const listeners = new Set<() => void>();
  // 通知只是"状态已变"的信号：回调异常不改变名额状态（占位/释放已生效），只记一行诊断。
  // 订阅者按 trusted 处理——回调里不做准入决策，只唤醒自己的 worker 再复查。
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        console.warn("model admission listener failed");
      }
    }
  };
  const hasRoom = (key: string): boolean =>
    activeTotal < totalOf() && (activeByProvider.get(key) ?? 0) < providerOf();
  /** 授予后统一再扫一遍队列：一次 release/refresh 可以推进多个等待者，直到无空位。 */
  const drain = () => {
    for (let index = 0; index < waiting.length; ) {
      const entry = waiting[index];
      if (!hasRoom(entry.key)) {
        index += 1;
        continue;
      }
      waiting.splice(index, 1);
      entry.enter();
    }
  };
  const acquire = (model: string | undefined, signal?: AbortSignal): Promise<() => void> => {
    signal?.throwIfAborted();
    const key = keyOf(model);
    if (hasRoom(key)) {
      activeTotal += 1;
      activeByProvider.set(key, (activeByProvider.get(key) ?? 0) + 1);
      notify();
      let released = false;
      return Promise.resolve(() => {
        if (released) return;
        released = true;
        activeTotal -= 1;
        activeByProvider.set(key, (activeByProvider.get(key) ?? 0) - 1);
        drain();
        notify();
      });
    }
    return new Promise<() => void>((resolve, reject) => {
      const entry = { key, abort: () => {}, enter: () => {} };
      entry.enter = () => {
        signal?.removeEventListener("abort", entry.abort);
        activeTotal += 1;
        activeByProvider.set(key, (activeByProvider.get(key) ?? 0) + 1);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          activeTotal -= 1;
          activeByProvider.set(key, (activeByProvider.get(key) ?? 0) - 1);
          drain();
          notify();
        });
      };
      entry.abort = () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal?.reason);
      };
      waiting.push(entry);
      signal?.addEventListener("abort", entry.abort, { once: true });
      notify();
    });
  };
  return {
    acquire,
    refresh() {
      drain();
      notify();
    },
    available(model) {
      return hasRoom(keyOf(model));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Keeps existing routing, strict-schema fallback, interruption and output-limit behavior.
 *
 * 准入交给 `createModelAdmission`：`modelCallConcurrency` 是整机帽，`providerConcurrency`
 * × `providerKey` 是服务帽；两者都省略即旧行为（不限），不由本函数另加默认。
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
  /**
   * 配置保存后的 drain 通知源。生产装配每进程一个 port，订阅与进程同寿命，因此这里
   * 丢弃注册返回的退订函数（不构造按 run 销毁的 dispose 语义）；回调内只做 refresh。
   */
  onPolicyChange?: (listener: () => void) => () => void;
}): ModelPort {
  const admission = createModelAdmission({
    total: options.modelCallConcurrency,
    perProvider: options.providerConcurrency,
    providerKey: options.providerKey,
  });
  // 上限被保存改写后由外部调用：重判等待队列并唤醒（无定时轮询）。
  options.onPolicyChange?.(() => admission.refresh());
  const constrained =
    options.modelCallConcurrency !== undefined || options.providerConcurrency !== undefined;
  const guarded = async <T>(
    run: () => Promise<T>,
    model: string | undefined,
    signal?: AbortSignal,
  ): Promise<T> => {
    signal?.throwIfAborted();
    if (!constrained) return run();
    const release = await admission.acquire(model, signal);
    try {
      signal?.throwIfAborted();
      return await run();
    } finally {
      release();
    }
  };
  return {
    defaultModel: options.gateway?.config?.model,
    admission,
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
      const release = constrained ? await admission.acquire(request.model, request.signal) : null;
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
