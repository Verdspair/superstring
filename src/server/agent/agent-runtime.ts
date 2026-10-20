import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AGENT_DECISION_JSON_SCHEMA,
  AgentDecisionSchema,
  type OutputDraft,
  parseAgentDecision,
} from "../../shared/contracts/agent-output";
import type {
  AgentStepSnapshot,
  ModelMessage,
  ModelResponseMetadata,
  OutputSummary,
  ProtectedModelOutput,
  RunEvent,
  RunEventPayload,
  RunOwner,
  RunStatus,
} from "../../shared/contracts/agent-run";
import { unicodeStrip } from "../../shared/contracts/code-point-string";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { ExecutionMode } from "../../shared/contracts/permissions";
import type { AgentRunRepository } from "../db/agent-run-repository";
import { AppError } from "../errors";
import type { ChatMessage } from "../llm/model-gateway";
import type { VisionClient, VisionImage } from "../llm/vision-client";
import {
  resolveAgentTraceScope,
  startAgentTrace,
  traceErrorCode,
  withinAgentTrace,
} from "../observability/agent-tracing";
import type {
  RuntimeTelemetry,
  TraceMetadata,
  TraceScope,
} from "../observability/runtime-telemetry";
import { ActionExecutor } from "./action-executor";
import type {
  ActionDescription,
  AgentGenerationConfig,
  AgentSpec,
  LeafAgentSpec,
} from "./agent-specs";
import type {
  ActionContext,
  BuiltInAction,
  ReadRetryOptions,
  RetryOrigin,
} from "./built-in-actions";
import { createCodeMode } from "./code-mode";
import type { CodeRunner, CodeRunnerLimits } from "./code-runner";
import {
  type ActionObservation,
  ContextEngine,
  type ContextReadTimings,
  type ContextTokenMeasure,
  type ContextTokenMeasureOptions,
  type ConversationContextSource,
  inputUnits,
  measureContextTokens,
  type RenderedContext,
  textMessage,
  uniqueSources,
  visionCostOf,
} from "./context-engine";
import type { ImageByteResolver } from "./image-byte-resolver";
import {
  createModelPort,
  type ModelContextBudget,
  type ModelPort,
  type ModelRequest,
  type ModelResolvedPrepareInput,
  type ModelResolvedPrepareOutput,
  type ModelWorkClass,
  type TextModelGateway,
  textMessages,
} from "./model-port";
import { createResearchAction, type ResearchLimits } from "./research-action";
import { ReservationLedger } from "./reservation-ledger";
import { createToolCatalog, type ToolCatalog } from "./tool-catalog";

export interface LeafInput {
  messages: ChatMessage[];
  owner: RunOwner;
  /** 可信宿主声明的任务类；缺省＝ordinary（ModelPort 原默认），不是新的持久状态。 */
  workClass?: ModelWorkClass;
  signal?: AbortSignal;
  sources?: readonly SourceRef[];
  /** Recheck leaf evidence before each additional physical model send when source-bound. */
  assertSources?: (sources: readonly SourceRef[]) => void;
  /** Trusted background/standalone owner provenance; nested calls inherit the ALS origin. */
  retryOrigin?: RetryOrigin;
  /** 与父 run 共用同一本账（可选）：叶子花的钱算进整棵树。 */
  usage?: RunUsage;
  budget?: RunBudget;
  /** Explicit leaf opt-in; no phase/model preparation or HTTP probe happens implicitly. */
  contextBudget?: ModelContextBudget;
  contextInputLimit?: number;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  /**
   * Existing domain parser executes inside the persisted step's success boundary.
   * 可信宿主消费可接收同 onModelResolved→resolveStepModel 真源的 resolved 模型名
   * （第二参，可选）：分类缓存等按实际模型维度的消费必须用它，不用 requested。
   */
  validate?: (text: string, meta?: { resolvedModel: string }) => unknown;
}
export interface VisionLeafInput extends Omit<LeafInput, "messages"> {
  model: string;
  prompt: string;
  images: readonly VisionImage[];
}
export interface MessageLeafInput extends Omit<LeafInput, "messages"> {
  messages: ModelMessage[];
  imageResolver?: ImageByteResolver;
  /** 本入口调用一次；宿主在这里按真实 runId/owner 重新登记 resolver 资产。 */
  bindRun?(context: ActionContext): void;
  /** T10 准备钩子（评分叶子等 message leaf）：actualModel 冻结后由网关调用一次。 */
  prepareWithResolved?: (input: ModelResolvedPrepareInput) => Promise<ModelResolvedPrepareOutput>;
  /** 每次实际发送前的宿主复验；抛错＝该次尝试不发出。 */
  assertPreparedCurrent?: (input: { readonly model: string }) => void;
}
export interface PreparedOutput extends OutputSummary {
  text?: string;
  /** Explicit QQ reply reference from this draft; the host validates scope/current availability. */
  replyToMessageId?: string;
  /** Explicit @ member IDs the host encodes; never CQ codes parsed out of the text. */
  mentionIds?: readonly string[];
  /** undefined/null asks the channel to select; [] explicitly declines; IDs select attachments. */
  stickerIds?: readonly string[] | null;
  /** Channel-resolved attachment provenance, retained with a pending plan and delivery. */
  sources?: readonly SourceRef[];
}
export interface PreparedGeneration extends AgentGenerationConfig {
  /** Explicit host-provided phase projection from the same authorized context source. */
  context?: RenderedContext;
  /**
   * Trusted host declaration (spec §10): a buffered generation that needs machine-readable
   * classifications in the SAME model call completes once with this response schema instead of
   * streaming; the runtime strips the envelope and submits the body through the ordinary
   * output path. Absent (default) keeps the existing streamText behavior byte for byte.
   * Media-classification consumption happens in the trusted host; the runtime only parses.
   */
  responseEnvelope?: {
    responseSchema: Record<string, unknown>;
    /** meta.resolvedModel = onModelResolved→resolveStepModel 同真源的实际模型（可信消费用）。 */
    parse: (raw: string, meta?: { resolvedModel: string }) => { text: string };
  };
  /**
   * 本目标自己的发送边界闭包：并行生成时各目标不得共用输入级的 prepareWithResolved /
   * onPhaseMediaUnsupported / onModelCallConsumed（它们会读写宿主的相投影与 fallback 状态）。
   * 宿主在 prepareGeneration 里按目标冻结并返回；缺省＝沿输入级闭包（单目标旧行为）。
   */
  hooks?: TargetHooks;
}
/** 一次生成发送所需的宿主闭包（按目标冻结，未给字段沿输入级）。 */
export interface TargetHooks {
  prepareWithResolved?: ConversationInput["prepareWithResolved"];
  onPhaseMediaUnsupported?: ConversationInput["onPhaseMediaUnsupported"];
  onModelCallConsumed?: ConversationInput["onModelCallConsumed"];
  assertPreparedCurrent?: ConversationInput["assertPreparedCurrent"];
  imageResolver?: ConversationInput["imageResolver"];
}
export interface ConversationInput {
  owner: RunOwner;
  /** Trusted standalone owner provenance; channel hosts set this at activation, children inherit it. */
  retryOrigin?: RetryOrigin;
  /** 可信宿主声明的任务类；随本 run 全部 complete/streamText 请求发出。 */
  workClass?: ModelWorkClass;
  context: ConversationContextSource;
  authorizedTargets: readonly string[];
  outputMode: "stream" | "buffered";
  signal?: AbortSignal;
  conversationId?: string;
  requestId?: string;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  /** Trusted host may supply a bounded next-step correction only for invalid agent decisions. */
  onDecisionInvalid?: (code: "AGENT_DECISION_INVALID", signal: AbortSignal) => Promise<boolean>;
  /** 整棵任务树共用的一本账与它的上限（0.4.0 P3）；省略＝只记这个 run 自己的账。 */
  usage?: RunUsage;
  budget?: RunBudget;
  /** Host-bound scope/budget handlers, never derived from model arguments. */
  actions?: readonly BuiltInAction[];
  /** Host admission for the runtime-created research result; never applied to external names. */
  prepareResearchAction?(action: BuiltInAction): BuiltInAction;
  /** Trusted host phase gate; terminal recovery never permits another ordinary tool call. */
  isTerminalDecision?: () => boolean;
  beforeActionBatch?: (
    calls: readonly {
      readonly action: BuiltInAction;
      readonly arguments: Record<string, unknown>;
    }[],
  ) => void;
  executionMode?: ExecutionMode;
  onContext?: (
    context: RenderedContext,
    input: { runId: string; phase: "next" | "generate" },
  ) => void | Promise<void>;
  /** Called before the first output delta, e.g. reserve the Web assistant message ID. */
  prepareOutput?: (
    draft: OutputDraft,
    ordinal: number,
    meta?: {
      readonly origin: "final" | "terminal-composition";
      readonly observations: readonly ActionObservation[];
    },
  ) => Promise<{ outputId: string } | { blocked: true; code: string }>;
  /**
   * 「被程序挡下」不等于「运行失败」（0.4.0 P4 §4.1）：许可不通过时这一轮该**静默结束**
   * （`no_output`），而不是整轮失败并触发唤醒重试。只有这里列出的码享有这个语义——
   * 别的 blocked（重复目标、未授权目标、贴图超额）照旧按失败处理，免得把模型犯错也吞掉。
   */
  silentBlockCodes?: readonly string[];
  /** Trusted host configuration and explicit phase view for this authorized output. */
  prepareGeneration?: (
    draft: Extract<OutputDraft, { kind: "generate" }>,
    input: { context: RenderedContext; outputId: string; signal: AbortSignal },
  ) => Promise<PreparedGeneration | undefined>;
  /**
   * 规格 §4.1 早提交：每个目标生成完成即提交该目标（不等批次内其它目标或整批 settled）。
   * 宿主在**原 host 事务**里写该目标的 outbox intent；runtime 不在此重复评分/重构上下文。
   * `meta` 带该目标本轮 ordinal 与提交时刻；返回 false＝宿主拒绝（未提交），true/void＝已提交。
   * 缺省＝无早提交，整批在 commitOutputs 一次结算。仅 prepared 输出会调用。
   */
  commitOutput?: (
    output: PreparedOutput,
    runId: string,
    meta: { ordinal: number; at: string },
  ) => Promise<boolean | void>;
  /**
   * T11 B：主 run 发送边界的图片解析器。可信宿主在本 run/owner 下登记已验证资产；
   * 生成步把它连同真实 runId/owner 传给端口（native 图 wire 只在发送边界解析字节）。
   * 缺省 undefined ＝ 无自动图（行为同 A）。
   */
  imageResolver?: ImageByteResolver;
  /**
   * 规格 §10：宿主按**当前投影**（每步 re-observe 后可能变化）决定本步决策是否走同次分类
   * envelope——本 run 存在待分类 unknown 图时启用；`parse` 由可信宿主提供（白名单校验＋同次
   * 分类消费），返回本体 decision 对象。返回 undefined＝该步走 AGENT_DECISION_JSON_SCHEMA
   * 原路径（text-only 行为逐字不变）。
   */
  decisionEnvelope?: () =>
    | {
        responseSchema: Record<string, unknown>;
        /** meta.resolvedModel = onModelResolved→resolveStepModel 同真源的实际模型（可信消费用）。 */
        parse: (
          raw: string,
          meta?: { resolvedModel: string },
        ) => ReturnType<typeof parseAgentDecision>;
      }
    | undefined;
  /**
   * T10 准备钩子（受信任宿主）：actualModel 冻结后、HTTP body 组装前由网关调用一次；
   * 宿主闭包按相（next=决策、generate=生成）准备最终 messages/resolver。返回 undefined＝
   * 沿用请求原样。metadata 由闭包自持（白名单落 span），不经网关回传。
   */
  prepareWithResolved?: (input: {
    phase: "next" | "generate";
    model: string;
    imagesAllowed: boolean;
    messages: readonly ModelMessage[];
    signal?: AbortSignal;
  }) => Promise<ModelResolvedPrepareOutput | undefined>;
  /**
   * 每次真正发送前的可信宿主复验：schema/tools 受控重试各算一次实际发送，
   * stream 发送前各调用一次。宿主闭包沿当前真源复验来源纪元/授权/provider 配置；
   * 抛错＝该次尝试不发出（零追加 HTTP）。网关不代任何判定。
   */
  assertPreparedCurrent?: (input: { readonly model: string }) => void;
  /**
   * §9 真实 HTTP unsupported 重试边界（受信任宿主）：一次相调用被精确
   * MODEL_IMAGE_UNSUPPORTED 拒绝（首逻辑调用，非任务 attempt）后由 runtime 调用一次；
   * 宿主标该相 fallback 并重备 description 材料，返回替换后的最终 messages；返回 null＝
   * 不重试（原样抛）。runtime 以返回消息重发同相 complete 恰一次（预算/来源复验仍走
   * assertPreparedCurrent 与宿主闭包）。
   */
  onPhaseMediaUnsupported?: (input: {
    readonly phase: "next" | "generate";
    readonly model: string;
    /** 被拒那次调用的当前请求消息（宿主据此剥离原生图并注入 notes）。 */
    readonly messages: readonly ModelMessage[];
    readonly signal?: AbortSignal;
  }) => Promise<{ readonly messages: readonly ModelMessage[] } | null>;
  /**
   * §8.1 current_run_consumed 记账边界（受信任宿主）：一次相模型调用**成功返回**后由 runtime
   * 调用（sentMediaIds=该次调用真实发送的图像 mediaId 集合）。MODEL_IMAGE_UNSUPPORTED 等失败
   * 发送不调用。宿主据此记录 native-read proof（gate 解除 legacy 旧失败误挡的唯一依据）。
   */
  onModelCallConsumed?: (input: { readonly phase: "next" | "generate" | "leaf" }) => void;
  /** Last observation checkpoint before a final/none decision becomes externally visible. */
  beforeFinal?: (drafts: readonly OutputDraft[], signal: AbortSignal) => Promise<boolean>;
  /** True re-observes; no_output suppresses a buffered plan that has no deliverable parts. */
  reconsider?: (
    outputs: readonly PreparedOutput[],
    signal: AbortSignal,
  ) => Promise<boolean | "no_output">;
  /** Host transaction for partial text/error state and the same run terminal. */
  commitFailure?: (
    error: unknown,
    runId: string,
    terminal: {
      status: "failed" | "cancelled";
      event: RunEventPayload;
      errorCode: string;
      at: string;
    },
  ) => Promise<RunEvent | undefined>;
  /** Persists completed messages/intentions. Network delivery belongs to the host. */
  commitOutputs?: (
    outputs: readonly PreparedOutput[],
    runId: string,
    terminal: {
      status: "completed" | "no_output";
      event: RunEventPayload;
      at: string;
    },
  ) => Promise<RunEvent | undefined>;
  /**
   * 终结回复动作（受信任宿主声明）：模型一次 invoke 该动作即**直接提交正文**，与 final 的
   * inline 草稿同形状、走同一输出/提交路径——runtime 不执行工具、不返回模型确认、不追加第二次
   * 调用。`parse` 由宿主提供（白名单/授权校验）；省略＝运行时无此终结路径（旧行为逐字不变）。
   */
  terminalAction?: {
    /** 参与同一次投递目录的终结贡献能力；名称唯一，由此列表广告。 */
    descriptions: readonly ActionDescription[];
    /** Host-declared carrier actions whose successful observations may remain in use after action deactivation. */
    retainedCarrierActions?: readonly string[];
    /** 把一批终结贡献聚合为既有草稿列表；非法即抛（该轮失败，不静默）。 */
    parse: (
      calls: readonly { readonly name: string; readonly arguments: Record<string, unknown> }[],
      authorizedTargets: readonly string[],
    ) => readonly OutputDraft[];
  };
}
export interface ConversationRunResult {
  runId: string;
  status: "completed" | "no_output";
  outputs: readonly PreparedOutput[];
}
/**
 * 一次任务树的用量与预算（0.4.0 P3"按任务树计预算"）。
 *
 * `usage` 是一本**可共享的账**：父 run 与它派生的叶子调用（判断、选图、媒体、压缩…）传同一个对象，
 * 所以"一次唤醒 ＋ 它的所有子调用"花掉多少是一笔总账；不给 `budget` 时只记账、不拦。
 */
export interface RunUsage {
  calls: number;
  inputUnits: number;
}
export interface RunBudget {
  maxCalls?: number;
  maxInputUnits?: number;
}

/**
 * 并行生成段里一个已准备就绪的目标：准备（上下文/媒体/水位）已在串行段完成并冻结，这里只
 * 携带该目标自己的请求材料，让模型网络段并行执行而不回读其它目标的共享投影。
 */
interface TargetPlan {
  draft: Extract<OutputDraft, { kind: "generate" }>;
  ordinal: number;
  outputId: string;
  generationContext: RenderedContext;
  messages: ModelMessage[];
  generationSpec: LeafAgentSpec;
  generationBudget?: ModelContextBudget;
  structured?: PreparedGeneration["responseEnvelope"];
  allowEmpty?: boolean;
  /** 宿主按目标冻结的发送闭包；缺省字段沿输入级闭包。 */
  hooks?: TargetHooks;
  /** 本目标自己的 resolved 回写目标：并行时不得共用 active.resolvedModel。 */
  resolvedSink: { resolvedModel?: string };
}

interface Running {
  runId: string;
  usage: RunUsage;
  budget?: RunBudget;
  /** 本 run 的任务类；嵌套子 run 经 taskTree 继承 owning task 的类。 */
  workClass?: ModelWorkClass;
  retryOrigin?: RetryOrigin;
  retryPolicy?: ReadRetryOptions;
  spec: LeafAgentSpec;
  signal: AbortSignal;
  callerSignal?: AbortSignal;
  deadlineAt?: number;
  stepNo: number;
  trace?: TraceScope;
  channel: TraceMetadata["channel"];
  conversationId?: string;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  dispose(): void;
  assertActions?: () => void;
  /** 当前步 onModelResolved 回写后的真实模型（resolveStepModel 同真源；步内消费用）。 */
  resolvedModel?: string;
}

/** 调用的稳定签名：键排序后再序列化，用来识别"同一调用被原样重复"。 */
function callSignature(name: string, args: Record<string, unknown>): string {
  const sort = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sort);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, sort(entry)]),
      );
    return value;
  };
  return `${name}\u0000${JSON.stringify(sort(args))}`;
}

export class AgentRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentRuntimeError";
  }
}

/** One inference owner for leaf tasks and iterative conversations. No channel sends here. */
export class AgentRuntime {
  private readonly taskTree = new AsyncLocalStorage<{
    usage: RunUsage;
    budget?: RunBudget;
    workClass?: ModelWorkClass;
    retryOrigin?: RetryOrigin;
    retryPolicy?: ReadRetryOptions;
    signal: AbortSignal;
  }>();
  private readonly contextEngine: ContextEngine;
  private readonly executor: ActionExecutor;
  private readonly actions: ToolCatalog;
  constructor(
    private readonly options: {
      model: ModelPort;
      repository: AgentRunRepository;
      systemRetryPolicy?: () => { maxAttempts: number; retryDelayMs: number };
      actions?: readonly BuiltInAction[];
      actionExecutor?: ActionExecutor;
      contextEngine?: ContextEngine;
      now?: () => string;
      telemetry?: RuntimeTelemetry;
      researchEnabled?: () => boolean;
      /** 研究子任务的有效限额；函数形式＝每个父轮重新读取（P7-c 执行配置）。 */
      researchLimits?: () => ResearchLimits;
      /** 无进展终止阈值：第 N 次同签名调用结束这一轮（默认 3）。 */
      noProgressLimit?: () => number;
      /** 叶子运行的中央边界（ADR0019 §13.3 D/H）：模型调用前与调用返回后（落盘为完成之前）各查一次，不依赖 db。 */
      assertLeaf?: (owner: RunOwner, specId: string) => void | (() => void);
      codeMode?: {
        runner: CodeRunner;
        enabled(): boolean;
        allowsModel(model: string | undefined): boolean;
        /** 沙箱限额；函数形式＝每次编排重新读取。 */
        limits?: () => Partial<CodeRunnerLimits>;
      };
    },
  ) {
    this.contextEngine = options.contextEngine ?? new ContextEngine();
    this.executor = options.actionExecutor ?? new ActionExecutor();
    this.actions = createToolCatalog(options.actions ?? []);
  }

  get repository(): AgentRunRepository {
    return this.options.repository;
  }
  get telemetry(): RuntimeTelemetry | undefined {
    return this.options.telemetry;
  }
  /**
   * 名额观察面（只读）：调度侧据此判断"现在有没有空位"并在名额释放时复查，
   * 真正占名额仍然只有 ModelPort 内部的 acquire，名额状态没有第二份。
   */
  get admission(): ModelPort["admission"] {
    return this.options.model.admission;
  }
  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  async completeLeaf(spec: LeafAgentSpec, input: LeafInput): Promise<string> {
    const active = this.start(spec, input);
    return this.withRun(active, () => this.completeLeafRun(active, spec, input));
  }

  private completeLeafRun(active: Running, spec: LeafAgentSpec, input: LeafInput): Promise<string> {
    return this.completeLeafTask(active, "leaf", input, () => {
      const messages = [
        ...(spec.instructions === undefined ? [] : [textMessage("system", spec.instructions)]),
        ...textMessages(input.messages),
      ];
      return {
        messages,
        invoke: async (capture, onModelResolved, onModelResponse, retryOptions) => {
          const raw = await this.options.model.complete({
            messages,
            model: spec.model,
            temperature: spec.temperature,
            maxTokens: spec.maxTokens,
            responseSchema: spec.responseSchema,
            ...(input.contextBudget === undefined ? {} : { contextBudget: input.contextBudget }),
            ...(input.contextInputLimit === undefined
              ? {}
              : { contextInputLimit: input.contextInputLimit }),
            ...(active.workClass === undefined ? {} : { workClass: active.workClass }),
            ...retryOptions(),
            signal: active.signal,
            onModelResolved,
            onResponseText: capture,
            onModelResponse,
          });
          capture(raw, true);
          await input.validate?.(raw, { resolvedModel: active.resolvedModel ?? "" });
          return raw;
        },
        ...(input.assertSources === undefined
          ? {}
          : { assertSources: () => input.assertSources?.(input.sources ?? []) }),
      };
    });
  }

  // 复用 completeLeafTask 的持久 step/预算/断言边界；resolver 登记只在模型调用前经 bindRun 建立。
  async completeMessageLeaf(spec: LeafAgentSpec, input: MessageLeafInput): Promise<string> {
    const active = this.start(spec, input);
    return this.withRun(active, async () => {
      try {
        const messages: ModelMessage[] = [
          ...(spec.instructions === undefined ? [] : [textMessage("system", spec.instructions)]),
          ...input.messages,
        ];
        return await this.completeLeafTask(active, "leaf", input, () => {
          input.bindRun?.({
            owner: input.owner,
            signal: active.signal,
            runId: active.runId,
          });
          return {
            messages,
            invoke: async (capture, onModelResolved, onModelResponse, retryOptions) => {
              const raw = await this.options.model.complete({
                messages,
                model: spec.model,
                temperature: spec.temperature,
                maxTokens: spec.maxTokens,
                responseSchema: spec.responseSchema,
                ...(input.contextBudget === undefined
                  ? {}
                  : { contextBudget: input.contextBudget }),
                ...(input.contextInputLimit === undefined
                  ? {}
                  : { contextInputLimit: input.contextInputLimit }),
                ...(active.workClass === undefined ? {} : { workClass: active.workClass }),
                runId: active.runId,
                owner: input.owner,
                ...(input.imageResolver === undefined
                  ? {}
                  : { imageResolver: input.imageResolver }),
                // T10 钩子与每次发送前的宿主复验（评分叶子等 message leaf 同权接入）。
                ...(input.prepareWithResolved === undefined
                  ? {}
                  : { prepareWithResolved: input.prepareWithResolved }),
                ...(input.assertPreparedCurrent === undefined
                  ? {}
                  : { assertPreparedCurrent: input.assertPreparedCurrent }),
                ...retryOptions(),
                signal: active.signal,
                onModelResolved,
                onResponseText: capture,
                onModelResponse,
              });
              capture(raw, true);
              await input.validate?.(raw, { resolvedModel: active.resolvedModel ?? "" });
              return raw;
            },
            ...(input.assertSources === undefined
              ? {}
              : { assertSources: () => input.assertSources?.(input.sources ?? []) }),
          };
        });
      } finally {
        // 运行结束按本 leaf run/owner 释放登记；父 run 与同 run 其它 owner 不受影响（规格 §12）。
        input.imageResolver?.release(active.runId, input.owner);
      }
    });
  }

  async completeVisionLeaf(spec: LeafAgentSpec, input: VisionLeafInput): Promise<string> {
    const active = this.start({ ...spec, model: input.model }, input);
    return this.withRun(active, () => this.completeVisionRun(active, spec, input));
  }

  private completeVisionRun(
    active: Running,
    spec: LeafAgentSpec,
    input: VisionLeafInput,
  ): Promise<string> {
    return this.completeLeafTask(active, "vision", input, () => {
      const source = input.sources?.[0];
      const messages: ModelMessage[] = [
        ...(spec.instructions === undefined ? [] : [textMessage("system", spec.instructions)]),
        {
          role: "user",
          content: [
            { kind: "text", text: input.prompt },
            ...input.images.map((image, index) => ({
              kind: "image" as const,
              sourceId: source?.id ?? `${active.runId}:image:${index}`,
              revision: source?.revision ?? "1",
              mimeType: image.mimeType,
              sha256: createHash("sha256").update(image.bytes).digest("hex"),
            })),
          ],
        },
      ];
      return {
        messages,
        invoke: async (capture, _onModelResolved, onModelResponse, retryOptions) => {
          const raw = await this.options.model.completeMultimodal({
            systemPrompt: spec.instructions,
            temperature: spec.temperature,
            maxTokens: spec.maxTokens,
            model: input.model,
            prompt: input.prompt,
            images: input.images,
            responseSchema: spec.responseSchema,
            ...(active.workClass === undefined ? {} : { workClass: active.workClass }),
            ...retryOptions(),
            signal: active.signal,
            onModelResponse,
          });
          capture(raw, true);
          await input.validate?.(raw);
          return raw;
        },
        ...(input.assertSources === undefined
          ? {}
          : { assertSources: () => input.assertSources?.(input.sources ?? []) }),
      };
    });
  }

  private async completeLeafTask(
    active: Running,
    phase: "leaf" | "vision",
    input: {
      owner: RunOwner;
      sources?: readonly SourceRef[];
      contextBudget?: ModelContextBudget;
      contextInputLimit?: number;
    },
    prepare: () => {
      messages: ModelMessage[];
      invoke: (
        capture: (text: string, complete?: boolean) => void,
        onModelResolved: (model: string) => void,
        onModelResponse: (metadata: ModelResponseMetadata) => void,
        retryOptions: () => { retryPolicy?: ReadRetryOptions; onRetry?: () => void },
      ) => Promise<string>;
      assertSources?: () => void;
    },
  ): Promise<string> {
    try {
      await this.emit(active, { type: "started" });
      this.repository.setStatus(active.runId, "generating", this.now());
      // 模型调用前查一次并冻结当前纪元；返回后再查当前状态与冻结纪元，且必须夹在这一步落盘为
      // 完成之前——飞行期间停用（哪怕随后恢复）已产出的叶子结果不得发布，该步按失败落盘，运行失败。
      const checkpoint = this.options.assertLeaf?.(input.owner, active.spec.id);
      const { messages, invoke, assertSources } = prepare();
      const guarded = async (
        capture: (text: string, complete?: boolean) => void,
        onModelResolved: (model: string) => void,
        onModelResponse: (metadata: ModelResponseMetadata) => void,
        retryOptions: () => { retryPolicy?: ReadRetryOptions; onRetry?: () => void },
      ) => {
        const value = await invoke(capture, onModelResolved, onModelResponse, () => {
          const options = retryOptions();
          if (!options.onRetry) return options;
          return {
            ...options,
            onRetry: () => {
              assertSources?.();
              this.options.assertLeaf?.(input.owner, active.spec.id);
              if (typeof checkpoint === "function") checkpoint();
              options.onRetry?.();
            },
          };
        });
        this.options.assertLeaf?.(input.owner, active.spec.id);
        if (typeof checkpoint === "function") checkpoint();
        return value;
      };
      const value = await this.step(
        active,
        phase,
        messages,
        input.sources ?? [],
        guarded,
        active.spec,
        undefined,
        undefined,
        undefined,
        {
          budget: input.contextBudget,
          inputLimit: input.contextInputLimit,
          options:
            active.spec.responseSchema === undefined
              ? undefined
              : { responseSchema: active.spec.responseSchema },
          stepInputLimit: input.contextInputLimit,
        },
      );
      await this.finish(active, "completed", { type: "completed", outputs: [] });
      return value;
    } catch (error) {
      await this.fail(active, error);
      throw error;
    } finally {
      active.dispose();
    }
  }

  async run(spec: AgentSpec, input: ConversationInput): Promise<ConversationRunResult> {
    const active = this.start(spec, input);
    return this.withRun(active, () => this.runConversation(active, spec, input));
  }

  /**
   * 无模型步骤的父 run 入口（如主动批次的评分叶子＋各目标回复子任务）。start+withRun 提供真实
   * agent_runs 行、agent.run span 与 taskTree{usage,budget,signal}；children 经 run/completeMessageLeaf
   * 由 AsyncLocalStorage 继承同一 usage/budget、父 callerSignal 与父 trace。
   * work 在父 run 内执行并覆盖评分叶子与全部目标子 run；work 正常返回但 abort 已生效时不写 completed。
   * work 抛错→failed 后原样抛出；caller abort→cancelled；onRunId 与终态同在本 run 生命周期内释放。
   * 宿主若用 allSettled，需自行把未达标/失败映射为抛错，否则父被标 completed。
   */
  async runTaskGroup<T>(
    spec: { id: string; version?: string },
    input: {
      owner: RunOwner;
      /** Explicit origin for standalone tasks; a parent task tree always wins. */
      retryOrigin?: RetryOrigin;
      /** 本任务树的类：嵌套子 run 经 taskTree 继承 owning task 的类，不必逐个传。 */
      workClass?: ModelWorkClass;
      conversationId?: string;
      signal?: AbortSignal;
      sources?: readonly SourceRef[];
      usage?: RunUsage;
      budget?: RunBudget;
      /** run 建立后立即回调（宿主据此 linkRun）；在本 run 生命周期内，抛错按运行失败结算。 */
      onRunId?: (runId: string) => void;
    },
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const active = this.start(spec, input);
    return this.withRun(active, async () => {
      try {
        input.onRunId?.(active.runId);
        await this.emit(active, { type: "started" });
        this.repository.setStatus(active.runId, "generating", this.now());
        const value = await work(active.signal);
        // work 可能忽略 abort 仍正常返回：终态写前按本 run 边界复核，abort 生效即按 cancelled 结算。
        active.signal.throwIfAborted();
        await this.finish(active, "completed", { type: "completed", outputs: [] });
        return value;
      } catch (error) {
        await this.fail(active, error);
        throw error;
      } finally {
        active.dispose();
      }
    });
  }

  private async runConversation(
    active: Running,
    spec: AgentSpec,
    input: ConversationInput,
  ): Promise<ConversationRunResult> {
    const originalActions = spec.availableActions;
    let releaseActions: readonly BuiltInAction[] = [];
    try {
      const observations: ActionObservation[] = [];
      const preparePhaseBudget = (
        model: string | undefined,
      ): Promise<ModelContextBudget | undefined> => {
        const resolved = model ?? this.options.model.defaultModel;
        return resolved && input.context.prepareModelContext
          ? input.context.prepareModelContext(resolved, active.signal)
          : Promise.resolve(undefined);
      };
      const mode = input.executionMode ?? "direct";
      const catalog = input.actions ? createToolCatalog(input.actions) : this.actions;
      const declaredNames = new Set<string>();
      const baseActions = originalActions.flatMap((descriptor) => {
        if (declaredNames.has(descriptor.name))
          throw new AgentRuntimeError(
            "TOOL_CATALOG_DUPLICATE",
            `TOOL_CATALOG_DUPLICATE: ${descriptor.name}`,
          );
        declaredNames.add(descriptor.name);
        const action = catalog.resolve(descriptor.name);
        return action && action.description.capability === descriptor.capability ? [action] : [];
      });
      releaseActions = baseActions;
      const extensions: BuiltInAction[] = [];
      if (mode === "direct" && this.options.researchEnabled?.()) {
        const research = createResearchAction({
          runtime: this,
          executor: this.executor,
          spec,
          input,
          actions: baseActions,
          allocation: input.context.researchAllocation?.(),
          limits: this.options.researchLimits?.(),
        });
        extensions.push(input.prepareResearchAction?.(research) ?? research);
      }
      const code = this.options.codeMode;
      if (
        mode === "direct" &&
        code?.enabled() &&
        code.runner.available &&
        code.allowsModel(spec.model)
      ) {
        const program = createCodeMode({
          actions: baseActions.filter((action) =>
            this.executor.allowed(action, { owner: input.owner, signal: active.signal }, "sandbox"),
          ),
          runner: code.runner,
          executor: this.executor,
          telemetry: this.telemetry,
          limits: code.limits?.(),
          assertSources: (sources) => input.context.assertSources?.(sources),
          assertCurrent: () => {
            if (!code.runner.available || !code.allowsModel(spec.model))
              throw new AgentRuntimeError(
                "CODE_EXECUTION_UNAVAILABLE",
                "Code execution was disabled",
              );
            input.context.assertCurrent?.();
          },
        }).action;
        if (program)
          extensions.push({
            ...program,
            assertAvailable: () => {
              program.assertAvailable?.();
              if (!code.runner.available || !code.allowsModel(spec.model))
                throw new AgentRuntimeError(
                  "CODE_EXECUTION_UNAVAILABLE",
                  "Code execution was disabled",
                );
              // 本群停用「代码」后构造时即使可用，也不能再启动 runner（执行边界，即时生效）。
              if (
                !this.executor.allowed(program, { owner: input.owner, signal: active.signal }, mode)
              )
                throw new AgentRuntimeError(
                  "CODE_EXECUTION_UNAVAILABLE",
                  "Code execution was disabled",
                );
            },
          });
      }
      const actions = extensions.length
        ? createToolCatalog([
            ...catalog.advertised().flatMap((descriptor) => {
              const action = catalog.resolve(descriptor.name);
              return action ? [action] : [];
            }),
            ...extensions,
          ])
        : catalog;
      const descriptors = actions.advertised(
        [...baseActions, ...extensions].map((action) => action.description.name),
      );
      // 实际用了哪一种编排写进运行追踪（B06）：direct 与 code/research 扩展可对比。
      active.trace?.update({
        details: {
          orchestration: extensions.length ? "extended" : "direct",
          executionMode: mode,
          actionCount: descriptors.length,
        },
      });
      /** 调用签名 → 已出现次数（无进展检测）：跨步累计，整轮有效。 */
      const callSignatures = new Map<string, number>();
      /** 本 run 已早提交目标的原始输出（按 targetId）：跨轮不重生成、不再提交，终态结算仍带其事实。 */
      const committedTargets = new Map<string, PreparedOutput>();
      const actionContext: ActionContext = {
        owner: input.owner,
        signal: active.signal,
        runId: active.runId,
        requestId: input.requestId,
        ...(active.retryOrigin === undefined ? {} : { retryOrigin: active.retryOrigin }),
        ...(active.retryOrigin === "system" && active.retryPolicy
          ? { retryPolicy: active.retryPolicy }
          : {}),
      };
      const usedActions = new Set<BuiltInAction>();
      const usedActionObservations = new Map<BuiltInAction, ActionObservation>();
      active.assertActions = () => {
        for (const action of usedActions) {
          const retainedCarrierObservation = input.terminalAction?.retainedCarrierActions?.includes(
            action.description.name,
          )
            ? usedActionObservations.get(action)
            : undefined;
          this.executor.assert(
            action,
            actionContext,
            mode,
            undefined,
            retainedCarrierObservation ? { retainedCarrierObservation } : undefined,
          );
        }
      };
      input.context.bindRun?.(actionContext);
      for (const action of baseActions) action.bindRun?.(actionContext);
      await this.emit(active, {
        type: "started",
        ...(input.requestId ? { requestId: input.requestId } : {}),
      });
      for (;;) {
        active.assertActions();
        this.checkStepBudget(active, spec);
        this.repository.setStatus(active.runId, "deciding", this.now());
        const terminalDecision = input.isTerminalDecision?.() ?? false;
        const availableActions = terminalDecision
          ? []
          : descriptors.filter((descriptor) => {
              const action = actions.resolve(descriptor.name);
              return action && this.executor.allowed(action, actionContext, mode);
            });
        // 终结回复能力与普通工具进入同一次投递目录：系统声明、原生 tools、configureActions
        // 都看到它——模型只对**本轮已广告**的终结名调用才被接受（下方 terminalDecision 校验），
        // 但它的执行不经 ActionExecutor（它没有可执行体）：转成 final 草稿走输出校验/提交边界。
        const advertisedActions = input.terminalAction
          ? [...availableActions, ...input.terminalAction.descriptions]
          : availableActions;
        input.context.configureActions?.(advertisedActions);
        // 规格 §10：本步决策的实际响应 schema 选择——投影（read）完成后现取并冻结一次，
        // 系统声明（render）与实际请求（requestFor）、响应解析共用同一个选择。
        let decisionEnvelope: ReturnType<NonNullable<ConversationInput["decisionEnvelope"]>>;
        const decisionBudget = await preparePhaseBudget(spec.model);
        active.signal.throwIfAborted();
        let currentMaterial: Awaited<ReturnType<ConversationContextSource["read"]>>;
        const context = await this.trace(
          active,
          "agent.context",
          {
            stage: "context",
            details: { phase: "next", observationCount: observations.length },
          },
          async (scope) => {
            const timings: ContextReadTimings & {
              onContextPresent: boolean;
              contextReadMs?: number;
              contextRenderMs?: number;
              onContextMs?: number;
            } = { onContextPresent: Boolean(input.onContext) };
            try {
              let material: Awaited<ReturnType<ConversationContextSource["read"]>>;
              const readStarted = performance.now();
              try {
                material = await input.context.read({
                  signal: active.signal,
                  observations,
                  onReadTimings: (readTimings) => Object.assign(timings, readTimings),
                });
                currentMaterial = material;
              } finally {
                timings.contextReadMs = performance.now() - readStarted;
              }
              active.signal.throwIfAborted();
              decisionEnvelope = input.decisionEnvelope?.();
              let rendered: RenderedContext;
              const renderStarted = performance.now();
              try {
                rendered = this.contextEngine.render(
                  { ...spec, availableActions: advertisedActions },
                  material,
                  observations,
                  input.authorizedTargets,
                  input.outputMode,
                  decisionEnvelope?.responseSchema,
                );
                rendered = this.measureRenderedContext(rendered, decisionBudget, {
                  responseSchema: decisionEnvelope?.responseSchema ?? AGENT_DECISION_JSON_SCHEMA,
                  tools: advertisedActions.map(({ name, description, parameters }) => ({
                    name,
                    description,
                    parameters,
                  })),
                });
              } finally {
                timings.contextRenderMs = performance.now() - renderStarted;
              }
              scope?.update({
                sources: rendered.sources,
                details: {
                  inputUnits: rendered.units,
                  messageCount: rendered.messages.length,
                  sourceCount: rendered.sources.length,
                  evidenceCount: material.evidence?.length ?? 0,
                  summaryCount: material.summaries?.length ?? 0,
                  historyCount: material.history?.length ?? 0,
                },
              });
              if (input.onContext) {
                const callbackStarted = performance.now();
                try {
                  await input.onContext(rendered, { runId: active.runId, phase: "next" });
                } finally {
                  timings.onContextMs = performance.now() - callbackStarted;
                }
              } else {
                timings.onContextMs = 0;
              }
              return rendered;
            } finally {
              scope?.update({ details: timings });
            }
          },
        );
        let decision: ReturnType<typeof parseAgentDecision>;
        try {
          decision = await this.step(
            active,
            "next",
            context.messages,
            context.sources,
            async (capture, onModelResolved, onModelResponse, retryOptions) => {
              let resolved =
                decisionBudget?.model ?? spec.model ?? this.options.model.defaultModel ?? "?";
              // T10/§9 决策相发送（真实 HTTP 服务首拒 unsupported → 宿主标 fallback 重备后
              // 同相同 complete 重试恰一次；非 unsupported 原样抛）。requestFor(messages) 每次以
              // 当前 messages 组请求；prepare/schema/tools 重试共用同一次钩子结果与 used。
              const requestFor = (phaseMessages: readonly ModelMessage[]): ModelRequest => ({
                messages: phaseMessages,
                model: spec.model,
                temperature: spec.temperature,
                maxTokens: spec.maxTokens ?? spec.limits.outputTokens,
                responseSchema: decisionEnvelope?.responseSchema ?? AGENT_DECISION_JSON_SCHEMA,
                ...(active.workClass === undefined ? {} : { workClass: active.workClass }),
                runId: active.runId,
                owner: input.owner,
                ...(input.imageResolver === undefined
                  ? {}
                  : { imageResolver: input.imageResolver }),
                // 已广告的动作同时以原生 tools 声明（issue #10）：模型用它表达 invoke，正文只剩
                // final/none。是否真的发送由网关决定——外部路由发，本地服务保持冻结的 JSON 决策。
                tools: advertisedActions.map((action) => ({
                  name: action.name,
                  description: action.description,
                  parameters: action.parameters,
                })),
                ...(decisionBudget === undefined ? {} : { contextBudget: decisionBudget }),
                ...(!decisionBudget?.countText ||
                !decisionBudget.tokenizerEncoding ||
                spec.limits.inputUnits === undefined
                  ? {}
                  : { contextInputLimit: spec.limits.inputUnits }),
                // T10 准备钩子透传（决策相）：actualModel 冻结后由网关调用；宿主闭包决定最终
                // messages/resolver，undefined＝原样。metadata 由闭包自持，不经网关回传。
                ...(input.prepareWithResolved === undefined
                  ? {}
                  : {
                      prepareWithResolved: async (hook) =>
                        (await input.prepareWithResolved?.({
                          ...hook,
                          phase: "next",
                        })) ?? {},
                    }),
                ...(input.assertPreparedCurrent === undefined
                  ? {}
                  : { assertPreparedCurrent: input.assertPreparedCurrent }),
                ...retryOptions(),
                signal: active.signal,
                onModelResolved: (model) => {
                  resolved = model;
                  onModelResolved(model);
                },
                onResponseText: capture,
                onModelResponse,
              });
              let raw: string;
              try {
                raw = await this.options.model.complete(requestFor(context.messages));
              } catch (error) {
                if (
                  !(
                    error instanceof Error &&
                    (error as { code?: unknown }).code === "MODEL_IMAGE_UNSUPPORTED"
                  ) ||
                  input.onPhaseMediaUnsupported === undefined
                )
                  throw error;
                const retry = await input.onPhaseMediaUnsupported({
                  phase: "next",
                  model: resolved,
                  messages: context.messages,
                  signal: active.signal,
                });
                if (retry === null) throw error;
                raw = await this.options.model.complete(requestFor(retry.messages));
              }
              capture(raw, true);
              // §8.1：决策相调用成功返回＝本 run 真实消费了请求中的图像 → 通知宿主记账。
              input.onModelCallConsumed?.({ phase: "next" });
              try {
                if (decisionEnvelope)
                  return decisionEnvelope.parse(raw, { resolvedModel: active.resolvedModel ?? "" });
                return parseAgentDecision(raw);
              } catch {
                // 「读不出决策」必须能一眼看出模型回了什么。原文也会随步骤落库
                // （受保护输出，运行检查器可看），这里只是让它出现在控制台/日志里。
                console.warn(
                  `[agent] 决策解析失败 model=${resolved} phase=next：${summariseModelText(raw)}`,
                );
                throw new AgentRuntimeError(
                  "AGENT_DECISION_INVALID",
                  "Decision must be a complete JSON object matching the Agent schema",
                );
              }
            },
            spec,
            undefined,
            undefined,
            undefined,
            {
              budget: decisionBudget,
              inputLimit: decisionBudget?.countText ? spec.limits.inputUnits : undefined,
              options: {
                responseSchema: decisionEnvelope?.responseSchema ?? AGENT_DECISION_JSON_SCHEMA,
                tools: advertisedActions.map(({ name, description, parameters }) => ({
                  name,
                  description,
                  parameters,
                })),
              },
              measure: context.tokenMeasure,
              stepInputLimit: spec.limits.inputUnits,
            },
            () => input.context.assertSources?.(context.sources),
          );
        } catch (error) {
          if (
            error instanceof Error &&
            (error as { code?: unknown }).code === "AGENT_DECISION_INVALID" &&
            input.onDecisionInvalid &&
            !terminalDecision
          ) {
            active.signal.throwIfAborted();
            const accepted = await input.onDecisionInvalid("AGENT_DECISION_INVALID", active.signal);
            active.signal.throwIfAborted();
            if (accepted) continue;
          }
          throw error;
        }
        if (decision.kind === "none") {
          if (
            await this.trace(
              active,
              "agent.checkpoint",
              { stage: "context", details: { phase: "before_final", decision: "none" } },
              async (scope) => {
                const result = await input.beforeFinal?.([], active.signal);
                scope?.update({ details: { reobserved: result ?? false } });
                return result;
              },
            )
          ) {
            if (terminalDecision)
              throw new AgentRuntimeError(
                "CONTEXT_SOURCE_INVALID",
                "Terminal budget recovery cannot reobserve",
              );
            continue;
          }
          active.signal.throwIfAborted();
          if (committedTargets.size > 0) {
            // 若上一轮已有目标早提交，本轮 none 不改写既有结果：按完成结算已提交事实。
            const settled = [...committedTargets.values()];
            await this.commitAndFinish(active, input, settled, "completed", {
              type: "completed",
              outputs: settled.map(({ outputId, targetId, status, code }) => ({
                outputId,
                targetId,
                status,
                ...(code ? { code } : {}),
              })),
            });
            return { runId: active.runId, status: "completed", outputs: settled };
          }
          await this.commitAndFinish(active, input, [], "no_output", { type: "no_output" });
          return { runId: active.runId, status: "no_output", outputs: [] };
        }
        let outputOrigin: "final" | "terminal-composition" = "final";
        if (decision.kind === "invoke" && input.terminalAction) {
          const terminalNames = new Set(input.terminalAction.descriptions.map(({ name }) => name));
          if (decision.calls.some(({ name }) => terminalNames.has(name))) {
            if (decision.calls.some(({ name }) => !terminalNames.has(name)))
              throw new AgentRuntimeError(
                "AGENT_OUTPUT_INVALID",
                "A terminal reply contribution cannot be mixed with other actions",
              );
            const names = decision.calls.map(({ name }) => name);
            if (new Set(names).size !== names.length)
              throw new AgentRuntimeError(
                "AGENT_OUTPUT_INVALID",
                "A terminal reply contribution may occur only once per action",
              );
            let drafts: readonly OutputDraft[];
            try {
              drafts = input.terminalAction.parse(decision.calls, input.authorizedTargets);
            } catch {
              throw new AgentRuntimeError(
                "AGENT_OUTPUT_INVALID",
                "Terminal reply contribution parameters are invalid",
              );
            }
            if (drafts.length === 0)
              throw new AgentRuntimeError(
                "AGENT_OUTPUT_INVALID",
                "A terminal reply action carried no output",
              );
            decision = { kind: "final", outputs: [...drafts] };
            outputOrigin = "terminal-composition";
          }
        }
        if (decision.kind === "invoke") {
          if (terminalDecision)
            throw new AgentRuntimeError(
              "AGENT_ACTION_UNAVAILABLE",
              "Terminal budget recovery cannot invoke tools",
            );
          // 一批调用（0.4.0 P2）：先整体校验再执行——任何一条不可用就整批拒绝，
          // 不留"执行了一半"的状态。只读的并行，有副作用的串行且保持模型给的顺序。
          const planned = decision.calls.map((call) => {
            const descriptor = availableActions.find((action) => action.name === call.name);
            const action = actions.resolve(call.name);
            if (!descriptor || !action || descriptor.capability !== action.description.capability)
              throw new AgentRuntimeError(
                "AGENT_ACTION_UNAVAILABLE",
                "Action is not available to this Agent",
              );
            const seen = (callSignatures.get(callSignature(call.name, call.arguments)) ?? 0) + 1;
            callSignatures.set(callSignature(call.name, call.arguments), seen);
            // 无进展：同一步里原样重复的倒数第二次仍执行（模型可能确实需要），但把"换个做法"写进观测；
            // 达到阈值就结束这一轮——它已经不是在用结果，而是在原地打转。
            const noProgressLimit = Math.max(3, this.options.noProgressLimit?.() ?? 3);
            if (seen >= noProgressLimit)
              throw new AgentRuntimeError(
                "AGENT_NO_PROGRESS",
                "The same tool call keeps repeating without progress",
              );
            return {
              call,
              action,
              effect: action.description.effect ?? "write",
              repeat: seen === noProgressLimit - 1,
            };
          });
          input.beforeActionBatch?.(
            planned.map((entry) => ({
              action: entry.action,
              arguments: entry.call.arguments,
            })),
          );
          this.repository.setStatus(active.runId, "observing", this.now());
          const settled = await this.trace<
            Map<(typeof planned)[number], Omit<ActionObservation, "id" | "name">>
          >(
            active,
            "agent.action",
            {
              stage: "action",
              sources: context.sources,
              details: { actions: planned.map((entry) => entry.call.name).join(",") },
            },
            async (scope) => {
              const reservations = new ReservationLedger();
              const fitReadResult: ActionContext["fitReadResult"] =
                mode === "subtask"
                  ? (name, arguments_, value, sources) => {
                      const token = Symbol("subtask-result");
                      const tokenMode = Boolean(
                        decisionBudget?.countText && decisionBudget.tokenizerEncoding,
                      );
                      const group = tokenMode ? "tokens" : "bytes";
                      const limit = spec.limits.inputUnits;
                      const baseline = tokenMode ? context.tokenMeasure?.textTokens : context.units;
                      const fit = (candidate: unknown) => {
                        active.signal.throwIfAborted();
                        input.context.assertCurrent?.();
                        input.context.assertSources?.(sources);
                        decisionBudget?.assertCurrent();
                        const observation: ActionObservation = {
                          id: "00000000-0000-0000-0000-000000000000",
                          name,
                          arguments: arguments_,
                          value: candidate,
                          sources,
                        };
                        const rendered = this.contextEngine.render(
                          { ...spec, availableActions: advertisedActions },
                          currentMaterial,
                          [...observations, observation],
                          input.authorizedTargets,
                          input.outputMode,
                          decisionEnvelope?.responseSchema,
                        );
                        const measured = this.measureRenderedContext(rendered, decisionBudget, {
                          responseSchema:
                            decisionEnvelope?.responseSchema ?? AGENT_DECISION_JSON_SCHEMA,
                          tools: advertisedActions.map(({ name, description, parameters }) => ({
                            name,
                            description,
                            parameters,
                          })),
                        });
                        const units = tokenMode
                          ? measured.tokenMeasure?.textTokens
                          : measured.units;
                        if (units === undefined || baseline === undefined)
                          throw new AgentRuntimeError(
                            "AGENT_CONTEXT_LIMIT",
                            "Subtask input measurement unavailable",
                          );
                        if (
                          limit !== undefined &&
                          units + reservations.reserved(token, group) > limit
                        )
                          return false;
                        reservations.set(token, Math.max(0, units - baseline), group);
                        return true;
                      };
                      if (fit(value)) return value;
                      const unavailable = {
                        status: "unavailable",
                        code: "CONTEXT_BUDGET_EXCEEDED",
                      };
                      if (!fit(unavailable))
                        throw new AgentRuntimeError(
                          "AGENT_CONTEXT_LIMIT",
                          "Subtask result and refusal exceed its input budget",
                        );
                      return unavailable;
                    }
                  : undefined;
              const values = await this.executor.executeBatch(
                planned.map((entry) => ({ action: entry.action, arguments: entry.call.arguments })),
                {
                  ...actionContext,
                  sources: context.sources,
                  ...(fitReadResult ? { fitReadResult } : {}),
                },
                { mode, assertCurrent: () => input.context.assertCurrent?.() },
              );
              const results = new Map(
                planned.map((entry, index) => {
                  usedActions.add(entry.action);
                  return [entry, values[index]] as const;
                }),
              );
              const reads = planned.filter((entry) => entry.effect === "read");
              const writes = planned.filter((entry) => entry.effect !== "read");
              scope?.update({
                sources: uniqueSources([
                  ...context.sources,
                  ...planned.flatMap((entry) => results.get(entry)?.sources ?? []),
                ]),
                details: {
                  actionCount: planned.length,
                  readCount: reads.length,
                  writeCount: writes.length,
                },
              });
              return results;
            },
          );
          for (const entry of planned) {
            const result = settled.get(entry);
            if (!result)
              throw new AgentRuntimeError("AGENT_ACTION_UNAVAILABLE", "Action produced no result");
            const observation: ActionObservation = {
              ...result,
              ...(entry.repeat
                ? { repeatWarning: "同一个调用这是第 2 次：换个做法，不要原样重试" }
                : {}),
              id: randomUUID(),
              name: entry.call.name,
              arguments: entry.call.arguments,
              // 只带**这次结果自己的**来源：k 条观测不再各复制一遍上下文来源（元数据重复是上下文
              // 膨胀的来源之一）。归属没有丢——"这条结果是在哪些来源之下产生的"由这一步的上下文
              // 快照记一次（`context_snapshots.source_refs`，`repository.getContext` 可读）。
              sources: uniqueSources([...result.sources]),
            };
            observations.push(observation);
            usedActionObservations.set(entry.action, observation);
            await this.emit(active, {
              type: "action_result",
              name: entry.call.name,
              observationId: observation.id,
            });
          }
          continue;
        }
        if (
          input.outputMode === "stream" &&
          (decision.outputs.length !== 1 || decision.outputs[0].kind !== "generate")
        ) {
          throw new AgentRuntimeError(
            "AGENT_OUTPUT_INVALID",
            "A streamed conversation requires one generated output",
          );
        }
        if (
          await this.trace(
            active,
            "agent.checkpoint",
            { stage: "context", details: { phase: "before_final", decision: "final" } },
            async (scope) => {
              const result = await input.beforeFinal?.(decision.outputs, active.signal);
              scope?.update({ details: { reobserved: result ?? false } });
              return result;
            },
          )
        ) {
          if (terminalDecision)
            throw new AgentRuntimeError(
              "CONTEXT_SOURCE_INVALID",
              "Terminal budget recovery cannot reobserve",
            );
          continue;
        }
        active.signal.throwIfAborted();
        this.repository.setStatus(active.runId, "generating", this.now());
        // 上下文/媒体/水位是共享可变状态，准备逐目标串行；只有模型网络段并行。
        // 每目标独立 catch：准备失败只作废该目标；结果按 ordinal 落位保持输出顺序。
        const slots: Array<PreparedOutput | undefined> = decision.outputs.map(() => undefined);
        const plans: TargetPlan[] = [];
        const commitFailedOutputs = new Set<string>();
        for (const [ordinal, draft] of decision.outputs.entries()) {
          active.signal.throwIfAborted();
          // 已早提交目标跨轮保留：不重生成、不再提交（原输出与事实已在宿主早提交事务里）。
          const alreadyCommitted = committedTargets.get(draft.targetId);
          if (alreadyCommitted) {
            slots[ordinal] = alreadyCommitted;
            continue;
          }
          if (!input.authorizedTargets.includes(draft.targetId)) {
            slots[ordinal] = {
              outputId: randomUUID(),
              targetId: draft.targetId,
              status: "blocked",
              code: "AGENT_TARGET_UNAUTHORIZED",
            };
            continue;
          }
          let outputId: string = randomUUID();
          try {
            const reservation = await input.prepareOutput?.(draft, ordinal, {
              origin: outputOrigin,
              observations: [...observations],
            });
            if (reservation && "blocked" in reservation) {
              slots[ordinal] = {
                outputId,
                targetId: draft.targetId,
                status: "blocked",
                code: reservation.code,
              };
              continue;
            }
            if (reservation) outputId = reservation.outputId;
            if (draft.kind === "inline") {
              const output: PreparedOutput = {
                outputId,
                targetId: draft.targetId,
                status: "prepared",
                text: draft.text,
                ...(draft.replyToMessageId === undefined
                  ? {}
                  : { replyToMessageId: draft.replyToMessageId }),
                ...(draft.mentionIds === undefined ? {} : { mentionIds: draft.mentionIds }),
                stickerIds: draft.stickerIds,
              };
              slots[ordinal] = output;
              // inline 草稿不走模型段，准备完成即与 generate 目标同一时机边界早提交。
              await this.commitPrepared(
                active,
                input,
                output,
                ordinal,
                committedTargets,
                commitFailedOutputs,
              );
              continue;
            }
            this.checkStepBudget(active, spec);
            const prepared = await this.trace(
              active,
              "agent.context",
              { stage: "context", outputId, details: { phase: "generate" } },
              async (scope) => {
                const preparedGeneration = await input.prepareGeneration?.(draft, {
                  context,
                  outputId,
                  signal: active.signal,
                });
                const generation = { ...spec.generation, ...preparedGeneration };
                const generationModel = generation.model ?? spec.model;
                const generationBudget = await preparePhaseBudget(generationModel);
                active.signal.throwIfAborted();
                // 规格 §10：是否走同次封装在系统声明渲染前冻结——renderOutput 的输出协议
                // 声明与 structured complete 的实际 responseSchema 用同一个选择。
                const structured =
                  input.outputMode === "buffered" ? generation.responseEnvelope : undefined;
                const generationContext = preparedGeneration?.context ?? context;
                const messages = this.contextEngine.renderOutput(
                  { ...spec, generation },
                  generationContext,
                  draft,
                  structured?.responseSchema,
                );
                const measuredGenerationContext = this.measureRenderedContext(
                  { ...generationContext, messages, units: inputUnits(messages) },
                  generationBudget,
                  structured === undefined
                    ? undefined
                    : { responseSchema: structured.responseSchema },
                );
                await input.onContext?.(measuredGenerationContext, {
                  runId: active.runId,
                  phase: "generate",
                });
                scope?.update({
                  sources: generationContext.sources,
                  details: {
                    inputUnits: inputUnits(messages),
                    messageCount: messages.length,
                    sourceCount: generationContext.sources.length,
                  },
                });
                const generationSpec: LeafAgentSpec = {
                  ...spec,
                  model: generation.model ?? spec.model,
                  temperature: generation.temperature ?? spec.temperature,
                  maxTokens: generation.maxTokens ?? spec.maxTokens ?? spec.limits.outputTokens,
                  limits: { inputUnits: generation.inputUnits ?? spec.limits.inputUnits },
                };
                return {
                  generation,
                  generationContext: measuredGenerationContext,
                  messages,
                  generationSpec,
                  generationBudget,
                  ...(structured === undefined ? {} : { structured }),
                  ...(preparedGeneration?.hooks === undefined
                    ? {}
                    : { hooks: preparedGeneration.hooks }),
                };
              },
            );
            plans.push({
              draft,
              ordinal,
              outputId,
              generationContext: prepared.generationContext,
              messages: prepared.messages,
              generationSpec: prepared.generationSpec,
              ...(prepared.generationBudget === undefined
                ? {}
                : { generationBudget: prepared.generationBudget }),
              ...(prepared.structured === undefined ? {} : { structured: prepared.structured }),
              ...(prepared.generation.allowEmpty === undefined
                ? {}
                : { allowEmpty: prepared.generation.allowEmpty }),
              ...(prepared.hooks === undefined ? {} : { hooks: prepared.hooks }),
              resolvedSink: {},
            });
          } catch (error) {
            if (
              active.signal.aborted ||
              input.outputMode === "stream" ||
              (error instanceof AgentRuntimeError && error.code === "AGENT_STEP_LIMIT")
            )
              throw error;
            slots[ordinal] = {
              outputId,
              targetId: draft.targetId,
              status: "failed",
              code: errorCode(error),
            };
          }
        }
        // 每目标写自己的 resolved sink（不共用 active.resolvedModel）。一个目标 fatal 时
        // 取消同批其余在飞请求并等它们 settle 再抛，避免资源已释放后兄弟仍访问。
        const batchAbort = new AbortController();
        const batchSignal = AbortSignal.any([active.signal, batchAbort.signal]);
        let fatal: { error: unknown } | undefined;
        await Promise.all(
          plans.map(async (plan) => {
            try {
              const generated = await this.generateTarget(active, input, plan, batchSignal);
              slots[plan.ordinal] = generated;
              // 规格 §4.1 早提交：本目标生成完成即提交，不等兄弟；宿主按目标写自己的 outbox intent。
              await this.commitPrepared(
                active,
                input,
                generated,
                plan.ordinal,
                committedTargets,
                commitFailedOutputs,
              );
            } catch (error) {
              if (
                active.signal.aborted ||
                input.outputMode === "stream" ||
                (error instanceof AgentRuntimeError && error.code === "AGENT_STEP_LIMIT")
              ) {
                fatal ??= { error };
                batchAbort.abort(error);
                return;
              }
              slots[plan.ordinal] = {
                outputId: plan.outputId,
                targetId: plan.draft.targetId,
                status: "failed",
                code: errorCode(error),
              };
            }
          }),
        );
        if (fatal) throw fatal.error;
        const outputs = this.mergeCommitted(
          slots.filter((slot): slot is PreparedOutput => slot !== undefined),
          committedTargets,
        );
        active.signal.throwIfAborted();
        // 已早提交目标不再复核/重开；reconsider 只观察未提交目标。
        const pendingOutputs = outputs.filter((output) => !committedTargets.has(output.targetId));
        const reconsidered = await this.trace(
          active,
          "agent.checkpoint",
          {
            stage: "context",
            details: { phase: "reconsider", outputCount: pendingOutputs.length },
          },
          async (scope) => {
            const result = await input.reconsider?.(pendingOutputs, active.signal);
            scope?.update({ details: { reconsidered: result ?? false } });
            return result;
          },
        );
        if (reconsidered) {
          if (terminalDecision && reconsidered !== "no_output")
            throw new AgentRuntimeError(
              "CONTEXT_SOURCE_INVALID",
              "Terminal budget recovery cannot reconsider",
            );
          if (input.outputMode === "stream")
            throw new AgentRuntimeError(
              "AGENT_STREAM_RECONSIDERED",
              "Already streamed output cannot be replaced",
            );
          if (reconsidered === "no_output") {
            if (committedTargets.size > 0) {
              // 已早提交目标不因“本轮无可提交输出”被抹除：带其事实按完成结算。
              await this.commitAndFinish(active, input, outputs, "completed", {
                type: "completed",
                outputs: outputs.map(({ outputId, targetId, status, code }) => ({
                  outputId,
                  targetId,
                  status,
                  ...(code ? { code } : {}),
                })),
              });
              return { runId: active.runId, status: "completed", outputs };
            }
            await this.commitAndFinish(active, input, [], "no_output", { type: "no_output" });
            return { runId: active.runId, status: "no_output", outputs: [] };
          }
          continue;
        }
        if (!outputs.some((output) => output.status === "prepared")) {
          const silent = new Set(input.silentBlockCodes ?? []);
          const allSilent =
            silent.size > 0 &&
            outputs.length > 0 &&
            outputs.every((output) => output.status === "blocked" && silent.has(output.code ?? ""));
          if (allSilent) {
            // 许可不通过＝这一轮不开口：静默结束，不进失败与重试。
            await this.commitAndFinish(active, input, outputs, "no_output", { type: "no_output" });
            return { runId: active.runId, status: "no_output", outputs };
          }
          const sourceCommitFailure =
            outputs.length > 0 &&
            outputs.every(
              (output) =>
                output.status === "failed" &&
                commitFailedOutputs.has(output.outputId) &&
                output.code === "CONTEXT_SOURCE_INVALID",
            );
          if (sourceCommitFailure)
            throw new AppError("CONTEXT_SOURCE_INVALID", "No output could be prepared");
          throw new AgentRuntimeError("AGENT_OUTPUT_FAILED", "No output could be prepared");
        }
        const summaries = outputs.map(({ outputId, targetId, status, code }) => ({
          outputId,
          targetId,
          status,
          ...(code ? { code } : {}),
        }));
        await this.commitAndFinish(active, input, outputs, "completed", {
          type: "completed",
          outputs: summaries,
        });
        return { runId: active.runId, status: "completed", outputs };
      }
    } catch (error) {
      await this.fail(active, error, input.commitFailure);
      throw error;
    } finally {
      try {
        input.context.configureActions?.(originalActions);
      } finally {
        try {
          for (const action of releaseActions)
            action.release?.({ owner: input.owner, runId: active.runId });
        } finally {
          active.dispose();
        }
      }
    }
  }

  /** 并行生成段里单个目标的一次模型调用；resolved 回写本目标的 sink。 */
  private async generateTarget(
    active: Running,
    input: ConversationInput,
    plan: TargetPlan,
    signalOverride: AbortSignal,
  ): Promise<PreparedOutput> {
    const {
      outputId,
      messages,
      generationContext,
      generationSpec,
      generationBudget,
      structured,
      allowEmpty,
    } = plan;
    // 宿主按目标冻结的闭包；未给的字段沿输入级（单目标行为）。并行多目标时宿主须给齐，
    // 否则会回读共享的相投影/fallback 状态。
    const hooks: TargetHooks = plan.hooks ?? {};
    const prepareWithResolved = hooks.prepareWithResolved ?? input.prepareWithResolved;
    const assertPreparedCurrent = hooks.assertPreparedCurrent ?? input.assertPreparedCurrent;
    const onPhaseMediaUnsupported = hooks.onPhaseMediaUnsupported ?? input.onPhaseMediaUnsupported;
    const onModelCallConsumed = hooks.onModelCallConsumed ?? input.onModelCallConsumed;
    const imageResolver = hooks.imageResolver ?? input.imageResolver;
    let text = "";
    // 规格 §10：buffered 且宿主声明"本次生成需要同次机器可读封装"时，走一次结构化
    // complete 取 envelope，剥离后正文照常提交——不新增第二次模型调用、不落 auxiliary
    // 阶段；缺省（未声明）与 stream 模式逐字保持原 streamText 行为。
    await this.step(
      active,
      "generate",
      messages,
      generationContext.sources,
      async (capture, onModelResolved, onModelResponse, retryOptions) => {
        if (structured) {
          // T10/§9 生成相发送（structured complete）：真实 HTTP 服务首拒
          // MODEL_IMAGE_UNSUPPORTED → 宿主标 fallback 重备后同相同 complete 重试
          // 恰一次；非 unsupported 原样抛。
          const requestFor = (phaseMessages: readonly ModelMessage[]): ModelRequest => ({
            messages: phaseMessages,
            model: generationSpec.model,
            temperature: generationSpec.temperature,
            maxTokens: generationSpec.maxTokens,
            responseSchema: structured.responseSchema,
            ...(generationBudget === undefined ? {} : { contextBudget: generationBudget }),
            ...(!generationBudget?.countText ||
            !generationBudget.tokenizerEncoding ||
            generationSpec.limits?.inputUnits === undefined
              ? {}
              : { contextInputLimit: generationSpec.limits.inputUnits }),
            ...(active.workClass === undefined ? {} : { workClass: active.workClass }),
            runId: active.runId,
            owner: input.owner,
            ...(imageResolver === undefined ? {} : { imageResolver: imageResolver }),
            ...(prepareWithResolved === undefined
              ? {}
              : {
                  prepareWithResolved: async (hook: ModelResolvedPrepareInput) =>
                    (await prepareWithResolved?.({
                      ...hook,
                      phase: "generate",
                    })) ?? {},
                }),
            ...(assertPreparedCurrent === undefined
              ? {}
              : { assertPreparedCurrent: assertPreparedCurrent }),
            ...retryOptions(),
            signal: active.signal,
            onModelResolved,
            onResponseText: capture,
            onModelResponse,
          });
          let raw: string;
          try {
            raw = await this.options.model.complete(requestFor(messages));
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                (error as { code?: unknown }).code === "MODEL_IMAGE_UNSUPPORTED"
              ) ||
              onPhaseMediaUnsupported === undefined
            )
              throw error;
            const retry = await onPhaseMediaUnsupported({
              phase: "generate",
              model: plan.resolvedSink.resolvedModel ?? generationSpec.model ?? "",
              messages,
              signal: active.signal,
            });
            if (retry === null) throw error;
            raw = await this.options.model.complete(requestFor(retry.messages));
          }
          capture(raw, true);
          text = structured.parse(raw, {
            resolvedModel: plan.resolvedSink.resolvedModel ?? "",
          }).text;
          if (!unicodeStrip(text) && !allowEmpty)
            throw new AgentRuntimeError("MODEL_EMPTY_RESPONSE", "Model returned an empty response");
          active.signal.throwIfAborted();
          // §8.1：生成相调用成功返回 → 通知宿主记账（native proof）。
          onModelCallConsumed?.({ phase: "generate" });
          return text;
        }
        // T10/§9 生成相 stream：unsupported 首拒（零 delta）→ 宿主标 fallback 重备
        // 后同相 stream 重试恰一次；已收到 delta 后的失败不重试。
        let phaseMessages: readonly ModelMessage[] = messages;
        const streamRequest = () => ({
          messages: phaseMessages,
          model: generationSpec.model,
          temperature: generationSpec.temperature,
          maxTokens: generationSpec.maxTokens,
          ...(generationBudget === undefined ? {} : { contextBudget: generationBudget }),
          ...(!generationBudget?.countText ||
          !generationBudget.tokenizerEncoding ||
          generationSpec.limits?.inputUnits === undefined
            ? {}
            : { contextInputLimit: generationSpec.limits.inputUnits }),
          ...(active.workClass === undefined ? {} : { workClass: active.workClass }),
          runId: active.runId,
          owner: input.owner,
          ...(imageResolver === undefined ? {} : { imageResolver: imageResolver }),
          ...(prepareWithResolved === undefined
            ? {}
            : {
                prepareWithResolved: async (hook: ModelResolvedPrepareInput) =>
                  (await prepareWithResolved?.({
                    ...hook,
                    phase: "generate",
                  })) ?? {},
              }),
          ...(assertPreparedCurrent === undefined
            ? {}
            : { assertPreparedCurrent: assertPreparedCurrent }),
          ...retryOptions(),
          signal: active.signal,
          onModelResolved,
          onModelResponse,
        });
        let unsupportedRetry = onPhaseMediaUnsupported !== undefined;
        try {
          for await (const delta of this.options.model.streamText(streamRequest())) {
            active.signal.throwIfAborted();
            if (!delta) continue;
            text += delta;
            capture(text);
            if (input.outputMode === "stream")
              await this.emit(active, { type: "output_delta", outputId, text: delta });
          }
        } catch (error) {
          // §9：首拒（零 delta）且宿主接了重试边界 → 重备后同相 stream 重试恰一次。
          if (
            text !== "" ||
            !(
              error instanceof Error &&
              (error as { code?: unknown }).code === "MODEL_IMAGE_UNSUPPORTED"
            ) ||
            !unsupportedRetry
          )
            throw error;
          unsupportedRetry = false;
          const retry = await onPhaseMediaUnsupported?.({
            phase: "generate",
            model: plan.resolvedSink.resolvedModel ?? generationSpec.model ?? "",
            messages: phaseMessages,
            signal: active.signal,
          });
          if (retry === null || retry === undefined) throw error;
          phaseMessages = retry.messages;
          for await (const delta of this.options.model.streamText(streamRequest())) {
            active.signal.throwIfAborted();
            if (!delta) continue;
            text += delta;
            capture(text);
            if (input.outputMode === "stream")
              await this.emit(active, { type: "output_delta", outputId, text: delta });
          }
        }
        capture(text, true);
        if (!unicodeStrip(text) && !allowEmpty)
          throw new AgentRuntimeError("MODEL_EMPTY_RESPONSE", "Model returned an empty response");
        active.signal.throwIfAborted();
        // §8.1：stream 生成相在完整流结束、abort/empty 检查通过后记账恰一次；
        // 流中异常、部分 delta 后失败/abort/empty 不允许时不通知。
        onModelCallConsumed?.({ phase: "generate" });
        return text;
      },
      generationSpec,
      outputId,
      plan.resolvedSink,
      signalOverride,
      {
        budget: generationBudget,
        inputLimit: generationBudget?.countText ? generationSpec.limits?.inputUnits : undefined,
        options:
          structured === undefined ? undefined : { responseSchema: structured.responseSchema },
        measure: generationContext.tokenMeasure,
        stepInputLimit: generationSpec.limits?.inputUnits,
      },
      () => input.context.assertSources?.(generationContext.sources),
    );
    return {
      outputId: plan.outputId,
      targetId: plan.draft.targetId,
      status: "prepared",
      text,
      ...(plan.draft.replyToMessageId === undefined
        ? {}
        : { replyToMessageId: plan.draft.replyToMessageId }),
      ...(plan.draft.mentionIds === undefined ? {} : { mentionIds: plan.draft.mentionIds }),
      stickerIds: plan.draft.stickerIds,
    };
  }

  private modelRetry(
    active: Running,
    signal: AbortSignal,
    messages: readonly ModelMessage[],
    assertCurrent?: () => void,
  ) {
    const policy = active.retryOrigin === "system" ? active.retryPolicy : undefined;
    if (!policy || policy.maxAttempts <= 1) return {};
    const units = inputUnits(messages);
    const budget = active.budget;
    return {
      retryPolicy: policy,
      onRetry: () => {
        signal.throwIfAborted();
        active.assertActions?.();
        assertCurrent?.();
        if (active.deadlineAt !== undefined && Date.now() >= active.deadlineAt)
          throw new AgentRuntimeError("AGENT_DEADLINE", "Agent run deadline exceeded");
        if (
          (budget?.maxCalls !== undefined && active.usage.calls + 1 > budget.maxCalls) ||
          (budget?.maxInputUnits !== undefined &&
            active.usage.inputUnits + units > budget.maxInputUnits)
        )
          throw new AgentRuntimeError(
            "AGENT_BUDGET_EXCEEDED",
            "This task tree has used its whole model budget",
          );
        active.usage.calls += 1;
        active.usage.inputUnits += units;
      },
    };
  }

  private start(
    spec: LeafAgentSpec,
    input: {
      owner: RunOwner;
      workClass?: ModelWorkClass;
      retryOrigin?: RetryOrigin;
      signal?: AbortSignal;
      onEvent?: Running["onEvent"];
      conversationId?: string;
      sources?: readonly SourceRef[];
      /** 共享给整棵任务树的账本；省略＝这个 run 自己一本。 */
      usage?: RunUsage;
      budget?: RunBudget;
    },
  ): Running {
    const deadline = new AbortController();
    const timer =
      spec.limits?.deadlineMs === undefined
        ? undefined
        : setTimeout(
            () =>
              deadline.abort(
                new AgentRuntimeError("AGENT_DEADLINE", "Agent run deadline exceeded"),
              ),
            spec.limits.deadlineMs,
          );
    const parent = this.taskTree.getStore();
    const callerSignal = parent
      ? AbortSignal.any([parent.signal, ...(input.signal ? [input.signal] : [])])
      : input.signal;
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadline.signal])
      : deadline.signal;
    const runId = randomUUID();
    this.repository.createRun({
      runId,
      specId: spec.id,
      specVersion: spec.version ?? "1",
      owner: input.owner,
      at: this.now(),
    });
    let channel: TraceMetadata["channel"] = "system";
    const trace = startAgentTrace(this.telemetry, "agent.run", (telemetry) => {
      const scope = resolveAgentTraceScope(telemetry, input.owner, input.conversationId);
      channel = scope.channel;
      return {
        ...scope,
        runId,
        sources: input.sources,
        details: {
          specId: spec.id,
          ownerKind: input.owner.kind,
          ownerId: input.owner.id,
        },
      };
    });
    const retryOrigin = parent ? parent.retryOrigin : input.retryOrigin;
    const configuredRetryPolicy =
      parent === undefined && retryOrigin === "system"
        ? this.options.systemRetryPolicy?.()
        : undefined;
    const retryPolicy = parent
      ? parent.retryPolicy
      : configuredRetryPolicy === undefined
        ? undefined
        : { ...configuredRetryPolicy };
    return {
      runId,
      usage: parent?.usage ?? input.usage ?? { calls: 0, inputUnits: 0 },
      budget: parent?.budget ?? input.budget,
      workClass: parent?.workClass ?? input.workClass,
      retryOrigin,
      retryPolicy,
      spec,
      signal,
      trace,
      channel,
      callerSignal,
      deadlineAt:
        spec.limits?.deadlineMs === undefined ? undefined : Date.now() + spec.limits.deadlineMs,
      stepNo: 0,
      conversationId: input.conversationId,
      onEvent: input.onEvent,
      dispose: () => clearTimeout(timer),
    };
  }

  private measureRenderedContext(
    rendered: RenderedContext,
    budget: ModelContextBudget | undefined,
    options?: ContextTokenMeasureOptions,
  ): RenderedContext {
    if (!budget?.countText || !budget.tokenizerEncoding) return rendered;
    budget.assertCurrent();
    const tokenMeasure = measureContextTokens(
      rendered.messages,
      { encoding: budget.tokenizerEncoding, count: budget.countText },
      options,
    );
    budget.assertCurrent();
    return { ...rendered, tokenMeasure };
  }

  private async step<T>(
    active: Running,
    phase: AgentStepSnapshot["phase"],
    messages: ModelMessage[],
    sources: readonly SourceRef[],
    execute: (
      capture: (text: string, complete?: boolean) => void,
      onModelResolved: (model: string) => void,
      onModelResponse: (metadata: ModelResponseMetadata) => void,
      retryOptions: () => { retryPolicy?: ReadRetryOptions; onRetry?: () => void },
    ) => Promise<T>,
    stepSpec: LeafAgentSpec = active.spec,
    outputId?: string,
    /**
     * 并行目标各自的 resolved 回写目标：并行时多个 step 同时在飞，不能都写共享的
     * `active.resolvedModel`（会互相覆盖）；给定则写这里，未给保持原单目标行为。
     */
    resolvedSink?: { resolvedModel?: string },
    /** 并行批次信号：兄弟 fatal 时取消同批在飞请求并先 settle；缺省＝只用 run 信号。 */
    signalOverride?: AbortSignal,
    tokenPreflight?: {
      budget?: ModelContextBudget;
      inputLimit?: number;
      options?: ContextTokenMeasureOptions;
      measure?: ContextTokenMeasure;
      stepInputLimit?: number;
    },
    assertRetryCurrent?: () => void,
  ): Promise<T> {
    const stepSignal = signalOverride ?? active.signal;
    stepSignal.throwIfAborted();
    active.assertActions?.();
    const units = inputUnits(messages);
    const tokenBudget = tokenPreflight?.budget;
    const tokenLimit = tokenPreflight?.inputLimit;
    if (tokenLimit !== undefined && tokenBudget?.countText && tokenBudget.tokenizerEncoding) {
      tokenBudget.assertCurrent();
      const measured =
        tokenPreflight?.measure ??
        measureContextTokens(
          messages,
          { encoding: tokenBudget.tokenizerEncoding, count: tokenBudget.countText },
          tokenPreflight?.options,
        );
      tokenBudget.assertCurrent();
      const limit = tokenPreflight?.stepInputLimit ?? tokenLimit;
      if (measured.textTokens > limit) {
        this.telemetry?.record("agent.budget", {
          channel: active.channel,
          stage: "run",
          status: "failed",
          code: "AGENT_CONTEXT_LIMIT",
          runId: active.runId,
          sources,
          details: {
            inputUnits: measured.textTokens,
            inputLimit: limit,
            estimator: measured.method,
            stepNo: active.stepNo,
            rejected: "context",
          },
        });
        throw new AgentRuntimeError(
          "AGENT_CONTEXT_LIMIT",
          "Context exceeds the configured input budget",
        );
      }
    }
    const limit = stepSpec.limits?.inputUnits;
    const tokenPreflightActive =
      tokenLimit !== undefined && Boolean(tokenBudget?.countText && tokenBudget.tokenizerEncoding);
    if (!tokenPreflightActive && limit !== undefined && units > limit) {
      // 拒绝发生在建 step 之前——没有这一步的模型记录，所以把码与量留在观测里（B06）。
      this.telemetry?.record("agent.budget", {
        channel: active.channel,
        stage: "run",
        status: "failed",
        code: "AGENT_CONTEXT_LIMIT",
        runId: active.runId,
        sources,
        details: {
          inputUnits: units,
          inputLimit: limit,
          stepNo: active.stepNo,
          rejected: "context",
        },
      });
      throw new AgentRuntimeError(
        "AGENT_CONTEXT_LIMIT",
        "Context exceeds the configured input budget",
      );
    }
    // 记账与拦限都在这里：每一次模型调用（含叶子）都经过 step，是唯一不会漏的地方。
    active.usage.calls += 1;
    active.usage.inputUnits += units;
    const budget = active.budget;
    if (
      (budget?.maxCalls !== undefined && active.usage.calls > budget.maxCalls) ||
      (budget?.maxInputUnits !== undefined && active.usage.inputUnits > budget.maxInputUnits)
    ) {
      this.telemetry?.record("agent.budget", {
        channel: active.channel,
        stage: "run",
        status: "failed",
        code: "AGENT_BUDGET_EXCEEDED",
        runId: active.runId,
        sources,
        details: {
          calls: active.usage.calls,
          inputUnits: active.usage.inputUnits,
          maxCalls: budget?.maxCalls ?? null,
          maxInputUnits: budget?.maxInputUnits ?? null,
          stepNo: active.stepNo,
          rejected: "tree-budget",
        },
      });
      throw new AgentRuntimeError(
        "AGENT_BUDGET_EXCEEDED",
        "This task tree has used its whole model budget",
      );
    }
    const stepId = randomUUID();
    const now = this.now();
    this.repository.startStep({
      runId: active.runId,
      stepId,
      stepNo: ++active.stepNo,
      model: stepSpec.model ?? this.options.model.defaultModel ?? "",
      phase,
      at: now,
      messages,
      sources,
    });
    let output: ProtectedModelOutput | undefined;
    const responses: ModelResponseMetadata[] = [];
    const onModelResponse = (metadata: ModelResponseMetadata): void => {
      responses.push({ ...metadata, finishReasons: [...metadata.finishReasons] });
    };
    const capture = (text: string, complete = false) => {
      output = {
        text,
        complete,
        format: phase === "next" ? "json" : "text",
        ...(responses.length ? { responses } : {}),
      };
    };
    // A stream can report its response after the last text delta, including on failure.
    const persistedOutput = (): ProtectedModelOutput | undefined =>
      output
        ? { ...output, ...(responses.length ? { responses } : {}) }
        : responses.length
          ? {
              text: "",
              format: phase === "next" ? "json" : "text",
              complete: false,
              hasText: false,
              responses,
            }
          : undefined;
    // T14 观测（已批 V4）：与 render 同一 visionCostOf 真源的三标量投影；unknown 不是 0、
    // 不折算 token、不进预算——pixels 是准备尺寸的安全边界值，不是计费事实。
    const visionCost = visionCostOf(messages);
    return this.trace(
      active,
      "agent.model",
      {
        stage: "model",
        outputId,
        model: stepSpec.model ?? this.options.model.defaultModel,
        sources,
        details: {
          stepId,
          modelResolved: phase === "vision",
          requestedModel: stepSpec.model ?? this.options.model.defaultModel ?? "",
          stepNo: active.stepNo,
          visionCostState: visionCost.state,
          visionImages: visionCost.images ?? 0,
          visionPixels: visionCost.pixels ?? 0,
          phase,
          inputUnits: inputUnits(messages),
          messageCount: messages.length,
          sourceCount: sources.length,
          imageCount: messages.reduce(
            (n, m) => n + m.content.filter((part) => part.kind === "image").length,
            0,
          ),
          maxTokens:
            stepSpec.maxTokens ??
            (phase === "next" ? (stepSpec as AgentSpec).limits?.outputTokens : undefined) ??
            null,
        },
      },
      async (scope) => {
        try {
          await this.emit(active, {
            type: "step",
            stepId,
            context: { runId: active.runId, stepId },
          });
          const result = await execute(
            capture,
            (model) => {
              // resolved 真源单点：先写本步的 resolved 目标（并行步写各自的 sink），再落库。
              if (resolvedSink) resolvedSink.resolvedModel = model;
              else active.resolvedModel = model;
              this.repository.resolveStepModel(stepId, model);
              scope?.update({ model, details: { modelResolved: true } });
            },
            onModelResponse,
            () =>
              this.modelRetry(active, stepSignal, messages, () => {
                assertRetryCurrent?.();
                if (active.deadlineAt !== undefined && Date.now() >= active.deadlineAt)
                  throw new AgentRuntimeError("AGENT_DEADLINE", "Agent run deadline exceeded");
                if (
                  (budget?.maxCalls !== undefined && active.usage.calls + 1 > budget.maxCalls) ||
                  (budget?.maxInputUnits !== undefined &&
                    active.usage.inputUnits + units > budget.maxInputUnits)
                )
                  throw new AgentRuntimeError(
                    "AGENT_BUDGET_EXCEEDED",
                    "This task tree has used its whole model budget",
                  );
              }),
          );
          active.signal.throwIfAborted();
          if (phase === "next") {
            const decision = AgentDecisionSchema.parse(result);
            scope?.update({
              details: {
                decision: decision.kind,
                ...(decision.kind === "invoke"
                  ? { actions: decision.calls.map((call) => call.name).join(",") }
                  : {}),
                ...(decision.kind === "final" ? { outputCount: decision.outputs.length } : {}),
              },
            });
          } else
            scope?.update({
              details: { outputCharacters: typeof result === "string" ? result.length : null },
            });
          this.repository.finishStep(stepId, "completed", this.now(), {
            decision: phase === "next" ? decisionMetadata(result) : undefined,
            output: persistedOutput(),
          });
          return result;
        } catch (error) {
          const failed = active.signal.aborted ? active.signal.reason : error;
          const code = errorCode(failed);
          this.repository.finishStep(
            stepId,
            active.callerSignal?.aborted ? "cancelled" : "failed",
            this.now(),
            { errorCode: code, output: persistedOutput() },
          );
          // 无码失败是一条死胡同（记录里只有 AGENT_FAILED）。留一行：阶段、模型、错误名与消息，
          // 以及模型这次实际回了什么（截断，不含正文以外的内容）——要求可定位。
          if (code === "AGENT_FAILED" && !active.callerSignal?.aborted)
            console.warn(
              `[agent] 步骤失败（无错误码）phase=${phase} model=${stepSpec.model ?? "?"}：${describeFailure(failed)}｜模型输出：${summariseModelText(output?.text)}`,
            );
          scope?.end(active.callerSignal?.aborted ? "cancelled" : "failed", traceErrorCode(failed));
          throw error;
        }
      },
    );
  }

  private async withRun<T>(active: Running, work: () => Promise<T>): Promise<T> {
    const execute = async () => {
      try {
        return await work();
      } finally {
        // Durable terminal is authoritative even when a downstream stream consumer disconnects.
        if (active.trace) {
          try {
            const snapshot = this.repository.getRun(active.runId);
            const status = snapshot?.endedAt ? snapshot.status : "failed";
            // 预算与累计用量按任务树投影（B06）：上限与实耗都写在这一层，不把估算单位说成账单。
            active.trace.update({
              details: {
                stepCount: active.stepNo,
                usageCalls: active.usage.calls,
                usageInputUnits: active.usage.inputUnits,
                budgetMaxCalls: active.budget?.maxCalls ?? null,
                budgetMaxInputUnits: active.budget?.maxInputUnits ?? null,
              },
            });
            active.trace.end(
              status === "completed" || status === "no_output" || status === "cancelled"
                ? status
                : "failed",
              snapshot?.errorCode
                ? traceErrorCode({ code: snapshot.errorCode })
                : status === "failed"
                  ? "AGENT_FAILED"
                  : undefined,
            );
          } catch {
            active.trace.end("unknown", "RUN_STATE_UNAVAILABLE");
          }
        }
      }
    };
    return this.taskTree.run(
      {
        usage: active.usage,
        budget: active.budget,
        workClass: active.workClass,
        retryOrigin: active.retryOrigin,
        retryPolicy: active.retryPolicy,
        signal: active.signal,
      },
      () => (active.trace ? active.trace.within(execute) : execute()),
    );
  }

  private trace<T>(
    active: Running,
    name: string,
    metadata: Omit<TraceMetadata, "channel">,
    work: (scope: TraceScope | undefined) => Promise<T>,
  ): Promise<T> {
    return withinAgentTrace(
      startAgentTrace(this.telemetry, name, () => ({ channel: active.channel, ...metadata })),
      async (scope) => {
        try {
          return await work(scope);
        } catch (error) {
          scope?.end(
            active.callerSignal?.aborted ? "cancelled" : "failed",
            traceErrorCode(active.signal.aborted ? active.signal.reason : error),
          );
          throw error;
        }
      },
    );
  }

  private checkStepBudget(active: Running, spec: AgentSpec): void {
    active.signal.throwIfAborted();
    if (active.stepNo >= spec.limits.steps)
      throw new AgentRuntimeError("AGENT_STEP_LIMIT", "Agent exhausted its configured model steps");
  }
  private async emit(active: Running, payload: RunEventPayload): Promise<void> {
    const event = this.repository.appendEvent(
      active.runId,
      payload,
      this.now(),
      active.conversationId,
    );
    await active.onEvent?.(event);
  }
  private async finish(
    active: Running,
    status: RunStatus,
    payload: RunEventPayload,
  ): Promise<void> {
    // 宿主可能已在本 run 内用同一 repo 结算（如 group 零达标时 finishRun(no_output)）：
    // repo.appendEvent 总会追加，故入口 early return，避免追加第二个终态事件。
    if (this.repository.getRun(active.runId)?.endedAt) return;
    const event = this.repository.finishRun(active.runId, status, payload, this.now(), {
      conversationId: active.conversationId,
    });
    await active.onEvent?.(event);
  }
  /**
   * 该目标 prepared 后立即在宿主原事务里提交，不等兄弟或整批；缺省无 commitOutput＝不早提交。
   * 与原 commitAndFinish 同一运行边界（assertActions）；权限/来源/租约等 guards 由宿主负责。
   * 返回 false＝宿主拒绝（未提交，留给终态结算）；true/void＝已提交，记入 committedTargets。
   */
  private async commitPrepared(
    active: Running,
    input: ConversationInput,
    output: PreparedOutput,
    ordinal: number,
    committedTargets: Map<string, PreparedOutput>,
    commitFailedOutputs: Set<string>,
  ): Promise<void> {
    if (input.commitOutput === undefined || output.status !== "prepared") return;
    try {
      // 与原 commitAndFinish 同一提交边界：先复核本 run 已用动作仍可用，再做宿主事务。
      active.assertActions?.();
      const accepted = await this.trace(
        active,
        "agent.commit",
        {
          stage: "run",
          details: { outputCount: 1, early: true, targetId: output.targetId, ordinal },
        },
        async () => input.commitOutput?.(output, active.runId, { ordinal, at: this.now() }),
      );
      if (accepted === false) {
        // 宿主拒绝＝未提交：标 blocked，终态结算不再把它当 prepared 重新提交（不绕过拒绝）。
        output.status = "blocked";
        output.code ??= "AGENT_EARLY_COMMIT_REJECTED";
        return;
      }
      committedTargets.set(output.targetId, output);
    } catch (error) {
      commitFailedOutputs.add(output.outputId);
      throw error;
    }
  }

  /**
   * 终态结算输出始终包含已早提交目标的原输出，供 run 终态与 wake 结算；
   * 宿主据自身已提交记录跳过重复 outbox。
   */
  private mergeCommitted(
    outputs: readonly PreparedOutput[],
    committedTargets: Map<string, PreparedOutput>,
  ): PreparedOutput[] {
    if (committedTargets.size === 0) return [...outputs];
    const present = new Set(outputs.map((output) => output.targetId));
    return [
      ...outputs,
      ...[...committedTargets.values()].filter((output) => !present.has(output.targetId)),
    ];
  }

  private async commitAndFinish(
    active: Running,

    input: ConversationInput,
    outputs: readonly PreparedOutput[],
    status: "completed" | "no_output",
    payload: RunEventPayload,
  ): Promise<void> {
    active.assertActions?.();
    const committed = await this.trace(
      active,
      "agent.commit",
      { stage: "run", details: { outputCount: outputs.length, terminal: status } },
      async (scope) => {
        const event = await input.commitOutputs?.(outputs, active.runId, {
          status,
          event: payload,
          at: this.now(),
        });
        scope?.update({ status });
        return event;
      },
    );
    for (const output of outputs) {
      const scope = startAgentTrace(this.telemetry, "agent.output", () => ({
        channel: active.channel,
        stage: "delivery",
        outputId: output.outputId,
        sources: output.sources,
        details: {
          targetId: output.targetId,
          outputStatus: output.status,
          textCharacters: output.text?.length ?? 0,
          attachmentCount: output.stickerIds?.length ?? 0,
        },
      }));
      scope?.end(
        output.status === "failed"
          ? "failed"
          : output.status === "blocked"
            ? "skipped"
            : "completed",
        output.code ? traceErrorCode({ code: output.code }) : undefined,
      );
    }
    // A durable host can atomically finishRun with intentions/wake acknowledgement and return
    // its committed terminal event. Publication is after the host transaction in either case.
    if (committed) await active.onEvent?.(committed);
    else await this.finish(active, status, payload);
  }
  private async fail(
    active: Running,
    error: unknown,
    commit?: ConversationInput["commitFailure"],
  ): Promise<void> {
    // Event consumers may disconnect after the terminal write. Do not mutate a completed run.
    if (this.repository.getRun(active.runId)?.endedAt) return;
    const cancelled = active.callerSignal?.aborted === true;
    const code = errorCode(active.signal.aborted ? active.signal.reason : error);
    const terminal = {
      status: cancelled ? ("cancelled" as const) : ("failed" as const),
      event: cancelled ? { type: "cancelled" as const } : { type: "failed" as const, code },
      at: this.now(),
      errorCode: code,
    };
    // 运行级失败也留一行：状态、错误名与消息。无码失败（AGENT_FAILED）从此不再是死胡同——
    // 记录里仍然只有码，但控制台能直接看到原因。
    if (!cancelled && code === "AGENT_FAILED")
      console.warn(`[agent] 运行失败（无错误码）：${describeFailure(error)}`);
    const committed = await commit?.(error, active.runId, terminal);
    const event =
      committed ??
      this.repository.finishRun(active.runId, terminal.status, terminal.event, terminal.at, {
        errorCode: code,
        conversationId: active.conversationId,
      });
    try {
      await active.onEvent?.(event);
    } catch {
      /* Original inference/stream failure remains the cause. */
    }
  }
}

/** 一行、截断的诊断摘要：模型输出与错误消息都可能很长，日志里只留一行。 */
function summariseModelText(text: string | null | undefined): string {
  if (text === null || text === undefined || text === "") return "(空)";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}…` : oneLine;
}

function describeFailure(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return `${name}: ${summariseModelText(message)}`;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
  }
  // 不猜消息里的码：记录与 span 里只许出现抛出点自己设的 `.code`，否则失败文本会顺着
  // "看着像码"的消息漏进诊断面（`runtime-peripheral-observability` 钉着这条边界）。
  // 严格解析读不出模型输出：这是"输出不符合要求"，不是"决策不合法"——决策那条路会把失败
  // 包成带码的 AgentRuntimeError，走到这里的其实是叶子任务自己的解析器（判断、整理等）。
  // JSON 读不出来是 SyntaxError、形状不对是 ZodError，两者是同一件事。
  return error instanceof SyntaxError || error instanceof z.ZodError
    ? "AGENT_OUTPUT_INVALID"
    : "AGENT_FAILED";
}

function decisionMetadata(value: unknown): unknown {
  const decision = AgentDecisionSchema.parse(value);
  if (decision.kind === "invoke")
    return { kind: decision.kind, names: decision.calls.map((call) => call.name).join(",") };
  if (decision.kind === "final")
    return {
      kind: decision.kind,
      outputs: decision.outputs.map(({ kind, targetId }) => ({ kind, targetId })),
    };
  return { kind: decision.kind };
}

export type LeafAgentRuntime = Pick<AgentRuntime, "completeLeaf" | "completeVisionLeaf">;
export function createAgentRuntime(options: {
  gateway?: TextModelGateway;
  vision?: VisionClient;
  repository: AgentRunRepository;
  actions?: readonly BuiltInAction[];
  actionExecutor?: ActionExecutor;
  contextEngine?: ContextEngine;
  telemetry?: RuntimeTelemetry;
  researchEnabled?: () => boolean;
  researchLimits?: () => ResearchLimits;
  noProgressLimit?: () => number;
  /** 叶子运行的中央边界（本群能力停用）；由 Runtime 装配，测试缺省不传。 */
  assertLeaf?: (owner: RunOwner, specId: string) => void | (() => void);
  codeMode?: {
    runner: CodeRunner;
    enabled(): boolean;
    allowsModel(model: string | undefined): boolean;
    limits?: () => Partial<CodeRunnerLimits>;
  };
  /** 进程级模型调用并发（见 `createModelPort`）；省略＝不限，与旧行为一致。 */
  modelCallConcurrency?: number | (() => number);
  /** 每个服务单独的并发上限；省略＝不限（沿用旧行为）。 */
  providerConcurrency?: number | (() => number);
  /** 模型名 → 服务键；省略＝全部模型共用一个名额池。 */
  providerKey?: (model: string | undefined) => string;
  systemRetryPolicy?: () => { maxAttempts: number; retryDelayMs: number };
  /**
   * 配置保存后的 drain 通知接线（宿主注入 `permissions.subscribe`）：保存成功即触发一次，
   * 让准入重判等待队列；缺省＝无订阅（测试装配）。
   */
  onPolicyChange?: (listener: () => void) => () => void;
}): AgentRuntime {
  return new AgentRuntime({ ...options, model: createModelPort(options) });
}
