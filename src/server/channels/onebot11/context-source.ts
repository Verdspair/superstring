import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { RuntimeConfig } from "../../../shared/contracts";
import type { ModelMessage, RunOwner } from "../../../shared/contracts/agent-run";
import { MODEL_LAYER_ERROR_CODES } from "../../../shared/contracts/errors";
import type { SourceRef } from "../../../shared/contracts/evidence";
import { qqEffectiveReplyPrompt } from "../../../shared/contracts/qq";
import type {
  AgentRuntime,
  PreparedGeneration,
  RunBudget,
  RunUsage,
} from "../../agent/agent-runtime";
import type { AgentSpec, OutputDraft } from "../../agent/agent-specs";
import {
  type ActionContext,
  type BuiltInAction,
  createBuiltInActions,
  type EvidenceQueryModule,
} from "../../agent/built-in-actions";
import { assertContextSources } from "../../agent/context-access";
import {
  type ActionObservation,
  ContextEngine,
  type ContextMaterial,
  inputUnits,
  type RenderedContext,
  textMessage,
  uniqueSources,
} from "../../agent/context-engine";
import type { CompressionRecord } from "../../agent/conversation-compression";
import { ReservationLedger } from "../../agent/reservation-ledger";
import { readMemoryCandidate } from "../../db/context-repository";
import type { ConversationEventRepository } from "../../db/conversation-event-repository";
import type { OutboundIntentRepository } from "../../db/outbound-intent-repository";
import { qqMemberLabels } from "../../db/qq-member-repository";
import {
  conversationMessagesForBackfill,
  conversationMessagesSince,
} from "../../db/qq-observation-repository";
import {
  type QqSchemeRow,
  schemeCompression,
  schemeContext,
  schemeOutputReserve,
  schemePrompts,
  schemeReply,
} from "../../db/qq-scheme-repository";
import { ownSpeechSince } from "../../db/qq-speech-repository";
import {
  type QqConversationSummary,
  type QqSummaryPackage,
  readQqConversationSummary,
} from "../../db/qq-summary-repository";
import { DEFAULT_USER_ID, type Orm } from "../../db/repositories";
import { AppError, fail } from "../../errors";
import type { ChatMessage, ModelGateway } from "../../llm/model-gateway";
import {
  createSqliteQueryFactory,
  type ModuleQueryFactory,
  type ModuleSourceResolver,
} from "../../modules/composition";
import {
  type EvidenceQueryPage,
  evidenceQueryPage,
  type KnowledgeModule,
  type MemoryModule,
} from "../../modules/contracts";
import {
  conversationEvidenceSourceAccess,
  createBotConversationEvidence,
} from "../../modules/conversation-evidence";
import { contextDumps, estimateMessages } from "../../modules/memory-query";
import { qqMemoryScopeKeyset } from "../../services/memory-scope";
import type { QqBinding, QqTaskSnapshot } from "../../services/qq-binding-contract";
import {
  type QqContextLimits,
  type QqContextMessage,
  type QqContextSelection,
  type QqContextTier,
  qqBuildTimeline,
  qqContextLimits,
  qqSelectContext,
} from "../../services/qq-context-contract";
import { qqJudgementQuestion } from "../../services/qq-judgement-material";
import {
  buildQqPrompt,
  QQ_JUDGEMENT_RESPONSE_SCHEMA,
  type QqPromptInput,
  type QqPromptMaterial,
  qqPromptMessages,
  qqSpeakerLabel,
} from "../../services/qq-prompt-contract";
import type { QqSpeechKind } from "../../services/qq-speaking-contract";
import { compileSystemPrompt } from "../../services/runtime-config";
import { estimateTokens } from "../../services/token-estimate";
import { type BotCompressionJob, createBotCompressionJob } from "./background-compression";
import { failureCode } from "./failure-code";

/** 观测信封里"动作自己的内容"（名字/参数/返回值）的余量；sources 那部分由 envelopeFloor 实量。 */
const ACTION_ENVELOPE_ALLOWANCE = 512;

export interface BotContextTarget {
  id: string;
  speakerId: string | null;
}

export interface BotContextSourceOptions {
  db: Database;
  orm: Orm;
  gateway: Pick<ModelGateway, "loadedContextCapacity">;
  agentRuntime: AgentRuntime;
  modules?: ModuleQueryFactory;
  resolveSource?: ModuleSourceResolver;
  journal: ConversationEventRepository;
  outbox: OutboundIntentRepository;
  conversationId: string;
  binding: QqBinding;
  snapshot: QqTaskSnapshot;
  scheme: QqSchemeRow;
  runtime: RuntimeConfig;
  spec: AgentSpec;
  path: QqSpeechKind;
  /** Original ingress that scheduled this activation; re-observation does not relabel it as latest. */
  trigger?: { sourceId: string; seq: number; participantId: string | null };
  /** Private direct uses reply; shared judgement keeps its separately configured window. */
  decisionTier: QqContextTier;
  targets: () => readonly BotContextTarget[];
  /** Lease, binding/owner/config snapshots remain host responsibilities. */
  assertCurrent: () => void;
  assertBackgroundCurrent?: () => void;
  usage?: RunUsage;
  budget?: RunBudget;
  now?: () => string;
  onRead?: (observedSeq: number) => void;
  onDiagnostic?: (event: {
    kind: "supplemental_summary_failed" | "supplemental_retrieval_failed";
    code: string;
    name?: string;
  }) => void;
}
interface View {
  material: ContextMaterial;
  selection: QqContextSelection;
  limit: number;
}

/** One authorized context owner with explicit decision/reply projections for every Bot topology. */
export class BotContextSource {
  readonly actions: BuiltInAction[];
  private readonly views = new Map<QqContextTier, View>();
  private readonly capacities = new Map<string, number>();
  private readonly engine = new ContextEngine();
  private readonly owner: RunOwner;
  private readonly memory: MemoryModule;
  private readonly knowledge: KnowledgeModule;
  private compressionJob?: BotCompressionJob;
  private observations: readonly ActionObservation[] = [];
  /** 同批在飞动作各自的投影增量（token→相对基线 cost(observations) 的 units；按档取最大值）。 */
  private readonly reservations = new ReservationLedger();
  private sequence = 0;
  private pendingPlan?: { value: unknown; sources: SourceRef[] };
  private retrievalFailures: { name: string; code: string; observedSeq: number }[] = [];
  constructor(private readonly options: BotContextSourceOptions) {
    const o = options;
    this.owner = {
      kind: "qq_binding",
      id: o.binding.id,
      userId: DEFAULT_USER_ID,
      agentId: o.binding.agentId,
    };
    const modules = (o.modules ?? createSqliteQueryFactory(o))({
      runtime: o.runtime,
      assertSources: (sources) => this.assertSources(sources),
    });
    this.memory = modules.memory;
    this.knowledge = modules.knowledge;
    const actions: Record<string, EvidenceQueryModule> = {};
    if (o.runtime.p5_config.retrieval_mode !== "off") {
      const memory = this.memory;
      const read = memory.read;
      actions.memory = {
        query: (input, action) => this.query("memory.query", input, action),
        ...(read
          ? {
              read: async (
                input: Parameters<NonNullable<EvidenceQueryModule["read"]>>[0],
                action: ActionContext,
              ) => {
                const sources = uniqueSources([
                  ...this.sources,
                  ...(action.sources ?? []),
                  ...input.evidence.sources,
                ]);
                action.signal.throwIfAborted();
                this.assertCurrent();
                this.assertSources(sources);
                const page = await read.call(memory, {
                  ...input,
                  agentId: o.binding.agentId,
                  scopes: qqMemoryScopeKeyset(o.snapshot.access).read,
                  owner: this.owner,
                  signal: action.signal,
                  sources,
                });
                action.signal.throwIfAborted();
                this.assertCurrent();
                this.assertSources(sources);
                return page;
              },
            }
          : {}),
      };
    }
    if (o.runtime.knowledge_read?.config.enabled !== false) {
      const knowledge = this.knowledge;
      const read = knowledge.read;
      actions.knowledge = {
        query: (input, action) => this.query("knowledge.query", input, action),
        ...(read
          ? {
              read: async (
                input: Parameters<NonNullable<EvidenceQueryModule["read"]>>[0],
                action: ActionContext,
              ) => {
                const sources = uniqueSources([
                  ...this.sources,
                  ...(action.sources ?? []),
                  ...input.evidence.sources,
                ]);
                action.signal.throwIfAborted();
                this.assertCurrent();
                this.assertSources(sources);
                const page = await read.call(knowledge, {
                  ...input,
                  agentId: o.binding.agentId,
                  owner: this.owner,
                  signal: action.signal,
                  sources,
                });
                action.signal.throwIfAborted();
                this.assertCurrent();
                this.assertSources(sources);
                return page;
              },
            }
          : {}),
      };
    }
    // 已存历史两档都可查；已存摘要仅回复档安装——判断档不读回复档水位包（ADR0019 §8.11：
    // 判断不能借摘要工具旁路）。两者都只读存储，不触发压缩、不推进水位。
    const conversationRow = o.journal.get(o.conversationId);
    if (!conversationRow) fail("CONTEXT_SOURCE_INVALID", "会话已失效");
    const evidence = createBotConversationEvidence({
      db: o.db,
      orm: o.orm,
      agentId: o.binding.agentId,
      conversationId: o.conversationId,
      bindingId: o.binding.id,
      bindingEpoch: conversationRow.bindingEpoch,
      authorityRevision: o.binding.authorityRevision,
      scope: {
        kind: "qq",
        accountId: o.binding.accountId,
        conversationKind: o.binding.kind,
        peerId: o.binding.peerId,
        agentId: o.binding.agentId,
      },
      summaryEnabled: o.decisionTier === "reply",
      assertCurrent: () => this.assertCurrent(),
      assertSources: (sources) => this.assertSources(sources),
      now: () => this.now(),
    });
    actions.history = evidence.history;
    if (evidence.summary) actions.summary = evidence.summary;
    this.actions = createBuiltInActions(actions, {
      assertSources: (sources) => {
        this.assertCurrent();
        this.assertSources(sources);
      },
      fit: (name, arguments_, signal) => this.actionResultFitter(name, arguments_, signal),
      budget: (kind) => this.evidenceBudget(kind),
    });
  }
  takeCompressionJob(): BotCompressionJob | undefined {
    const job = this.compressionJob;
    this.compressionJob = undefined;
    return job;
  }
  get observedSeq(): number {
    return this.sequence;
  }
  get selection(): QqContextSelection | undefined {
    return (
      this.views.get("reply")?.selection ?? this.views.get(this.options.decisionTier)?.selection
    );
  }
  get sources(): SourceRef[] {
    return uniqueSources(
      [...this.views.values()]
        .flatMap((view) => view.material.sources ?? [])
        .concat(
          this.observations.flatMap((observation) => observation.sources),
          this.pendingPlan?.sources ?? [],
        ),
    );
  }
  /** Host-owned, source-bound prior work, never a system instruction or permission to send. */
  setPendingPlan(value: unknown, sources: readonly SourceRef[]): void {
    this.assertSources(sources);
    this.pendingPlan = { value: structuredClone(value), sources: uniqueSources(sources) };
    this.views.clear();
    this.reservations.clear();
  }
  private withPendingPlan(material: ContextMaterial): ContextMaterial {
    if (!this.pendingPlan && !this.retrievalFailures.length) return material;
    const pending = [...(material.pending ?? [])];
    if (this.pendingPlan)
      pending.push(
        textMessage(
          "user",
          contextDumps({ kind: "pending_plan", trust: "data_only", value: this.pendingPlan.value }),
        ),
      );
    if (this.retrievalFailures.length)
      pending.push(
        textMessage(
          "user",
          contextDumps({
            kind: "retrieval_status",
            trust: "data_only",
            failures: this.retrievalFailures,
          }),
        ),
      );
    return {
      ...material,
      pending,
      sources: uniqueSources([...(material.sources ?? []), ...(this.pendingPlan?.sources ?? [])]),
    };
  }
  /** Only a newly observed event changes the cached initial material; unchanged model steps reuse it. */
  invalidate(): void {
    this.assertCurrent();
    this.views.clear();
    this.compressionJob = undefined;
    this.reservations.clear();
  }
  configureActions(actions: AgentSpec["availableActions"]): void {
    this.options.spec.availableActions = actions;
  }
  async read(input: {
    signal: AbortSignal;
    observations: readonly ActionObservation[];
  }): Promise<ContextMaterial> {
    this.observations = input.observations;
    // observations 被替换＝上一批的投影已并入基线，旧预留不再代表"在飞结果"。
    this.reservations.clear();
    this.assertCurrent();
    input.signal.throwIfAborted();
    // 观测累到"材料 + 现有观测"顶住上限时重装一次（窗口自动收窄，循环继续），
    // 而不是等第 N 步渲染超上限被判失败；收窗口也救不回来的情形照旧留给运行时。
    if (this.views.size && !this.viewsStillFit() && this.rebuildCouldFit()) this.views.clear();
    if (!this.views.size) {
      const conversation = this.options.journal.get(this.options.conversationId);
      if (!conversation) fail("CONTEXT_SOURCE_INVALID", "会话已失效");
      this.sequence = (
        this.options.db
          .query(
            "SELECT COALESCE(MAX(seq),0) AS seq FROM conversation_events WHERE conversation_id=? AND kind IN ('inbound','media_revision','outbound')",
          )
          .get(conversation.id) as { seq: number }
      ).seq;
    }
    const view = await this.view(this.options.decisionTier, input.signal);
    this.options.spec.limits.inputUnits = view.limit;
    this.options.onRead?.(this.sequence);
    this.assertCurrent();
    return this.withPendingPlan(view.material);
  }
  async prepareGeneration(
    draft: Extract<OutputDraft, { kind: "generate" }>,
    input: { context: RenderedContext; outputId: string; signal: AbortSignal },
  ): Promise<PreparedGeneration> {
    this.assertCurrent();
    const target = this.options.targets().find((target) => target.id === draft.targetId);
    if (!target) fail("CONTEXT_SOURCE_INVALID", "回复目标不再受权");
    const view = await this.view("reply", input.signal);
    const context = this.engine.render(
      this.options.spec,
      this.withPendingPlan(view.material),
      this.observations,
      this.targetIds(),
    );
    // Draft instructions were inferred from the decision view; retain their provenance too.
    context.sources = uniqueSources([...context.sources, ...input.context.sources]);
    return {
      model: this.options.runtime.model_name,
      allowEmpty: true,
      inputUnits: view.limit,
      instructions: this.replyInstructions(view.selection.messages, target),
      context,
    };
  }
  /** A score leaf uses the same phase material/observations; only its trusted output protocol differs. */
  async prepareEvaluation(input: {
    signal: AbortSignal;
    target: BotContextTarget | null;
    /** 这一轮打算说什么（意图的"要点"）：带上去评分，而不是让程序替它想。 */
    intent?: string;
  }): Promise<{
    model: string;
    messages: ChatMessage[];
    sources: SourceRef[];
    inputUnits: number;
    /**
     * **相关状态摘要**（0.4.0 P4 §4.1）：这份评分材料本身（人设、场景、时间线、资料、目标）的哈希，
     * **不含意图**——意图是被判的对象，不是状态。许可绑定它：材料没变＝同一相关状态，材料变了＝
     * 旧许可自动失效。
     */
    stateDigest: string;
  }> {
    input.signal.throwIfAborted();
    this.assertCurrent();
    if (
      input.target &&
      !this.options
        .targets()
        .some(
          (target) => target.id === input.target?.id && target.speakerId === input.target.speakerId,
        )
    )
      fail("CONTEXT_SOURCE_INVALID", "评分目标不再受权");
    const view = await this.view("judgement", input.signal);
    const rendered = this.engine.render(
      this.options.spec,
      this.withPendingPlan(view.material),
      this.observations,
      this.targetIds(),
    );
    const messages = this.evaluationMessages(
      view.material,
      this.observations,
      input.target ?? undefined,
      view.selection.messages,
      input.intent,
    );
    const units =
      estimateMessages(messages as Parameters<typeof estimateMessages>[0]) +
      estimateTokens(contextDumps(QQ_JUDGEMENT_RESPONSE_SCHEMA));
    if (units > view.limit)
      fail("CONTEXT_BUDGET_EXCEEDED", "评分上下文及结构化输出协议超过模型容量");
    this.assertSources(rendered.sources);
    input.signal.throwIfAborted();
    const stateDigest = createHash("sha256")
      .update(
        JSON.stringify([this.options.scheme.revision, input.target?.id ?? null, rendered.messages]),
      )
      .digest("hex");
    return {
      model: this.options.spec.model ?? this.options.runtime.model_name,
      messages,
      sources: rendered.sources,
      inputUnits: view.limit,
      stateDigest,
    };
  }
  private evaluationMessages(
    material: ContextMaterial,
    observations: readonly ActionObservation[],
    target?: BotContextTarget,
    timeline: readonly QqContextMessage[] = [],
    intent?: string,
  ): ChatMessage[] {
    const prompt = this.prompt(timeline, target);
    const systems = qqPromptMessages(
      buildQqPrompt({ ...prompt, tier: "judgement", prompts: schemePrompts(this.options.scheme) }),
    ).filter((message) => message.role === "system");
    const withIntent: ContextMaterial =
      intent === undefined || intent.trim() === ""
        ? material
        : {
            ...material,
            // 意图是**这一轮自己打算说什么**（程序在评分前拿到的东西）：作为资料附在时间线之后，
            // 与其它资料同级——它不是系统指令，也不能提升为系统指令。
            pending: [
              ...(material.pending ?? []),
              textMessage(
                "user",
                `## 本次打算说（草稿意图）
${intent.trim()}`,
              ),
            ],
          };
    const rendered = this.engine.render(
      this.options.spec,
      this.withPendingPlan(withIntent),
      observations,
      this.targetIds(),
    );
    return [
      ...systems,
      ...rendered.messages.slice(1).map((message) => ({
        role: message.role,
        content: message.content
          .map((part) => {
            if (part.kind !== "text")
              throw new Error("Bot scoring expects source descriptions, not image bytes");
            return part.text;
          })
          .join(""),
      })),
    ];
  }
  assertCurrent(): void {
    this.options.assertCurrent();
    this.assertSources(this.sources, false);
  }
  assertSources(sources: readonly SourceRef[], hostCheck = true): void {
    const o = this.options;
    if (hostCheck) o.assertCurrent();
    assertContextSources({
      db: o.db,
      sources,
      owner: this.owner,
      now: this.now(),
      // 会话证据先本地复验（持久存储），外部注入解析器不能把已撤权的引用改判为 available。
      resolveSource: (source, owner, at) =>
        conversationEvidenceSourceAccess(o, source, owner, at) ??
        o.resolveSource?.(source, owner, at),
      memoryRevisions: (ids) =>
        new Map(
          [...new Set(ids)].map((id) => {
            const item = readMemoryCandidate(
              o.orm,
              o.binding.agentId,
              qqMemoryScopeKeyset(o.snapshot.access).read,
              id,
            );
            return [item.id, item.revision];
          }),
        ),
      messages: {
        memory: "已选记忆正文或作用域发生变化",
        other: "上下文来源已变更、过期或撤权",
      },
    });
  }
  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
  private targetIds(): string[] {
    return this.options.targets().map((target) => target.id);
  }
  /** Domain totals belong to the action factory; both QQ projections share that allowance. */
  private evidenceBudget(kind: string): number {
    const runtime = this.options.runtime;
    if (kind === "knowledge") return runtime.knowledge_read?.budget ?? Number.MAX_SAFE_INTEGER;
    // 记忆额度只约束记忆；历史与已存摘要是独立的有界工具，由拟合时的真实上下文剩余额度约束，
    // 不能因为记忆检索关闭（额度 0）被一并禁掉。
    if (kind !== "memory") return Number.MAX_SAFE_INTEGER;
    const { retrieval_mode: mode, retrieval_presets: presets } = runtime.p5_config;
    if (mode === "off") return 0;
    return presets[mode === "full_catalog" || mode === "full_body" ? "broad" : mode].max_tokens;
  }
  private async available(tier: QqContextTier, signal: AbortSignal): Promise<number> {
    const o = this.options;
    const model = tier === "reply" ? o.runtime.model_name : (o.spec.model ?? o.runtime.model_name);
    let capacity = this.capacities.get(model);
    if (capacity === undefined) {
      const actual = await o.gateway.loadedContextCapacity(model, { signal });
      if (actual === null || !Number.isSafeInteger(actual) || actual < 1)
        fail("CONTEXT_CAPACITY_UNKNOWN", "无法确认会话模型容量");
      capacity = actual;
      this.capacities.set(model, capacity);
    }
    const reserve =
      tier === "reply"
        ? schemeOutputReserve(o.scheme).reply_output_reserved
        : schemeOutputReserve(o.scheme).judgement_output_reserved;
    // 装配冗余——可用容量先扣掉这个比例再分配（默认 5%）。
    const headroom = schemeCompression(o.scheme).headroom_ratio;
    return Math.max(1, Math.floor((capacity - reserve) * (1 - headroom)));
  }
  private prompt(
    messages: readonly QqContextMessage[],
    target?: BotContextTarget,
    material?: QqPromptMaterial[],
  ): QqPromptInput {
    const o = this.options;
    const labels = qqMemberLabels(
      o.orm,
      {
        accountId: o.binding.accountId,
        conversationKind: o.binding.kind,
        peerId: o.binding.peerId,
      },
      this.now(),
    );
    return {
      tier: "reply",
      path: o.path,
      persona: compileSystemPrompt(o.runtime),
      prompts: {
        ...schemePrompts(o.scheme),
        // 用户改过就用他改的（存在 prompt_reply），没改过按开关派生——与界面显示同一个函数。
        reply: qqEffectiveReplyPrompt(
          schemePrompts(o.scheme).reply,
          schemeReply(o.scheme).split_by_speaker,
        ),
      },
      timeline: messages,
      nowSeconds: Math.floor(Date.parse(this.now()) / 1000),
      labels,
      attentionMembers: o.binding.attention.members,
      ...(target !== undefined
        ? {
            replyingTo: {
              speakerId: target.speakerId,
              label: qqSpeakerLabel(target.speakerId, labels),
            },
          }
        : {}),
      ...(material ? { material } : {}),
    };
  }
  private replyInstructions(
    messages: readonly QqContextMessage[],
    target?: BotContextTarget,
  ): string {
    return qqPromptMessages(buildQqPrompt(this.prompt(messages, target)))
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
  }
  private cost(
    tier: QqContextTier,
    material: ContextMaterial,
    observations = this.observations,
    timeline = this.views.get(tier)?.selection.messages ?? [],
  ): number {
    const o = this.options;
    const rendered = this.engine.render(
      o.spec,
      this.withPendingPlan(material),
      observations,
      this.targetIds(),
    );
    const targets = o.targets();
    if (tier === "judgement") {
      const schemaUnits = estimateTokens(contextDumps(QQ_JUDGEMENT_RESPONSE_SCHEMA));
      const evaluations = [undefined, ...targets].map(
        (target) =>
          estimateMessages(
            this.evaluationMessages(material, observations, target, timeline) as Parameters<
              typeof estimateMessages
            >[0],
          ) + schemaUnits,
      );
      return Math.max(tier === o.decisionTier ? rendered.units : 0, ...evaluations);
    }
    const generation = targets.map((target) =>
      inputUnits(
        this.engine.renderOutput(
          {
            ...o.spec,
            generation: {
              ...o.spec.generation,
              instructions: this.replyInstructions(timeline, target),
            },
          },
          rendered,
          { kind: "generate", targetId: target.id, instructions: "" },
        ),
      ),
    );
    return Math.max(tier === o.decisionTier ? rendered.units : 0, ...generation, 0);
  }
  // 来源归属留在步骤快照，下一条观测只预留自身信封。
  private envelopeFloor(material: ContextMaterial): number {
    const probe: ActionObservation = {
      id: "00000000-0000-0000-0000-000000000000",
      name: "action.result",
      arguments: {},
      value: {},
      sources: [],
    };
    const units = (observations: readonly ActionObservation[]) =>
      this.engine.render(
        this.options.spec,
        this.withPendingPlan(material),
        observations,
        this.targetIds(),
      ).units;
    return units([...this.observations, probe]) - units(this.observations);
  }
  /**
   * 材料 + 当前观测（外加下一条观测的余量）是否还放得下。放不下就该重装、让窗口自动收窄——
   * 观测是一条条累起来的（模型每调一次动作多一条），材料却只在新事件到达时重装，不重装就会在
   * 第 N 步的渲染上顶穿上限，运行时只能整轮判失败（`AGENT_CONTEXT_LIMIT`）。
   */
  private viewsStillFit(): boolean {
    return [...this.views].every(([tier, view]) =>
      this.fitsWithObservations(tier, view.material, view.limit),
    );
  }
  /** 重装有没有用：连"只剩协议 + 观测"都放不下时，收窗口也救不回来，照旧交给运行时判超限。 */
  private rebuildCouldFit(): boolean {
    return [...this.views].every(([tier, view]) => this.fitsWithObservations(tier, {}, view.limit));
  }
  private fitsWithObservations(
    tier: QqContextTier,
    material: ContextMaterial,
    limit: number,
  ): boolean {
    const used = this.cost(tier, material, this.observations);
    return used + this.envelopeFloor(material) + ACTION_ENVELOPE_ALLOWANCE <= limit;
  }
  private async view(tier: QqContextTier, signal: AbortSignal): Promise<View> {
    const saved = this.views.get(tier);
    if (saved) {
      this.assertCurrent();
      return saved;
    }
    const o = this.options;
    signal.throwIfAborted();
    const nowSeconds = Math.floor(Date.parse(this.now()) / 1000);
    const context = schemeContext(o.scheme);
    const compression = schemeCompression(o.scheme);
    // QQ 的窗口只有一份——条数取绑定助手的「近期保留轮数」（方案里那一栏不再生效），
    // 分钟与预算取回复档；判断档的参数照旧只管"要不要说话"那一步的原文选取。
    const windows = {
      judgement: qqContextLimits(context, "judgement"),
      reply: {
        ...qqContextLimits(context, "reply"),
        messageLimit: o.runtime.p5_config.recent_turns,
      },
    };
    const shared: QqContextLimits = windows.reply;
    const price = tier === "judgement" ? windows.judgement : shared;
    // 一次取够两档都要看的范围（谁的窗口大听谁的），各档的选取再各自收窄。
    const sinceSeconds = Math.max(
      0,
      nowSeconds - Math.max(windows.judgement.windowMinutes, shared.windowMinutes) * 60 - 1,
    );
    const fetchLimit = Math.max(windows.judgement.messageLimit, shared.messageLimit);
    const scope = {
      kind: "qq" as const,
      accountId: o.binding.accountId,
      conversationKind: o.binding.kind,
      peerId: o.binding.peerId,
      agentId: o.binding.agentId,
    };
    const timeline = qqBuildTimeline({
      messages: conversationMessagesSince(o.orm, scope, {
        sinceSeconds,
        limit: fetchLimit,
        includeSources: true,
      }).map(({ eventKey: _key, ...message }) => message),
      ownSpeech: [
        ...ownSpeechSince(o.orm, scope, {
          sinceSeconds,
          limit: fetchLimit,
          includeSources: true,
        }),
        ...o.outbox.partialSpeechSince(o.conversationId, {
          sinceSeconds,
          limit: fetchLimit,
          at: this.now(),
        }),
      ],
    });
    let selection = qqSelectContext({ timeline, limits: price, nowSeconds });
    const cost = (material: ContextMaterial) =>
      this.cost(tier, material, this.observations, selection.messages);
    const timelineMessages = () =>
      qqPromptMessages(buildQqPrompt(this.prompt(selection.messages)))
        .filter((message) => message.role === "user")
        .map((message) => textMessage("user", message.content));
    const triggerMessages = (): ModelMessage[] => {
      const trigger = o.trigger;
      if (!trigger) return [];
      const input = selection.messages.find((message) =>
        message.sources?.some(
          (source) => source.kind === "qq_observation" && source.id === trigger.sourceId,
        ),
      );
      return [
        textMessage(
          "user",
          contextDumps({
            kind: "activation_trigger",
            trust: "data_only",
            value: {
              ...trigger,
              cause: o.path,
              text: input?.text ?? null,
              contentState: input ? "in_selected_context" : "outside_selected_context",
            },
          }),
        ),
      ];
    };
    // 已存水位包独立于近期窗口；长期资料仅经工具观察进入上下文。
    const pending = (items: readonly QqSummaryPackage[]) => {
      const messages: ModelMessage[] = [];
      if (items.length > 0)
        messages.push(
          textMessage(
            "user",
            contextDumps({
              kind: "qq_context_packages",
              trust: "data_only",
              packages: items.map((item) => ({
                fromSeq: item.fromSeq,
                throughSeq: item.throughSeq,
                fromSeconds: item.fromSeconds,
                throughSeconds: item.throughSeconds,
                facts: item.facts,
              })),
            }),
          ),
        );
      messages.push(...timelineMessages(), ...triggerMessages());
      return messages;
    };
    let material: ContextMaterial = {
      pending: pending([]),
      sources: selection.messages.flatMap((message) => message.sources ?? []),
    };
    // 先给下一条动作信封留余量，动作再按实际返回值拟合。
    const ceiling = await this.available(tier, signal);
    const roomFor = (candidate: ContextMaterial, used: number) =>
      ceiling - used - this.envelopeFloor(candidate) - ACTION_ENVELOPE_ALLOWANCE;
    const fitsTarget = (candidate: ContextMaterial) => roomFor(candidate, cost(candidate)) >= 0;
    let fixed = cost(material);
    // 窗口是"配置的预算"，但预算可能比这台模型能装的还大（换模型、调输出预留或冗余
    // 都会这样）。**宁可把最老的原文裁掉，也不打死整轮**：预算对半收到放得下为止（最新一条永远保留），
    // 裁掉的事实由窗口自身的预算说明（诊断里带码，运行详情能看到）。真的连一条消息加协议都放不下时
    // 才失败——那是容量本身撑不住协议。
    let budget = price.tokenBudget;
    while (roomFor(material, fixed) < 0 && selection.messages.length > 1 && budget > 1) {
      budget = Math.floor(budget / 2);
      selection = qqSelectContext({
        timeline,
        limits: { ...price, tokenBudget: budget },
        nowSeconds,
      });
      material = {
        pending: pending([]),
        sources: selection.messages.flatMap((message) => message.sources ?? []),
      };
      fixed = cost(material);
    }
    if (roomFor(material, fixed) < 0)
      fail("CONTEXT_BUDGET_EXCEEDED", "配置窗口的原文、完整协议与后续动作余量超过模型容量");
    const question = qqJudgementQuestion(selection.messages.map((message) => message.text));
    // 回复档只读已提交包；新压缩在本轮提交后由后台队列执行。
    const baseline = cost(material);
    if (tier === "reply" && o.runtime.p5_config.compression_enabled) {
      let stored: QqConversationSummary | null = null;
      try {
        stored = readQqConversationSummary(o.orm, o.conversationId, o.binding.agentId);
      } catch (error) {
        // 无法验证的包不进入模型输入；保留原行并记录诊断。
        const event = {
          kind: "supplemental_summary_failed" as const,
          code: "CONTEXT_INVALID_RESULT",
        };
        if (o.onDiagnostic) o.onDiagnostic(event);
        else console.warn("bot_context", event, error);
      }
      let packages: QqSummaryPackage[] = (stored?.packages ?? []).filter((item) => {
        try {
          this.assertSources(item.sources ?? []);
          return true;
        } catch (error) {
          if (!(error instanceof AppError) || error.code !== "CONTEXT_SOURCE_INVALID") throw error;
          const event = { kind: "supplemental_summary_failed" as const, code: error.code };
          if (o.onDiagnostic) o.onDiagnostic(event);
          else console.warn("bot_context", event);
          return false;
        }
      });
      const historical = stored?.throughSeq ?? -1;
      const coveredSeq = stored?.coveredSeq ?? -1;
      const windowStart = Math.max(0, nowSeconds - shared.windowMinutes * 60 - 1);
      const retainedSeqs = this.compressionRecords(selection.messages).flatMap((record) =>
        record.seq === null ? [] : [record.seq],
      );
      const buffer = conversationMessagesForBackfill(o.orm, scope, {
        conversationId: o.conversationId,
        afterSeq: Math.max(historical, coveredSeq),
        beforeSeq: retainedSeqs.length ? Math.min(...retainedSeqs) : this.sequence + 1,
        limit: compression.watermark_trigger,
        at: this.now(),
      });
      const tail = this.compressionRecords(buffer);
      const bufferRecords = this.compressionRecords(
        buffer.filter((message) => message.occurredAtSeconds < windowStart),
      );
      if (tail.length >= compression.watermark_trigger) {
        const readBudget =
          o.runtime.p5_config.summary_read_max_tokens ?? o.runtime.p5_config.summary_max_tokens;
        const target = Math.min(
          o.runtime.p5_config.summary_target_tokens,
          readBudget,
          roomFor(material, baseline),
        );
        if (target > 0) {
          const seqs = tail.flatMap((record) => (record.seq === null ? [] : [record.seq]));
          const bufferSeqs = bufferRecords.flatMap((record) =>
            record.seq === null ? [] : [record.seq],
          );
          const times = buffer.map((message) => message.occurredAtSeconds);
          this.compressionJob = createBotCompressionJob({
            orm: o.orm,
            gateway: o.gateway,
            agentRuntime: o.agentRuntime,
            runtime: o.runtime,
            owner: this.owner,
            conversationId: o.conversationId,
            agentId: o.binding.agentId,
            expected: stored,
            records: tail,
            throughSeq: bufferSeqs.length
              ? Math.max(historical, ...bufferSeqs)
              : Math.max(0, historical),
            coveredSeq: seqs.length ? Math.max(coveredSeq, ...seqs) : coveredSeq,
            fromSeconds: times.length ? Math.min(...times) : 0,
            throughSeconds: times.length ? Math.max(...times) : 0,
            question,
            sources: material.sources ?? [],
            target,
            packageLimit: compression.package_limit,
            task: schemePrompts(o.scheme).compress,
            usage: o.usage,
            budget: o.budget,
            assertCurrent: o.assertBackgroundCurrent ?? o.assertCurrent,
            assertSources: (sources) => this.assertSources(sources, false),
            now: () => this.now(),
            onFailure: (code) => {
              const event = { kind: "supplemental_summary_failed" as const, code };
              if (o.onDiagnostic) o.onDiagnostic(event);
              else console.warn("bot_context", event);
            },
          });
        }
      }
      // 协议、已有工具观察与近期窗口先占预算；包装不下就从最早的整包开始丢。
      const packageRoom = Math.min(
        roomFor(material, baseline),
        o.runtime.p5_config.summary_read_max_tokens ?? o.runtime.p5_config.summary_max_tokens,
      );
      const withPackages = (items: readonly QqSummaryPackage[]) => ({
        ...material,
        pending: pending(items),
      });
      while (
        packages.length > 0 &&
        cost(withPackages(packages)) - baseline > Math.max(0, packageRoom)
      )
        packages = packages.slice(1);
      material = {
        ...material,
        pending: pending(packages),
        sources: uniqueSources([
          ...(material.sources ?? []),
          ...packages.flatMap((item) => item.sources ?? []),
        ]),
      };
    }
    if (!fitsTarget(material))
      fail("CONTEXT_BUDGET_EXCEEDED", "近期窗口、水位包、协议与后续动作余量超过可用容量");
    signal.throwIfAborted();
    this.assertSources(material.sources ?? []);
    const view: View = { material, selection, limit: ceiling };
    this.views.set(tier, view);
    this.assertCurrent();
    return view;
  }
  private unavailable(name: string, code: string): EvidenceQueryPage {
    this.retrievalFailures = [
      ...this.retrievalFailures.filter((failure) => failure.name !== name),
      { name, code, observedSeq: this.sequence },
    ];
    const event = { kind: "supplemental_retrieval_failed" as const, name, code };
    if (this.options.onDiagnostic) this.options.onDiagnostic(event);
    else console.warn("bot_context", event);
    return { status: "unavailable", code, items: [] };
  }
  private compressionRecords(messages: readonly QqContextMessage[]): CompressionRecord[] {
    return messages.map((message, index) => {
      const sources = message.sources ?? [];
      const rows = sources.flatMap(
        (source) =>
          this.options.db
            .query(
              "SELECT e.seq FROM conversation_events e,json_each(e.sources) s WHERE e.conversation_id=? AND e.kind IN ('inbound','outbound') AND json_extract(s.value,'$.kind')=? AND json_extract(s.value,'$.id')=?",
            )
            .all(this.options.conversationId, source.kind, source.id) as {
            seq: number;
          }[],
      );
      return {
        id: sources.length
          ? contextDumps(sources.map((source) => [source.kind, source.id, source.revision]))
          : `anonymous:${message.occurredAtSeconds}:${index}`,
        seq: rows.length ? Math.min(...rows.map((row) => row.seq)) : null,
        speaker: message.speakerId ?? message.speaker,
        // 摘要只压正文。媒体描述是模型产物、还会变长，压进摘要既贵又容易把
        // "看图看的"当成事实；未读的那一份本来就只是计数。
        text: contextDumps({ text: message.text }),
        sources,
      };
    });
  }
  /** Fit a channel action's actual result envelope against both decision and reply projections. */
  async actionResultFitter(
    name: string,
    arguments_: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<(value: unknown, sources: readonly SourceRef[]) => boolean> {
    this.assertCurrent();
    await this.view(this.options.decisionTier, signal);
    await this.view("reply", signal);
    // 同批只读工具并发跑，每个的 fit 只看到"上一轮已提交的 observations"；
    // 保守联合预留：把本批其它在飞结果的增量也算进来，宁可少装，不许下一步渲染炸轮。
    const token = Symbol("action-result-fit");
    return (value, sources) => {
      const observation: ActionObservation = {
        id: "00000000-0000-0000-0000-000000000000",
        name,
        arguments: arguments_,
        value,
        sources: uniqueSources(sources),
      };
      // 检查与登记必须在同一同步块内完成，才能消除并发竞态（JS 单线程）。
      let reservation = 0;
      for (const [tier, view] of this.views) {
        const projected = this.cost(tier, view.material, [...this.observations, observation]);
        // 各档增量不同，预留取最大值（保守）。
        reservation = Math.max(
          reservation,
          projected - this.cost(tier, view.material, this.observations),
        );
        if (projected + this.reservations.reserved(token) > view.limit) return false;
      }
      // 通过则覆盖自己的预留（fitter 记住上次通过的值）；失败不改预留。
      this.reservations.set(token, reservation);
      return true;
    };
  }
  /**
   * 补充资料查询。返回**信封**而不是裸数组：`ok`＋空＝真的没有相关内容，`unavailable`＋`code`＝
   * 这次取不到（预算／容量／模型失败）。撤权与来源失效是**硬失败**（直接抛，整轮失败）——
   * "没搜到"与"不能读"对模型必须是两件事（0.4.0 P2 出口之一）。
   */
  private async query(
    name: "memory.query" | "knowledge.query",
    input: { query: string; limit?: number; cursor?: string },
    action: ActionContext,
  ): Promise<EvidenceQueryPage> {
    const { signal } = action;
    signal.throwIfAborted();
    this.assertCurrent();
    await this.view(this.options.decisionTier, signal);
    await this.view("reply", signal);
    const empty: ActionObservation = {
      id: "00000000-0000-0000-0000-000000000000",
      name,
      arguments: input,
      value: { status: "ok", items: [], nextCursor: null },
      sources: [],
    };
    const budget = Math.min(
      this.evidenceBudget(name === "memory.query" ? "memory" : "knowledge"),
      Math.min(
        ...[...this.views].map(
          ([tier, view]) =>
            view.limit - this.cost(tier, view.material, [...this.observations, empty]),
        ),
      ) - this.reservations.reserved(),
    );
    const sources = uniqueSources([...this.sources, ...(action.sources ?? [])]);
    signal.throwIfAborted();
    this.assertCurrent();
    this.assertSources(sources);
    if (budget < 1) return this.unavailable(name, "CONTEXT_BUDGET_EXCEEDED");
    const o = this.options;
    const common = {
      agentId: o.binding.agentId,
      query: input.query,
      limit: input.limit,
      cursor: input.cursor,
      projection: "catalog" as const,
      budget,
      owner: this.owner,
      sources,
      signal,
    };
    let page: EvidenceQueryPage;
    try {
      page = evidenceQueryPage(
        name === "memory.query"
          ? await this.memory.query({
              ...common,
              mode: o.runtime.p5_config.retrieval_mode,
              scopes: qqMemoryScopeKeyset(o.snapshot.access).read,
            })
          : await this.knowledge.query(common),
      );
    } catch (error) {
      signal.throwIfAborted();
      this.assertCurrent();
      this.assertSources(sources);
      const code = failureCode(error, { pattern: /^MODEL_[A-Z_]+$/, allowErrorCode: true });
      if (
        ![
          ...MODEL_LAYER_ERROR_CODES,
          "MODEL_EMPTY_RESPONSE",
          "CONTEXT_CAPACITY_UNKNOWN",
          "CONTEXT_CAPACITY_ERROR",
          "CONTEXT_CAPACITY_INSUFFICIENT",
          "CONTEXT_CAPACITY_TIMEOUT",
          "CONTEXT_AUX_BUDGET",
          "CONTEXT_MEMORY_BUDGET",
          "KNOWLEDGE_CONTEXT_BUDGET",
          "CONTEXT_BUDGET_EXCEEDED",
        ].includes(code)
      )
        throw error;
      return this.unavailable(name, code);
    }
    signal.throwIfAborted();
    this.assertCurrent();
    this.assertSources([...sources, ...page.items.flatMap((item) => item.sources)]);
    if (page.status === "unavailable" && page.code) this.unavailable(name, page.code);
    else this.retrievalFailures = this.retrievalFailures.filter((failure) => failure.name !== name);
    // The factory fits the envelope and retains undisclosed candidates before following nextCursor.
    return page;
  }
}
