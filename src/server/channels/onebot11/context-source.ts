import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { RuntimeConfig } from "../../../shared/contracts";
import type { ModelMessage, RunOwner } from "../../../shared/contracts/agent-run";
import { MODEL_LAYER_ERROR_CODES } from "../../../shared/contracts/errors";
import type { Evidence, SourceRef } from "../../../shared/contracts/evidence";
import { qqEffectiveReplyPrompt } from "../../../shared/contracts/qq";
import type {
  QqEffectiveMediaPolicy,
  QqImagePhase,
} from "../../../shared/contracts/qq-media-input";
import type {
  QqConversationScope,
  QqMessageFact,
  QqMessageFocus,
  QqMessageSettings,
} from "../../../shared/contracts/qq-message";
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
  createEvidenceActionSet,
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
  schemeMessageSettings,
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
import type { ModelGateway } from "../../llm/model-gateway";
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
import { contextDumps } from "../../modules/memory-query";
import { QqGroupCapabilityGuard } from "../../permissions/qq-group-capabilities";
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
import { ownerScope } from "../../services/qq-media-sources";
import {
  formatQqTime,
  renderQqMessageFacts,
  resolveQqDisplayName,
} from "../../services/qq-message-renderer";
import {
  buildQqPrompt,
  QQ_JUDGEMENT_RESPONSE_SCHEMA,
  type QqPromptInput,
  type QqPromptMaterial,
  qqPromptMessages,
  qqSpeakerLabel,
  TIER_OUTPUT_RULES,
} from "../../services/qq-prompt-contract";
import type { QqSpeechKind } from "../../services/qq-speaking-contract";
import { projectQqTextRelations } from "../../services/qq-text-relations";
import { compileSystemPrompt } from "../../services/runtime-config";
import { estimateTokens } from "../../services/token-estimate";
import { type BotCompressionJob, createBotCompressionJob } from "./background-compression";
import { failureCode } from "./failure-code";
import type { QqMediaInputService, QqMediaProjection } from "./media-input-service";
import {
  loadQqMessageFact,
  loadQqMessageFactState,
  loadQqOutboundMessageFact,
  loadQqOutboundMessageFactState,
  projectQqMessageFacts,
  qqSpeechCarriedByOutboundFacts,
} from "./message-projection";
import { expandQqReplies, type QqReplyProjection as QqFullReplyProjection } from "./reply-context";

/** 观测信封里"动作自己的内容"（名字/参数/返回值）的余量；sources 那部分由 envelopeFloor 实量。 */
const ACTION_ENVELOPE_ALLOWANCE = 512;

/**
 * 本会话窗口内**已确认**助手出站部件的候选枚举（计划 T04 Step3；规格 §4.3/§5）。
 *
 * 这层**只枚举候选，不做任何授权判定**：每个候选仍要过 `loadQqOutboundMessageFact`
 * （confirmed 台账与 facts 双账一致、intent target 六维 + 当前 authorityRevision、真实
 * delivery journal 归属、双期限帽、同平台 ID 只被一个 confirmed part 认领）才可能投影。
 * 这里复用现成来源、不复制任何权限 SQL。
 *
 * 范围约束（不扩成全会话历史预载）：只列**本档已选窗口**能证明在场的出站意图——
 * 具体按 journal 稳定序取：候选 intent 的 delivery 事件 seq 不晚于窗口上界 `maxSeq`
 * （窗口消息的最大 seq）；seq 下界不由 SQL 承担——助手的 delivery 事件合法地早于窗口
 * 最早一条入站消息（群友回复的正是它），「哪一段时间」由调用方对投影事实的
 * `occurredAtSeconds`（真实 finishedAt）时间裁剪把关，候选数再由 LIMIT 封顶。
 * 过滤仍只按 conversation + fact 侧 account/agent 维度，返回按 journal 稳定序。
 * 平台消息 ID 可以是负数字符串（合法）。入站 eventKey 与出站 part 是**两个命名空间**，
 * 调用方用独立集合承载，绝不塞进 `qq_observation` 的 eventKey 空间。
 */
interface ConfirmedOutboundPartCandidate {
  readonly intentId: string;
  readonly platformMessageId: string;
}

function confirmedOutboundPartCandidates(
  db: Database,
  scope: QqConversationScope,
  seqWindow: { minSeq: number; maxSeq: number },
  limit: number,
): ConfirmedOutboundPartCandidate[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  if (!Number.isInteger(seqWindow.minSeq) || !Number.isInteger(seqWindow.maxSeq)) return [];
  if (seqWindow.maxSeq < seqWindow.minSeq) return [];
  const rows = db
    .query(
      `SELECT p.intent_id AS intentId,p.platform_message_id AS platformMessageId
      FROM outbound_parts p
      JOIN outbound_intents i ON i.id=p.intent_id
      JOIN qq_outbound_message_facts f ON f.intent_id=i.id
      JOIN conversation_events ce
        ON ce.conversation_id=i.conversation_id AND ce.kind='delivery'
       AND ce.source_kind='outbound_intent' AND ce.source_id=i.id
      WHERE i.conversation_id=? AND f.account_id=? AND f.agent_id=?
        AND p.status='confirmed' AND p.platform_message_id IS NOT NULL
        AND p.platform_message_id<>''
        AND ce.seq<=?
      ORDER BY ce.seq DESC, p.ordinal DESC, p.id DESC LIMIT ?`,
    )
    .all(scope.conversationId, scope.accountId, scope.agentId, seqWindow.maxSeq, limit) as {
    intentId: string;
    platformMessageId: string;
  }[];
  // 取回是「最新在前」（LIMIT 只截最近的候选），反转回 journal 稳定升序后再去重：
  // 同一平台 ID 只出现一次（loader 仍会自己再判「只被一个 confirmed part 认领」，
  // 这里去重只为不让同一候选被重复投影、事实段不出现两条同一正文）。
  const seen = new Set<string>();
  const ordered: ConfirmedOutboundPartCandidate[] = [];
  for (const row of rows.reverse()) {
    if (seen.has(row.platformMessageId)) continue;
    seen.add(row.platformMessageId);
    ordered.push({ intentId: row.intentId, platformMessageId: row.platformMessageId });
  }
  return ordered;
}

export interface BotContextTarget {
  id: string;
  speakerId: string | null;
}

/**
 * 评分相结构化输出协议的**实际**开销（规格 §10 同源；`cost` 与 `prepareEvaluation` 共用此
 * 一处，不各估一遍）。
 *
 * 评分叶子实际发送的 `responseSchema` 由宿主按本次是否走 envelope 决定，判断档系统段落里的
 * 输出要求也随之**整段替换**（`qqReplaceOutputRule`）——两者都比 plain 长。只按 plain 估会
 * 少算，把装不下的评分调用当成装得下。这里按同一份真源计：
 *   * schema 取注入的**实际**那一份（缺省＝plain，行为与从前逐字相同）；
 *   * 规则文本按**实际规则相对 plain 规则的净字节增量**折算进 token，注入实际规则时不再按旧
 *     规则文本估；
 *   * 两者都只会变大，fail-closed 方向正确，不放宽任何上限。
 *
 * 决策相的 envelope 不在此计：决策 schema 的文本已经进系统段、由 `inputUnits` 计入，
 * 再加一次就是双计。`envelopeFloor` 用 plain 渲染探针也不冲突——它只覆盖评分/生成相关的
 * 替换，本函数只服务评分相。
 */
function scoreProtocolUnits(options: BotContextSourceOptions): number {
  const schema = options.scoreProtocol?.responseSchema ?? QQ_JUDGEMENT_RESPONSE_SCHEMA;
  const plain = estimateTokens(contextDumps(QQ_JUDGEMENT_RESPONSE_SCHEMA));
  const actual = estimateTokens(contextDumps(schema));
  const actualRule = options.scoreProtocol?.outputRule;
  // 净增量按**字节**比值折算，与 estimateTokens 同一估算口径（UTF-8 字节近似），
  // 不引第二套 token 换算。
  const ruleUnits =
    actualRule === undefined
      ? 0
      : Math.max(
          0,
          estimateTokens(contextDumps(actualRule)) -
            estimateTokens(contextDumps(TIER_OUTPUT_RULES.judgement)),
        );
  return Math.max(plain, actual) + ruleUnits;
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
  /**
   * 背景摘要任务的启动闸门（与 `assertBackgroundCurrent` 相对）：只拒绝尚未开始的
   * 队列任务（暂停、普通配置变化），缺省＝不拒绝。
   */
  assertStartable?: () => void;
  usage?: RunUsage;
  budget?: RunBudget;
  now?: () => string;
  onRead?: (observedSeq: number) => void;
  onDiagnostic?: (event: {
    kind: "supplemental_summary_failed" | "supplemental_retrieval_failed";
    code: string;
    name?: string;
  }) => void;
  /**
   * 本群能力 guard（ADR0019 §13.3）：模块安装、调用点与来源复验都按它判定。
   * 缺省按同一张 orm 构造，测试可注入替身。
   */
  guard?: QqGroupCapabilityGuard;
  /**
   * 评分相**实际**使用的结构化输出协议（规格 §10 同源；由宿主注入，缺省＝plain）。
   *
   * 评分叶子真正发送的 `responseSchema` 与判断档系统段落里的输出要求都由**宿主**按本次是否
   * 走 envelope 决定（envelope 时 schema 换成带 `scoreResult`/`media` 的那一份，系统段落里
   * 的 plain 输出要求经 `qqReplaceOutputRule` **整段替换**成 envelope 版本）。两处都比 plain
   * 更长，所以只按 plain 估会**少算**、把装不下的评分调用当成装得下。这里按同一口径取
   * 「实际 schema + 实际规则替换后的净增量」，两者都取**更大**的那一份，fail-closed 不放宽。
   *
   * 缺省＝plain（与迁移前逐字相同的估算），不改变未注入调用方的行为。
   */
  scoreProtocol?: {
    /** 本次评分实际发送的 responseSchema（宿主那份真源，不在本文件重造）。 */
    readonly responseSchema: Record<string, unknown>;
    /**
     * 实际生效的判断档输出要求全文（envelope 走替换后的那一份）。提供时按「实际规则相对
     * plain 规则的净字节增量」计入，避免只换 schema 名却仍按旧规则文本估。
     */
    readonly outputRule?: string;
  };
  /**
   * T11 B：三相自动图的媒体准备供给（同一份服务与策略真源由宿主注入）。
   * `capabilityEnabled` 是全局/本群 media 能力放行真值；缺省＝不接自动图（行为同 A）。
   */
  mediaInput?: {
    service: QqMediaInputService;
    settings: QqEffectiveMediaPolicy;
    focus: () => QqMessageFocus;
    capabilityEnabled: boolean;
    /** 分类缓存回读键：与 consume 的 policyRevision 同一 plain mediaPolicyRevision 真源。 */
    classificationPolicy?: string;
    /** 方案 message_settings 组（D2）：回复展开深度/模式的真源，由宿主从生效方案读取。 */
    messageSettings?: QqMessageSettings;
    /**
     * 本 run 已成功 media.read 的 mediaId 集合（宿主记账）：投影按“明确细问/已明确读取”
     * 桶纳入当相取舍——下一相是否真发原生画面仍按当相阶段开关与能力卫视。
     */
    detailMediaIds?: () => ReadonlySet<string>;
    /**
     * 回读门控（真实执行隔离）：返回 null＝路由不确定（本 call resolved 无法预先确认）→
     * 服务零回读，unknown 按普通规格（§7.2 首次 unknown 语义）；返回模型名＝宿主已确认
     * 该 requested 的 resolved 与之相同（上一次同 binding 消费点记录）。宿主不得用
     * requested 字符串相等冒充 resolved 确认。
     */
    classificationGate?: () => string | null;
  };
}
interface View {
  material: ContextMaterial;
  selection: QqContextSelection;
  limit: number;
  /** D2 S4b：本档窗口事实投影与回复展开（一次构建、各相复用，登记只发生一次）。 */
  replyFacts: readonly QqMessageFact[];
  replyExpansion: QqFullReplyProjection;
}

/** One authorized context owner with explicit decision/reply projections for every Bot topology. */
export class BotContextSource {
  readonly actions: BuiltInAction[];
  /** D2：引用正文的真实 run 证据注册（createEvidenceActionSet 同一 registry，history 域）。 */
  readonly registerEvidence: (kind: string, evidence: Evidence, context: ActionContext) => string;
  private readonly views = new Map<QqContextTier, View>();
  private readonly capacities = new Map<string, number>();
  private readonly engine = new ContextEngine();
  private readonly owner: RunOwner;
  private readonly guard: QqGroupCapabilityGuard;
  private readonly memory: MemoryModule;
  private readonly knowledge: KnowledgeModule;
  private compressionJob?: BotCompressionJob;
  private observations: readonly ActionObservation[] = [];
  /** 同批在飞动作各自的投影增量（token→相对基线 cost(observations) 的 units；按档取最大值）。 */
  private readonly reservations = new ReservationLedger();
  private sequence = 0;
  private pendingPlan?: { value: unknown; sources: SourceRef[] };
  private retrievalFailures: { name: string; code: string; observedSeq: number }[] = [];
  /** 各相最近一次媒体投影（宿主在发送边界按它登记字节；无媒体接线时恒空）。 */
  private readonly phaseMedia = new Map<QqImagePhase, QqMediaProjection>();
  /**
   * §9 显式 fallback 状态：宿主捕到精确 MODEL_IMAGE_UNSUPPORTED 后按相请求 description 备用；
   * 该相下次 preparePhaseMedia 走 describeAfterUnsupported（requestedMode 仍 native）。
   */
  private readonly phaseFallback = new Map<QqImagePhase, string>();
  private runId?: string;
  constructor(private readonly options: BotContextSourceOptions) {
    const o = options;
    this.owner = {
      kind: "qq_binding",
      id: o.binding.id,
      userId: DEFAULT_USER_ID,
      agentId: o.binding.agentId,
    };
    this.guard = o.guard ?? new QqGroupCapabilityGuard(o.orm);
    const modules = (o.modules ?? createSqliteQueryFactory(o))({
      runtime: o.runtime,
      assertSources: (sources) => this.assertSources(sources),
    });
    this.memory = modules.memory;
    this.knowledge = modules.knowledge;
    const actions: Record<string, EvidenceQueryModule> = {};
    // 本群停用系统能力后不安装对应模块：模型可见目录里没有它，调用点也过不去
    // （ADR0019 §13.3 D）。历史原文（history）不属能力停用面，照旧安装。
    if (
      o.runtime.p5_config.retrieval_mode !== "off" &&
      this.guard.allowed(this.owner, "memory_read")
    ) {
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
                // 停用即刻生效：正文读取是硬边界——本群停用后，在途的这一轮也不能继续取正文
                // （不是"这次没取到"的可恢复信封；中央 ActionExecutor 在调用前也有一层同样的检查）。
                this.guard.assert(this.owner, "memory_read");
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
                // 读完之后再复验一次：正文出栈的这一刻，本群能力、绑定授权与来源都还成立才交给模型。
                this.assertCurrent();
                this.guard.assert(this.owner, "memory_read");
                this.assertSources(sources);
                return page;
              },
            }
          : {}),
      };
    }
    if (
      o.runtime.knowledge_read?.config.enabled !== false &&
      this.guard.allowed(this.owner, "knowledge_read")
    ) {
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
                // 同上：知识正文读取同样是硬边界，不能返回"取不到"的信封。
                this.guard.assert(this.owner, "knowledge_read");
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
                this.guard.assert(this.owner, "knowledge_read");
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
      summaryEnabled:
        o.decisionTier === "reply" && this.guard.allowed(this.owner, "history_summary"),
      assertCurrent: () => this.assertCurrent(),
      assertSources: (sources) => this.assertSources(sources),
      now: () => this.now(),
    });
    actions.history = evidence.history;
    // P2/S19 桥：locateHistory 留存在实例上——register 回调（view 内）用它铸造合法 history
    // Evidence（真实 run context）。
    this.locateHistory = evidence.locateHistory;
    if (evidence.summary) actions.summary = evidence.summary;
    const evidenceSet = createEvidenceActionSet(actions, {
      assertSources: (sources) => {
        this.assertCurrent();
        this.assertSources(sources);
      },
      fit: (name, arguments_, signal) => this.actionResultFitter(name, arguments_, signal),
      budget: (kind) => this.evidenceBudget(kind),
    });
    this.actions = evidenceSet.actions;
    // D2：媒体引用展开的真实 run 证据注册入口（同一 registry/预算/refs 上限，不旁路）。
    this.registerEvidence = (kind, evidence, context) =>
      evidenceSet.registerEvidence(kind, evidence, context);
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
    // 决策相自动图（§7.1）：投影（可能为空/禁用）作为资料消息并入材料；来源并入统一复验。
    const decisionMedia = await this.preparePhaseMedia("decision", input.signal);
    if (decisionMedia) {
      this.assertSources(decisionMedia.sources);
      return this.withPendingPlan({
        ...view.material,
        pending: [...(view.material.pending ?? []), ...decisionMedia.messages],
        sources: uniqueSources([...(view.material.sources ?? []), ...decisionMedia.sources]),
      });
    }
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
    // 生成相自动图（§9）：相位关闭→全零投影；未知分类同次封装由宿主声明（responseEnvelope）。
    const generationMedia = await this.preparePhaseMedia("generation", input.signal);
    const generationMaterial = generationMedia
      ? {
          ...view.material,
          pending: [...(view.material.pending ?? []), ...generationMedia.messages],
          sources: uniqueSources([...(view.material.sources ?? []), ...generationMedia.sources]),
        }
      : view.material;
    const context = this.engine.render(
      this.options.spec,
      this.withPendingPlan(generationMaterial),
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
    /** 评分叶子的原生有序消息（T11 Step5）：图片以来源元数据 part 原样携带，不再拼回字符串。 */
    messages: ModelMessage[];
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
    // 评分相自动图（§7.1/§9）：评估相位关闭时服务给全零投影；说明 notes 走资料消息，
    // 原生图 part 随渲染进入评分叶子消息（字节由宿主在发送边界登记）。
    const evaluationMedia = await this.preparePhaseMedia("evaluation", input.signal);
    const evaluationMaterial = evaluationMedia
      ? {
          ...view.material,
          pending: [...(view.material.pending ?? []), ...evaluationMedia.messages],
          sources: uniqueSources([...(view.material.sources ?? []), ...evaluationMedia.sources]),
        }
      : view.material;
    const rendered = this.engine.render(
      this.options.spec,
      this.withPendingPlan(evaluationMaterial),
      this.observations,
      this.targetIds(),
    );
    const messages = this.evaluationMessages(
      evaluationMaterial,
      this.observations,
      input.target ?? undefined,
      view.selection.messages,
      input.intent,
    );
    // 计量单源（审查项 2 统一）：与 runtime 步内预算同一 inputUnits 估算器（图片不折算为
    // 文本 token，视觉成本由 visionCost=unknown 如实标出），schema 协议开销照旧单列。
    const units = inputUnits(messages) + scoreProtocolUnits(this.options);
    if (units > view.limit)
      fail("CONTEXT_BUDGET_EXCEEDED", "评分上下文及结构化输出协议超过模型容量");
    this.assertSources(rendered.sources);
    input.signal.throwIfAborted();
    // 摘要的"状态"边界（T11 Step5）：不只是文本——渲染消息里携带的图片来源元数据（sha、
    // 实际模式、帧序）与时间线事实修订都参与哈希；同 source 换图、分类变更、来源过期都会
    // 让摘要变化，旧许可自动失效。意图仍不进摘要。
    const evaluationImageParts = rendered.messages.flatMap((message) =>
      message.content.flatMap((part) => (part.kind === "image" ? [part] : [])),
    );
    const factRevisions = view.selection.messages.flatMap((message) =>
      (message.sources ?? []).map((source) => [source.kind, source.id, source.revision] as const),
    );
    const stateDigest = createHash("sha256")
      .update(
        JSON.stringify([
          this.options.scheme.revision,
          input.target?.id ?? null,
          rendered.messages,
          factRevisions,
          evaluationImageParts.map((part) => [
            part.sourceId,
            part.revision,
            part.sha256,
            part.width ?? null,
            part.height ?? null,
            part.frameIndex ?? null,
          ]),
          // 计划 Step5 的显式键：实际呈现模式与取舍原因参与摘要——native↔description/disabled
          // 切换、超限取舍变化都使旧许可失效（同材料同摘要，材料变则复评）。
          evaluationMedia?.actualMode ?? null,
          evaluationMedia?.omissions.map((omission) => [omission.mediaId, omission.reason]) ?? [],
        ]),
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
  ): ModelMessage[] {
    const prompt = this.prompt(timeline, target);
    const systems = qqPromptMessages(
      buildQqPrompt({ ...prompt, tier: "judgement", prompts: schemePrompts(this.options.scheme) }),
    )
      .filter((message) => message.role === "system")
      .map((message) => textMessage(message.role as ModelMessage["role"], message.content));
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
    // 原生有序消息（T11 Step5）：渲染产物本就是 ModelMessage[]——图片 part 携带来源元数据，
    // 原样交给评分叶子；不再把 image part 拼回字符串（旧 :542 的 throw 随之移除）。
    // 图片能否真正进入 wire 由宿主在发送边界经 imageResolver 决定，本层不伪造字节。
    return [...systems, ...rendered.messages.slice(1)];
  }
  assertCurrent(): void {
    this.options.assertCurrent();
    this.assertSources(this.sources, false);
  }
  /** P2 修复：真实调用 owner（ActionContext.owner，conversation 域）——registry 登记/查询同 owner。 */
  private runOwner?: RunOwner;
  /** P2/S19 桥：locateHistory 铸造合法 history Evidence（JSON tuple id + conversation sources）。 */
  private locateHistory?: (platformMessageId: string, context: ActionContext) => Evidence | null;
  /** 运行标识（runConversation 构造后、首次 read 前调用恰一次）：媒体投影与登记按真实 run。 */
  bindRun(context: ActionContext): void {
    if (context.runId !== undefined) this.runId = context.runId;
    // P2：capture 真实调用 owner——registry（registerEvidence/history.read）必须以同一
    // (owner, runId) 登记+查询，否则同 run 读 miss。来源域读取（SourceRef 末验）仍按
    // this.owner（qq_binding）——不放宽授权/存储边界，不跨 run。
    this.runOwner = context.owner;
  }
  /** 宿主发送边界读取：本相已准备的媒体投影（无接线或未准备时 undefined）。 */
  mediaProjection(phase: QqImagePhase): QqMediaProjection | undefined {
    return this.phaseMedia.get(phase);
  }
  /**
   * §9 显式 fallback 请求（宿主在精确 isModelImageUnsupportedError 后调用）：只接受
   * MODEL_IMAGE_UNSUPPORTED 专属原因，不接受鉴权/超长/限流/网络/5xx/超时等一般故障。
   * 该相媒体投影作废并触发视图重建——重评/重渲不再携带原生 image part，改走
   * describeAfterUnsupported 的 description notes（reason 随 diagnose 观测面持久）。
   */
  requestMediaFallback(phase: QqImagePhase, reason: "model_image_unsupported"): void {
    this.assertCurrent();
    this.phaseFallback.set(phase, reason);
    this.phaseMedia.delete(phase);
    this.views.clear();
    this.compressionJob = undefined;
    this.reservations.clear();
  }
  /** 本相是否已请求 §9 description fallback（宿主观测读回用）。 */
  mediaFallbackReason(phase: QqImagePhase): string | undefined {
    return this.phaseFallback.get(phase);
  }
  /**
   * 相模型调用的档位上限（宿主在准备钩子里做最终预算复验用）：decision=决策档视图上限，
   * generation=回复档视图上限。视图未建＝undefined（宿主按无上限处理）。
   */
  phaseUnitsCeiling(phase: "decision" | "generation"): number | undefined {
    return (
      phase === "decision" ? this.views.get(this.options.decisionTier) : this.views.get("reply")
    )?.limit;
  }
  /**
   * §9 fallback 后按相重备媒体（宿主钩子在能力拒绝时调用）：preparePhaseMedia 的
   * fallback 分支已因 phaseFallback 生效，本方法只是按相触发一次重备并返回新投影
   * （actualMode=description，无可用视觉模型时 unavailable——不编内容，图像标 unknown）。
   */
  async repreparePhaseMedia(
    phase: QqImagePhase,
    signal: AbortSignal,
  ): Promise<QqMediaProjection | undefined> {
    this.assertCurrent();
    // 相档视图先重建（fallback 清空过视图）：facts/selection 是 describe 选取的真实输入。
    const tier =
      phase === "evaluation"
        ? "judgement"
        : phase === "decision"
          ? this.options.decisionTier
          : "reply";
    await this.view(tier, signal);
    const result = await this.preparePhaseMedia(phase, signal);
    return result === null ? undefined : this.phaseMedia.get(phase);
  }
  /**
   * T10/§7.2：以 actualModel（used）重备指定相媒体并激活分类回读真源。钩子闭包在
   * resolved 冻结后调用：classificationPolicy 按真实 resolved 比对放行（不再恒 null），
   * 投影替换进 phaseMedia；随后同 call 分类经 consume 以真实 resolved 落库。
   * 返回新投影（形状与原投影一致时宿主请求消息原样）。
   */
  async repreparePhaseForModel(
    phase: QqImagePhase,
    model: string,
    signal: AbortSignal,
  ): Promise<QqMediaProjection | undefined> {
    this.assertCurrent();
    // 相档视图先重建（fallback 清空过视图）：facts/selection 是 describe 选取的真实输入。
    const tier =
      phase === "evaluation"
        ? "judgement"
        : phase === "decision"
          ? this.options.decisionTier
          : "reply";
    await this.view(tier, signal);
    const result = await this.preparePhaseMedia(phase, signal, model);
    return result === null ? undefined : this.phaseMedia.get(phase);
  }
  /**
   * 一相自动图的统一投影（T11 Step4/Step5/Step6）：capability/stage 双闸由服务自身执行
   * （disabled 投影全零 omissions），这里只决定"是否调用"。disabled/unavailable 投影没有
   * 图片，只可能贡献 description notes 与来源——notes 走文字资料消息，图片走原生 part。
   * 投影失败按来源缺陷 fail closed（CONTEXT_SOURCE_INVALID），不静默降级。
   */
  private async preparePhaseMedia(
    phase: QqImagePhase,
    signal: AbortSignal,
    modelOverride?: string,
  ): Promise<{
    messages: ModelMessage[];
    sources: SourceRef[];
    actualMode: QqMediaProjection["actualMode"];
    omissions: QqMediaProjection["omissions"];
  } | null> {
    const media = this.options.mediaInput;
    if (media?.capabilityEnabled !== true || this.runId === undefined) return null;
    signal.throwIfAborted();
    const binding = this.options.binding;
    const conversationRow = this.options.journal.get(this.options.conversationId);
    if (!conversationRow) fail("CONTEXT_SOURCE_INVALID", "会话已失效");
    const scope: QqConversationScope = {
      conversationId: this.options.conversationId,
      accountId: binding.accountId,
      conversationKind: binding.kind,
      peerId: binding.peerId,
      agentId: binding.agentId,
      bindingId: binding.id,
      bindingEpoch: conversationRow.bindingEpoch,
      authorityRevision: binding.authorityRevision,
    };
    // D2 S4b：本相窗口事实投影与回复展开已在对应档 view() 构建时算好并缓存
    // （真实 load/register/fits 只发生一次，同一 registry/refs≤512/2MiB/预算计量）；
    // 这里只复用，不重复登记。自动范围仍由 selector 按 focus/direct 判定。
    const tier = phase === "evaluation" ? "judgement" : "reply";
    const phaseView =
      phase === "decision" ? this.views.get(this.options.decisionTier) : this.views.get(tier);
    const facts = phaseView?.replyFacts ?? [];
    const replies = phaseView?.replyExpansion ?? { roots: [], sources: [] };
    const baseInput = {
      scope,
      phase,
      focus: media.focus(),
      facts,
      replies,
      settings: media.settings,
      // resolvedModel 覆盖（T10 准备钩子）：钩子闭包用 actualModel 冻结值重备/激活分类；
      // 未覆盖＝按 requested 真源。
      model: modelOverride ?? this.options.spec.model ?? this.options.runtime.model_name,
      now: this.now(),
      runId: this.runId,
      signal,
      assertCurrent: () => this.assertCurrent(),
      capabilityEnabled: media.capabilityEnabled,
      owner: this.owner,
      // 本 run 已明确读取的 mediaId（media.read 成功记账）：细问升普通规格 + explicit 桶。
      detailMediaIds: media.detailMediaIds?.(),
    };
    const fallbackReason = this.phaseFallback.get(phase);
    const projection = fallbackReason
      ? // §9 显式备用：requestedMode 保持 native、actualMode=description；只有精确
        // MODEL_IMAGE_UNSUPPORTED 能到这里（宿主 isModelImageUnsupportedError 窄判别），
        // 鉴权/超长/限流/网络/5xx/超时绝不降级。
        await media.service.describeAfterUnsupported(baseInput)
      : // 分类缓存回读键（片1）：与 consumeModelMediaData 同一 plain mediaPolicyRevision
        // 真源（宿主 mediaInput 配置同源注入），不自算、缺省不回读。
        // 门控：宿主 gate 报告上一次同键真实消费的 resolved；仅当其与本相 requested 模型
        // 一致（路由已被真实执行确认）才回读；首次/不确定 → 零回读，unknown 按普通规格，
        // 不以 requested 字符串相等冒充 resolved 确认。
        await media.service.prepareQqMediaProjection({
          ...baseInput,
          ...(media.classificationPolicy === undefined
            ? {}
            : (media.classificationGate?.() ?? null) ===
                (modelOverride ?? this.options.spec.model ?? this.options.runtime.model_name)
              ? { classificationPolicy: media.classificationPolicy }
              : {}),
        });
    const detailIds = media.detailMediaIds?.();
    const requestedImages =
      detailIds && detailIds.size > 0
        ? projection.images.filter((image) => detailIds.has(image.mediaId))
        : projection.images;
    const seenImages = new Set<string>();
    const images = requestedImages.filter((image) => {
      if (image.content.kind !== "image") fail("CONTEXT_SOURCE_INVALID", "图片投影缺少画面部件");
      const key = JSON.stringify([
        image.content.sourceId,
        image.content.revision,
        image.frameIndex,
      ]);
      if (seenImages.has(key)) return false;
      seenImages.add(key);
      return true;
    });
    const omittedImages = projection.images.filter(
      (image) => detailIds && detailIds.size > 0 && !detailIds.has(image.mediaId),
    );
    const omissions = [...projection.omissions];
    for (const image of omittedImages) {
      for (const messageId of image.messageIds) {
        if (
          !omissions.some(
            (entry) => entry.mediaId === image.mediaId && entry.messageId === messageId,
          )
        ) {
          omissions.push({ mediaId: image.mediaId, messageId, reason: "not_supplied" });
        }
      }
    }
    const suppliedProjection = { ...projection, images, omissions };
    this.phaseMedia.set(phase, suppliedProjection);
    const messages: ModelMessage[] = [];
    if (suppliedProjection.images.length > 0)
      messages.push({
        role: "user",
        content: suppliedProjection.images.map((image) => image.content),
      });
    if (suppliedProjection.notes.length > 0)
      messages.push(
        textMessage(
          "user",
          contextDumps({
            kind: "qq_media_notes",
            trust: "data_only",
            notes: suppliedProjection.notes,
          }),
        ),
      );
    // 动画 unsupported 等不可读图像的 data_only 说明（§7.3）：模型知道图存在但本轮不可读，
    // 不伪 not_supplied/已理解。仅 reason 为 unreadable 的 omission 产生说明。
    const unreadableOmissions = suppliedProjection.omissions.filter(
      (o) => o.reason === "unreadable",
    );
    if (unreadableOmissions.length > 0)
      messages.push(
        textMessage(
          "user",
          contextDumps({
            kind: "qq_media_unreadable",
            trust: "data_only",
            omissions: unreadableOmissions.map((o) => ({
              mediaId: o.mediaId,
              messageId: o.messageId,
              reason: o.reason,
            })),
          }),
        ),
      );
    return {
      messages,
      sources: [...suppliedProjection.sources],
      actualMode: suppliedProjection.actualMode,
      omissions: [...suppliedProjection.omissions],
    };
  }
  assertSources(sources: readonly SourceRef[], hostCheck = true): void {
    const o = this.options;
    if (hostCheck) o.assertCurrent();
    // 本群作用域的来源（QQ 观察、素材、记忆等）先按 guard 复验：停用/撤权后不能继续暴露正文，
    // 这一层与下面的通用复验叠加，不是它的替代。
    this.guard.assertSources(this.owner, sources);
    assertContextSources({
      db: o.db,
      sources,
      owner: this.owner,
      now: this.now(),
      // 本群能力引用先按 guard 复验（纪元与停用）；会话证据再本地复验（持久存储），
      // 外部注入解析器不能把已撤权的引用改判为 available。
      resolveSource: (source, owner, at) =>
        this.guard.sourceAccess(source, owner) ??
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
      // 与 cost() 同一处估算（评分相实际 schema + 实际规则替换的净增量），不各估一遍。
      const schemaUnits = scoreProtocolUnits(o);
      const evaluations = [undefined, ...targets].map(
        (target) =>
          inputUnits(this.evaluationMessages(material, observations, target, timeline)) +
          schemaUnits,
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
    const readAt = this.now();
    const nowSeconds = Math.floor(Date.parse(readAt) / 1000);
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
        includeMediaNotes: false,
        now: readAt,
      }).map(({ eventKey: _key, ...message }) => message),
      ownSpeech: [
        ...ownSpeechSince(o.orm, scope, {
          sinceSeconds,
          limit: fetchLimit,
          includeSources: true,
          now: readAt,
        }),
        ...o.outbox.partialSpeechSince(o.conversationId, {
          sinceSeconds,
          limit: fetchLimit,
          at: readAt,
        }),
      ],
    });
    let selection = qqSelectContext({ timeline, limits: price, nowSeconds });
    const cost = (material: ContextMaterial) =>
      this.cost(tier, material, this.observations, selection.messages);
    // 正文去重：预计算哪些 selected 消息有 facts 投影（eventKey 匹配）。
    // 有 facts 的消息正文由 qq_message_facts 资料段承载（唯一来源），
    // timeline 对这些消息不再重复正文文本。
    const conversationForFacts = o.journal.get(o.conversationId);
    const factsScope = conversationForFacts
      ? {
          conversationId: o.conversationId,
          accountId: o.binding.accountId,
          conversationKind: o.binding.kind,
          peerId: o.binding.peerId,
          agentId: o.binding.agentId,
          bindingId: o.binding.id,
          bindingEpoch: conversationForFacts.bindingEpoch,
          authorityRevision: o.binding.authorityRevision,
        }
      : null;
    const factEventKeys = new Set(
      selection.messages.flatMap((message) =>
        (message.sources ?? [])
          .filter((source) => source.kind === "qq_observation")
          .map((source) => source.id),
      ),
    );
    /**
     * 本档窗口（回复档分钟/条数、共享预算）内**已确认**的助手出站 part 事实（T04 Step3）。
     *
     * 只有进入窗口的才投影：窗口条数/分钟之外的出站原话不因这次接线被整段拉进资料段
     * （引用展开里「窗口外按明确 ID 补」那条路仍归 `load`/`loadState` 回落，不受此裁剪影响）。
     * 未确认（unknown/failed/not_sent/stale）与本 scope 外的一律不在候选里，也拿不到事实：
     * loader 自身仍按 confirmed 台账、唯一认领、intent target 六维 + 当前 authorityRevision、
     * 真实 delivery journal 归属与双期限帽再判一次，这里不替代它的 fail-closed。
     */
    const outboundWindowFloor =
      nowSeconds - Math.max(windows.judgement.windowMinutes, shared.windowMinutes) * 60 - 1;
    /**
     * 候选范围＝**本档窗口能证明在场的出站意图**，按 journal 稳定 seq 取（§4.3「不扩成
     * 通用历史预载」）。seq 上界取窗口消息的真实最大 seq（`outboundSeqWindow`，与窗口同
     * 一次读冻结）；seq 下界不裁——助手的 delivery 事件合法地早于窗口最早一条入站消息
     * （群友回复的正是它），「哪一段时间」由下面对投影事实 `occurredAtSeconds`（真实
     * finishedAt）的时间裁剪把关，不靠 SQL 解析时间串，避免刻度/格式漂移。
     */
    const outboundSeqWindow = factsScope
      ? this.outboundSeqWindow(o.conversationId, selection.messages)
      : null;
    // 投影 + 意图身份一次算完：只有真正投影成功的 part 才进事实段，其 intent 才算
    // 「正文已由 facts 承载」（loader 拒掉的候选不得让时间线正文消失）。
    const outboundProjected =
      factsScope && outboundSeqWindow
        ? confirmedOutboundPartCandidates(
            o.db,
            factsScope,
            outboundSeqWindow,
            fetchLimit * 4,
          ).flatMap((candidate) => {
            const fact = loadQqOutboundMessageFact(
              { db: o.db, orm: o.orm },
              factsScope,
              candidate.platformMessageId,
              readAt,
            );
            if (!fact) return [];
            if (
              fact.occurredAtSeconds < sinceSeconds ||
              fact.occurredAtSeconds <= outboundWindowFloor
            )
              return [];
            return [{ intentId: candidate.intentId, fact }];
          })
        : [];
    const outboundFacts = outboundProjected.map((entry) => entry.fact);
    const projectedFacts = [
      ...(factsScope && factEventKeys.size > 0
        ? projectQqMessageFacts({ db: o.db, orm: o.orm }, factsScope, [...factEventKeys], readAt)
        : []),
      ...outboundFacts,
    ];
    const projectedFactKeys = new Set(projectedFacts.map((f) => f.id));
    // 时间线正文去重用的真实意图身份：哪些 outbound_intent 已在 facts 资料段承载正文。
    // 来自同一次投影（不按正文文本猜，也不给 QqMessageFact 加工字段）。
    const projectedOutboundIntentIds = new Set(outboundProjected.map((entry) => entry.intentId));
    /**
     * 已确认出站件的**旧**时间线正文（`qq_speech` source）由 facts 资料段唯一承载后才剥离。
     *
     * 精确身份，不按内容/时刻猜：发送通路把一次发送的 `qq_send_log` 行 id 直接交给
     * `recordQqSpeech` 当 `qq_speech_log.id`（同一事务、同一 id），而
     * `outbound_intents.legacy_send_id` 指向同一行——所以 `speech.id === legacy_send_id`
     * 就是「这条旧 speech 正文属于哪个出站意图」的确切关联（§4.3「同一消息最多供一次正文」）。
     *
     * 两条硬约束：
     *   * **只在全部已确认文本部件都真的进了本档 facts 时才剥**。旧 speech 正文是这些部件
     *     正文的换行拼接；只要有一个部件未确认/无平台 ID/是贴图/被 loader 拒/超窗口/已过期，
     *     拼接里就仍有只此一份可读的字——那一条 speech 保持原样，并且该意图的事实段只留
     *     身份与关系、**不再重复正文**（否则会出现「speech 一份 + 已选部件一份」两处正文）。
     *   * `partialSpeechSince` 那种带 `outbound_intent` source 的行（非 confirmed 意图）照旧：
     *     它没有 facts 可承载，正文永不由 facts 段提供。
     * 未映射的独立旧 speech（无 `legacy_send_id`、或非本 scope/纪元）原文字保留，不删、不
     * 预载整段历史、不迁旧 ID。
     */
    const speechFactsCarrying = (() => {
      const ids = selection.messages.flatMap((message) =>
        (message.sources ?? [])
          .filter((source) => source.kind === "qq_speech")
          .map((source) => source.id),
      );
      const empty = {
        fullyCarriedSpeechIds: new Set<string>(),
        partlyCarriedSpeechIds: new Set<string>(),
        partlyCarriedPartIds: new Set<string>(),
      };
      if (ids.length === 0 || !factsScope) return empty;
      return qqSpeechCarriedByOutboundFacts({
        speechSourceIds: ids,
        // 平台 ID → **part id**。只有带真实平台 ID 的事实能作为「这个部件已在 facts 段承载」
        // 的证据；没有平台 ID 的事实无法与部件对上，不进这张表。value 存 part id（=
        // `QqMessageFact.id` = `outbound_parts.id`），helper 据此要求「同一个部件」而不是
        // 「同一条线上消息 ID」——后者可能由别的部件的事实满足。
        projectedByPlatformMessageId: new Map(
          outboundFacts.flatMap((fact) =>
            fact.platformMessageId === null
              ? []
              : ([[fact.platformMessageId, fact.id]] as [string, string][]),
          ),
        ),
        store: { db: o.db, orm: o.orm },
        scope: factsScope,
        now: readAt,
      });
    })();
    /**
     * 「部分承载」的出站件：其旧 speech 正文仍须作为唯一来源，所以事实段**只去掉正文**，
     * 身份／完整时间／@与引用关系／其它片段一律保留——不把整条事实删掉（那会让「这条消息
     * 是谁在什么时候说的、引用了谁」凭空消失），也不谎称正文已完整。
     *
     * part 身份直接取自上面 helper 已定位过的同一批意图（`partlyCarriedPartIds`），不在这里
     * 另跑一条缺 conversation 约束的重复 SQL；仍然只按精确 id 匹配，不按正文/时刻猜。
     */
    const partlyCarriedPartIds = speechFactsCarrying.partlyCarriedPartIds;
    /**
     * 部分承载时该事实在**资料段**里的形状：保留身份、时间、关系与其它非正文片段，摘掉正文。
     *
     * `completeness` 只用既有契约里的两个字面（`"full" | "legacy_partial" | "unavailable"`），
     * **不新增 `"partial"`**：那等于在没有扩 schema 的情况下偷写第四个状态。
     * `legacy_partial` 的既有语义是「没有 facts 行、但原正文仍有效」，与这里不符；这里的事实
     * 行存在、正文被有意让给 timeline 那一份，所以「本段读不到正文」用 `unavailable` 表达——
     * 它只声明**本段**没有正文，不谎称这条消息的正文不存在。
     */
    const withoutBodyOf = (fact: QqMessageFact): QqMessageFact => ({
      ...fact,
      parts: fact.parts.filter((part) => part.kind !== "text"),
      completeness: "unavailable",
    });
    /**
     * 引用展开专用：**只渲染用的 metadata 视图**，不进材料、不当真实 fact 复用。
     *
     * 身份/时间/关系/来源全留，`parts` 清空。它存在的唯一理由是让 `expandQqReplies` 的
     * in_window 分支命中——该分支本来就只产 metadata 并以 `targetMessageId` 指向窗口消息
     * （`metadataMessage` 同样 `parts=[]`），所以这里与那条既有约定完全同形。
     *
     * `completeness` 保持 `"full"` 只在这一个前提下成立：**当前窗口身份里那份正文确实存在**
     * （本档 timeline 保留了这条 speech 的原正文，见上面的剥离判据）。它不是「这条事实完整」，
     * 也不是「本段提供它的正文」，因此这个对象绝不回写进 material、也不复用为真实 fact：
     * 一旦离开本视图，`full` + `parts=[]` 就是一个会骗人的组合。
     * 若该正文其实不在窗口（例如窗口正文被裁），`speechFactsCarrying` 不会把它标成部分承载，
     * 也就走不到这里——那种情况仍按正常 lazy read 拒或按预算裁，不把「名字」当已理解。
     */
    const metadataOnly = (fact: QqMessageFact): QqMessageFact => ({ ...fact, parts: [] });

    const timelineMessages = () => {
      // 正文去重：有 facts 的消息 text 置 null（正文由 facts 资料段承载）；
      // 无 facts 的消息（legacy/未确认出站/无事实行）保留 timeline 正文作为唯一来源。
      const timelineMsgs = selection.messages.map((message) => {
        const eventKey = (message.sources ?? []).find(
          (source) => source.kind === "qq_observation",
        )?.id;
        if (eventKey !== undefined && projectedFactKeys.has(eventKey))
          return { ...message, text: null };
        // 助手自己的时间线消息经 outbox（outbound_intent source）或旧 timeline（qq_speech
        // source）进场，没有 qq_observation source。正文去重**按真实意图身份**判，不按正文
        // 文本猜：本档已投影该 intent 的已确认 part 事实时，时间线那份正文就是重复的一份，
        // 置 null 由 facts 资料段唯一承载（单消息整体正文一份）；未投影到（未确认/超窗口）
        // 就保留原正文，绝不因此丢失助手说过的话。
        const intentId = (message.sources ?? []).find(
          (source) => source.kind === "outbound_intent",
        )?.id;
        if (intentId !== undefined && projectedOutboundIntentIds.has(intentId))
          return { ...message, text: null };
        // 旧 `qq_speech` 承载的已确认出站正文：只在**全部**已确认文本部件都进了本档 facts
        // （`speech.id === intent.legacy_send_id` 精确关联）时，那份拼接正文才是重复的一份。
        // 「部分承载」与未映射的独立旧 speech 都在上面的判据之外，原正文保持为唯一来源。
        const speechId = (message.sources ?? []).find((source) => source.kind === "qq_speech")?.id;
        return speechId !== undefined && speechFactsCarrying.fullyCarriedSpeechIds.has(speechId)
          ? { ...message, text: null }
          : message;
      });
      return qqPromptMessages(buildQqPrompt(this.prompt(timelineMsgs)))
        .filter((message) => message.role === "user")
        .map((message) => textMessage("user", message.content));
    };
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
    /**
     * D2 统一事实投影（规格 §4.1–§4.4）：选中窗口消息经 projectQqMessageFacts →
     * renderQqMessageFacts（同一 renderer 口径：@原位/引用原文/双昵称快照/媒体未读标记），
     * 作为资料段进决策/评分/生成材料。身份/引用是数据，不提升为指令；渲染失败/无 facts
     * 时该段缺省（不伪造）。scope 由投影自身 fail-closed。
     */
    const factsDetailMessages = (): ModelMessage[] => {
      if (selection.messages.length === 0) return [];
      const eventKeys = selection.messages.flatMap((message) =>
        (message.sources ?? [])
          .filter((source) => source.kind === "qq_observation")
          .map((source) => source.id),
      );
      if (eventKeys.length === 0) return [];
      const conversation = o.journal.get(o.conversationId);
      if (!conversation) return [];
      // 「部分承载」的出站件**只摘掉正文片段**，身份/完整时间/@与引用关系/其它片段照旧留在
      // 资料段：它的旧 speech 正文仍须作为唯一来源，这里再印一次正文就会出现两处
      // （§4.3「同一消息最多供一次正文」），但整条删掉会让「谁在何时说了什么、引用了谁」
      // 凭空消失。按真实 part 身份（ref id = `outbound_parts.id`）判定，不按正文文本猜。
      const facts = projectedFacts.map((fact) =>
        partlyCarriedPartIds.has(fact.id) ? withoutBodyOf(fact) : fact,
      );
      if (facts.length === 0) return [];
      const focus = {
        triggerMessageIds: o.trigger ? [o.trigger.sourceId] : [],
        responseMessageIds: o.trigger ? [o.trigger.sourceId] : [],
        responseQqs: o.targets().map((target) => target.speakerId ?? "anonymous"),
        assistantQq: o.binding.accountId,
      };
      const rendered = renderQqMessageFacts({
        messages: facts,
        focus,
        settings: schemeMessageSettings(o.scheme),
        nowSeconds: nowSeconds,
      });
      if (rendered.trim() === "") return [];
      return [
        textMessage(
          "user",
          contextDumps({ kind: "qq_message_facts", trust: "data_only", facts: rendered }),
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
      messages.push(...timelineMessages(), ...factsDetailMessages(), ...triggerMessages());
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
    // 本群停用历史摘要：已存包与新压缩都不再进入这一轮（原文窗口照旧）。
    if (
      tier === "reply" &&
      o.runtime.p5_config.compression_enabled &&
      this.guard.allowed(this.owner, "history_summary")
    ) {
      // 包装进材料才附当前纪元的能力引用：停用后旧包正文连同缓存视图一起失效。
      const summaryRefs = this.guard.sources(this.owner, "history_summary");
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
        at: readAt,
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
            assertStartable: o.assertStartable,
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
          // 没有包（例如只有排队任务）时不附引用：停用不该打死这一轮。
          ...(packages.length > 0 ? summaryRefs : []),
          ...packages.flatMap((item) => item.sources ?? []),
        ]),
      };
    }
    // D2 S4b：回复展开与引用正文资料段（规格 §4.3/§4.4）。展开只在本档 view 构建时做一次：
    // 真实 load（scope fail-closed 投影）/register（同一 evidence registry，真实 runId）/
    // fits。引用段字节记账按**最终渲染实量**（qq_reply_roots 段完整序列化的 UTF-8 字节，
    // 含 JSON 转义/元数据行/bodyRef），不用净正文字节、不用固定每根预留；超余量按
    // §4.4 降级（深层/最早的引用行先裁，直接层 Unicode 前缀页由展开内 fitPrefix 处理），
    // 不删已选窗口、不整轮失败。configured_depth 才渲染引用段；one_then_on_demand 规则不变。
    const settings = schemeMessageSettings(o.scheme);
    const conversationRowForReply = o.journal.get(o.conversationId);
    const replyScope =
      this.runId !== undefined && conversationRowForReply
        ? {
            conversationId: o.conversationId,
            accountId: o.binding.accountId,
            conversationKind: o.binding.kind,
            peerId: o.binding.peerId,
            agentId: o.binding.agentId,
            bindingId: o.binding.id,
            bindingEpoch: conversationRowForReply.bindingEpoch,
            authorityRevision: o.binding.authorityRevision,
          }
        : null;
    const replyEventKeys = (material.sources ?? [])
      .filter((source) => source.kind === "qq_observation")
      .map((source) => source.id);
    // 引用展开的窗口事实：本档窗口的入站事实 + 本档已投影的已确认助手出站 part 事实。
    // 助手 part 必须在窗口里，否则「目标已在窗口」判不出来，展开会改走 load 回落，
    // 同一份正文既在 facts 段又在引用段各出现一次（§4.3「正文只供一次」）。两者是同一
    // 个 `QqMessageFact[]`，`expandQqReplies` 按平台 ID 建 windowByPlatformId，天然去重。
    const replyFacts = [
      ...(replyScope && replyEventKeys.length > 0
        ? projectQqMessageFacts({ db: o.db, orm: o.orm }, replyScope, replyEventKeys, readAt)
        : []),
      ...outboundFacts,
    ];
    /**
     * 「部分承载」的出站件在引用展开里的形状：**仍是窗口内可指向的合法目标，但只作 metadata
     * 引用**（render-only，绝不进材料）。
     *
     * 它的正文此刻由旧 speech 时间线那一份承载（资料段已按上面剥掉正文），所以这里若把它
     * 标成非完整，`expandQqReplies` 会跳过 in_window 分支、改走 `load`/`loadState` 回落，
     * 又把同一份正文印进引用段——那正是要避免的第二处正文。
     *
     * 前置条件由上面的剥离判据保证，而不是在这里假设：只有当那条 speech 时间线正文**被判定
     * 保留**时（既不在 `fullyCarriedSpeechIds` 里、其 source 又确实在本档 `selection` 中），
     * 它的 part 才可能进 `partlyCarriedPartIds`。因此这里再显式核一次「该 speech 正文在场」，
     * 不在场就退回真实 fact，让正常 lazy read／预算裁去处理——绝不凭空造一个
     * `full` + 空 parts 的对象、也不把「有这条消息」当成「正文已理解」。
     */
    const speechBodyRetainedFor = (partIds: ReadonlySet<string>): ReadonlySet<string> => {
      const retainedSpeech = new Set(
        selection.messages.flatMap((message) =>
          (message.sources ?? [])
            .filter(
              (source) =>
                source.kind === "qq_speech" && message.text !== null && message.text !== "",
            )
            .map((source) => source.id),
        ),
      );
      if (retainedSpeech.size === 0) return new Set<string>();
      const allowed = new Set(
        [...speechFactsCarrying.partlyCarriedSpeechIds].filter((id) => retainedSpeech.has(id)),
      );
      if (allowed.size === 0) return new Set<string>();
      return partIds;
    };
    const speechBodyBackedPartIds = speechBodyRetainedFor(partlyCarriedPartIds);
    const replyWindowFacts = replyFacts.map((fact) =>
      speechBodyBackedPartIds.has(fact.id) ? metadataOnly(fact) : fact,
    );
    let replyExpansion: QqFullReplyProjection = { roots: [], sources: [] };
    // 引用段可用的真实字节余量（与 fitsTarget 同口径）。
    const quoteRoom = Math.max(
      0,
      ceiling - cost(material) - this.envelopeFloor(material) - ACTION_ENVELOPE_ALLOWANCE - 32, // 引用段自身作为一条 user 消息的 message 开销（12+role），保证终检不因它超限。
    );
    /** 根 → 资料段行（与最终渲染逐字同一形状）。 */
    const toQuoteLine = (root: QqFullReplyProjection["roots"][number]) => {
      const message = root.message;
      // P2：message==null（missing/expired/revoked/cycle）也保留安全关系行——稳定 id/state/
      // depth 指向明确，不冒充无引用、不隐藏状态；不可读正文/私名一律不出（无 speaker/time/
      // text/bodyRef 字段）。
      if (!message) {
        return {
          from: root.fromMessageId,
          target: root.targetMessageId,
          state: root.state,
          depth: root.depth,
        };
      }
      return {
        from: root.fromMessageId,
        target: root.targetMessageId,
        state: root.state,
        depth: root.depth,
        platformMessageId: message.platformMessageId,
        speaker: {
          role: message.speaker.role,
          qq: message.speaker.qq,
          displayName: resolveQqDisplayName(message.speaker),
          nameState: message.speaker.nameState,
        },
        occurredAtSeconds: message.occurredAtSeconds,
        // 引用元数据始终带完整时间（规格 §5），时区沿方案 message_settings 真源。
        time: formatQqTime(message.occurredAtSeconds, {
          nowSeconds,
          timezone: settings.timezone,
          display: settings.time_display,
          full: true,
        }),
        ...(root.textPage
          ? {
              text: root.textPage.text,
              offset: root.textPage.offset,
              total: root.textPage.total,
              nextOffset: root.textPage.nextOffset,
              complete: root.textPage.complete,
            }
          : {}),
        ...(root.bodyRef ? { bodyRef: root.bodyRef } : {}),
      };
    };
    /** 最终渲染实量：整个 qq_reply_roots 段（含包装、转义、元数据行、bodyRef）的 UTF-8 字节。 */
    const quoteDumpBytes = (roots: QqFullReplyProjection["roots"]): number => {
      const lines = roots
        .map(toQuoteLine)
        .filter((line): line is NonNullable<typeof line> => line !== null);
      if (lines.length === 0) return 0;
      return estimateTokens(
        contextDumps({ kind: "qq_reply_roots", trust: "data_only", roots: lines }),
      );
    };
    if (replyScope && replyFacts.length > 0) {
      replyExpansion = expandQqReplies({
        scope: replyScope,
        window: replyWindowFacts,
        focus: o.mediaInput?.focus() ?? {
          triggerMessageIds: o.trigger ? [o.trigger.sourceId] : [],
          responseMessageIds: o.trigger ? [o.trigger.sourceId] : [],
          responseQqs: o.targets().map((target) => target.speakerId ?? "anonymous"),
          assistantQq: o.binding.accountId,
        },
        settings,
        now: readAt,
        // 纯函数的预算单位是码点；这里的装配预算是 UTF-8 字节。字符预算不设限（沿用
        // evidenceBudget("qq_reply") 口径），真实字节边界交给 fits：按候选投影的**整段
        // 渲染实量**（元数据行＋page＋bodyRef 全部序列化）复检——fitPrefix 二分因此找到
        // 整段可容的最长前缀，深层超段则被裁。
        remainingTextUnits: this.evidenceBudget("qq_reply"),
        // 出站回落（T04 Step3）：入站 loader 取不到时，按同一平台 ID 查**已确认助手 part**
        // （群友回复助手旧消息时目标就是助手 part；只走入站 loader 恒 missing，原话取不到）。
        // loader 自身按 confirmed/唯一认领/双账一致/target 六维+authorityRevision/真实
        // delivery journal 归属/双期限帽 fail closed，本层不复制任何授权判定。
        load: (id: string) =>
          loadQqMessageFact({ db: o.db, orm: o.orm }, replyScope, id, readAt) ??
          loadQqOutboundMessageFact({ db: o.db, orm: o.orm }, replyScope, id, readAt),
        // P2/S14：状态感知读取——expired/revoked/legacy 分别表达（同 scope 到期保状态
        // 不泄正文/身份；跨 scope 恒 missing），不把过期混为 missing。
        // 出站回落（T04 Step3）：入站 missing 时走同一平台 ID 的**已确认助手 part** 状态
        // 读取——message-projection 的 `loadQqOutboundMessageFactState` 与事实读同一
        // guard（scope 八维先决，visiblePart(now=null) 免期定位）：同 scope 过期表达为
        // `expired`（不给正文/身份），未确认/跨 scope/撤权一律 `missing` 不泄存在，
        // available 才带事实。本层不复制任何授权判定。
        loadState: (id: string) => {
          const inbound = loadQqMessageFactState({ db: o.db, orm: o.orm }, replyScope, id, readAt);
          if (inbound.state !== "missing") return inbound;
          return loadQqOutboundMessageFactState({ db: o.db, orm: o.orm }, replyScope, id, readAt);
        },
        // 引用正文注册走既有 history 域（规格 §4.4：按需读取扩展 history.read 同一证据
        // 注册机制，不发明新域/新工具名；history 模块 lazy read 以真实 bodyRef 解析正文）。
        register: (_candidateEvidence: Evidence, fact: QqMessageFact) => {
          // P2/S19 桥：reply-context 给的 evidence.id 是 "qq-message:<eventKey>" 形状的
          // 普通文本 id——history 域的 lazy read 只认 locateHistory 铸造的 JSON tuple
          // Evidence（带 conversation_evidence sources）。通过当前 fact 的真实
          // platformMessageId 调 locateHistory，用真实 run ActionContext（owner/runId/
          // assertAuthority）铸造合法 Evidence 后注册——同 run 读命中，跨 run 仍拒。
          // locateHistory 内部已做 scope/owner 复验。
          const platformId = fact?.platformMessageId ?? undefined;
          const anchor = platformId
            ? this.locateHistory?.(platformId, {
                owner: this.runOwner ?? this.owner,
                runId: this.runId,
                signal,
              })
            : null;
          if (!anchor) {
            // locateHistory 返回 null＝无法合法定位（scope/权限/存在性失败）——不注册，
            // 不发不可读 bodyRef 假满足。
            return "";
          }
          return this.registerEvidence("history", anchor, {
            owner: this.runOwner ?? this.owner,
            runId: this.runId,
            signal,
          });
        },
        fits: (value: QqFullReplyProjection, sources: readonly SourceRef[]) => {
          this.assertSources(sources);
          // bodyRef 在展开授予之后才注册（随机 UUID），此时序列化还看不到它——每个可能携带
          // 受限读取引用的根（页不完整/被裁直接层）预留一个 bodyRef JSON 的固定字节数，
          // 不让最终序列化超出这里判定的余量。
          const pendingBodyRefs = value.roots.filter(
            (root) => root.message !== null && (root.textPage === null || !root.textPage.complete),
          ).length;
          return quoteDumpBytes(value.roots) + pendingBodyRefs * 64 <= quoteRoom;
        },
      });
    }
    // configured_depth：已授权根（metadata/textPage）进实际资料段；one_then_on_demand 也渲染
    // 引用行但**仅关系/状态元数据**（正文仍按需读取，不自动供入——规格 §4.3 默认模式）。
    // 降级顺序（§4.4）：
    // 段超余量先裁最深、再最早的引用行（其关系仍留在窗口事实与 bodyRef 登记里），
    // 直接层正文页已由展开内 Unicode 前缀二分裁到位；都不够则整段不渲染——不删窗口、
    // 不打死整轮。窗口内正文只供一次（in_window 根只带关系指向）；过期/跨 scope 根
    // fail-closed 不暴露、来源不并入。
    {
      const oneThen = settings.reply_mode === "one_then_on_demand";
      let quoteRoots = [...replyExpansion.roots];
      while (quoteRoots.length > 0 && quoteDumpBytes(quoteRoots) > quoteRoom) {
        // 最深优先；同深取最早（occurredAtSeconds 小者），再按 fromMessageId 决胜。
        let victim = quoteRoots[0];
        for (const root of quoteRoots) {
          if (
            root.depth > victim.depth ||
            (root.depth === victim.depth &&
              (root.message?.occurredAtSeconds ?? 0) < (victim.message?.occurredAtSeconds ?? 0)) ||
            (root.depth === victim.depth &&
              (root.message?.occurredAtSeconds ?? 0) === (victim.message?.occurredAtSeconds ?? 0) &&
              root.fromMessageId < victim.fromMessageId)
          ) {
            victim = root;
          }
        }
        quoteRoots = quoteRoots.filter((root) => root !== victim);
      }

      const quoteLines = quoteRoots
        .map(toQuoteLine)
        .filter((line): line is NonNullable<typeof line> => line !== null)
        .map((line) =>
          oneThen
            ? // one_then：只保留关系/状态元数据，正文与受限读取引用不进模型输入（按需读取）。
              { from: line.from, target: line.target, state: line.state, depth: line.depth }
            : line,
        );
      if (quoteLines.length > 0 && quoteDumpBytes(quoteRoots) <= quoteRoom) {
        material = {
          ...material,
          pending: [
            ...(material.pending ?? []),
            textMessage(
              "user",
              contextDumps({ kind: "qq_reply_roots", trust: "data_only", roots: quoteLines }),
            ),
          ],
          sources: uniqueSources([...(material.sources ?? []), ...replyExpansion.sources]),
        };
      }
    }
    if (!fitsTarget(material))
      fail("CONTEXT_BUDGET_EXCEEDED", "近期窗口、水位包、协议与后续动作余量超过可用容量");
    signal.throwIfAborted();
    this.assertSources(material.sources ?? []);
    const view: View = { material, selection, limit: ceiling, replyFacts, replyExpansion };
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
  /**
   * 本档窗口在 journal 里的真实 seq 区间——出站候选枚举的上界真源（§4.3「不扩成通用
   * 历史预载」；seq 下界由投影事实的真实时间裁剪承担，见 confirmedOutboundPartCandidates）。
   *
   * 窗口是「哪些消息进这一轮」，seq 区间就是它的稳定投影：下界取窗口里最早一条**带真实
   * journal seq** 的消息（本档已投影事实的入站事件，或本档已列入 timeline 的助手出站意图
   * 的 delivery 事件），上界取同一批 seq 的最大值。不按时间猜、不整表扫，也不用入站
   * eventKey 与出站 part 混键；窗口里一条可定位 seq 的消息都没有时返回 null（=没有候选，
   * 而不是"退化成全会话历史"）。
   */
  private outboundSeqWindow(
    conversationId: string,
    window: readonly QqContextMessage[],
  ): { minSeq: number; maxSeq: number } | null {
    const eventKeys: string[] = [];
    const intentIds: string[] = [];
    for (const message of window) {
      for (const source of message.sources ?? []) {
        if (source.kind === "qq_observation") eventKeys.push(source.id);
        else if (source.kind === "outbound_intent") intentIds.push(source.id);
      }
    }
    if (eventKeys.length === 0 && intentIds.length === 0) return null;
    const rows = this.options.db
      .query(
        `SELECT MIN(seq) AS minSeq,MAX(seq) AS maxSeq FROM conversation_events
        WHERE conversation_id=? AND (
          (kind='inbound' AND source_kind='qq_event'
            AND source_id IN (SELECT value FROM json_each(?)))
          OR (kind='delivery' AND source_kind='outbound_intent'
            AND source_id IN (SELECT value FROM json_each(?)))
        )`,
      )
      .get(conversationId, JSON.stringify(eventKeys), JSON.stringify(intentIds)) as {
      minSeq: number | null;
      maxSeq: number | null;
    };
    if (rows.minSeq === null || rows.maxSeq === null) return null;
    return { minSeq: rows.minSeq, maxSeq: rows.maxSeq };
  }

  /**
   * 水位压缩的输入记录。id/seq/说话人与水位计数规则逐字保持旧规则（原 sources tuple 的
   * id、journal SQL 的 seq、anonymous 兜底）；text 从裸正文升级为统一事实投影的文字关系：
   * 发送时双名快照、@/reply 关系与有序片段（projectQqMessageFacts → projectQqTextRelations，
   * 同 scope/now）。当前目录名（currentName）与媒体分类不进压缩输入——category 统一 unknown
   * 存在标记，不 join 模型分类/视觉笔记/OCR。事实行存在但已过期（投影整跳）不回旧正文，
   * 只留最少状态；真缺失 facts 行且原正文仍有效的消息沿原 body 标 legacy_partial，不编双名。
   * sources 并入投影产出的真实 qq_message_fact/qq_observation 引用（由 assertSources 沿
   * 现有 guard 复验），身份 tuple 只按原 sources 计算，不受新增 refs 影响。
   */
  private compressionRecords(messages: readonly QqContextMessage[]): CompressionRecord[] {
    const o = this.options;
    // 每次调用冻结一次时钟：投影与正文期限判断用同一 now。
    const now = this.now();
    // 用实际 ownerScope 定位 full8 scope；conversationId 必须匹配本会话——scope 存在性与
    // 授权面由 projectQqMessageFacts 内部校验，这里只负责"别把别群的事实投影进来"。
    const located = ownerScope(o.db, this.owner);
    const scope: QqConversationScope | null =
      located && located !== "ambiguous" && located.scope.conversationId === o.conversationId
        ? located.scope
        : null;
    // 入站消息的真实事件键只从原 sources 的 qq_event/qq_observation 引用取（id 即 eventKey），
    // 不猜平台消息 ID；助手自己的 qq_speech 发言不属入站事实链。
    const eventKeyOf = (message: QqContextMessage): string | null =>
      message.sources?.find(
        (source) => source.kind === "qq_event" || source.kind === "qq_observation",
      )?.id ?? null;
    const eventKeys = messages
      .map((message) => eventKeyOf(message))
      .filter((key): key is string => key !== null);
    const projected = new Map(
      scope && eventKeys.length
        ? projectQqMessageFacts(o, scope, eventKeys, now).map((fact) => [fact.id, fact])
        : [],
    );
    /** 事实行是否存在（含已过期）：用于区分"真缺失"与"存在但投影整跳"。 */
    const factRowExists = (eventKey: string): boolean =>
      !!(
        scope &&
        o.db
          .query(
            "SELECT 1 FROM qq_message_facts f JOIN qq_events e ON e.event_key=f.event_key WHERE f.event_key=? AND e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=?",
          )
          .get(eventKey, scope.accountId, scope.conversationKind, scope.peerId, scope.agentId)
      );
    return messages.map((message, index) => {
      const sources = message.sources ?? [];
      const rows = sources.flatMap(
        (source) =>
          o.db
            .query(
              "SELECT e.seq FROM conversation_events e,json_each(e.sources) s WHERE e.conversation_id=? AND e.kind IN ('inbound','outbound') AND json_extract(s.value,'$.kind')=? AND json_extract(s.value,'$.id')=?",
            )
            .all(o.conversationId, source.kind, source.id) as {
            seq: number;
          }[],
      );
      // 稳定身份 tuple 只按原 sources 计算：新增的投影 refs 不改变 record 身份。
      const id = sources.length
        ? contextDumps(sources.map((source) => [source.kind, source.id, source.revision]))
        : `anonymous:${message.occurredAtSeconds}:${index}`;
      const eventKey = eventKeyOf(message);
      const fact = eventKey ? projected.get(eventKey) : undefined;
      let text: string;
      let extraSources: readonly SourceRef[] = [];
      if (fact && scope) {
        const relations = projectQqTextRelations({ facts: [fact], scope, now });
        const record = relations.records[0];
        if (record) {
          // 只消费本次复验过的白名单记录：clone 后去掉未复验的当前名映射；image category
          // 统一成 unknown 存在标记（模型分类/视觉笔记不进）；其余片段与关系原样。
          const rest = structuredClone(record) as Record<string, unknown>;
          delete rest.currentName;
          rest.parts = (rest.parts as Array<Record<string, unknown>>).map((part) =>
            part.kind === "image" ? { ...part, category: "unknown" } : part,
          );
          text = contextDumps(rest);
          extraSources = relations.sources;
        } else {
          // 投影整跳（事实行已过期）：不回旧正文、不给名字与关系。
          text = contextDumps({ completeness: "unavailable" });
        }
      } else if (eventKey && (scope === null || factRowExists(eventKey))) {
        // 事实行存在但 projection 未产出（过期/时间线不复验），或无法定位 scope
        // （ownerScope 判 null/ambiguous/会话不匹配）：两类都无法授权，fail closed
        // 同判 unavailable，不回退 legacy 正文、不标 legacy_partial。
        text = contextDumps({ completeness: "unavailable" });
      } else if (message.speaker !== "assistant" && message.text !== null) {
        // 真缺失 facts 行且原正文仍有效：沿原 text 标 legacy_partial，不编双名、不回填当前名。
        text = contextDumps({ completeness: "legacy_partial", text: message.text });
      } else {
        // 助手发言（走既有 qq_speech ref）与无正文消息沿既有 ref 保 legacy 行为。
        text = contextDumps({ text: message.text });
      }
      return {
        id,
        seq: rows.length ? Math.min(...rows.map((row) => row.seq)) : null,
        speaker: message.speakerId ?? message.speaker,
        // 摘要只压文字关系与正文。媒体描述是模型产物、还会变长，压进摘要既贵又容易把
        // "看图看的"当成事实；未读的那一份本来就只是计数。
        text,
        sources: [...sources, ...extraSources],
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
        if (projected + this.reservations.reserved(token) > view.limit) {
          // §4.4 预算降级：工具观察装不下时，尝试缩减引用段（qq_reply_roots）腾出余量。
          // 按深→早顺序逐根移除，直到装下或无引用可裁。失败不改 views/reservations。
          const shrunk = this.tryShrinkQuoteForObservation(tier, observation, view, token);
          if (shrunk === null) return false;
          reservation = Math.max(reservation, shrunk);
        }
      }
      // 通过则覆盖自己的预留（fitter 记住上次通过的值）；失败不改预留。
      this.reservations.set(token, reservation);
      return true;
    };
  }
  /**
   * §4.4 预算降级：当工具观察因引用段占满余量而装不下时，尝试移除 qq_reply_roots 段
   * 腾出空间。移除是永久性的（更新 view material）——引用关系仍由窗口事实的 replyTo
   * 和 bodyRef registry 保留，模型可在下一轮重新请求。返回新 reservation 或 null（仍装不下）。
   */
  private tryShrinkQuoteForObservation(
    tier: QqContextTier,
    observation: ActionObservation,
    view: View,
    token: symbol,
  ): number | null {
    // 找到 qq_reply_roots 消息
    const pending = view.material.pending ?? [];
    const rootsIdx = pending.findIndex((m) =>
      m.content.some((p) => p.kind === "text" && p.text.includes("qq_reply_roots")),
    );
    if (rootsIdx < 0) return null;
    // 移除该消息，重算 reservation
    const shrunkPending = pending.filter((_, idx) => idx !== rootsIdx);
    const shrunkMaterial: ContextMaterial = {
      ...view.material,
      pending: shrunkPending,
    };
    const projected = this.cost(tier, shrunkMaterial, [...this.observations, observation]);
    const base = this.cost(tier, shrunkMaterial, this.observations);
    const reservation = Math.max(0, projected - base);
    if (projected + this.reservations.reserved(token) > view.limit) return null;
    // 成功：永久更新 view 的 material（引用段已降级为不可用）
    view.material = shrunkMaterial;
    return reservation;
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
    // 本群停用后，本轮后续调用不再放行：返回不可读的信封而不是正文（不是只隐藏工具目录）。
    if (!this.guard.allowed(this.owner, name === "memory.query" ? "memory_read" : "knowledge_read"))
      return this.unavailable(name, "QQ_GROUP_CAPABILITY_DISABLED");
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
