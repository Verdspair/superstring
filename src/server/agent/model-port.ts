import type {
  ModelMessage,
  ModelResponseMetadata,
  RunOwner,
} from "../../shared/contracts/agent-run";
import { toGatewayMessages } from "../llm/chat-content";
import type {
  ChatContentResolver,
  ChatMessage,
  ModelGateway,
  ModelTool,
} from "../llm/model-gateway";
import type { TextTokenEncoding } from "../llm/text-token-counter";
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

/**
 * 上下文预算描述符（宿主 fitting 的唯一入口，只读）：actualModel、**那个模型**的实际容量，以及
 * 路由显式声明编码时才有的纯文本计数器。没有声明就没有 `countText`——不按模型名或 provider 名猜编码，
 * 也不把 OpenAI 兼容当编码证据。描述符本身冻结；`assertCurrent()` 在准备之后、每次真正发送之前复验
 * 「仍然是这一条路由」（抛错＝该次不发送）。`countText` 是整段纯文本的精确计数，不是 chat 模板、
 * 工具/schema 包装或媒体后的整请求精确成本。
 */
export interface ModelContextBudget {
  /** 本次实际模型（与最终 HTTP body 的 model 同值）。 */
  readonly model: string;
  /** 该实际模型的容量；null = 未知，调用方按未知处理（不缩预算、不加载模型）。 */
  readonly capacity: number | null;
  readonly tokenizerEncoding?: TextTokenEncoding;
  /** Frozen provider revision for retry metadata; absent for local routes. */
  readonly routeRevision?: number;
  readonly countText?: (text: string) => number;
  assertCurrent: () => void;
}

export type ModelWorkClass = "mention" | "ordinary";

export interface ModelRequest {
  messages: readonly ModelMessage[];
  model?: string;
  /** Trusted Runtime task class used only for next-free send admission ordering. */
  workClass?: ModelWorkClass;
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
  onModelResponse?: (metadata: ModelResponseMetadata) => void;
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
  /**
   * 宿主已经准备好的上下文预算（可选；缺席＝旧行为）。带它发送时，实际模型改用
   * `contextBudget.model`（它就是本 call 冻结的真实模型），并在每次真正发送前按
   * `assertCurrent()` 复验路由当前性——抛错＝该次尝试不发出（零追加 HTTP）。
   * 描述符的计数器供宿主装配使用，不代表这里已经测量了完整请求。
   */
  contextBudget?: ModelContextBudget;
  /** Optional input ceiling in the descriptor counting method; omitted keeps legacy behavior. */
  contextInputLimit?: number;
}
export interface MultimodalRequest {
  onModelResponse?: (metadata: ModelResponseMetadata) => void;
  systemPrompt?: string;
  workClass?: ModelWorkClass;
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
   * 准备某模型的上下文预算描述符（可选能力；网关没实现就缺席＝旧行为，不影响既有调用）。
   * 解析一次、复用既有容量目录/外部路由，不另起路由或缓存。
   */
  prepareContextModel?(
    model: string,
    options?: { signal?: AbortSignal },
  ): Promise<ModelContextBudget>;
  /**
   * 准入观察面（只读提示，不预留、不代替 acquire）；由 `createModelPort` 装配，
   * 手工构造的夹具可省略。
   */
  readonly admission?: ModelAdmission;
}
export type TextModelGateway = Pick<ModelGateway, "complete"> &
  Partial<Pick<ModelGateway, "streamChat" | "config" | "prepareContextModel">>;

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
  acquire(
    model: string | undefined,
    signal?: AbortSignal,
    workClass?: ModelWorkClass,
  ): Promise<() => void>;
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
  /** One queue; mention requests take the next available slot while each class keeps FIFO order. */
  const waiting: {
    key: string;
    workClass: ModelWorkClass;
    enter: () => void;
    abort: () => void;
  }[] = [];
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
  /** One release/refresh can fill free slots; scan mention before ordinary, skipping busy providers. */
  const drain = () => {
    for (const workClass of ["mention", "ordinary"] as const) {
      for (let index = 0; index < waiting.length; ) {
        const entry = waiting[index];
        if (entry.workClass !== workClass || !hasRoom(entry.key)) {
          index += 1;
          continue;
        }
        waiting.splice(index, 1);
        entry.enter();
      }
    }
  };
  const acquire = (
    model: string | undefined,
    signal?: AbortSignal,
    workClass: ModelWorkClass = "ordinary",
  ): Promise<() => void> => {
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
      const entry = { key, workClass, abort: () => {}, enter: () => {} };
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
  const acquireSendPermit = constrained
    ? (model: string, signal?: AbortSignal, workClass?: ModelWorkClass) =>
        admission.acquire(model, signal, workClass)
    : undefined;
  return {
    defaultModel: options.gateway?.config?.model,
    prepareContextModel: options.gateway?.prepareContextModel?.bind(options.gateway),
    admission,
    async complete(request) {
      const gateway = options.gateway;
      if (!gateway) throw new Error("Text model gateway is not configured");
      const permitHook =
        acquireSendPermit === undefined
          ? {}
          : {
              acquireSendPermit: (
                model: string,
                signal?: AbortSignal,
                workClass?: ModelWorkClass,
              ) => acquireSendPermit(model, signal, workClass ?? request.workClass),
            };
      if (request.prepareWithResolved !== undefined) {
        return gateway.complete({
          ...request,
          ...permitHook,
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
      }
      const messages = await gatewayMessagesAsync(request.messages, request);
      return gateway.complete({ ...request, ...permitHook, messages });
    },
    async *streamText(request) {
      if (!options.gateway?.streamChat)
        throw new Error("Streaming text model gateway is not configured");
      request.signal?.throwIfAborted();
      const permitHook =
        acquireSendPermit === undefined
          ? {}
          : {
              acquireSendPermit: (
                model: string,
                signal?: AbortSignal,
                workClass?: ModelWorkClass,
              ) => acquireSendPermit(model, signal, workClass ?? request.workClass),
            };
      if (request.prepareWithResolved !== undefined) {
        yield* options.gateway.streamChat({
          ...request,
          ...permitHook,
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
      yield* options.gateway.streamChat({ ...request, ...permitHook, messages });
    },
    async completeMultimodal(request) {
      const vision = options.vision;
      if (!vision) throw new Error("Vision model gateway is not configured");
      if (acquireSendPermit === undefined) return vision.annotate(request);
      return vision.annotate({
        ...request,
        acquireSendPermit: (model: string, signal?: AbortSignal) =>
          acquireSendPermit(model, signal, request.workClass ?? "ordinary"),
      });
    },
  };
}
