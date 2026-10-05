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
  OutputSummary,
  ProtectedModelOutput,
  RunEvent,
  RunEventPayload,
  RunOwner,
  RunStatus,
} from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { ExecutionMode } from "../../shared/contracts/permissions";
import type { AgentRunRepository } from "../db/agent-run-repository";
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
import { unicodeStrip } from "../services/text";
import { ActionExecutor } from "./action-executor";
import type { AgentGenerationConfig, AgentSpec, LeafAgentSpec } from "./agent-specs";
import type { ActionContext, BuiltInAction } from "./built-in-actions";
import { createCodeMode } from "./code-mode";
import type { CodeRunner, CodeRunnerLimits } from "./code-runner";
import {
  type ActionObservation,
  ContextEngine,
  type ConversationContextSource,
  inputUnits,
  type RenderedContext,
  textMessage,
  uniqueSources,
  visionCostOf,
} from "./context-engine";
import type { ImageByteResolver } from "./image-byte-resolver";
import {
  createModelPort,
  type ModelPort,
  type ModelRequest,
  type ModelResolvedPrepareInput,
  type ModelResolvedPrepareOutput,
  type TextModelGateway,
  textMessages,
} from "./model-port";
import { createResearchAction, type ResearchLimits } from "./research-action";
import { createToolCatalog, type ToolCatalog } from "./tool-catalog";

export interface LeafInput {
  messages: ChatMessage[];
  owner: RunOwner;
  signal?: AbortSignal;
  sources?: readonly SourceRef[];
  /** 与父 run 共用同一本账（可选）：叶子花的钱算进整棵树。 */
  usage?: RunUsage;
  budget?: RunBudget;
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
  /** 每次实际发送前的宿主复验（fix1）；抛错＝该次尝试不发出。 */
  assertPreparedCurrent?: (input: { readonly model: string }) => void;
}
export interface PreparedOutput extends OutputSummary {
  text?: string;
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
}
export interface ConversationInput {
  owner: RunOwner;
  context: ConversationContextSource;
  authorizedTargets: readonly string[];
  outputMode: "stream" | "buffered";
  signal?: AbortSignal;
  conversationId?: string;
  requestId?: string;
  onEvent?: (event: RunEvent) => void | Promise<void>;
  /** 整棵任务树共用的一本账与它的上限（0.4.0 P3）；省略＝只记这个 run 自己的账。 */
  usage?: RunUsage;
  budget?: RunBudget;
  /** Host-bound scope/budget handlers, never derived from model arguments. */
  actions?: readonly BuiltInAction[];
  executionMode?: ExecutionMode;
  onContext?: (
    context: RenderedContext,
    input: { runId: string; phase: "next" | "generate" },
  ) => void | Promise<void>;
  /** Called before the first output delta, e.g. reserve the Web assistant message ID. */
  prepareOutput?: (
    draft: OutputDraft,
    ordinal: number,
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
   * T11 B：主 run 发送边界的图片解析器。可信宿主在本 run/owner 下登记已验证资产；
   * 生成步把它连同真实 runId/owner 传给端口（native 图 wire 只在发送边界解析字节）。
   * 缺省 undefined ＝ 无自动图（行为同 A）。
   */
  imageResolver?: ImageByteResolver;
  /**
   * 规格 §10：本 run 存在待分类 unknown 图时，决策同次响应走内部 envelope schema；
   * `parse` 由可信宿主提供（白名单校验＋同次分类消费），返回本体 decision 对象。
   * 缺省＝沿用 AGENT_DECISION_JSON_SCHEMA 原路径（text-only 行为逐字不变）。
   */
  /**
   * 规格 §10：宿主按**当前投影**（每步 re-observe 后可能变化）决定本步决策是否走同次
   * 分类 envelope——每次决策模型调用前现取；返回 undefined＝该步走原 schema。
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
   * 每次真正发送前的可信宿主复验（T10 fix1）：schema/tools 受控重试各算一次实际发送，
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

interface Running {
  runId: string;
  usage: RunUsage;
  budget?: RunBudget;
  spec: LeafAgentSpec;
  signal: AbortSignal;
  callerSignal?: AbortSignal;
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
    signal: AbortSignal;
  }>();
  private readonly contextEngine: ContextEngine;
  private readonly executor: ActionExecutor;
  private readonly actions: ToolCatalog;
  constructor(
    private readonly options: {
      model: ModelPort;
      repository: AgentRunRepository;
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
        invoke: async (capture, onModelResolved) => {
          const raw = await this.options.model.complete({
            messages,
            model: spec.model,
            temperature: spec.temperature,
            maxTokens: spec.maxTokens,
            responseSchema: spec.responseSchema,
            signal: active.signal,
            onModelResolved,
            onResponseText: capture,
          });
          capture(raw, true);
          await input.validate?.(raw, { resolvedModel: active.resolvedModel ?? "" });
          return raw;
        },
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
            invoke: async (capture, onModelResolved) => {
              const raw = await this.options.model.complete({
                messages,
                model: spec.model,
                temperature: spec.temperature,
                maxTokens: spec.maxTokens,
                responseSchema: spec.responseSchema,
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
                signal: active.signal,
                onModelResolved,
                onResponseText: capture,
              });
              capture(raw, true);
              await input.validate?.(raw, { resolvedModel: active.resolvedModel ?? "" });
              return raw;
            },
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
        invoke: async (capture) => {
          const raw = await this.options.model.completeMultimodal({
            systemPrompt: spec.instructions,
            temperature: spec.temperature,
            maxTokens: spec.maxTokens,
            model: input.model,
            prompt: input.prompt,
            images: input.images,
            responseSchema: spec.responseSchema,
            signal: active.signal,
          });
          capture(raw, true);
          await input.validate?.(raw);
          return raw;
        },
      };
    });
  }

  private async completeLeafTask(
    active: Running,
    phase: "leaf" | "vision",
    input: { owner: RunOwner; sources?: readonly SourceRef[] },
    prepare: () => {
      messages: ModelMessage[];
      invoke: (
        capture: (text: string, complete?: boolean) => void,
        onModelResolved: (model: string) => void,
      ) => Promise<string>;
    },
  ): Promise<string> {
    try {
      await this.emit(active, { type: "started" });
      this.repository.setStatus(active.runId, "generating", this.now());
      // 模型调用前查一次并冻结当前纪元；返回后再查当前状态与冻结纪元，且必须夹在这一步落盘为
      // 完成之前——飞行期间停用（哪怕随后恢复）已产出的叶子结果不得发布，该步按失败落盘，运行失败。
      const checkpoint = this.options.assertLeaf?.(input.owner, active.spec.id);
      const { messages, invoke } = prepare();
      const guarded = async (
        capture: (text: string, complete?: boolean) => void,
        onModelResolved: (model: string) => void,
      ) => {
        const value = await invoke(capture, onModelResolved);
        this.options.assertLeaf?.(input.owner, active.spec.id);
        if (typeof checkpoint === "function") checkpoint();
        return value;
      };
      const value = await this.step(active, phase, messages, input.sources ?? [], guarded);
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

  private async runConversation(
    active: Running,
    spec: AgentSpec,
    input: ConversationInput,
  ): Promise<ConversationRunResult> {
    const originalActions = spec.availableActions;
    let releaseActions: readonly BuiltInAction[] = [];
    try {
      const observations: ActionObservation[] = [];
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
      if (mode === "direct" && this.options.researchEnabled?.())
        extensions.push(
          createResearchAction({
            runtime: this,
            executor: this.executor,
            spec,
            input,
            actions: baseActions,
            limits: this.options.researchLimits?.(),
          }),
        );
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
      const actionContext: ActionContext = {
        owner: input.owner,
        signal: active.signal,
        runId: active.runId,
        requestId: input.requestId,
      };
      const usedActions = new Set<BuiltInAction>();
      active.assertActions = () => {
        for (const action of usedActions) this.executor.assert(action, actionContext, mode);
      };
      input.context.bindRun?.(actionContext);
      await this.emit(active, {
        type: "started",
        ...(input.requestId ? { requestId: input.requestId } : {}),
      });
      for (;;) {
        active.assertActions();
        this.checkStepBudget(active, spec);
        this.repository.setStatus(active.runId, "deciding", this.now());
        const availableActions = descriptors.filter((descriptor) => {
          const action = actions.resolve(descriptor.name);
          return action && this.executor.allowed(action, actionContext, mode);
        });
        input.context.configureActions?.(availableActions);
        // 规格 §10：本步决策的实际响应 schema 选择——投影（read）完成后现取并冻结一次，
        // 系统声明（render）与实际请求（requestFor）、响应解析共用同一个选择。
        let decisionEnvelope: ReturnType<NonNullable<ConversationInput["decisionEnvelope"]>>;
        const context = await this.trace(
          active,
          "agent.context",
          {
            stage: "context",
            details: { phase: "next", observationCount: observations.length },
          },
          async (scope) => {
            const material = await input.context.read({ signal: active.signal, observations });
            active.signal.throwIfAborted();
            decisionEnvelope = input.decisionEnvelope?.();
            const rendered = this.contextEngine.render(
              { ...spec, availableActions },
              material,
              observations,
              input.authorizedTargets,
              input.outputMode,
              decisionEnvelope?.responseSchema,
            );
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
            await input.onContext?.(rendered, { runId: active.runId, phase: "next" });
            return rendered;
          },
        );
        const decision = await this.step(
          active,
          "next",
          context.messages,
          context.sources,
          async (capture, onModelResolved) => {
            let resolved = spec.model ?? this.options.model.defaultModel ?? "?";
            // T10/§9 决策相发送（真实 HTTP 服务首拒 unsupported → 宿主标 fallback 重备后
            // 同相同 complete 重试恰一次；非 unsupported 原样抛）。requestFor(messages) 每次以
            // 当前 messages 组请求；prepare/schema/tools 重试共用同一次钩子结果与 used。
            const requestFor = (phaseMessages: readonly ModelMessage[]): ModelRequest => ({
              messages: phaseMessages,
              model: spec.model,
              temperature: spec.temperature,
              maxTokens: spec.maxTokens ?? spec.limits.outputTokens,
              responseSchema: decisionEnvelope?.responseSchema ?? AGENT_DECISION_JSON_SCHEMA,
              runId: active.runId,
              owner: input.owner,
              ...(input.imageResolver === undefined ? {} : { imageResolver: input.imageResolver }),
              // 已广告的动作同时以原生 tools 声明（issue #10）：模型用它表达 invoke，正文只剩
              // final/none。是否真的发送由网关决定——外部路由发，本地服务保持冻结的 JSON 决策。
              tools: availableActions.map((action) => ({
                name: action.name,
                description: action.description,
                parameters: action.parameters,
              })),
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
              signal: active.signal,
              onModelResolved: (model) => {
                resolved = model;
                onModelResolved(model);
              },
              onResponseText: capture,
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
        );
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
          )
            continue;
          active.signal.throwIfAborted();
          await this.commitAndFinish(active, input, [], "no_output", { type: "no_output" });
          return { runId: active.runId, status: "no_output", outputs: [] };
        }
        if (decision.kind === "invoke") {
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
              const values = await this.executor.executeBatch(
                planned.map((entry) => ({ action: entry.action, arguments: entry.call.arguments })),
                { ...actionContext, sources: context.sources },
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
            const observation = {
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
        )
          continue;
        active.signal.throwIfAborted();
        this.repository.setStatus(active.runId, "generating", this.now());
        const outputs: PreparedOutput[] = [];
        for (const [ordinal, draft] of decision.outputs.entries()) {
          active.signal.throwIfAborted();
          if (!input.authorizedTargets.includes(draft.targetId)) {
            outputs.push({
              outputId: randomUUID(),
              targetId: draft.targetId,
              status: "blocked",
              code: "AGENT_TARGET_UNAUTHORIZED",
            });
            continue;
          }
          let outputId: string = randomUUID();
          try {
            const reservation = await input.prepareOutput?.(draft, ordinal);
            if (reservation && "blocked" in reservation) {
              outputs.push({
                outputId,
                targetId: draft.targetId,
                status: "blocked",
                code: reservation.code,
              });
              continue;
            }
            if (reservation) outputId = reservation.outputId;
            if (draft.kind === "inline") {
              outputs.push({
                outputId,
                targetId: draft.targetId,
                status: "prepared",
                text: draft.text,
                stickerIds: draft.stickerIds,
              });
              continue;
            }
            this.checkStepBudget(active, spec);
            const { generation, generationContext, messages, generationSpec, structured } =
              await this.trace(
                active,
                "agent.context",
                {
                  stage: "context",
                  outputId,
                  details: { phase: "generate" },
                },
                async (scope) => {
                  const prepared = await input.prepareGeneration?.(draft, {
                    context,
                    outputId,
                    signal: active.signal,
                  });
                  const generation = { ...spec.generation, ...prepared };
                  // 规格 §10：是否走同次封装在系统声明渲染前冻结——renderOutput 的输出协议
                  // 声明与 structured complete 的实际 responseSchema 用同一个选择。
                  const structured =
                    input.outputMode === "buffered" ? generation.responseEnvelope : undefined;
                  const generationContext = prepared?.context ?? context;
                  const messages = this.contextEngine.renderOutput(
                    { ...spec, generation },
                    generationContext,
                    draft,
                    structured?.responseSchema,
                  );
                  await input.onContext?.(
                    { ...generationContext, messages, units: inputUnits(messages) },
                    { runId: active.runId, phase: "generate" },
                  );
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
                  return { generation, generationContext, messages, generationSpec, structured };
                },
              );
            let text = "";
            // 规格 §10：buffered 且宿主声明"本次生成需要同次机器可读封装"时，走一次结构化
            // complete 取 envelope，剥离后正文照常提交——不新增第二次模型调用、不落 auxiliary
            // 阶段；缺省（未声明）与 stream 模式逐字保持原 streamText 行为。
            await this.step(
              active,
              "generate",
              messages,
              generationContext.sources,
              async (capture, onModelResolved) => {
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
                    runId: active.runId,
                    owner: input.owner,
                    ...(input.imageResolver === undefined
                      ? {}
                      : { imageResolver: input.imageResolver }),
                    ...(input.prepareWithResolved === undefined
                      ? {}
                      : {
                          prepareWithResolved: async (hook: ModelResolvedPrepareInput) =>
                            (await input.prepareWithResolved?.({
                              ...hook,
                              phase: "generate",
                            })) ?? {},
                        }),
                    ...(input.assertPreparedCurrent === undefined
                      ? {}
                      : { assertPreparedCurrent: input.assertPreparedCurrent }),
                    signal: active.signal,
                    onModelResolved,
                    onResponseText: capture,
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
                      input.onPhaseMediaUnsupported === undefined
                    )
                      throw error;
                    const retry = await input.onPhaseMediaUnsupported({
                      phase: "generate",
                      model: active.resolvedModel ?? generationSpec.model ?? "",
                      messages,
                      signal: active.signal,
                    });
                    if (retry === null) throw error;
                    raw = await this.options.model.complete(requestFor(retry.messages));
                  }
                  capture(raw, true);
                  text = structured.parse(raw, { resolvedModel: active.resolvedModel ?? "" }).text;
                  if (!unicodeStrip(text) && !generation.allowEmpty)
                    throw new AgentRuntimeError(
                      "MODEL_EMPTY_RESPONSE",
                      "Model returned an empty response",
                    );
                  active.signal.throwIfAborted();
                  // §8.1：生成相调用成功返回 → 通知宿主记账（native proof）。
                  input.onModelCallConsumed?.({ phase: "generate" });
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
                  runId: active.runId,
                  owner: input.owner,
                  ...(input.imageResolver === undefined
                    ? {}
                    : { imageResolver: input.imageResolver }),
                  ...(input.prepareWithResolved === undefined
                    ? {}
                    : {
                        prepareWithResolved: async (hook: ModelResolvedPrepareInput) =>
                          (await input.prepareWithResolved?.({
                            ...hook,
                            phase: "generate",
                          })) ?? {},
                      }),
                  ...(input.assertPreparedCurrent === undefined
                    ? {}
                    : { assertPreparedCurrent: input.assertPreparedCurrent }),
                  signal: active.signal,
                  onModelResolved,
                });
                let unsupportedRetry = input.onPhaseMediaUnsupported !== undefined;
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
                  const retry = await input.onPhaseMediaUnsupported?.({
                    phase: "generate",
                    model: active.resolvedModel ?? generationSpec.model ?? "",
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
                if (!unicodeStrip(text) && !generation.allowEmpty)
                  throw new AgentRuntimeError(
                    "MODEL_EMPTY_RESPONSE",
                    "Model returned an empty response",
                  );
                active.signal.throwIfAborted();
                // §8.1：stream 生成相在完整流结束、abort/empty 检查通过后记账恰一次；
                // 流中异常、部分 delta 后失败/abort/empty 不允许时不通知。
                input.onModelCallConsumed?.({ phase: "generate" });
                return text;
              },
              generationSpec,
              outputId,
            );
            outputs.push({
              outputId,
              targetId: draft.targetId,
              status: "prepared",
              text,
              stickerIds: draft.stickerIds,
            });
          } catch (error) {
            if (
              active.signal.aborted ||
              input.outputMode === "stream" ||
              (error instanceof AgentRuntimeError && error.code === "AGENT_STEP_LIMIT")
            )
              throw error;
            outputs.push({
              outputId,
              targetId: draft.targetId,
              status: "failed",
              code: errorCode(error),
            });
          }
        }
        active.signal.throwIfAborted();
        const reconsidered = await this.trace(
          active,
          "agent.checkpoint",
          { stage: "context", details: { phase: "reconsider", outputCount: outputs.length } },
          async (scope) => {
            const result = await input.reconsider?.(outputs, active.signal);
            scope?.update({ details: { reconsidered: result ?? false } });
            return result;
          },
        );
        if (reconsidered) {
          if (input.outputMode === "stream")
            throw new AgentRuntimeError(
              "AGENT_STREAM_RECONSIDERED",
              "Already streamed output cannot be replaced",
            );
          if (reconsidered === "no_output") {
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

  private start(
    spec: LeafAgentSpec,
    input: {
      owner: RunOwner;
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
    return {
      runId,
      usage: parent?.usage ?? input.usage ?? { calls: 0, inputUnits: 0 },
      budget: parent?.budget ?? input.budget,
      spec,
      signal,
      trace,
      channel,
      callerSignal,
      stepNo: 0,
      conversationId: input.conversationId,
      onEvent: input.onEvent,
      dispose: () => clearTimeout(timer),
    };
  }

  private async step<T>(
    active: Running,
    phase: AgentStepSnapshot["phase"],
    messages: ModelMessage[],
    sources: readonly SourceRef[],
    execute: (
      capture: (text: string, complete?: boolean) => void,
      onModelResolved: (model: string) => void,
    ) => Promise<T>,
    stepSpec: LeafAgentSpec = active.spec,
    outputId?: string,
  ): Promise<T> {
    active.signal.throwIfAborted();
    active.assertActions?.();
    const units = inputUnits(messages);
    const limit = stepSpec.limits?.inputUnits;
    if (limit !== undefined && units > limit) {
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
    const capture = (text: string, complete = false) => {
      output = { text, complete, format: phase === "next" ? "json" : "text" };
    };
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
          const result = await execute(capture, (model) => {
            // resolved 真源单点：先写 active（同闭包供步内可信消费读取），再落库。
            active.resolvedModel = model;
            this.repository.resolveStepModel(stepId, model);
            scope?.update({ model, details: { modelResolved: true } });
          });
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
            output,
          });
          return result;
        } catch (error) {
          const failed = active.signal.aborted ? active.signal.reason : error;
          const code = errorCode(failed);
          this.repository.finishStep(
            stepId,
            active.callerSignal?.aborted ? "cancelled" : "failed",
            this.now(),
            { errorCode: code, output },
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
      { usage: active.usage, budget: active.budget, signal: active.signal },
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
    const event = this.repository.finishRun(active.runId, status, payload, this.now(), {
      conversationId: active.conversationId,
    });
    await active.onEvent?.(event);
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
}): AgentRuntime {
  return new AgentRuntime({ ...options, model: createModelPort(options) });
}
